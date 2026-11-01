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

if __package__:
    from .swift import swift_references
else:
    from swift import swift_references

CODE = re.compile(r'\.(py|ts|tsx|mts|cts|js|jsx|mjs|cjs|swift)$')
SKIP = re.compile(r'(^|/)(node_modules|dist|build|vendor|\.git|\.venv|\.agents|\.codex)(/|$)|\.d\.[cm]?ts$')
TEST = re.compile(r'(^|/)(tests?|__tests__|__smoke__)/|(^|/)test_[^/]+\.py$|\.(test|spec)\.[^.]+$|(^|/)[^/]*Tests/|Tests\.swift$')
JS_CACHE = {}
PY_IMPORT_CACHE = {}

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

def infer_modules(paths, roots=('', 'src')):
    """Infer outer package gates, leaving nested packages inside their owner."""
    modules = {}
    counts = collections.Counter(parent.as_posix() for p in paths for parent in PurePosixPath(p).parents)
    for p in sorted(paths):
        if not p.endswith(('/__init__.py', '/index.ts', '/index.tsx', '/index.mts', '/index.cts', '/index.js', '/index.jsx', '/index.mjs', '/index.cjs')):
            continue
        folder = p.rsplit('/', 1)[0]
        if TEST.search(p):
            continue
        # Source roots are containers, even when they have an entry point.
        # Keep feature packages under src visible without walling every nested
        # implementation package within a feature.
        if folder in roots or PurePosixPath(folder).name == 'src':
            continue
        if counts[folder] >= 2:
            module = modules.setdefault(folder, {'path': folder, 'public': [], 'inferred': True})
            module['public'].append(p)
    return [module for folder, module in modules.items()
            if not any(parent.as_posix() in modules for parent in PurePosixPath(folder).parents)]

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
        roots = config.get('pythonRoots', ['', 'src'])
        package = p.split('/')[:-1]
        root = max((r for r in roots if r and p.startswith(r + '/')), key=len, default='')
        package_depth = len(package) - (len(root.split('/')) if root else 0)
        if text not in PY_IMPORT_CACHE:
            if len(PY_IMPORT_CACHE) > 20000: PY_IMPORT_CACHE.clear()
            try:
                PY_IMPORT_CACHE[text] = [node for node in ast.walk(ast.parse(text)) if isinstance(node, (ast.Import, ast.ImportFrom))]
            except SyntaxError:
                PY_IMPORT_CACHE[text] = None
        nodes = PY_IMPORT_CACHE[text]
        if nodes is None:
            return [], ['Python syntax could not be parsed: %s (scanner Python %d.%d; use PYTHON with a version that supports the repository syntax).' % (p, sys.version_info.major, sys.version_info.minor)]
        for n in nodes:
            if isinstance(n, ast.Import):
                for alias in n.names:
                    hit = resolve_py(alias.name.split('.'), paths, roots)
                    if hit:
                        out.append((hit, n.lineno))
            elif isinstance(n, ast.ImportFrom):
                # Relative imports belong to this file's package, even when
                # another source root contains a package with the same name.
                if n.level > package_depth:
                    continue
                prefix = package[:len(package) - n.level + 1] if n.level else []
                parts = prefix + (n.module.split('.') if n.module else [])
                search_roots = [''] if n.level else roots
                base = resolve_py(parts, paths, search_roots)
                # A directly imported child module bypasses __init__, even if the
                # package also re-exports a symbol with the same name.
                for alias in n.names:
                    child = resolve_py(parts + [alias.name], paths, search_roots)
                    hit = child or base
                    if hit:
                        out.append((hit, n.lineno))
    elif not p.endswith('.swift'):
        parsed_js = parsed_js if parsed_js is not None else parse_js_sources({p: text})[p]
        if parsed_js['invalid']:
            warnings.append('JavaScript/TypeScript syntax could not be fully parsed: ' + p)
        aliases = config.get('aliases', {})
        for spec, line in parsed_js['imports']:
            if spec.startswith('.'):
                base = os.path.normpath(str(PurePosixPath(p).parent / spec)).replace(os.sep, '/')
            else:
                alias = next((a for a in aliases if spec.startswith(a)), None)
                if not alias:
                    continue
                base = aliases[alias] + spec[len(alias):]
            substitutions = {'.js': ('.ts', '.tsx', '.js', '.jsx'), '.jsx': ('.tsx', '.ts', '.jsx', '.js'),
                             '.mjs': ('.mts', '.mjs'), '.cjs': ('.cts', '.cjs')}
            extensions = substitutions.get(PurePosixPath(base).suffix)
            if extensions:
                candidates = [base.rsplit('.', 1)[0] + extension for extension in extensions]
            else:
                candidates = [base + extension for extension in ('', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.mts', '/index.cts', '/index.js', '/index.jsx', '/index.mjs', '/index.cjs')]
            hit = next((candidate for candidate in candidates if candidate in paths), None)
            if hit:
                out.append((hit, line))
    return sorted(set((target, line) for target, line in out if target != p)), warnings

def analyze(sources, config, modules=None, importers=None, import_cache=None):
    sources = {p: text for p, text in sources.items() if safe_path(p) and CODE.search(p) and not SKIP.search(p)}
    paths = set(sources)
    modules = modules if modules is not None else config['modules'] if 'modules' in config else infer_modules(paths, config.get('pythonRoots', ('', 'src')))
    module_map = {m['path']: m for m in modules}
    files = {p: {'path': p, 'district': module_for(p, modules), 'lines': len(t.splitlines()), 'gate': False} for p, t in sources.items()}
    for p, f in files.items():
        mod = module_map.get(f['district'])
        f['gate'] = bool(mod and any(fnmatch.fnmatchcase(p, pattern) for pattern in mod.get('public', [])))
    edges, shortcuts, warnings = [], [], []
    selected = sources if importers is None else {p: text for p, text in sources.items() if p in importers}
    parsed_js = parse_js_sources({p: text for p, text in selected.items() if not p.endswith(('.py', '.swift')) and (import_cache is None or p not in import_cache)})
    # Swift names are heuristic relationships, never resolved imports or gates.
    # Resolve against every current declaration, even for unchanged importers.
    references, swift_warnings = swift_references({p: text for p, text in sources.items() if p.endswith('.swift')}, importers)
    warnings.extend(swift_warnings)
    swift_modules = sorted({file['district'] for path, file in files.items()
                            if path.endswith('.swift') and file['district'] in module_map})
    if swift_modules:
        warnings.append('Swift import and boundary checks are unavailable for modules: ' + ', '.join(swift_modules) + '.')
    for p, text in selected.items():
        if import_cache is not None and p in import_cache:
            imports, failed = import_cache[p]
        else:
            imports, failed = extract_imports(p, text, paths, config, parsed_js.get(p))
            if import_cache is not None: import_cache[p] = (imports, failed)
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
    outgoing_counts = collections.Counter(files[e['source']]['district'] for e in edges)
    breach_counts = collections.Counter(files[e['source']]['district'] for e in shortcuts)
    incoming_counts = collections.Counter(files[e['target']]['district'] for e in shortcuts)
    districts = []
    for group in sorted({f['district'] for f in files.values()}):
        outgoing, breaches, incoming = outgoing_counts[group], breach_counts[group], incoming_counts[group]
        mod = module_map.get(group, {})
        districts.append({'id': group, 'name': group.split('/')[-1], 'walled': group in module_map,
                          'inferred': mod.get('inferred', False), 'public': mod.get('public', []),
                          'outgoing': outgoing, 'shortcuts': breaches, 'incoming': incoming,
                          'ratio': breaches / outgoing if outgoing else 0})
    targets = collections.defaultdict(list)
    for e in shortcuts:
        targets[e['target']].append(e['source'])
    desires = [{'target': p, 'sources': sorted(set(src)), 'districts': sorted({files[s]['district'] for s in src})}
               for p, src in targets.items() if len({files[s]['district'] for s in src}) >= 2]
    desires.sort(key=lambda d: (-len(d['districts']), -len(d['sources']), d['target']))
    return {'files': files, 'districts': districts, 'imports': edges, 'inferredReferences': references,
            'shortcuts': shortcuts, 'desirePaths': desires, 'warnings': warnings}

class Repository:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.blobs = {}

    def head(self):
        """Return HEAD, or None for a valid checkout with an unborn branch."""
        command = ['git', '-C', str(self.path)]
        head = subprocess.run(command + ['rev-parse', '--verify', '--quiet', 'HEAD'], capture_output=True)
        if head.returncode == 0:
            return head.stdout.decode().strip()
        branch = subprocess.run(command + ['symbolic-ref', '--quiet', 'HEAD'], capture_output=True)
        if branch.returncode == 0:
            exists = subprocess.run(command + ['show-ref', '--verify', '--quiet', branch.stdout.decode().strip()], capture_output=True)
            if exists.returncode == 1:
                return None
        # Preserve the useful Git error for invalid repositories or broken refs.
        return git(self.path, 'rev-parse', '--verify', 'HEAD').decode().strip()

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

def scan(repo, config, maximum=70, working=False, maximum_records=100000, history_analysis=False):
    if __package__:
        from .entropy import EntropyTracker, Ownership, metadata as entropy_metadata, parse_numstat, sampled_values, settings as entropy_settings
        from .rework import ReworkTracker, REWORK_METHOD
    else:
        from entropy import EntropyTracker, Ownership, metadata as entropy_metadata, parse_numstat, sampled_values, settings as entropy_settings
        from rework import ReworkTracker, REWORK_METHOD
    if maximum < 2 or maximum > 366:
        raise ValueError('maximum snapshots must be between 2 and 366')
    if maximum_records < 1:
        raise ValueError('maximum snapshot records must be positive')
    if not isinstance(history_analysis, bool):
        raise ValueError('history_analysis must be a boolean')
    repo = Repository(repo)
    head = repo.head()
    rows = git(repo.path, 'log', '--first-parent', '--reverse', '--format=%H %ct', head).decode().splitlines() if head else []
    commits = [(sha, int(timestamp)) for sha, timestamp in (row.split() for row in rows)]
    head_sources = repo.tree(head) if head else {}
    # An unborn checkout still has a useful city: its current source files.
    working_sources = repo.working() if working or head is None else None
    modules = config.get('modules', infer_modules(set(head_sources) | set(working_sources or {}), config.get('pythonRoots', ('', 'src'))))
    head_result = analyze(head_sources, config, modules)
    records_per_snapshot = max(1, len(head_result['files']) + len(head_result['imports']) + len(head_result['inferredReferences']))
    budget_limit = max(2, maximum_records // records_per_snapshot - (working_sources is not None))
    limit = min(maximum, budget_limit)
    sampled = commits
    if len(commits) > limit:
        sampled = [commits[round(i * (len(commits) - 1) / (limit - 1))] for i in range(limit)]
    include_path = lambda p: safe_path(p) and CODE.search(p) and not SKIP.search(p)
    shallow = git(repo.path, 'rev-parse', '--is-shallow-repository').strip() == b'true' if head else False
    entropy = None
    if history_analysis:
        ownership = Ownership(modules, config, module_for, lambda p: bool(TEST.search(p)))
        params = entropy_settings(config)
        rework = ReworkTracker(ownership.owner, window_days=params['reworkDays'], cohort_days=params['reworkCohortDays'])
        entropy = EntropyTracker(config, ownership, rework, history_complete=not shallow)
    numstats = parse_numstat(git(repo.path, 'log', '--first-parent', '--reverse', '--root', '--diff-merges=first-parent',
                                 '--format=%x00@@%H%x00', '--numstat', '-z', '-w', '--no-renames', head), include_path) if head and history_analysis else {}
    sampled_shas = {sha for sha, _ in sampled}
    snapshots = []
    all_files, previous, last_changed = {}, {}, {}
    previous_sources, import_cache = {}, {}
    warnings = set()
    if len(commits) > limit and budget_limit < maximum:
        warnings.add('History sampled at %d commits using a %d file/import record budget estimated from HEAD; first and latest commits are retained.' % (limit, maximum_records))
    observed = commits if history_analysis else sampled
    for i, (sha, timestamp) in enumerate(observed):
        date = dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).strftime('%Y-%m-%d')
        sources = repo.tree(sha)
        if set(sources) != set(previous_sources): import_cache.clear()
        else:
            for path, source in sources.items():
                if previous_sources.get(path) != source: import_cache.pop(path, None)
        result = head_result if sha == head else analyze(sources, config, modules, import_cache=import_cache)
        if entropy is not None:
            entropy.observe(sources, result, timestamp, numstats.get(sha, {}))
        previous_sources = sources
        if sha not in sampled_shas: continue
        entropy_values = entropy.values(timestamp) if entropy is not None else sampled_values(result, config)
        result['entropy'] = entropy_values['repo']
        for district in result['districts']: district['entropy'] = entropy_values['districts'][district['id']]
        warnings.update(result.pop('warnings'))
        digests = {}
        for p, f in result['files'].items():
            digest = hashlib.sha256(sources[p].encode()).digest()
            if previous.get(p) != digest:
                last_changed[p] = timestamp
            f['changed'] = last_changed[p]
            digests[p] = digest
            all_files[p] = {k: f[k] for k in ('path', 'district', 'gate')}
        previous = digests
        snapshots.append({'date': date, 'timestamp': timestamp, 'revision': sha[:12], **result})
        print('Scanning %s %s (%d/%d analyzed commits; %d/%d views)' % (date, sha[:12], i + 1, len(observed), len(snapshots), len(sampled)), file=sys.stderr)
    if working_sources is not None:
        result = analyze(working_sources, config, modules)
        warnings.update(result.pop('warnings'))
        timestamp = int(dt.datetime.now(dt.timezone.utc).timestamp())
        if entropy is not None:
            entropy.observe(working_sources, result, timestamp, {}, committed=False)
        entropy_values = entropy.values(timestamp) if entropy is not None else sampled_values(result, config)
        result['entropy'] = entropy_values['repo']
        for district in result['districts']: district['entropy'] = entropy_values['districts'][district['id']]
        for p, f in result['files'].items():
            digest = hashlib.sha256(working_sources[p].encode()).digest()
            f['changed'] = timestamp if previous.get(p) != digest else last_changed[p]
            all_files[p] = {k: f[k] for k in ('path', 'district', 'gate')}
        snapshots.append({'date': 'Working tree', 'timestamp': timestamp, 'revision': 'working', **result})
    # Strip every commit message, author name and email. Only time and changed
    # source paths survive. One dot is one commit, not a claim of agent identity.
    log = git(repo.path, 'log', '--no-merges', '--reverse', '--format=@@%ct', '--name-only', head).decode(errors='replace') if head else ''
    changes = []
    for block in log.split('@@')[1:]:
        lines = block.splitlines()
        touched = [p for p in lines[1:] if p in all_files]
        if touched:
            changes.append({'time': int(lines[0]), 'files': touched})
    params = entropy_settings(config)
    rework_days, cohort_days = params['reworkDays'], params['reworkCohortDays']
    rework_method = {**REWORK_METHOD, 'windowDays': rework_days, 'cohortDays': cohort_days,
                     'definition': ('Of nonblank source lines whose %d-day survival window completed in the last %d days, '
                                    'the share removed within %d days of introduction.') % (rework_days, cohort_days, rework_days)}
    entropy_meta = {**entropy_metadata(config), 'reworkMethod': rework_method, 'firstParentCommits': len(commits),
                    'historyComplete': not shallow, 'historyAnalysis': history_analysis,
                    'analysisMode': 'full_history' if history_analysis else 'sampled', 'analyzedCommits': len(observed)}
    sampling = {'method': 'evenly_spaced_first_parent_commits', 'availableCommits': len(commits),
                'maxSnapshots': maximum, 'recordBudget': maximum_records,
                'estimatedRecordsPerSnapshot': records_per_snapshot, 'snapshotLimit': limit,
                'historicalSnapshots': len(sampled), 'workingTreeIncluded': working_sources is not None,
                'sampled': len(sampled) < len(commits),
                'limitedByRecordBudget': budget_limit < min(maximum, len(commits))}
    return {'schemaVersion': 1, 'meta': {'name': config.get('name', repo.path.name), 'private': config.get('private', True),
            'revision': head, 'entropy': entropy_meta, 'sampling': sampling, 'gatePolicy': 'declared' if 'modules' in config and not any(m.get('inferred') for m in modules) else 'inferred from current package entry points',
            'coverage': 'Python and JS/TS imports use ASTs. Swift files contribute size, activity, rework, scatter and change diffs; type-name references are inferred for layout only, not resolved imports or gate checks. Swift build targets, type checking, macros and conditional compilation are not resolved. Computed imports, external packages and runtime resolution may be missed.',
            'limitations': ['Boundary pressure is not a validated entropy or defect predictor.',
                           'Current gate definitions are applied to all snapshots; past intent is not inferred.',
                           'Heat means changed since the previous sampled snapshot, not exact edit time.',
                           'History sampling uses a HEAD-based file/import record budget, not a hard byte limit; at least the first and latest commits are retained.'],
            'warnings': sorted(warnings)}, 'files': list(all_files.values()), 'snapshots': snapshots, 'changes': changes}

def check(repo, config, base='HEAD'):
    r = Repository(repo)
    before_sources = {} if base == 'HEAD' and r.head() is None else r.tree(base)
    after_sources = r.working()
    modules = config.get('modules', infer_modules(set(before_sources) | set(after_sources), config.get('pythonRoots', ('', 'src'))))
    before = analyze(before_sources, config, modules)
    after = analyze(after_sources, config, modules)
    key = lambda e: (e['source'], e['target'])
    old, new = {key(e) for e in before['shortcuts']}, {key(e) for e in after['shortcuts']}
    if any(p.endswith('.swift') for p in before_sources.keys() | after_sources.keys()):
        after['warnings'].append('Swift import and boundary checks are unavailable; inferred type references are for layout only.')
    return {'base': base, 'before': len(old), 'after': len(new),
            'added': [e for e in after['shortcuts'] if key(e) not in old],
            'removed': [e for e in before['shortcuts'] if key(e) not in new],
            'warnings': sorted(set(before['warnings'] + after['warnings']))}

def main():
    ap = argparse.ArgumentParser(description='Strata: a read-only city of your git history.')
    ap.add_argument('command', nargs='?', choices=['scan', 'check', 'explain'], default='scan')
    ap.add_argument('--repo', default='.')
    ap.add_argument('--config')
    ap.add_argument('--out', default='.strata/city.json')
    ap.add_argument('--max-snapshots', type=int, default=70)
    ap.add_argument('--max-snapshot-records', type=int, default=100000,
                    help='Approximate total file/import record budget, estimated from HEAD (default: 100000).')
    ap.add_argument('--working', action='store_true')
    ap.add_argument('--history-analysis', action='store_true',
                    help='Replay every first-parent commit for rework, scatter, and shortcut-age signals (slower).')
    ap.add_argument('--base', default='HEAD')
    ap.add_argument('--module')
    args = ap.parse_args()
    if args.max_snapshots < 2 or args.max_snapshots > 366:
        ap.error('--max-snapshots must be between 2 and 366')
    if args.max_snapshot_records < 1:
        ap.error('--max-snapshot-records must be positive')
    config = load_config(args.repo, args.config)
    if args.command == 'check':
        result = check(args.repo, config, args.base)
        print(json.dumps(result, indent=2))
        return 2 if result['warnings'] else 1 if result['added'] else 0
    if args.command == 'explain':
        result = analyze(Repository(args.repo).working(), config)
        if args.module:
            result = {'district': next((d for d in result['districts'] if d['id'] == args.module), None),
                      'shortcuts': [e for e in result['shortcuts'] if args.module in (result['files'][e['source']]['district'], result['files'][e['target']]['district'])],
                      'desirePaths': [d for d in result['desirePaths'] if result['files'][d['target']]['district'] == args.module]}
        print(json.dumps(result, indent=2))
        return 0
    result = scan(args.repo, config, args.max_snapshots, args.working, args.max_snapshot_records, args.history_analysis)
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
