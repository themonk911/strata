import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import Repository, check


class CommitChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], stderr=subprocess.PIPE).decode().strip()

    def write(self, path, content):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def boundary(self, private=False):
        self.write('billing/__init__.py', 'from .core import value\n')
        self.write('billing/core.py', 'value = 1\n')
        self.write('consumer.py', 'from billing%s import value\n' % ('.core' if private else ''))

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')

    def cli(self, *args):
        return subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'core/scan.py'),
                               'check', '--repo', str(self.repo), *args], capture_output=True, text=True)

    def test_missing_explicit_config_fails_instead_of_inferring_gates(self):
        self.boundary()
        self.commit()
        missing = self.repo / 'missing.json'
        for value in (str(missing), ''):
            result = self.cli('--config', value)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertEqual(result.stdout, '')
            self.assertIn('does not exist: ' + value, result.stderr)

    def test_repository_without_config_still_checks_inferred_gates(self):
        self.boundary()
        self.commit()
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['added'], [])

    def test_staged_shortcut_blocks_even_when_unstaged_repair_is_good_and_reads_do_not_mutate(self):
        self.boundary()
        self.commit()
        self.boundary(private=True)
        self.git('add', 'consumer.py')
        self.boundary()
        index = (self.repo / '.git/index').read_bytes()
        head = self.git('rev-parse', 'HEAD')
        source = (self.repo / 'consumer.py').read_bytes()
        result = check(self.repo, {}, staged=True)
        self.assertEqual(result['source'], 'index')
        self.assertEqual(result['added'], [{'source': 'consumer.py', 'target': 'billing/core.py', 'line': 1}])
        self.assertEqual(check(self.repo, {})['added'], [])
        cli = self.cli('--staged')
        self.assertEqual(cli.returncode, 1, cli.stderr)
        self.assertEqual(json.loads(cli.stdout)['added'], result['added'])
        self.assertEqual((self.repo / '.git/index').read_bytes(), index)
        self.assertEqual(self.git('rev-parse', 'HEAD'), head)
        self.assertEqual((self.repo / 'consumer.py').read_bytes(), source)

    def test_unstaged_and_untracked_shortcuts_do_not_block_clean_index(self):
        self.boundary()
        self.commit()
        self.write('consumer.py', 'from billing import value\nprint(value)\n')
        self.git('add', 'consumer.py')
        self.boundary(private=True)
        self.write('untracked.py', 'from billing.core import value\n')
        self.assertEqual(check(self.repo, {}, staged=True)['added'], [])
        self.assertEqual(self.cli('--staged').returncode, 0)
        self.assertEqual(len(check(self.repo, {})['added']), 2)

    def test_existing_shortcut_is_debt_but_new_importer_is_blocked(self):
        self.boundary(private=True)
        self.commit()
        self.write('consumer.py', 'from billing.core import value\nprint(value)\n')
        self.git('add', 'consumer.py')
        existing = check(self.repo, {}, staged=True)
        self.assertEqual((existing['before'], existing['after'], existing['added']), (1, 1, []))
        self.write('second.py', 'from billing.core import value\n')
        self.git('add', 'second.py')
        self.assertEqual([edge['source'] for edge in check(self.repo, {}, staged=True)['added']], ['second.py'])

    def linked_worktree(self):
        """Check out a committed 'feature' branch outside the main working tree."""
        parent = tempfile.TemporaryDirectory()
        self.addCleanup(parent.cleanup)
        linked = Path(parent.name) / 'linked'
        self.git('worktree', 'add', '-qb', 'feature', str(linked))
        (linked / 'feature.py').write_text('value = 2\n')
        subprocess.check_call(['git', '-C', str(linked), 'add', 'feature.py'])
        subprocess.check_call(['git', '-C', str(linked), 'commit', '-qm', 'feature'])
        return linked

    def install_merge_check(self):
        hook = self.repo / '.git/hooks/commit-msg'
        hook.parent.mkdir(exist_ok=True)
        scanner = Path(__file__).resolve().parents[1] / 'core/scan.py'
        hook.write_text('#!/bin/sh\nexec %s %s check --repo "$(git rev-parse --show-toplevel)" --staged\n'
                        % (shlex.quote(sys.executable), shlex.quote(str(scanner))))
        hook.chmod(0o755)

    def merge(self, checkout, other):
        return subprocess.run(['git', '-C', str(checkout), 'merge', '--no-edit', other], capture_output=True, text=True)

    def test_automatic_merge_passes_a_hook_with_only_the_other_parents_shortcuts(self):
        self.boundary()
        self.commit()
        branch = self.git('branch', '--show-current')
        linked = self.linked_worktree()
        self.write('main.py', 'from billing.core import value\n')
        self.commit()
        self.install_merge_check()
        merged = self.merge(linked, branch)
        self.assertEqual(merged.returncode, 0, merged.stdout + merged.stderr)
        parents = subprocess.check_output(['git', '-C', str(linked), 'log', '-1', '--format=%P']).decode().split()
        self.assertEqual(len(parents), 2)

    def test_automatic_merge_hook_blocks_a_shortcut_no_parent_has(self):
        self.write('billing/__init__.py', 'value = 1\n')
        self.write('other.py', 'value = 1\n')
        self.commit()
        branch = self.git('branch', '--show-current')
        self.git('checkout', '-qb', 'target')
        self.write('billing/core.py', 'value = 1\n')
        self.commit()
        self.git('checkout', '-q', branch)
        # The import only resolves once the merge brings in its target.
        self.write('consumer.py', 'from billing.core import value\n')
        self.commit()
        head = self.git('rev-parse', 'HEAD')
        self.install_merge_check()
        merged = self.merge(self.repo, 'target')
        self.assertEqual(merged.returncode, 1, merged.stdout + merged.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD'), head)
        self.assertEqual([edge['source'] for edge in check(self.repo, {}, staged=True)['added']], ['consumer.py'])

    def test_merge_keeps_other_parents_shortcuts_as_debt_but_blocks_new_ones(self):
        self.boundary()
        self.commit()
        branch = self.git('branch', '--show-current')
        linked = self.linked_worktree()
        self.write('main.py', 'from billing.core import value\n')
        self.commit()
        for checkout, other in [(self.repo, 'feature'), (linked, branch)]:
            with self.subTest(checkout=checkout.name):
                subprocess.check_call(['git', '-C', str(checkout), 'merge', '-q', '--no-ff', '--no-commit', other])
                merged = check(checkout, {}, staged=True)
                self.assertEqual(merged['added'], [])
                self.assertEqual(len(merged['merged']), 1)
                (checkout / 'resolved.py').write_text('from billing.core import value\n')
                subprocess.check_call(['git', '-C', str(checkout), 'add', 'resolved.py'])
                self.assertEqual([edge['source'] for edge in check(checkout, {}, staged=True)['added']], ['resolved.py'])
                subprocess.check_call(['git', '-C', str(checkout), 'merge', '--abort'])

    def test_initial_commit_compares_index_to_empty_baseline(self):
        self.boundary(private=True)
        self.assertEqual(check(self.repo, {}, staged=True)['added'], [])
        self.git('add', '.')
        result = check(self.repo, {}, staged=True)
        self.assertEqual((result['before'], result['after']), (0, 1))
        self.assertEqual(len(result['added']), 1)

    def test_new_inferred_gate_uses_same_boundaries_for_base_and_index(self):
        self.write('billing/core.py', 'value = 1\n')
        self.write('consumer.py', 'from billing.core import value\n')
        self.commit()
        self.write('billing/__init__.py', 'from .core import value\n')
        self.git('add', 'billing/__init__.py')
        result = check(self.repo, {}, staged=True)
        self.assertEqual((result['before'], result['after'], result['added']), (1, 1, []))

    def test_explicit_scope_reports_swift_exclusion_and_keeps_supported_parse_failures(self):
        self.boundary()
        self.write('Screen.swift', 'struct Screen {}\n')
        self.commit()
        self.assertTrue(any('Swift' in warning for warning in check(self.repo, {}, staged=True)['warnings']))
        languages = ['python', 'javascript', 'typescript']
        scoped = check(self.repo, {}, staged=True, languages=languages)
        self.assertEqual(scoped['warnings'], [])
        self.assertEqual(scoped['scope'], {'languages': languages, 'excluded': {'swift': 1}})
        self.assertEqual(self.cli('--staged', '--languages', *languages).returncode, 0)
        for filename, invalid in [('broken.py', 'def broken('), ('broken.ts', 'export const broken = ;')]:
            with self.subTest(filename=filename):
                self.write(filename, invalid)
                self.git('add', filename)
                self.write(filename, '')
                result = self.cli('--staged', '--languages', *languages)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertTrue(any(filename in warning for warning in json.loads(result.stdout)['warnings']))
                self.git('reset', '-q', 'HEAD', '--', filename)

    def test_language_scope_preserves_cross_language_import_resolution(self):
        self.write('billing/index.ts', 'export { value } from "./core";\n')
        self.write('billing/core.ts', 'export const value = 1;\n')
        self.commit()
        self.write('consumer.js', 'import { value } from "./billing/core";\n')
        self.git('add', 'consumer.js')
        result = check(self.repo, {}, staged=True, languages=['javascript'])
        self.assertEqual(result['added'], [{'source': 'consumer.js', 'target': 'billing/core.ts', 'line': 1}])
        self.assertEqual(result['scope']['excluded'], {'typescript': 2})

    def test_unmerged_non_source_entry_fails_explicitly(self):
        self.boundary()
        self.write('README.md', 'base\n')
        self.commit()
        branch = self.git('branch', '--show-current')
        self.git('checkout', '-qb', 'other')
        self.write('README.md', 'other\n')
        self.commit()
        self.git('checkout', branch)
        self.write('README.md', 'current\n')
        self.commit()
        merge = subprocess.run(['git', '-C', str(self.repo), 'merge', 'other'], capture_output=True)
        self.assertEqual(merge.returncode, 1)
        with self.assertRaisesRegex(ValueError, 'unmerged Git index: README.md'):
            check(self.repo, {}, staged=True)
        cli = self.cli('--staged')
        self.assertEqual(cli.returncode, 2)
        self.assertIn('unmerged', cli.stderr)

    def test_index_omits_intent_to_add_symlinks_deleted_and_generated_sources(self):
        self.boundary()
        self.write('deleted.py', 'value = 2\n')
        self.commit()
        self.git('rm', 'deleted.py')
        self.write('intent.py', 'from billing.core import value\n')
        self.git('add', '-N', 'intent.py')
        self.write('node_modules/dep/main.js', '')
        self.git('add', 'node_modules/dep/main.js')
        (self.repo / 'linked.py').symlink_to(self.repo / 'billing/core.py')
        self.git('add', 'linked.py')
        self.assertEqual(set(Repository(self.repo).index()), {'billing/__init__.py', 'billing/core.py', 'consumer.py'})
        self.assertEqual(check(self.repo, {}, staged=True)['added'], [])


if __name__ == '__main__':
    unittest.main()
