import contextlib
import io
import math
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from core import scan
from core.entropy import Ownership, EntropyTracker, aggregate, metadata, parse_numstat, sampled_values, scatter_change, signal, settings
from core.rework import ReworkTracker
from core.scan import module_for, TEST, analyze

DAY = 86400
MODULES = [{'path': 'a', 'public': ['a/__init__.py']}, {'path': 'b', 'public': ['b/__init__.py']}]
CONFIG = {'modules': MODULES, 'pythonRoots': ['']}

class MatureRework:
    def observe(self, sources, timestamp): pass
    def signals(self, timestamp):
        return {'repo': signal(0.15, 'available'), 'districts': {d: signal(0.15, 'available') for d in ['a', 'b']}}

class Entropy(unittest.TestCase):
    def owner(self, config=CONFIG):
        return Ownership(MODULES, config, module_for, lambda p: bool(TEST.search(p)))

    def test_fixed_anchors_and_missing_signal_never_reweight_the_index(self):
        value = aggregate(signal(.15, 'available'), signal(.5, 'available'), signal(.05, 'available'))
        self.assertEqual(value['score'], .5)
        missing = aggregate(signal(status='no_mature_cohorts'), signal(.5, 'available'), signal(.05, 'available'))
        self.assertIsNone(missing['score'])
        self.assertEqual(missing['status'], 'incomplete')
        self.assertEqual(metadata({})['omittedSignals'], ['change coupling', 'leftovers', 'reversals'])

    def test_anchor_basis_discloses_uncalibrated_scales(self):
        model = metadata({})
        self.assertEqual(model['version'], 'strata-entropy-v3')
        self.assertEqual(model['anchorBasis']['kind'], 'heuristic')
        self.assertFalse(model['anchorBasis']['calibrated'])
        self.assertTrue(all(name in model['anchorBasis'] for name in model['anchors']))

    def test_recent_cohort_window_is_configured_separately_from_survival(self):
        params = settings({'entropy': {'reworkDays': 7, 'reworkCohortDays': 21}})
        self.assertEqual((params['reworkDays'], params['reworkCohortDays']), (7, 21))
        for invalid in [0, -1, True, 1.5, 366, '14']:
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, 'reworkCohortDays'):
                    settings({'entropy': {'reworkCohortDays': invalid}})

    def test_sampled_values_keep_raw_shortcuts_separate_from_unmeasured_age_premium(self):
        sources = {'a/__init__.py': '', 'a/private.py': 'v=1', 'b/run.py': 'from a.private import v'}
        values = sampled_values(analyze(sources, CONFIG), CONFIG)
        for measured in [values['repo'], *values['districts'].values()]:
            self.assertIsNone(measured['score'])
            self.assertTrue(all(s['value'] is None and s['score'] is None for s in measured['signals'].values()))
        shortcut = values['repo']['signals']['shortcuts']
        self.assertEqual(shortcut['rawRatio'], 1)
        self.assertEqual((shortcut['imports'], shortcut['shortcuts']), (1, 1))
        self.assertIsNone(shortcut['recentShortcuts'])
        self.assertFalse(shortcut['premiumApplied'])
        self.assertEqual(shortcut['status'], 'history_analysis_disabled')

    def test_scatter_normalizes_against_modules_that_exist_at_the_change(self):
        event = scatter_change({'a/x.py': 2, 'b/y.py': 2}, {'a/x.py': 'a', 'b/y.py': 'b'}, 4)
        self.assertAlmostEqual(event['value'], .5)
        self.assertEqual(scatter_change({'a/x.py': 100}, {'a/x.py': 'a'}, 4)['value'], 0)

    def test_scatter_weights_changes_equally_and_expires_the_recent_window(self):
        tracker = EntropyTracker(CONFIG, self.owner(), MatureRework())
        sources = {'a/x.py': 'x=1', 'b/y.py': 'y=1'}
        result = analyze(sources, CONFIG)
        tracker.observe(sources, result, 0, {})
        tracker.observe(sources, result, DAY, {'a/x.py': 1})
        tracker.observe(sources, result, 2 * DAY, {'a/x.py': 1000, 'b/y.py': 1000})
        self.assertEqual(tracker.values(2 * DAY)['repo']['signals']['scatter']['value'], .5)
        self.assertEqual(tracker.values(40 * DAY)['repo']['signals']['scatter']['status'], 'no_recent_changes')

    def test_tests_follow_unique_source_owner_or_explicit_mapping(self):
        owner = self.owner()
        owner.set_sources({'a/engine.py': '', 'b/run.py': '', 'tests/test_engine.py': ''})
        self.assertEqual(owner.owner('tests/test_engine.py'), 'a')
        owner.set_sources({'a/engine.py': '', 'b/engine.py': ''})
        self.assertIsNone(owner.owner('tests/test_engine.py'))
        owner = self.owner({**CONFIG, 'entropy': {'testOwners': {'tests/test_engine.py': 'b'}}})
        owner.set_sources({'a/engine.py': '', 'b/engine.py': ''})
        self.assertEqual(owner.owner('tests/test_engine.py'), 'b')

    def test_unassigned_tests_preserve_attributed_scatter_with_partial_coverage(self):
        tracker = EntropyTracker(CONFIG, self.owner(), MatureRework())
        sources = {'a/x.py': 'x=1', 'b/y.py': 'y=1', 'tests/test_missing.py': ''}
        result = analyze(sources, CONFIG)
        tracker.observe(sources, result, 0, {})
        tracker.observe(sources, result, DAY, {'tests/test_missing.py': 7, 'a/x.py': 2})
        values = tracker.values(DAY)
        value = values['repo']
        self.assertIsNotNone(value['score'])
        self.assertEqual(value['status'], 'partial')
        scatter = value['signals']['scatter']
        self.assertEqual(scatter['status'], 'available')
        self.assertEqual(scatter['value'], 0)
        self.assertEqual(scatter['unknownTestLines'], 7)
        self.assertEqual(scatter['attributedLines'], 2)
        self.assertAlmostEqual(scatter['attributionRatio'], 2 / 9)
        self.assertEqual(scatter['coverage'], 'partial')
        self.assertEqual(values['districts']['a']['status'], 'partial')

    def test_unassigned_only_changes_are_excluded_instead_of_scored_zero(self):
        tracker = EntropyTracker(CONFIG, self.owner(), MatureRework())
        sources = {'a/x.py': 'x=1', 'b/y.py': 'y=1', 'tests/test_missing.py': ''}
        result = analyze(sources, CONFIG)
        tracker.observe(sources, result, 0, {})
        tracker.observe(sources, result, DAY, {'tests/test_missing.py': 7})
        unknown = tracker.values(DAY)['repo']
        self.assertIsNone(unknown['score'])
        self.assertIsNone(unknown['signals']['scatter']['value'])
        self.assertEqual(unknown['signals']['scatter']['status'], 'unknown_test_ownership')
        tracker.observe(sources, result, 2 * DAY, {'a/x.py': 2, 'b/y.py': 2})
        scatter = tracker.values(2 * DAY)['repo']['signals']['scatter']
        self.assertEqual(scatter['value'], 1)
        self.assertEqual(scatter['changes'], 1)
        self.assertEqual(scatter['excludedChanges'], 1)
        self.assertEqual(scatter['unknownTestPaths'], ['tests/test_missing.py'])

    def test_unassigned_rework_keeps_known_district_cohorts_and_repository_totals(self):
        owner = self.owner()
        tracker = EntropyTracker(CONFIG, owner, ReworkTracker(owner.owner))
        sources = {'a/x.py': 'baseline=0', 'b/y.py': 'baseline=0', 'tests/test_missing.py': ''}
        tracker.observe(sources, analyze(sources, CONFIG), 0, {})
        sources = {**sources, 'a/x.py': 'baseline=0\nknown=1', 'tests/test_missing.py': 'unowned=2'}
        tracker.observe(sources, analyze(sources, CONFIG), DAY, {'a/x.py': 1, 'tests/test_missing.py': 1})
        sources = {**sources, 'tests/test_missing.py': ''}
        tracker.observe(sources, analyze(sources, CONFIG), 2 * DAY, {'tests/test_missing.py': 1})
        measured = tracker.values(16 * DAY)
        self.assertEqual(measured['repo']['signals']['rework']['value'], .5)
        district = measured['districts']['a']
        self.assertEqual(district['signals']['rework']['value'], 0)
        self.assertEqual(district['signals']['rework']['eligibleLines'], 1)
        self.assertEqual(district['signals']['rework']['unassignedLines'], 1)
        self.assertEqual(district['status'], 'partial')
        self.assertIsNone(measured['districts']['b']['signals']['rework']['value'])

    def test_test_owner_can_follow_unambiguous_resolved_production_imports(self):
        owner = self.owner()
        sources = {'a/core.py': 'v=1', 'b/core.py': 'v=1', 'tests/test_behavior.py': 'from a.core import v'}
        owner.set_sources(sources); owner.set_imports(analyze(sources, CONFIG))
        self.assertEqual(owner.owner('tests/test_behavior.py'), 'a')
        sources['tests/test_behavior.py'] += '\nfrom b.core import v'
        owner.set_sources(sources); owner.set_imports(analyze(sources, CONFIG))
        self.assertIsNone(owner.owner('tests/test_behavior.py'))

    def test_deleted_test_keeps_its_previous_unambiguous_import_owner(self):
        tracker = EntropyTracker(CONFIG, self.owner(), MatureRework())
        sources = {'a/core.py': 'v=1', 'b/core.py': 'v=1', 'tests/test_behavior.py': 'from a.core import v'}
        tracker.observe(sources, analyze(sources, CONFIG), 0, {})
        del sources['tests/test_behavior.py']
        tracker.observe(sources, analyze(sources, CONFIG), DAY, {'tests/test_behavior.py': 1})
        self.assertEqual(tracker.values(DAY)['repo']['signals']['scatter']['unknownTestLines'], 0)
        self.assertEqual(tracker.values(DAY)['districts']['a']['signals']['scatter']['value'], 0)

    def test_earlier_as_of_query_cannot_return_future_shortcuts(self):
        tracker = EntropyTracker(CONFIG, self.owner(), MatureRework())
        sources = {'a/core.py': 'v=1'}
        tracker.observe(sources, analyze(sources, CONFIG), DAY, {})
        value = tracker.values(0)['repo']
        self.assertIsNone(value['score'])
        self.assertTrue(all(s['value'] is None for s in value['signals'].values()))
        self.assertEqual(value['signals']['shortcuts']['status'], 'snapshot_precedes_history')

    def test_recent_shortcut_premium_expires_and_reintroduced_edges_are_new(self):
        tracker = EntropyTracker(CONFIG, self.owner(), MatureRework())
        baseline = {'a/__init__.py': '', 'a/private.py': 'v=1', 'b/__init__.py': '', 'b/run.py': 'from a import v'}
        sources = {**baseline, 'b/run.py': 'from a.private import v'}
        tracker.observe(baseline, analyze(baseline, CONFIG), 0, {})
        tracker.observe(sources, analyze(sources, CONFIG), DAY, {'b/run.py': 2})
        self.assertEqual(tracker.values(DAY)['repo']['signals']['shortcuts']['value'], 2)
        self.assertEqual(tracker.values(15 * DAY)['repo']['signals']['shortcuts']['value'], 1)
        tracker.observe(baseline, analyze(baseline, CONFIG), 16 * DAY, {'b/run.py': 2})
        tracker.observe(sources, analyze(sources, CONFIG), 17 * DAY, {'b/run.py': 2})
        self.assertEqual(tracker.values(18 * DAY)['repo']['signals']['shortcuts']['recentShortcuts'], 1)

    def test_shallow_or_nonmonotonic_history_is_unavailable(self):
        sources = {'a/x.py': 'x=1'}
        for shallow in [True, False]:
            tracker = EntropyTracker(CONFIG, self.owner(), MatureRework(), history_complete=not shallow)
            tracker.observe(sources, analyze(sources, CONFIG), 2 * DAY, {})
            if not shallow: tracker.observe(sources, analyze(sources, CONFIG), DAY, {'a/x.py': 1})
            self.assertIsNone(tracker.values(2 * DAY)['repo']['score'])

    def test_numstat_preserves_spaces_and_omits_binary_files(self):
        sha = 'a' * 40
        result = parse_numstat(('\0@@' + sha + '\0\n2\t3\ta/file name.py\0-\t-\tphoto.png\0').encode(), lambda p: p.endswith('.py'))
        self.assertEqual(result, {sha: {'a/file name.py': 5}})

    def test_full_history_ages_shortcuts_even_when_views_are_sampled(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            def git(*args, env=None):
                return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.PIPE, env=env)
            git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
            def commit(day, private):
                for path, text in {'a/__init__.py': '', 'a/private.py': 'v=1\n', 'b/__init__.py': '', 'b/run.py': 'from a%s import v\n' % ('.private' if private else ''), 'a/keep.py': 'day=%d\n' % day}.items():
                    target = repo / path; target.parent.mkdir(exist_ok=True); target.write_text(text)
                git('add', '.')
                date = '2026-01-%02dT00:00:00+00:00' % (day + 1)
                git('commit', '-qm', 'fixture', env={**os.environ, 'GIT_AUTHOR_DATE': date, 'GIT_COMMITTER_DATE': date})
            for day, private in [(0, False), (1, True), (2, False), (10, True), (20, True)]: commit(day, private)
            with contextlib.redirect_stderr(io.StringIO()):
                sampled = scan(repo, CONFIG, maximum=2, history_analysis=True)
                complete = scan(repo, CONFIG, maximum=70, history_analysis=True)
            latest = sampled['snapshots'][-1]['entropy']
            self.assertEqual(latest, complete['snapshots'][-1]['entropy'])
            self.assertEqual(latest['signals']['shortcuts']['recentShortcuts'], 1)
            self.assertEqual(latest['status'], 'complete')
            self.assertIsNone(sampled['snapshots'][0]['entropy']['score'])

if __name__ == '__main__': unittest.main()
