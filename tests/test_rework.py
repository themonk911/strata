import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from core.rework import ReworkTracker


DAY = 86400


class ReworkTests(unittest.TestCase):
    def tracker(self):
        return ReworkTracker(lambda path: path.split('/')[0])

    def test_only_mature_cohorts_enter_both_counts(self):
        tracker = self.tracker()
        tracker.observe({'a/seed.py': 'baseline = 1\n'}, 0)
        tracker.observe({'a/seed.py': 'baseline = 1\nnew = 2\nstays = 3\n'}, DAY)
        tracker.observe({'a/seed.py': 'baseline = 1\nstays = 3\n'}, 2 * DAY)
        early = tracker.signals(14 * DAY)['repo']
        self.assertIsNone(early['value'])
        self.assertEqual(early['status'], 'no_mature_cohorts')
        self.assertEqual(early['eligibleLines'], 0)
        mature = tracker.signals(15 * DAY)['repo']
        self.assertEqual(mature['eligibleLines'], 2)
        self.assertEqual(mature['deletedLines'], 1)
        self.assertEqual(mature['value'], .5)

    def test_recent_rework_is_not_diluted_by_old_surviving_lines(self):
        tracker = self.tracker()
        old = {'a/stable.py': ''.join('old_%d = %d\n' % (i, i) for i in range(100))}
        tracker.observe({}, 0)
        tracker.observe(old, DAY)
        self.assertEqual(tracker.signals(15 * DAY)['repo']['value'], 0)
        tracker.observe({**old, 'a/recent.py': 'removed_soon = True\n'}, 30 * DAY)
        tracker.observe(old, 31 * DAY)
        result = tracker.signals(44 * DAY)
        self.assertEqual(result['repo']['eligibleLines'], 1)
        self.assertEqual(result['repo']['deletedLines'], 1)
        self.assertEqual(result['repo']['value'], 1)
        self.assertEqual(result['districts']['a']['value'], 1)

    def test_expired_cohorts_leave_missing_value_instead_of_zero(self):
        tracker = self.tracker()
        tracker.observe({}, 0)
        tracker.observe({'a/new.py': 'gone = True\n'}, DAY)
        tracker.observe({}, 2 * DAY)
        self.assertEqual(tracker.signals(29 * DAY - 1)['repo']['value'], 1)
        result = tracker.signals(29 * DAY)
        for signal in (result['repo'], result['districts']['a']):
            self.assertEqual(signal['eligibleLines'], 0)
            self.assertEqual(signal['deletedLines'], 0)
            self.assertEqual(signal['status'], 'no_mature_cohorts')
            self.assertIsNone(signal['value'])

    def test_cohort_window_excludes_old_boundary_and_includes_maturity_boundary(self):
        tracker = ReworkTracker(lambda path: 'a', cohort_days=3)
        tracker.observe({}, 0)
        sources = {}
        for day in (13, 14, 16, 17):
            sources['a/day_%d.py' % day] = 'born_on_%d = True\n' % day
            tracker.observe(sources.copy(), day * DAY)
        result = tracker.signals(30 * DAY)['repo']
        self.assertEqual(result['eligibleLines'], 2)
        self.assertEqual(result['value'], 0)
        self.assertEqual(result['windowDays'], 14)
        self.assertEqual(result['cohortDays'], 3)
        self.assertEqual(result['cohortStartExclusive'], 13 * DAY)
        self.assertEqual(result['cohortEndInclusive'], 16 * DAY)

    def test_survival_horizon_and_cohort_span_are_independent(self):
        tracker = ReworkTracker(lambda path: 'a', window_days=4, cohort_days=2)
        tracker.observe({}, 0)
        tracker.observe({'a/new.py': 'gone = True\n'}, DAY)
        tracker.observe({}, 4 * DAY)
        self.assertIsNone(tracker.signals(4 * DAY)['repo']['value'])
        self.assertEqual(tracker.signals(5 * DAY)['repo']['value'], 1)
        self.assertEqual(tracker.signals(6 * DAY)['repo']['value'], 1)
        self.assertIsNone(tracker.signals(7 * DAY)['repo']['value'])

    def test_window_lengths_must_be_positive_finite_numbers(self):
        for field in ('window_days', 'cohort_days'):
            for value in (0, -1, float('inf'), float('nan'), '14', None, True):
                with self.subTest(field=field, value=value):
                    with self.assertRaisesRegex(ValueError, field):
                        ReworkTracker(lambda path: 'a', **{field: value})

    def test_late_deletion_is_not_early_rework(self):
        tracker = self.tracker()
        tracker.observe({}, 0)
        tracker.observe({'a/new.py': 'survives = True\n'}, DAY)
        tracker.observe({}, 16 * DAY)
        result = tracker.signals(20 * DAY)['repo']
        self.assertEqual(result['eligibleLines'], 1)
        self.assertEqual(result['deletedLines'], 0)
        self.assertEqual(result['value'], 0)

    def test_deletion_at_exact_window_boundary_counts(self):
        tracker = self.tracker()
        tracker.observe({}, 0)
        tracker.observe({'a/new.py': 'one = 1\n'}, DAY)
        tracker.observe({}, 15 * DAY)
        self.assertEqual(tracker.signals(15 * DAY)['repo']['value'], 1)

    def test_moves_whitespace_and_reordering_survive_with_birth_owner(self):
        tracker = self.tracker()
        tracker.observe({}, 0)
        tracker.observe({'a/source.py': 'first = 1\nsecond = 2\n\n'}, DAY)
        tracker.observe({'b/moved.py': '\tsecond=2\n    first=1\n'}, 2 * DAY)
        result = tracker.signals(16 * DAY)
        self.assertEqual(result['repo']['eligibleLines'], 2)
        self.assertEqual(result['repo']['deletedLines'], 0)
        self.assertEqual(result['districts']['a']['value'], 0)
        self.assertNotIn('b', result['districts'])
        tracker.observe({'b/moved.py': 'second=2\n'}, 3 * DAY)
        result = tracker.signals(16 * DAY)
        self.assertEqual(result['districts']['a']['value'], .5)

    def test_copy_is_new_code_and_does_not_steal_source_cohort(self):
        tracker = self.tracker()
        tracker.observe({'a/source.py': 'same = 1\n'}, 0)
        tracker.observe({'a/source.py': 'same = 1\n', 'b/copy.py': 'same = 1\n'}, DAY)
        tracker.observe({'a/source.py': 'same = 1\n'}, 2 * DAY)
        result = tracker.signals(15 * DAY)
        self.assertEqual(result['repo']['value'], 1)
        self.assertEqual(result['districts']['b']['eligibleLines'], 1)

    def test_baseline_and_blank_lines_never_become_cohorts(self):
        tracker = self.tracker()
        tracker.observe({'a/source.py': 'baseline=1\n\n'}, 0)
        tracker.observe({'a/source.py': '\n\t\n'}, DAY)
        result = tracker.signals(20 * DAY)['repo']
        self.assertEqual(result['eligibleLines'], 0)
        self.assertIsNone(result['value'])

    def test_future_observations_cannot_leak_into_earlier_snapshot(self):
        tracker = self.tracker()
        tracker.observe({}, 0)
        tracker.observe({'a/new.py': 'line=1\n'}, DAY)
        tracker.observe({}, 2 * DAY)
        result = tracker.signals(DAY)['repo']
        self.assertEqual(result['status'], 'unavailable')
        self.assertIsNone(result['value'])

    def test_nonmonotonic_commit_dates_are_explicitly_unavailable(self):
        tracker = self.tracker()
        tracker.observe({}, 2 * DAY)
        tracker.observe({'a/new.py': 'line=1\n'}, DAY)
        result = tracker.signals(20 * DAY)['repo']
        self.assertEqual(result['status'], 'unavailable')
        self.assertIn('backwards', result['reason'])

    def test_unknown_owner_is_preserved_without_invalidating_repo_counts(self):
        tracker = ReworkTracker(lambda path: None if path.startswith('tests/') else 'app')
        tracker.observe({}, 0)
        tracker.observe({'tests/ambiguous.py': 'test=1\n', 'app/new.py': 'new=1\n'}, DAY)
        tracker.observe({'app/new.py': 'new=1\n'}, 2 * DAY)
        result = tracker.signals(15 * DAY)
        self.assertEqual(result['repo']['value'], .5)
        self.assertEqual(result['unknownLines'], 1)
        self.assertEqual(result['unknownDeletedLines'], 1)
        self.assertEqual(result['unassigned']['value'], 1)
        self.assertEqual(result['districts']['app']['value'], 0)

    def test_young_district_remains_incomplete(self):
        tracker = self.tracker()
        tracker.observe({}, 0)
        tracker.observe({'a/new.py': 'a=1\n'}, DAY)
        tracker.observe({'a/new.py': 'a=1\n', 'b/new.py': 'b=1\n'}, 15 * DAY)
        result = tracker.signals(15 * DAY)
        self.assertEqual(result['districts']['a']['value'], 0)
        self.assertIsNone(result['districts']['b']['value'])
        self.assertEqual(result['repo']['eligibleLines'], 1)

    def test_first_parent_replay_excludes_branch_iterations_and_worktree(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)

            def git(*args, day=0):
                stamp = '%d +0000' % (1700000000 + day * DAY)
                env = dict(os.environ, GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
                           GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid',
                           GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)
                result = subprocess.run(['git', '-C', directory, *args], env=env, capture_output=True, check=True)
                return result.stdout.decode()

            def commit(path, text, day):
                (repo / path).write_text(text)
                git('add', path)
                git('commit', '-m', 'fixture', day=day)

            git('init', '-b', 'main')
            commit('baseline.py', 'baseline=1\n', 0)
            commit('stable.py', 'stable=1\n', 1)
            git('checkout', '-b', 'feature')
            commit('feature.py', 'candidate=1\n', 2)
            commit('feature.py', 'candidate=2\n', 3)
            commit('feature.py', 'candidate=3\n', 4)
            git('checkout', 'main')
            git('merge', '--no-ff', 'feature', '-m', 'integration', day=5)
            commit('feature.py', 'candidate=4\n', 6)
            git('commit', '--allow-empty', '-m', 'maturity', day=20)
            (repo / 'feature.py').write_text('uncommitted=999\n')
            tracker = ReworkTracker(lambda path: 'app')
            rows = git('log', '--first-parent', '--reverse', '--format=%H %ct').splitlines()
            for row in rows:
                sha, timestamp = row.split()
                paths = git('ls-tree', '-r', '--name-only', sha).splitlines()
                tracker.observe({path: git('show', sha + ':' + path) for path in paths}, int(timestamp))
            result = tracker.signals(int(timestamp))['repo']
            self.assertEqual(len(rows), 5)
            self.assertEqual(result['eligibleLines'], 3)
            self.assertEqual(result['deletedLines'], 1)
            self.assertAlmostEqual(result['value'], 1 / 3)


if __name__ == '__main__':
    unittest.main()
