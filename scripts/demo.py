#!/usr/bin/env python3
"""Create a clearly synthetic git history for tests and public demos."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo', type=Path, default=root / '.demo-repo', help='New synthetic repository directory; existing directories are never overwritten.')
parser.add_argument('--out', type=Path, default=root / '.local/demo-city.json', help='Generated public city JSON path.')
args = parser.parse_args()
repo = args.repo.resolve()
if repo.exists():
    print('Synthetic demo already exists at %s. Choose a new --repo directory to create another fixture.' % repo)
    sys.exit(0)
repo.mkdir(parents=True)
# Fifteen integration points span 28 days, so the early 14-day rework
# cohorts mature before the repair. These are synthetic dates, not build dates.
start = dt.datetime(2026, 9, 1, 12, tzinfo=dt.timezone.utc)
def synthetic_date(step):
    return (start + dt.timedelta(days=(step - 1) * 2)).isoformat()

def git(*args, date=None):
    env = dict(os.environ, GIT_AUTHOR_NAME='Strata demo', GIT_AUTHOR_EMAIL='demo@example.invalid', GIT_COMMITTER_NAME='Strata demo', GIT_COMMITTER_EMAIL='demo@example.invalid')
    if date:
        env.update(GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
    subprocess.run(['git', '-C', str(repo), *args], env=env, check=True, stdout=subprocess.DEVNULL)
git('init', '-b', 'main')
modules = ['catalog', 'orders', 'billing', 'shipping', 'reports', 'notifications']
config = {'name': 'Harbor · synthetic demo', 'private': False, 'pythonRoots': [''], 'modules': [{'path': 'app/' + m, 'public': ['app/' + m + '/__init__.py']} for m in modules]}
(repo / 'strata.config.json').write_text(json.dumps(config, indent=2))
(repo / 'app').mkdir()
(repo / 'app/__init__.py').write_text('')
for m in modules:
    p = repo / 'app' / m; p.mkdir(); (p / '__init__.py').write_text('from .service import summary\n')
    (p / 'service.py').write_text('def summary(records):\n    return {"count": len(records)}\n')
git('add', '.'); git('commit', '-qm', 'Synthetic: establish public gates', date=synthetic_date(1))
for day in range(2, 15):
    for index, m in enumerate(modules):
        filename = ['validate', 'format', 'calculate', 'schedule', 'render', 'deliver'][index]
        p = repo / 'app' / m / f'{filename}_{day}.py'
        blocks = [f'def step_{k}(records):\n    selected = [r for r in records if r is not None]\n    return selected[:{day+k}]\n' for k in range(2 + (index + day) % 6)]
        p.write_text('\n'.join(blocks))
    if day >= 6:
        (repo / 'app/billing/rates.py').write_text('def rate(amount):\n    return round(amount * 0.2, 2)\n')
        for m in modules[:min(4, day - 4)]:
            if m == 'billing':
                continue
            (repo / 'app' / m / 'invoice.py').write_text('from app.billing.rates import rate\n\ndef total(amount):\n    return amount + rate(amount)\n')
    git('add', '.'); git('commit', '-qm', 'Synthetic: add a small feature', date=synthetic_date(day))
git('tag', 'before-repair')
# A genuine, behavior-preserving repair: expose one operation and update callers.
(repo / 'app/billing/__init__.py').write_text('from .service import summary\nfrom .rates import rate\n')
for m in ['catalog', 'orders', 'shipping']:
    p = repo / 'app' / m / 'invoice.py'
    p.write_text(p.read_text().replace('from app.billing.rates import rate', 'from app.billing import rate'))
git('add', '.'); git('commit', '-qm', 'Synthetic: expose rate through the billing gate', date=synthetic_date(15)); git('tag', 'after-repair')
subprocess.run([sys.executable, str(root / 'core/scan.py'), '--repo', str(repo), '--out', str(args.out.resolve())], check=True)
print('Created a synthetic history with a real before/after gate repair. Private workspace data was not used.')
