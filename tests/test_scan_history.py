import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import Repository, check, scan


class RepositoryHistory(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Private Test Author')
        self.git('config', 'user.email', 'private@example.invalid')
        self.commits = 0

    def git(self, *args, env=None):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], env=env, stderr=subprocess.PIPE).decode().strip()

    def write(self, path, content):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def commit(self, timestamp=None):
        self.git('add', '.')
        timestamp = timestamp or '2026-01-01T10:%02d:00+00:00' % self.commits
        env = {**os.environ, 'GIT_AUTHOR_DATE': timestamp, 'GIT_COMMITTER_DATE': timestamp}
        self.git('commit', '-qm', 'Private commit message', env=env)
        self.commits += 1
        return self.git('rev-parse', 'HEAD')

    def scan(self, **options):
        with contextlib.redirect_stderr(io.StringIO()):
            return scan(self.repo, {}, **options)

    def boundary(self, violating=False):
        self.write('src/billing/__init__.py', 'from .core import value\n')
        self.write('src/billing/core.py', 'value = 1\n')
        self.write('src/orders/run.py', 'from billing%s import value\n' % ('.core' if violating else ''))

    def test_same_day_commits_are_distinct_snapshots_and_sampling_keeps_endpoints(self):
        revisions = []
        for i in range(4):
            self.write('app.py', 'value = %d\n' % i)
            revisions.append(self.commit())
        data = self.scan()
        self.assertEqual([s['revision'] for s in data['snapshots']], [r[:12] for r in revisions])
        self.assertEqual(len({s['date'] for s in data['snapshots']}), 1)
        self.assertEqual(len(data['changes']), 4)
        self.assertNotIn('Private commit message', str(data))
        self.assertNotIn('Private Test Author', str(data))
        self.assertNotIn('private@example.invalid', str(data))
        sampled = self.scan(maximum=2)
        self.assertEqual([s['revision'] for s in sampled['snapshots']], [revisions[0][:12], revisions[-1][:12]])

    def test_snapshot_budget_retains_endpoints_and_reports_sampling(self):
        for i in range(4):
            self.write('a.py', 'value = %d\n' % i)
            self.write('b.py', 'import a\n')
            self.commit()
        data = self.scan(maximum_records=6)
        self.assertEqual(len(data['snapshots']), 2)
        self.assertTrue(any('record budget' in warning for warning in data['meta']['warnings']))
        self.assertEqual(data['snapshots'][-1]['revision'], data['meta']['revision'][:12])
        sampling = data['meta']['sampling']
        self.assertEqual(sampling['recordBudget'], 6)
        self.assertEqual(sampling['availableCommits'], 4)
        self.assertEqual(sampling['historicalSnapshots'], 2)
        self.assertTrue(sampling['limitedByRecordBudget'])

    def test_sampling_metadata_is_present_when_no_limit_is_reached(self):
        self.write('a.py', 'value=1\n')
        self.commit()
        result = self.scan(working=True)
        sampling = result['meta']['sampling']
        self.assertEqual(sampling['recordBudget'], 100000)
        self.assertEqual(sampling['maxSnapshots'], 70)
        self.assertEqual(sampling['availableCommits'], 1)
        self.assertEqual(sampling['historicalSnapshots'], 1)
        self.assertTrue(sampling['workingTreeIncluded'])
        self.assertFalse(sampling['sampled'])
        self.assertFalse(sampling['limitedByRecordBudget'])

    def test_default_scan_skips_history_metrics_and_opt_in_replays_mature_cohorts(self):
        self.write('base.py', 'baseline=1\n')
        self.commit('2026-01-01T00:00:00+00:00')
        self.write('new.py', 'candidate=1\n')
        self.commit('2026-01-02T00:00:00+00:00')
        (self.repo / 'new.py').unlink()
        self.commit('2026-01-03T00:00:00+00:00')
        self.write('base.py', 'baseline=1\nmaturity=1\n')
        self.commit('2026-01-21T00:00:00+00:00')
        default = self.scan(maximum=2)
        self.assertEqual(default['meta']['entropy']['analysisMode'], 'sampled')
        self.assertFalse(default['meta']['entropy']['historyAnalysis'])
        self.assertEqual(default['meta']['entropy']['analyzedCommits'], 2)
        signals = default['snapshots'][-1]['entropy']['signals']
        self.assertTrue(all(s['value'] is None and s['score'] is None for s in signals.values()))
        self.assertEqual(signals['rework']['status'], 'history_analysis_disabled')
        self.assertEqual(signals['shortcuts']['rawRatio'], 0)
        complete = self.scan(maximum=2, history_analysis=True)
        self.assertTrue(complete['meta']['entropy']['historyAnalysis'])
        self.assertEqual(complete['meta']['entropy']['analyzedCommits'], 4)
        self.assertEqual(complete['snapshots'][-1]['entropy']['signals']['rework']['value'], 1)
        self.assertEqual([s['revision'] for s in default['snapshots']], [s['revision'] for s in complete['snapshots']])
        configured = scan(self.repo, {'entropy': {'reworkDays': 7, 'reworkCohortDays': 7}}, maximum=2, history_analysis=True)
        recent = configured['snapshots'][-1]['entropy']['signals']['rework']
        self.assertIsNone(recent['value'])
        self.assertEqual((recent['windowDays'], recent['cohortDays']), (7, 7))
        self.assertEqual(configured['meta']['entropy']['reworkMethod']['cohortDays'], 7)

    def test_working_tree_heat_uses_content_and_preserves_unchanged_files(self):
        self.write('a.py', 'value = 1\n')
        self.write('b.py', 'value = 2\n')
        self.commit()
        self.write('a.py', 'value = 3\n')
        self.write('new.py', 'value = 4\n')
        data = self.scan(working=True)
        committed, current = data['snapshots']
        self.assertEqual(current['files']['a.py']['lines'], committed['files']['a.py']['lines'])
        self.assertEqual(current['files']['a.py']['changed'], current['timestamp'])
        self.assertGreater(current['files']['a.py']['changed'], committed['files']['a.py']['changed'])
        self.assertEqual(current['files']['b.py']['changed'], committed['files']['b.py']['changed'])
        self.assertEqual(current['files']['new.py']['changed'], current['timestamp'])

    def test_deleted_files_remain_in_layout_and_reintroduction_is_a_change(self):
        self.write('a.py', 'value = 1\n')
        self.write('keep.py', '')
        self.commit()
        (self.repo / 'a.py').unlink()
        self.commit()
        self.write('a.py', 'value = 1\n')
        self.commit()
        data = self.scan()
        self.assertIn('a.py', {f['path'] for f in data['files']})
        self.assertNotIn('a.py', data['snapshots'][1]['files'])
        self.assertEqual(data['snapshots'][2]['files']['a.py']['changed'], data['snapshots'][2]['timestamp'])

    def test_check_reports_added_removed_and_existing_shortcuts(self):
        self.boundary()
        self.commit()
        self.boundary(violating=True)
        result = check(self.repo, {})
        self.assertEqual((result['before'], result['after']), (0, 1))
        self.assertEqual(result['added'], [{'source': 'src/orders/run.py', 'target': 'src/billing/core.py', 'line': 1}])
        self.commit()
        self.assertEqual(check(self.repo, {})['added'], [])
        self.boundary()
        repaired = check(self.repo, {})
        self.assertEqual((repaired['before'], repaired['after']), (1, 0))
        self.assertEqual(repaired['removed'], result['added'])

    def test_check_infers_a_new_untracked_package(self):
        self.write('app.py', '')
        self.commit()
        self.boundary(violating=True)
        self.assertEqual(len(check(self.repo, {})['added']), 1)

    def test_working_reader_excludes_ignored_deleted_symlink_and_generated_files(self):
        self.write('.gitignore', 'ignored.py\n')
        self.write('tracked.py', '')
        self.write('deleted.py', '')
        self.commit()
        (self.repo / 'deleted.py').unlink()
        self.write('ignored.py', '')
        self.write('untracked.py', '')
        self.write('node_modules/dep/main.js', '')
        self.write('src/data/model.py', '')
        (self.repo / 'linked.py').symlink_to(self.repo / 'tracked.py')
        self.assertEqual(set(Repository(self.repo).working()), {'tracked.py', 'untracked.py', 'src/data/model.py'})

    def test_unborn_repo_scans_working_tree_and_checks_against_empty_baseline(self):
        self.boundary(violating=True)
        self.assertIsNone(Repository(self.repo).head())
        data = self.scan()
        self.assertIsNone(data['meta']['revision'])
        self.assertEqual([s['revision'] for s in data['snapshots']], ['working'])
        self.assertEqual(len(data['snapshots'][0]['shortcuts']), 1)
        self.assertEqual(data['changes'], [])
        self.assertEqual(len(check(self.repo, {})['added']), 1)
        with self.assertRaises(ValueError):
            check(self.repo, {}, base='missing-revision')

    def test_empty_unborn_repo_still_has_a_snapshot(self):
        data = self.scan()
        self.assertEqual(data['files'], [])
        self.assertEqual(data['snapshots'][0]['files'], {})


if __name__ == '__main__':
    unittest.main()
