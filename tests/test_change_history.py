import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import history_evidence


class ChangeHistory(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Private Fixture Author')
        self.git('config', 'user.email', 'author@example.invalid')
        self.count = 0

    def git(self, *args, env=None):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], env=env,
                                       stderr=subprocess.PIPE).decode().strip()

    def write(self, path, contents):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(contents)

    def commit(self, subject='A local change'):
        self.git('add', '.')
        timestamp = '2026-01-01T10:%02d:00+00:00' % self.count
        self.git('commit', '-qm', subject, env={**os.environ, 'GIT_AUTHOR_DATE': timestamp,
                                             'GIT_COMMITTER_DATE': timestamp})
        self.count += 1
        return self.git('rev-parse', 'HEAD')

    def history(self, revisions, **kwargs):
        return history_evidence(self.repo, {'private': True}, revisions, **kwargs)

    def test_exact_change_has_real_commit_evidence_and_snapshot_indices(self):
        self.write('app.py', 'value = 1\n')
        before = self.commit('Initial source')
        self.write('app.py', 'value = 2\n')
        after = self.commit('Adjust the value')
        result = self.history([before[:12], after[:12], 'working'])
        self.assertEqual(result['skipped'], 2)
        self.assertEqual(len(result['changes']), 1)
        change = result['changes'][0]
        self.assertEqual((change['id'], change['revision'], change['beforeRevision']), (after, after, before))
        self.assertEqual((change['beforeSnapshot'], change['afterSnapshot']), (0, 1))
        self.assertEqual(change['beforeSnapshotRevision'], before)
        self.assertTrue(change['exactSnapshots'])
        self.assertEqual(change['date'], '2026-01-01')
        self.assertEqual(change['subject'], 'Adjust the value')
        self.assertEqual(change['files'], ['app.py'])
        self.assertIn('-value = 1', change['patch'])
        self.assertIn('+value = 2', change['patch'])
        self.assertFalse(change['truncated'])
        self.assertNotIn('Private Fixture Author', str(result))
        self.assertNotIn('author@example.invalid', str(result))

    def test_sparse_city_uses_actual_parent_diff_and_marks_earlier_view_approximate(self):
        revisions = []
        for number in range(4):
            self.write('app.py', 'value = %d\n' % number)
            revisions.append(self.commit())
        result = self.history([revisions[0][:12], revisions[3][:12], 'working'])
        change = result['changes'][0]
        self.assertFalse(change['exactSnapshots'])
        self.assertEqual(change['beforeRevision'], revisions[2])
        self.assertEqual(change['beforeSnapshotRevision'], revisions[0])
        self.assertEqual((change['beforeSnapshot'], change['afterSnapshot']), (0, 1))
        self.assertIn('-value = 2', change['patch'])
        self.assertNotIn('-value = 0', change['patch'])

    def test_limits_keep_most_recent_source_changes_in_chronological_order(self):
        revisions = []
        for number in range(5):
            self.write('app.py', 'value = %d\n' % number)
            revisions.append(self.commit())
        result = self.history(revisions, maximum=2)
        self.assertEqual([change['revision'] for change in result['changes']], revisions[-2:])
        self.assertEqual(result['skipped'], 3)

    def test_only_analyzed_sources_are_included_and_worktree_is_untouched(self):
        self.write('app.py', 'old = 1\n')
        before = self.commit()
        self.write('app.py', 'new = 1\n')
        self.write('README.md', 'Excluded prose')
        self.write('.env', 'EXCLUDED_SECRET=anything')
        self.write('node_modules/dependency/index.js', 'excluded = true;')
        self.write('dist/build.js', 'excluded = true;')
        (self.repo / 'linked.py').symlink_to(self.repo / 'app.py')
        after = self.commit()
        self.write('app.py', 'uncommitted = 1\n')
        self.write('untracked.py', 'not_in_history = 1\n')
        status = self.git('status', '--porcelain')
        index = hashlib.sha256((self.repo / '.git/index').read_bytes()).digest()
        result = self.history([before, after, 'working'])
        self.assertEqual(result['changes'][0]['files'], ['app.py'])
        self.assertNotIn('EXCLUDED_SECRET', str(result))
        self.assertNotIn('uncommitted', str(result))
        self.assertNotIn('not_in_history', str(result))
        self.assertEqual(self.git('status', '--porcelain'), status)
        self.assertEqual(self.git('rev-parse', 'HEAD'), after)
        self.assertEqual(hashlib.sha256((self.repo / '.git/index').read_bytes()).digest(), index)
        self.assertEqual((self.repo / 'app.py').read_text(), 'uncommitted = 1\n')

    def test_non_source_changes_and_unborn_history_produce_no_label(self):
        self.assertEqual(self.history(['working']), {'changes': [], 'skipped': 1})
        self.write('app.py', 'value = 1\n')
        before = self.commit()
        self.write('README.md', 'Only documentation changed')
        after = self.commit()
        self.assertEqual(self.history([before, after]), {'changes': [], 'skipped': 2})

    def test_revisions_reject_options_expressions_and_non_lineage_commits(self):
        self.write('app.py', 'root = 1\n')
        root = self.commit()
        self.git('checkout', '-qb', 'side')
        self.write('app.py', 'side = 1\n')
        side = self.commit()
        self.git('checkout', '-q', 'main')
        for revisions in [['--output=/tmp/invalid'], ['HEAD'], [root + '^'], ['a' * 11], [1], side, [root, side], [root, root[:12]]]:
            with self.subTest(revisions=revisions):
                with self.assertRaises(ValueError):
                    self.history(revisions)
        for maximum in [0, 51, True, 1.5]:
            with self.assertRaises(ValueError):
                self.history([root], maximum=maximum)

    def test_merge_evidence_compares_first_parent_and_excludes_branch_only_snapshots(self):
        self.write('app.py', 'value = 1\n')
        root = self.commit()
        self.git('checkout', '-qb', 'side')
        self.write('app.py', 'value = 2\n')
        side = self.commit()
        self.git('checkout', '-q', 'main')
        self.git('merge', '--no-ff', '-qm', 'Integrate source', 'side')
        merge = self.git('rev-parse', 'HEAD')
        change = self.history([root, merge])['changes'][0]
        self.assertEqual(change['beforeRevision'], root)
        self.assertIn('+value = 2', change['patch'])
        with self.assertRaisesRegex(ValueError, 'first-parent'):
            self.history([root, side, merge])

    def test_diff_helpers_are_disabled_and_path_globs_are_literal(self):
        self.write('[app].py', 'literal = 1\n')
        self.write('a.py', 'other = 1\n')
        self.write('.gitattributes', '*.py diff=repository_helper\n')
        before = self.commit()
        self.write('[app].py', 'literal = 2\n')
        after = self.commit()
        helper = self.repo / 'helper.sh'
        helper.write_text('#!/bin/sh\ntouch "' + str(self.repo / 'helper-ran') + '"\necho executed\n')
        helper.chmod(0o755)
        self.git('config', 'diff.external', str(helper))
        self.git('config', 'diff.repository_helper.command', str(helper))
        self.git('config', 'diff.repository_helper.textconv', str(helper))
        change = self.history([before, after])['changes'][0]
        self.assertIn('+literal = 2', change['patch'])
        self.assertNotIn('other = 1', change['patch'])
        self.assertFalse((self.repo / 'helper-ran').exists())

    def test_evidence_is_bounded_and_email_metadata_is_redacted(self):
        self.write('app.py', 'old = 1\n')
        before = self.commit()
        self.write('app.py', 'contact = "contact@example.invalid"\n' + '\n'.join('value_%d = "' % i + 'x' * 100 + '"' for i in range(100)))
        after = self.commit('Fix contact@example.invalid ' + 'a' * 300)
        change = self.history([before, after])['changes'][0]
        self.assertLessEqual(len(change['patch'].encode()), 6000)
        self.assertLessEqual(len(change['subject']), 250)
        self.assertTrue(change['truncated'])
        self.assertNotIn('contact@example.invalid', str(change))
        self.assertIn('[email]', str(change))

    def test_total_patch_budget_retains_the_newest_changes(self):
        revisions = []
        for number in range(24):
            self.write('app.py', 'value = "' + str(number) + 'x' * 7000 + '"\n')
            revisions.append(self.commit())
        result = self.history(revisions)
        self.assertLess(len(result['changes']), len(revisions) - 1)
        self.assertLessEqual(sum(len(change['patch'].encode()) for change in result['changes']), 120000)
        self.assertTrue(all(change['truncated'] for change in result['changes']))
        self.assertEqual(result['changes'][-1]['revision'], revisions[-1])
        self.assertEqual(result['skipped'] + len(result['changes']), len(revisions))

    def test_file_list_has_a_bound_and_marks_omitted_files(self):
        self.write('base.py', 'baseline = 1\n')
        before = self.commit()
        for index in range(105):
            self.write('app/file_%03d.py' % index, 'value = %d\n' % index)
        after = self.commit()
        change = self.history([before, after])['changes'][0]
        self.assertEqual(len(change['files']), 100)
        self.assertTrue(change['truncated'])


if __name__ == '__main__':
    unittest.main()
