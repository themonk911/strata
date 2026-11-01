"""Versioned, experimental structural index. No model fitting or future data."""
import collections
import fnmatch
import math
from pathlib import PurePosixPath

VERSION = 'strata-entropy-v2'
ANCHORS = {'rework': 0.30, 'scatter': 1.0, 'shortcuts': 0.10}
DAY = 86400

def settings(config):
    supplied = config.get('entropy', {})
    result = {'reworkDays': 14, 'scatterDays': 30, 'shortcutDays': 14, 'shortcutPremium': 2.0,
              'testOwners': supplied.get('testOwners', {})}
    for name in ('reworkDays', 'scatterDays', 'shortcutDays'):
        value = supplied.get(name, result[name])
        if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 365:
            raise ValueError('entropy.%s must be an integer between 1 and 365' % name)
        result[name] = value
    premium = supplied.get('shortcutPremium', result['shortcutPremium'])
    if not isinstance(premium, (int, float)) or not math.isfinite(premium) or not 1 <= premium <= 10:
        raise ValueError('entropy.shortcutPremium must be between 1 and 10')
    result['shortcutPremium'] = premium
    if not isinstance(result['testOwners'], dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in result['testOwners'].items()):
        raise ValueError('entropy.testOwners must map test path globs to module paths')
    return result

def metadata(config):
    params = settings(config)
    return {'version': VERSION, 'experimental': True, 'validated': False,
            'formula': 'mean(min(1, rework/0.30), scatter, min(1, weightedShortcutRatio/0.10)); null if any required signal is missing',
            'anchors': ANCHORS, 'weights': {'rework': 1, 'scatter': 1, 'shortcuts': 1},
            'anchorBasis': {
                'kind': 'heuristic', 'calibrated': False,
                'description': 'Display saturation choices, not fitted baselines, quality thresholds, or predictions. Equal weights are a design choice.',
                'rework': '30% early line removal is the chosen saturation point; it has no empirical calibration.',
                'scatter': '1.0 is the mathematical maximum of the normalized Shannon scatter over active modules.',
                'shortcuts': '10% age-weighted shortcuts is the chosen saturation point; it has no empirical calibration.'},
            'windows': params, 'omittedSignals': ['change coupling', 'leftovers', 'reversals'],
            'limitations': [
                'Experimental index; not validated as a predictor of defects or maintenance cost.',
                'First-parent commits are integration events, not a claim that every commit was a reviewed merge.',
                'Configured module boundaries are applied consistently to history; historical design intent is not inferred.',
                'Scatter uses Git changed-line counts with whitespace-only differences ignored (-w) and an equal-weight mean of changes over the recent window; its denominator is the number of active source modules at that change.',
                'Tests map to an explicit owner, a containing declared module, a unique mirrored source path, a unique source-file owner, or the single owner of all resolved production imports. Unassigned tests are excluded from scatter with explicit attribution coverage; changes without attributable lines are not scored as zero.',
                'A numeric index with partial coverage describes attributable changes and cohorts only; it is not a complete repository measurement. Unassigned rework cohorts still contribute to the repository rework ratio, but not to any district.',
                'New live shortcuts receive the configured premium for the configured window, then weight one. All resolved outgoing imports, including internal imports, form the denominator.',
                'Rework excludes the root baseline and immature cohorts; working-tree edits affect shortcuts only.',
                'Shallow history or nonmonotonic commit timestamps cannot support a complete historical index.'
            ]}

class Ownership:
    def __init__(self, modules, config, module_for, is_test):
        self.modules, self.module_for, self.is_test = modules, module_for, is_test
        self.test_owners = settings(config)['testOwners']
        self.sources = {}
        self.import_owners = {}
        self.owner_cache = {}

    def set_sources(self, sources):
        self.owner_cache.clear()
        self.sources = sources
        self.production = {p for p in sources if not self.is_test(p)}
        self.by_name = collections.defaultdict(set)
        for path in self.production:
            self.by_name[PurePosixPath(path).name].add(self.module_for(path, self.modules))

    def owner(self, path):
        if path not in self.owner_cache: self.owner_cache[path] = self._owner(path)
        return self.owner_cache[path]

    def _owner(self, path):
        if not self.is_test(path):
            return self.module_for(path, self.modules)
        explicit = {owner for pattern, owner in self.test_owners.items() if fnmatch.fnmatchcase(path, pattern)}
        if explicit:
            return next(iter(explicit)) if len(explicit) == 1 else None
        containing = [m['path'] for m in self.modules if path.startswith(m['path'] + '/')]
        if containing:
            return max(containing, key=len)
        parts = list(PurePosixPath(path).parts)
        name = parts[-1]
        if name.startswith('test_'): name = name[5:]
        if name.endswith('_test.py'): name = name[:-8] + '.py'
        for token in ('.test.', '.spec.'):
            name = name.replace(token, '.')
        mirrored = '/'.join([p for p in parts[:-1] if p not in ('test', 'tests', '__tests__', '__smoke__')] + [name])
        matches = {self.module_for(p, self.modules) for p in self.production if p == mirrored or p.endswith('/' + mirrored)}
        if len(matches) == 1: return next(iter(matches))
        names = self.by_name.get(name, set())
        if len(names) == 1: return next(iter(names))
        imports = self.import_owners.get(path, set())
        return next(iter(imports)) if len(imports) == 1 else None

    def set_imports(self, result):
        self.owner_cache.clear()
        owners = collections.defaultdict(set)
        for edge in result['imports']:
            if self.is_test(edge['source']) and not self.is_test(edge['target']):
                owners[edge['source']].add(result['files'][edge['target']]['district'])
        self.import_owners = owners

def signal(value=None, status='unavailable', **details):
    return {'value': value, 'status': status, **details}

def normalized(name, raw):
    result = dict(raw)
    value = result.get('value')
    available = result.get('status') == 'available' and isinstance(value, (int, float)) and math.isfinite(value)
    result['score'] = min(1.0, max(0.0, value / ANCHORS[name])) if available else None
    result['anchor'] = ANCHORS[name]
    return result

def aggregate(rework, scatter, shortcuts):
    signals = {name: normalized(name, raw) for name, raw in [('rework', rework), ('scatter', scatter), ('shortcuts', shortcuts)]}
    complete = all(s['score'] is not None for s in signals.values())
    partial = any(s.get('coverage') == 'partial' for s in signals.values())
    return {'version': VERSION, 'score': sum(s['score'] for s in signals.values()) / 3 if complete else None,
            'status': 'partial' if complete and partial else 'complete' if complete else 'incomplete', 'signals': signals}

def sampled_values(result, config):
    """Expose snapshot facts without pretending to have replayed full history."""
    params = settings(config)
    reason = 'Run scan --history-analysis to measure complete first-parent history.'
    import_counts = collections.Counter(result['files'][edge['source']]['district'] for edge in result['imports'])
    shortcut_counts = collections.Counter(result['files'][edge['source']]['district'] for edge in result['shortcuts'])
    def values(district=None):
        imports = len(result['imports']) if district is None else import_counts[district]
        shortcuts = len(result['shortcuts']) if district is None else shortcut_counts[district]
        missing = lambda: signal(status='history_analysis_disabled', reason=reason)
        observed = signal(status='history_analysis_disabled', reason='Shortcut age premium was not calculated. ' + reason,
                          rawRatio=shortcuts / imports if imports else 0.0, imports=imports, shortcuts=shortcuts,
                          recentShortcuts=None, premium=params['shortcutPremium'], premiumApplied=False,
                          windowDays=params['shortcutDays'])
        return aggregate(missing(), missing(), observed)
    return {'repo': values(), 'districts': {district['id']: values(district['id']) for district in result['districts']}}

def scatter_change(line_counts, owners, module_count):
    grouped = collections.Counter()
    unknown, unknown_paths = 0, []
    for path, count in line_counts.items():
        if count <= 0: continue
        owner = owners.get(path)
        if owner is None:
            unknown += count
            unknown_paths.append(path)
        else: grouped[owner] += count
    total = sum(grouped.values())
    value = 0.0
    if total and module_count > 1:
        value = -sum((count / total) * math.log(count / total) for count in grouped.values()) / math.log(module_count)
    return {'value': min(1.0, value) if total else None, 'owners': set(grouped), 'unknownLines': unknown, 'unknownPaths': sorted(unknown_paths),
            'attributedLines': total, 'changedLines': total + unknown, 'moduleCount': module_count}

class EntropyTracker:
    def __init__(self, config, ownership, rework, history_complete=True):
        self.params = settings(config)
        self.ownership, self.rework = ownership, rework
        self.history_complete = history_complete
        self.events = collections.deque()
        self.first_seen = {}
        self.latest = None
        self.timestamp = None
        self.monotonic = True
        self.previous_sources = {}

    def observe(self, sources, result, timestamp, line_counts, committed=True):
        if self.timestamp is not None and timestamp < self.timestamp:
            self.monotonic = False
        first = self.timestamp is None
        ownership_sources = {**self.previous_sources, **sources}
        self.ownership.set_sources(ownership_sources)
        previous_import_owners = self.ownership.import_owners
        self.ownership.set_imports(result)
        for path, owners in previous_import_owners.items():
            if path not in sources: self.ownership.import_owners[path] = owners
        active_modules = {self.ownership.owner(p) for p in ownership_sources if not self.ownership.is_test(p)}
        if committed:
            self.rework.observe(sources, timestamp)
            if not first and line_counts:
                owners = {p: self.ownership.owner(p) for p in line_counts}
                event = scatter_change(line_counts, owners, len(active_modules))
                if event['changedLines']:
                    self.events.append({'timestamp': timestamp, **event})
        live = {(edge['source'], edge['target']) for edge in result['shortcuts']}
        self.first_seen = {edge: self.first_seen.get(edge, timestamp) for edge in live}
        self.latest, self.timestamp = result, timestamp
        self.previous_sources = dict(sources)

    def _scatter(self, timestamp, district=None):
        cutoff = timestamp - self.params['scatterDays'] * DAY
        recent = [event for event in self.events if cutoff < event['timestamp'] <= timestamp]
        unknown = sum(event['unknownLines'] for event in recent)
        unknown_paths = sorted({path for event in recent for path in event.get('unknownPaths', [])})
        attributed = sum(event['attributedLines'] for event in recent)
        selected = [event for event in recent if event['attributedLines'] and (district is None or district in event['owners'])]
        details = {'windowDays': self.params['scatterDays'], 'changes': len(selected), 'unknownTestLines': unknown,
                   'unknownTestFiles': len(unknown_paths), 'unknownTestPaths': unknown_paths[:20],
                   'attributedLines': attributed, 'attributionRatio': attributed / (attributed + unknown) if attributed + unknown else None,
                   'coverage': 'partial' if unknown else 'complete', 'coverageScope': 'repository_window',
                   'excludedChanges': sum(not event['attributedLines'] for event in recent)}
        if not selected and unknown: return signal(status='unknown_test_ownership', **details)
        if not selected: return signal(status='no_recent_changes', **details)
        return signal(sum(event['value'] for event in selected) / len(selected), 'available', **details)

    def _shortcuts(self, timestamp, district=None):
        result = self.latest
        files = result['files']
        selected = lambda edge: district is None or files[edge['source']]['district'] == district
        imports = sum(1 for edge in result['imports'] if selected(edge))
        shortcuts = [edge for edge in result['shortcuts'] if selected(edge)]
        recent = sum(1 for edge in shortcuts if 0 <= timestamp - self.first_seen[(edge['source'], edge['target'])] < self.params['shortcutDays'] * DAY)
        weighted = len(shortcuts) + recent * (self.params['shortcutPremium'] - 1)
        return signal(weighted / imports if imports else 0.0, 'available', imports=imports, shortcuts=len(shortcuts), recentShortcuts=recent,
                      weightedShortcuts=weighted, windowDays=self.params['shortcutDays'], premium=self.params['shortcutPremium'])

    def values(self, timestamp):
        districts = [district['id'] for district in self.latest['districts']]
        if not self.history_complete or not self.monotonic or timestamp < self.timestamp:
            reason = 'shallow_history' if not self.history_complete else 'nonmonotonic_timestamps' if not self.monotonic else 'snapshot_precedes_history'
            unavailable = lambda: aggregate(signal(status=reason), signal(status=reason), signal(status=reason))
            return {'repo': unavailable(), 'districts': {district: unavailable() for district in districts}}
        rework = self.rework.signals(timestamp)
        repo = aggregate(rework['repo'], self._scatter(timestamp), self._shortcuts(timestamp))
        out = {}
        for district in districts:
            raw = rework['districts'].get(district, signal(status='no_mature_cohorts'))
            if rework.get('unknownLines', 0):
                raw = {**raw, 'coverage': 'partial', 'unassignedLines': rework['unknownLines'],
                       'reason': 'Unassigned cohorts are included in repository rework but cannot be attributed to a district.'}
            out[district] = aggregate(raw, self._scatter(timestamp, district), self._shortcuts(timestamp, district))
        return {'repo': repo, 'districts': out}

def parse_numstat(raw, include_path):
    """Parse `git log --format=%x00@@%H%x00 --numstat -z --no-renames`."""
    changes, current = {}, None
    for part in raw.split(b'\0'):
        part = part.lstrip(b'\n')
        if part.startswith(b'@@') and len(part) == 42:
            current = part[2:].decode('ascii'); changes[current] = {}
        elif part and current:
            fields = part.split(b'\t', 2)
            if len(fields) != 3: continue
            added, deleted, name = fields
            path = name.decode('utf-8', 'replace')
            if added.isdigit() and deleted.isdigit() and include_path(path):
                changes[current][path] = int(added) + int(deleted)
    return changes
