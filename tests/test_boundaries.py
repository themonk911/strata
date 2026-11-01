import concurrent.futures
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import check, load_config, preview_boundaries, read_boundaries, save_boundaries


class BoundaryPolicy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        self.write('server/api.py', 'from .internal import value\n')
        self.write('server/internal.py', 'value = 1\n')
        self.write('app/main.py', 'from server.internal import value\n')
        self.modules = [{'path': 'server', 'public': ['server/api.py']}]

    def tearDown(self):
        self.temp.cleanup()

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def preview(self, modules=None):
        state = read_boundaries(self.root)
        return preview_boundaries(self.root, self.modules if modules is None else modules, state['revision'])

    def save(self, preview):
        return save_boundaries(self.root, preview['modules'], preview['revision'], preview['previewToken'])

    def test_read_keeps_inferred_suggestions_separate_from_declarations(self):
        self.write('server/__init__.py', '')
        result = read_boundaries(self.root)
        self.assertFalse(result['configured'])
        self.assertEqual(result['modules'], [])
        self.assertEqual(result['suggestions'], [{'path': 'server', 'public': ['server/__init__.py']}])
        self.assertIn('server/internal.py', result['files'])
        self.assertFalse((self.root / 'strata.config.json').exists())

    def test_configured_inferred_modules_require_explicit_acceptance(self):
        self.write('app/index.py', '')
        inferred = {'path': 'app', 'public': ['app/index.py'], 'inferred': True}
        self.write('strata.config.json', json.dumps({'modules': self.modules + [inferred]}))
        state = read_boundaries(self.root)
        self.assertEqual(state['modules'], self.modules)
        self.assertEqual(state['suggestions'], [{'path': 'app', 'public': ['app/index.py']}])
        accepted = state['modules'] + state['suggestions']
        self.save(preview_boundaries(self.root, accepted, state['revision']))
        self.assertEqual(load_config(self.root)['modules'], accepted)
        self.assertTrue(all('inferred' not in module for module in load_config(self.root)['modules']))

    def test_suggestions_respect_configured_python_source_root(self):
        self.write('strata.config.json', json.dumps({'pythonRoots': ['python']}))
        self.write('python/__init__.py', '')
        self.write('python/billing/__init__.py', '')
        self.write('python/billing/private.py', 'value=1\n')
        self.write('python/billing/internal/__init__.py', '')
        self.write('python/billing/internal/helper.py', 'value=2\n')
        state = read_boundaries(self.root)
        self.assertEqual(state['suggestions'], [{'path': 'python/billing', 'public': ['python/billing/__init__.py']}])

    def test_preview_reports_exact_imports_without_writing(self):
        before = {path.relative_to(self.root): path.read_bytes()
                  for path in self.root.rglob('*.py')}
        result = self.preview()
        edge = {'source': 'app/main.py', 'target': 'server/internal.py', 'line': 1}
        self.assertEqual(result['shortcuts'], [edge])
        self.assertEqual(result['added'], [edge])
        self.assertEqual(result['counts'], {'before': 0, 'after': 1, 'added': 1, 'removed': 0})
        self.assertEqual(result['warnings'], [])
        self.assertFalse((self.root / 'strata.config.json').exists())
        self.assertEqual(before, {path.relative_to(self.root): path.read_bytes()
                                  for path in self.root.rglob('*.py')})

    def test_preview_preserves_existing_exemptions_and_resolution(self):
        config = {'modules': [], 'pythonRoots': [''], 'allow': ['app/*']}
        self.write('strata.config.json', json.dumps(config))
        self.assertEqual(self.preview()['shortcuts'], [])
        self.assertEqual(load_config(self.root), config)

    def test_save_preserves_other_config_and_rechecks_new_imports(self):
        config = {'name': 'Fixture', 'private': True, 'pythonRoots': [''],
                  'aliases': {'@/': 'app/'}, 'allow': [], 'customMetadata': {'keep': True},
                  'modules': []}
        self.write('strata.config.json', json.dumps(config))
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Boundary Test',
                        '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], check=True)
        preview = self.preview()
        result = self.save(preview)
        self.assertTrue(result['saved'])
        self.assertNotEqual(result['revision'], preview['revision'])
        self.assertEqual(load_config(self.root), {**config, 'modules': self.modules})
        # Declaring a gate reports existing debt, while hook checks still enforce new edges.
        self.assertEqual(check(self.root, load_config(self.root))['added'], [])
        self.write('app/new.py', 'from server.internal import value\n')
        self.assertEqual(check(self.root, load_config(self.root))['added'], [
            {'source': 'app/new.py', 'target': 'server/internal.py', 'line': 1}])
        self.assertFalse((self.root / 'strata.config.json.lock').exists())
        self.assertEqual(list(self.root.glob('.strata.config-*.tmp')), [])

    def test_opening_a_module_reports_removed_violations(self):
        self.save(self.preview())
        result = self.preview([])
        self.assertEqual(result['shortcuts'], [])
        self.assertEqual(len(result['removed']), 1)
        self.save(result)
        self.assertTrue(read_boundaries(self.root)['configured'])
        self.assertEqual(load_config(self.root)['modules'], [])

    def test_empty_gates_close_module_and_globs_use_scanner_semantics(self):
        self.write('app/main.py', 'from server.api import value\n')
        closed = self.preview([{'path': 'server', 'public': []}])
        self.assertEqual(len(closed['shortcuts']), 1)
        opened = self.preview([{'path': 'server', 'public': ['server/*.py']}])
        self.assertEqual(opened['shortcuts'], [])

    def test_invalid_and_ambiguous_modules_are_rejected(self):
        invalid = [None, {}, ['server'], [{'path': '../server', 'public': []}],
                   [{'path': './server', 'public': []}], [{'path': 'server/', 'public': []}],
                   [{'path': 'server', 'public': 'server/api.py'}],
                   [{'path': 'server', 'public': ['../api.py']}],
                   [{'path': 'server', 'public': ['app/main.py']}],
                   [{'path': 'server', 'public': ['server/missing.py']}],
                   [{'path': 'absent', 'public': []}], self.modules * 2]
        revision = read_boundaries(self.root)['revision']
        for modules in invalid:
            with self.subTest(modules=modules), self.assertRaises(ValueError):
                preview_boundaries(self.root, modules, revision)
        self.assertFalse((self.root / 'strata.config.json').exists())

    def test_nested_module_gates_cannot_be_declared_on_parent(self):
        self.write('server/nested/api.py', '')
        self.write('server/nested/private.py', '')
        modules = [{'path': 'server', 'public': ['server/nested/api.py']},
                   {'path': 'server/nested', 'public': []}]
        with self.assertRaisesRegex(ValueError, 'another declared module'):
            self.preview(modules)
        modules[0]['public'] = ['server/api.py']
        modules[1]['public'] = ['server/nested/api.py']
        self.assertEqual(self.preview(modules)['modules'], modules)

    def test_missing_or_changed_preview_cannot_be_saved(self):
        preview = self.preview()
        for token in (None, '', 'invented'):
            with self.subTest(token=token), self.assertRaises(ValueError):
                save_boundaries(self.root, self.modules, preview['revision'], token)
        with self.assertRaisesRegex(ValueError, 'proposed rules changed'):
            save_boundaries(self.root, [], preview['revision'], preview['previewToken'])
        self.assertFalse((self.root / 'strata.config.json').exists())

    def test_source_edit_addition_and_deletion_invalidate_preview(self):
        for operation in ('edit', 'add', 'delete'):
            with self.subTest(operation=operation):
                preview = self.preview()
                if operation == 'edit':
                    self.write('app/main.py', 'from server.api import value\n')
                elif operation == 'add':
                    self.write('app/new.py', 'from server.internal import value\n')
                else:
                    (self.root / 'app/new.py').unlink()
                with self.assertRaisesRegex(ValueError, 'Source files or proposed rules changed'):
                    self.save(preview)
        self.assertFalse((self.root / 'strata.config.json').exists())

    def test_external_config_edit_is_preserved(self):
        preview = self.preview()
        raw = '{"private": false, "name": "External edit"}\n'
        self.write('strata.config.json', raw)
        with self.assertRaisesRegex(ValueError, 'Boundary rules changed'):
            self.save(preview)
        with self.assertRaisesRegex(ValueError, 'Boundary rules changed'):
            preview_boundaries(self.root, self.modules, preview['revision'])
        self.assertEqual((self.root / 'strata.config.json').read_text(), raw)

    def test_invalid_syntax_is_visible_and_cannot_be_saved(self):
        self.write('app/broken.py', 'def broken(')
        preview = self.preview()
        self.assertTrue(preview['warnings'])
        with self.assertRaisesRegex(ValueError, 'incomplete analysis'):
            self.save(preview)
        self.assertFalse((self.root / 'strata.config.json').exists())

    def test_swift_gate_coverage_is_incomplete_and_cannot_be_saved(self):
        self.write('Models/Record.swift', 'struct Record {}\n')
        self.write('Views/Screen.swift', 'let record: Record? = nil\n')
        preview = self.preview([{'path': 'Models', 'public': []}])
        self.assertTrue(any('Swift' in warning and 'unavailable' in warning for warning in preview['warnings']))
        self.assertEqual(preview['shortcuts'], [])
        with self.assertRaisesRegex(ValueError, 'incomplete analysis'):
            self.save(preview)
        self.assertFalse((self.root / 'strata.config.json').exists())
        # Native source does not prevent declaring supported Python gates.
        self.assertTrue(self.save(self.preview())['saved'])

    def test_invalid_json_and_config_symlink_are_not_overwritten(self):
        self.write('strata.config.json', '{broken')
        with self.assertRaisesRegex(ValueError, 'not valid JSON'):
            read_boundaries(self.root)
        (self.root / 'strata.config.json').unlink()
        self.write('other.json', '{}')
        (self.root / 'strata.config.json').symlink_to(self.root / 'other.json')
        with self.assertRaisesRegex(ValueError, 'symbolic link'):
            read_boundaries(self.root)
        self.assertEqual((self.root / 'other.json').read_text(), '{}')

    def test_overlapping_saves_cannot_silently_overwrite_each_other(self):
        candidates = [self.preview(), self.preview([])]
        def save_one(candidate):
            try:
                return self.save(candidate)
            except ValueError as error:
                return str(error)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save_one, candidates))
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertFalse((self.root / 'strata.config.json.lock').exists())

    def test_save_lock_blocks_another_process_and_recovers_after_a_crash(self):
        preview = self.preview()
        # A separate writer holds the same OS lock as a save in progress.
        # Killing it must release the lock without creating a repository file.
        holder = subprocess.Popen([sys.executable, '-I', '-c', '''
import fcntl, os, sys
directory = os.open(sys.argv[1], os.O_RDONLY)
fcntl.flock(directory, fcntl.LOCK_EX)
print('locked', flush=True)
sys.stdin.read()
''', str(self.root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), 'locked')
            with self.assertRaisesRegex(ValueError, 'being saved'):
                self.save(preview)
            self.assertFalse((self.root / 'strata.config.json').exists())
            holder.kill()
            holder.communicate(timeout=5)
            self.assertTrue(self.save(preview)['saved'])
            self.assertEqual(load_config(self.root)['modules'], self.modules)
            self.assertFalse((self.root / 'strata.config.json.lock').exists())
        finally:
            if holder.poll() is None:
                holder.kill()
            holder.communicate(timeout=5)

    def test_subdirectory_uses_repository_root(self):
        state = read_boundaries(self.root / 'app')
        preview = preview_boundaries(self.root / 'app', self.modules, state['revision'])
        save_boundaries(self.root / 'app', self.modules, state['revision'], preview['previewToken'])
        self.assertEqual(load_config(self.root)['modules'], self.modules)
        self.assertFalse((self.root / 'app/strata.config.json').exists())

    def test_external_rules_require_import_choice_and_leave_source_unchanged(self):
        external = self.root / 'external.json'
        raw = json.dumps({'name': 'External', 'private': True, 'modules': self.modules})
        external.write_text(raw)
        state = read_boundaries(self.root, config=external)
        self.assertTrue(state['importRequired'])
        self.assertEqual(state['sourceConfig'], str(external))
        self.assertEqual(state['targetConfig'], str(self.root / 'strata.config.json'))
        preview = preview_boundaries(self.root, state['modules'], state['revision'], config=external)
        with self.assertRaisesRegex(ValueError, 'Confirm importing'):
            save_boundaries(self.root, state['modules'], state['revision'], preview['previewToken'], config=external)
        self.assertFalse((self.root / 'strata.config.json').exists())
        saved = save_boundaries(self.root, state['modules'], state['revision'], preview['previewToken'],
                                config=external, import_config=True)
        self.assertEqual(load_config(self.root), json.loads(raw))
        self.assertEqual(external.read_text(), raw)
        self.assertEqual(saved['targetConfig'], state['targetConfig'])
        self.assertFalse(saved['importRequired'])
        self.assertEqual(saved['revision'], read_boundaries(self.root)['revision'])

    def test_external_preview_uses_exact_settings_saved_to_existing_destination(self):
        self.write('strata.config.json', json.dumps({'private': False, 'allow': ['app/*'],
                                                    'pythonRoots': [''], 'modules': []}))
        external = self.root / 'external.json'
        external.write_text(json.dumps({'name': 'External', 'private': True, 'allow': [],
                                        'aliases': {'@/': 'app/'}, 'modules': self.modules}))
        state = read_boundaries(self.root, config=external)
        preview = preview_boundaries(self.root, state['modules'], state['revision'], config=external)
        self.assertEqual(preview['shortcuts'], [])
        self.assertEqual(preview['counts'], {'before': 1, 'after': 0, 'added': 0, 'removed': 1})
        save_boundaries(self.root, state['modules'], state['revision'], preview['previewToken'],
                        config=external, import_config=True)
        self.assertEqual(load_config(self.root), {'name': 'External', 'private': False,
                         'allow': ['app/*'], 'pythonRoots': [''], 'aliases': {'@/': 'app/'}, 'modules': self.modules})

    def test_external_preview_compares_active_policy_with_imported_settings(self):
        self.write('strata.config.json', json.dumps({'allow': [], 'modules': []}))
        external = self.root / 'external.json'
        external.write_text(json.dumps({'allow': ['app/*'], 'modules': self.modules}))
        state = read_boundaries(self.root, config=external)
        preview = preview_boundaries(self.root, state['modules'], state['revision'], config=external)
        self.assertEqual(preview['counts'], {'before': 0, 'after': 1, 'added': 1, 'removed': 0})
        self.assertEqual(preview['added'], [{'source': 'app/main.py', 'target': 'server/internal.py', 'line': 1}])
        save_boundaries(self.root, state['modules'], state['revision'], preview['previewToken'],
                        config=external, import_config=True)
        self.assertEqual(self.preview()['shortcuts'], preview['shortcuts'])

    def test_external_source_and_destination_edits_both_invalidate_import(self):
        external = self.root / 'external.json'
        external.write_text(json.dumps({'modules': self.modules}))
        state = read_boundaries(self.root, config=external)
        preview = preview_boundaries(self.root, state['modules'], state['revision'], config=external)
        external.write_text(json.dumps({'modules': self.modules, 'private': False}))
        with self.assertRaisesRegex(ValueError, 'Boundary rules changed'):
            save_boundaries(self.root, state['modules'], state['revision'], preview['previewToken'],
                            config=external, import_config=True)
        state = read_boundaries(self.root, config=external)
        preview = preview_boundaries(self.root, state['modules'], state['revision'], config=external)
        raw = '{"name": "Destination changed"}\n'
        self.write('strata.config.json', raw)
        with self.assertRaisesRegex(ValueError, 'Boundary rules changed'):
            save_boundaries(self.root, state['modules'], state['revision'], preview['previewToken'],
                            config=external, import_config=True)
        self.assertEqual((self.root / 'strata.config.json').read_text(), raw)

    def test_explicit_canonical_source_does_not_require_import(self):
        state = read_boundaries(self.root, config=self.root / 'strata.config.json')
        self.assertFalse(state['importRequired'])


if __name__ == '__main__':
    unittest.main()
