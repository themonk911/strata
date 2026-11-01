#!/usr/bin/env python3
"""Read-only git analyzer. Never imports or executes the code being scanned."""
import argparse
import ast
import collections
import datetime as dt
import fnmatch
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

CODE = re.compile(r'\.(py|ts|tsx|js|jsx|mjs|cjs)$')
SKIP = re.compile(r'(^|/)(node_modules|dist|build|vendor|\.git|\.venv|data|data_demo|app-state|codex-home|\.agents|\.codex)(/|$)|\.d\.ts$')
TEST = re.compile(r'(^|/)(tests?|__tests__|__smoke__)/|(^|/)test_[^/]+\.py$|\.(test|spec)\.[^.]+$')
JS_CACHE = {}

def parse_js_sources(sources):
    keys = {p: (PurePosixPath(p).suffix, hashlib.sha256(text.encode()).hexdigest()) for p, text in sources.items()}
    missing = {p: sources[p] for p, key in keys.items() if key not in JS_CACHE}
    if missing:
        parser = Path(__file__).with_name('parse-js.mjs')
        proc = subprocess.run(['node', str(parser)], input=json.dumps(missing), text=True, capture_output=True)
        if proc.returncode:
            raise ValueError('JavaScript parser unavailable. Run npm ci in the Strata installation; Node 22+ is required.')
        for p, result in json.loads(proc.stdout).items():
            JS_CACHE[keys[p]] = result
    return {p: JS_CACHE[key] for p, key in keys.items()}

def git(repo, *args, data=None):
    p = subprocess.run(['git', '-C', str(repo), *args], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode:
        raise ValueError('git ' + args[0] + ' failed: ' + p.stderr.decode(errors='replace')[:300])
    return p.stdout

def safe_path(p):
    return bool(p) and not p.startswith('/') and '..' not in PurePosixPath(p).parts and '\\' not in p

def load_config(repo, explicit=None):
    path = Path(explicit) if explicit else Path(repo) / 'strata.config.json'
    config = json.loads(path.read_text()) if path.exists() else {}
    for m in config.get('modules', []):
        if not safe_path(m['path']) or any(not safe_path(p) for p in m.get('public', [])):
            raise ValueError('Module and public paths must be repository-relative.')
    return config

def infer_modules(paths):
    """Package entry points are hypotheses, visibly distinguished from declarations."""
    modules = []
    for p in sorted(paths):
        if not p.endswith(('/__init__.py', '/index.ts', '/index.tsx', '/index.js')):
            continue
        folder = p.rsplit('/', 1)[0]
        if TEST.search(p) or folder.count('/') < 2:
            continue
        # Prefer bounded feature/service packages, not a wall around the entire app.
        if folder in ('backend/app/services', 'frontend/src/components', 'frontend/src'):
            continue
        count = sum(q.startswith(folder + '/') for q in paths)
        if count >= 3:
            modules.append({'path': folder, 'public': [p], 'inferred': True})
    return modules

def module_for(p, modules):
    matches = [m['path'] for m in modules if p == m['path'] or p.startswith(m['path'] + '/')]
    if matches:
        return max(matches, key=len)
    parts = p.split('/')[:-1]
    return '/'.join(parts[:3]) or '(root)'

def resolve_py(parts, paths, roots):
    for root in roots:
        base = '/'.join(([root] if root else []) + parts)
        for p in (base + '.py', base + '/__init__.py'):
            if p in paths:
                return p

def extract_imports(p, text, paths, config, parsed_js=None):
    """Return local static edges and coverage warnings. Python uses the AST."""
    out, warnings = [], []
    if p.endswith('.py'):
        roots = config.get('pythonRoots', ['backend', 'src', ''])
        root = next((r for r in roots if r and p.startswith(r + '/')), '')
        package = p[len(root) + 1 if root else 0:].split('/')[:-1]
        try:
            tree = ast.parse(text)
        except SyntaxError:
            return [], ['Python syntax could not be parsed: ' + p]
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                for alias in n.names:
                    hit = resolve_py(alias.name.split('.'), paths, roots)
                    if hit:
                        out.append((hit, n.lineno))
            elif isinstance(n, ast.ImportFrom):
                prefix = package[:len(package) - n.level + 1] if n.level else []
                parts = prefix + (n.module.split('.') if n.module else [])
                base = resolve_py(parts, paths, roots)
                # A directly imported child module bypasses __init__, even if the
                # package also re-exports a symbol with the same name.
                for alias in n.names:
                    child = resolve_py(parts + [alias.name], paths, roots)
                    hit = child or base
                    if hit:
                        out.append((hit, n.lineno))
    else:
        parsed_js = parsed_js if parsed_js is not None else parse_js_sources({p: text})[p]
        if parsed_js['invalid']:
            warnings.append('JavaScript/TypeScript syntax could not be fully parsed: ' + p)
        aliases = config.get('aliases', {'@/': 'frontend/src/'})
        for spec, line in parsed_js['imports']:
            if spec.startswith('.'):
                base = os.path.normpath(str(PurePosixPath(p).parent / spec)).replace(os.sep, '/')
            else:
                alias = next((a for a in aliases if spec.startswith(a)), None)
                if not alias:
                    continue
                base = aliases[alias] + spec[len(alias):]
            bases = [base]
            if base.endswith(('.js', '.mjs', '.jsx')):
                bases.append(base.rsplit('.', 1)[0])
            hit = next((b + ext for b in bases for ext in ('', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js') if b + ext in paths), None)
            if hit:
                out.append((hit, line))
    return sorted(set((target, line) for target, line in out if target != p)), warnings

def analyze(sources, config, modules=None):
    sources = {p: text for p, text in sources.items() if safe_path(p) and CODE.search(p) and not SKIP.search(p)}
    paths = set(sources)
    modules = modules if modules is not None else config['modules'] if 'modules' in config else infer_modules(paths)
    module_map = {m['path']: m for m in modules}
    files = {p: {'path': p, 'district': module_for(p, modules), 'lines': len(t.splitlines()), 'gate': False} for p, t in sources.items()}
    for p, f in files.items():
        mod = module_map.get(f['district'])
        f['gate'] = bool(mod and any(fnmatch.fnmatchcase(p, pattern) for pattern in mod.get('public', [])))
    edges, shortcuts, warnings = [], [], []
    parsed_js = parse_js_sources({p: text for p, text in sources.items() if not p.endswith('.py')})
    for p, text in sources.items():
        imports, failed = extract_imports(p, text, paths, config, parsed_js.get(p))
        warnings.extend(failed)
        seen = set()
        for target, line in imports:
            if target in seen:
                continue
            seen.add(target)
            a, b = files[p], files[target]
            allowed = bool(TEST.search(p)) or any(fnmatch.fnmatchcase(p, g) for g in config.get('allow', []))
            edge = {'source': p, 'target': target, 'line': line}
            edges.append(edge)
            if a['district'] != b['district'] and b['district'] in module_map and not b['gate'] and not allowed:
                shortcuts.append(edge)
    districts = []
    for group in sorted({f['district'] for f in files.values()}):
        outgoing = [e for e in edges if files[e['source']]['district'] == group]
        breaches = [e for e in shortcuts if files[e['source']]['district'] == group]
        incoming = [e for e in shortcuts if files[e['target']]['district'] == group]
        mod = module_map.get(group, {})
        districts.append({'id': group, 'name': group.split('/')[-1], 'walled': group in module_map,
                          'inferred': mod.get('inferred', False), 'public': mod.get('public', []),
                          'outgoing': len(outgoing), 'shortcuts': len(breaches), 'incoming': len(incoming),
                          'ratio': len(breaches) / len(outgoing) if outgoing else 0})
    targets = collections.defaultdict(list)
    for e in shortcuts:
        targets[e['target']].append(e['source'])
    desires = [{'target': p, 'sources': sorted(set(src)), 'districts': sorted({files[s]['district'] for s in src})}
               for p, src in targets.items() if len({files[s]['district'] for s in src}) >= 2]
    desires.sort(key=lambda d: (-len(d['districts']), -len(d['sources']), d['target']))
    return {'files': files, 'districts': districts, 'imports': edges, 'shortcuts': shortcuts, 'desirePaths': desires, 'warnings': warnings}

class Repository:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.blobs = {}

    def tree(self, revision):
        result = {}
        for entry in git(self.path, 'ls-tree', '-rz', revision).split(b'\0'):
            if not entry:
                continue
            info, rawpath = entry.split(b'\t', 1)
            mode, kind, sha = info.decode().split()
            p = rawpath.decode('utf-8', 'replace')
            if kind == 'blob' and mode != '120000' and CODE.search(p) and not SKIP.search(p):
                result[p] = sha
        missing = list(set(result.values()) - self.blobs.keys())
        if missing:
            raw = git(self.path, 'cat-file', '--batch', data=('\n'.join(missing) + '\n').encode())
            i = 0
            while i < len(raw):
                end = raw.index(b'\n', i)
                sha, kind, length = raw[i:end].split()
                length = int(length)
                self.blobs[sha.decode()] = raw[end + 1:end + 1 + length].decode('utf-8', 'replace')
                i = end + length + 2
        return {p: self.blobs[sha] for p, sha in result.items()}

    def working(self):
        paths = git(self.path, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0')
        sources = {}
        for p in paths:
            path = self.path / p
            if safe_path(p) and CODE.search(p) and not SKIP.search(p) and path.is_file() and not path.is_symlink():
                if self.path not in path.resolve().parents:
                    continue
                sources[p] = path.read_text(errors='replace')
        return sources

def scan(repo, config, maximum=70, working=False):
    repo = Repository(repo)
    head = git(repo.path, 'rev-parse', 'HEAD').decode().strip()
    rows = git(repo.path, 'log', '--first-parent', '--reverse', '--format=%H %ct', head).decode().splitlines()
    daily = {}
    for row in rows:
        sha, timestamp = row.split()
        date = dt.datetime.fromtimestamp(int(timestamp), dt.timezone.utc).strftime('%Y-%m-%d')
        daily[date] = (sha, int(timestamp))
    dates = sorted(daily)
    if len(dates) > maximum:
        dates = [dates[round(i * (len(dates) - 1) / (maximum - 1))] for i in range(maximum)]
    head_sources = repo.tree(head)
    modules = config.get('modules', infer_modules(head_sources))
    snapshots = []
    all_files, previous, last_changed = {}, {}, {}
    warnings = set()
    for i, date in enumerate(dates):
        sha, timestamp = daily[date]
        sources = repo.tree(sha)
        result = analyze(sources, config, modules)
        warnings.update(result.pop('warnings'))
        for p, f in result['files'].items():
            digest = hashlib.sha256(sources[p].encode()).digest()
            if previous.get(p) != digest:
                last_changed[p] = timestamp
            f['changed'] = last_changed[p]
            previous[p] = digest
            all_files[p] = {k: f[k] for k in ('path', 'district', 'gate')}
        snapshots.append({'date': date, 'timestamp': timestamp, 'revision': sha[:12], **result})
        print('Scanning %s (%d/%d)' % (date, i + 1, len(dates)), file=sys.stderr)
    if working:
        result = analyze(repo.working(), config, modules)
        warnings.update(result.pop('warnings'))
        timestamp = int(dt.datetime.now(dt.timezone.utc).timestamp())
        for p, f in result['files'].items():
            f['changed'] = timestamp if snapshots[-1]['files'].get(p, {}).get('lines') != f['lines'] else last_changed.get(p, timestamp)
            all_files[p] = {k: f[k] for k in ('path', 'district', 'gate')}
        snapshots.append({'date': 'Working tree', 'timestamp': timestamp, 'revision': 'working', **result})
    # Strip every commit message, author name and email. Only time and changed
    # source paths survive. One dot is one commit, not a claim of agent identity.
    log = git(repo.path, 'log', '--no-merges', '--reverse', '--format=@@%ct', '--name-only', head).decode(errors='replace')
    changes = []
    for block in log.split('@@')[1:]:
        lines = block.splitlines()
        touched = [p for p in lines[1:] if p in all_files]
        if touched:
            changes.append({'time': int(lines[0]), 'files': touched})
    return {'schemaVersion': 1, 'meta': {'name': config.get('name', repo.path.name), 'private': config.get('private', True),
            'revision': head, 'gatePolicy': 'declared' if 'modules' in config and not any(m.get('inferred') for m in modules) else 'inferred from current package entry points',
            'coverage': 'Python and TypeScript ASTs. Static import strings are resolved locally; computed paths, external packages and runtime resolution may be missed.',
            'limitations': ['Boundary pressure is not a validated entropy or defect predictor.',
                           'Current gate definitions are applied to all snapshots; past intent is not inferred.',
                           'Heat means changed since the previous sampled snapshot, not exact edit time.'],
            'warnings': sorted(warnings)}, 'files': list(all_files.values()), 'snapshots': snapshots, 'changes': changes}

def check(repo, config, base='HEAD'):
    r = Repository(repo)
    before_sources = r.tree(base)
    modules = config.get('modules', infer_modules(before_sources))
    before = analyze(before_sources, config, modules)
    after = analyze(r.working(), config, modules)
    key = lambda e: (e['source'], e['target'])
    old, new = {key(e) for e in before['shortcuts']}, {key(e) for e in after['shortcuts']}
    return {'base': base, 'before': len(old), 'after': len(new),
            'added': [e for e in after['shortcuts'] if key(e) not in old],
            'removed': [e for e in before['shortcuts'] if key(e) not in new],
            'warnings': after['warnings']}

def main():
    ap = argparse.ArgumentParser(description='Strata: a read-only city of your git history.')
    ap.add_argument('command', nargs='?', choices=['scan', 'check', 'explain'], default='scan')
    ap.add_argument('--repo', default='.')
    ap.add_argument('--config')
    ap.add_argument('--out', default='.strata/city.json')
    ap.add_argument('--max-snapshots', type=int, default=70)
    ap.add_argument('--working', action='store_true')
    ap.add_argument('--base', default='HEAD')
    ap.add_argument('--module')
    args = ap.parse_args()
    if args.max_snapshots < 2 or args.max_snapshots > 366:
        ap.error('--max-snapshots must be between 2 and 366')
    config = load_config(args.repo, args.config)
    if args.command == 'check':
        result = check(args.repo, config, args.base)
        print(json.dumps(result, indent=2))
        return 1 if result['added'] else 0
    if args.command == 'explain':
        result = analyze(Repository(args.repo).working(), config)
        if args.module:
            result = {'district': next((d for d in result['districts'] if d['id'] == args.module), None),
                      'shortcuts': [e for e in result['shortcuts'] if args.module in (result['files'][e['source']]['district'], result['files'][e['target']]['district'])],
                      'desirePaths': [d for d in result['desirePaths'] if result['files'][d['target']]['district'] == args.module]}
        print(json.dumps(result, indent=2))
        return 0
    result = scan(args.repo, config, args.max_snapshots, args.working)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, separators=(',', ':')))
    print('Wrote %s: %d files, %d snapshots, %d current shortcuts' % (out, len(result['files']), len(result['snapshots']), len(result['snapshots'][-1]['shortcuts'])))
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError) as e:
        print('strata: ' + str(e), file=sys.stderr)
        sys.exit(2)
