import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import analyze

class Boundaries(unittest.TestCase):
    def imports(self, path, text, paths, config):
        result = analyze({p: text if p == path else '' for p in paths}, config)
        return [(e['target'], e['line']) for e in result['imports']], result['warnings']

    def setUp(self):
        self.config = {'pythonRoots': [''], 'modules': [
            {'path': 'app/basis', 'public': ['app/basis/__init__.py']},
            {'path': 'app/tax', 'public': ['app/tax/__init__.py']}], 'allow': ['app/routes/*']}
        self.files = {'app/basis/__init__.py': 'from .engine import calculate\n',
                      'app/basis/engine.py': 'def calculate(): return 1\n',
                      'app/tax/__init__.py': '', 'app/tax/report.py': ''}

    def test_gate_and_internal_import_are_healthy(self):
        self.files['app/tax/report.py'] = 'from app.basis import calculate\n'
        self.assertEqual(analyze(self.files, self.config)['shortcuts'], [])

    def test_direct_private_import_is_a_shortcut(self):
        self.files['app/tax/report.py'] = 'from app.basis.engine import calculate\n'
        result = analyze(self.files, self.config)
        self.assertEqual(result['shortcuts'], [{'source': 'app/tax/report.py', 'target': 'app/basis/engine.py', 'line': 1}])
        self.assertEqual(next(d for d in result['districts'] if d['id'] == 'app/tax')['ratio'], 1)

    def test_child_module_import_cannot_hide_behind_package(self):
        self.files['app/tax/report.py'] = 'from app.basis import engine\n'
        self.assertEqual(len(analyze(self.files, self.config)['shortcuts']), 1)

    def test_tests_and_declared_adapters_are_exempt(self):
        self.files['tests/test_report.py'] = 'from app.basis.engine import calculate\n'
        self.files['app/routes/api.py'] = 'from app.basis.engine import calculate\n'
        self.assertEqual(analyze(self.files, self.config)['shortcuts'], [])

    def test_desire_path_requires_distinct_districts(self):
        self.files['app/tax/report.py'] = 'from app.basis.engine import calculate\n'
        self.files['app/reports/month.py'] = 'from app.basis.engine import calculate\n'
        result = analyze(self.files, self.config)
        self.assertEqual(len(result['desirePaths']), 1)

    def test_relative_python_import(self):
        self.files['app/tax/report.py'] = 'from ..basis.engine import calculate\n'
        self.assertEqual(len(analyze(self.files, self.config)['shortcuts']), 1)

    def test_python_strings_are_not_imports(self):
        self.files['app/tax/report.py'] = 'text = "from app.basis.engine import calculate"\n'
        self.assertEqual(analyze(self.files, self.config)['shortcuts'], [])

    def test_typescript_js_extension_resolves_source(self):
        imports, _ = self.imports('src/a.ts', 'import { b } from "./b.js";', {'src/a.ts', 'src/b.ts'}, {})
        self.assertEqual(imports, [('src/b.ts', 1)])

    def test_explicit_runtime_extensions_select_matching_typescript_sources(self):
        paths = {'src/a.ts'} | {'src/b' + extension for extension in ('.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs')}
        for runtime, source in (('.js', '.ts'), ('.jsx', '.tsx'), ('.mjs', '.mts'), ('.cjs', '.cts')):
            with self.subTest(runtime=runtime):
                text = 'import "./b%s";' % runtime
                self.assertEqual(self.imports('src/a.ts', text, paths, {})[0], [('src/b' + source, 1)])
                if runtime in ('.mjs', '.cjs'):
                    without_source = paths - {'src/b' + source}
                    self.assertEqual(self.imports('src/a.ts', text, without_source, {})[0], [('src/b' + runtime, 1)])
                    self.assertEqual(self.imports('src/a.ts', text, without_source - {'src/b' + runtime}, {})[0], [])

    def test_typescript_multiline_import_and_comment(self):
        text = '// import { fake } from "./fake";\nimport {\n b,\n} from "./b";\nconst s = "import nope from \'./fake\'";'
        imports, _ = self.imports('src/a.ts', text, {'src/a.ts', 'src/b.ts', 'src/fake.ts'}, {})
        self.assertEqual(imports, [('src/b.ts', 4)])

    def test_invalid_python_is_disclosed(self):
        self.files['app/tax/report.py'] = 'def broken('
        self.assertTrue(analyze(self.files, self.config)['warnings'])

    def test_shallow_and_root_packages_have_inferred_gates(self):
        for prefix in ('src/', ''):
            with self.subTest(prefix=prefix):
                files = {prefix + 'billing/__init__.py': '', prefix + 'billing/core.py': 'value = 1\n',
                         prefix + 'orders/run.py': 'from billing.core import value\n'}
                result = analyze(files, {})
                self.assertEqual(result['shortcuts'], [{'source': prefix + 'orders/run.py', 'target': prefix + 'billing/core.py', 'line': 1}])
                district = next(d for d in result['districts'] if d['id'] == prefix + 'billing')
                self.assertTrue(district['inferred'])

    def test_explicit_src_package_import_has_an_inferred_gate(self):
        files = {'src/billing/__init__.py': '', 'src/billing/core.py': '',
                 'src/orders/run.py': 'import src.billing.core\n'}
        self.assertEqual(len(analyze(files, {})['shortcuts']), 1)

    def test_shallow_javascript_package_import_uses_gate_and_private_import_is_flagged(self):
        for extension in ('ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'):
            with self.subTest(extension=extension):
                gate, private = 'src/billing/index.' + extension, 'src/billing/core.' + extension
                source = 'src/orders/run.js'
                result = analyze({gate: '', private: '', source: 'import "../billing";\nimport "../billing/core";'}, {})
                self.assertCountEqual(result['imports'], [{'source': source, 'target': gate, 'line': 1},
                                                          {'source': source, 'target': private, 'line': 2}])
                self.assertEqual(result['shortcuts'], [{'source': source, 'target': private, 'line': 2}])
                district = next(d for d in result['districts'] if d['id'] == 'src/billing')
                self.assertTrue(district['inferred'])

    def test_multiple_package_entrypoints_are_all_public(self):
        gates = ['src/billing/index.js', 'src/billing/index.ts']
        files = {gate: '' for gate in gates}
        files['src/billing/core.js'] = ''
        files['src/orders/run.js'] = 'import "../billing/index.js";\nimport "../billing/index.ts";'
        result = analyze(files, {})
        # Explicit .js imports select the adjacent TypeScript source; both
        # entry-point files still remain inferred public gates below.
        self.assertEqual({e['target'] for e in result['imports']}, {'src/billing/index.ts'})
        self.assertEqual(result['shortcuts'], [])
        district = next(d for d in result['districts'] if d['id'] == 'src/billing')
        self.assertEqual(district['public'], gates)
        self.assertTrue(all(result['files'][gate]['gate'] for gate in gates))

    def test_nested_packages_share_outer_boundary(self):
        files = {
            'src/billing/__init__.py': '',
            'src/billing/internal/__init__.py': '',
            'src/billing/internal/core.py': 'value = 1\n',
            'src/billing/service.py': 'from .internal.core import value\n',
            'src/orders/__init__.py': '',
            'src/orders/run.py': 'from billing.internal.core import value\n',
        }
        result = analyze(files, {})
        self.assertEqual({d['id'] for d in result['districts'] if d['walled']}, {'src/billing', 'src/orders'})
        self.assertEqual(result['files']['src/billing/internal/core.py']['district'], 'src/billing')
        self.assertEqual(result['shortcuts'], [{'source': 'src/orders/run.py', 'target': 'src/billing/internal/core.py', 'line': 1}])

    def test_source_container_entrypoints_do_not_swallow_feature_boundaries(self):
        for container, config in [('src', {}), ('python', {'pythonRoots': ['python']})]:
            with self.subTest(container=container):
                files = {container + '/__init__.py': '', container + '/billing/__init__.py': '',
                         container + '/billing/private.py': 'value=1\n',
                         container + '/orders/__init__.py': '',
                         container + '/orders/run.py': 'from billing.private import value\n'}
                result = analyze(files, config)
                self.assertEqual({d['id'] for d in result['districts'] if d['walled']},
                                 {container + '/billing', container + '/orders'})
                self.assertEqual(len(result['shortcuts']), 1)

    def test_project_specific_source_folders_are_not_excluded(self):
        files = {folder + '/code.py': '' for folder in ('src/data', 'data_demo', 'app-state', 'codex-home')}
        files.update({'backend/app/services/__init__.py': '', 'backend/app/services/engine.py': '',
                      'frontend/src/components/index.ts': '', 'frontend/src/components/button.ts': ''})
        result = analyze(files, {})
        self.assertEqual(set(result['files']), set(files))
        self.assertTrue(all(d['walled'] for d in result['districts'] if d['id'] in ('backend/app/services', 'frontend/src/components')))

    def test_no_implicit_project_alias_or_backend_root(self):
        paths = {'src/a.ts', 'frontend/src/b.ts', 'main.py', 'backend/billing/core.py'}
        self.assertEqual(self.imports('src/a.ts', 'import "@/b";', paths, {})[0], [])
        self.assertEqual(self.imports('main.py', 'import billing.core', paths, {})[0], [])
        self.assertEqual(self.imports('src/a.ts', 'import "@/b";', paths, {'aliases': {'@/': 'frontend/src/'}})[0], [('frontend/src/b.ts', 1)])
        self.assertEqual(self.imports('main.py', 'import billing.core', paths, {'pythonRoots': ['backend']})[0], [('backend/billing/core.py', 1)])

    def test_component_commands_and_library_share_one_inferred_owner(self):
        files = {'components/billing/bin/index.ts': 'import "../lib/billing";',
                 'components/billing/lib/billing.ts': 'export const billing = [];',
                 'components/orders/bin/run.ts': 'import "../../billing/lib/billing";',
                 'components/orders/lib/messages.ts': ''}
        result = analyze(files, {})
        candidates = {d['id']: d for d in result['districts'] if d['inferred']}
        self.assertEqual(set(candidates), {'components/billing', 'components/orders'})
        self.assertTrue(all(not d['walled'] and d['gateStatus'] == 'unknown' for d in candidates.values()))
        self.assertEqual(result['shortcuts'], [])
        self.assertEqual(result['boundaryCandidates'], [{'source': 'components/orders/bin/run.ts',
                                                       'target': 'components/billing/lib/billing.ts', 'line': 1}])
        self.assertFalse(result['files']['components/billing/bin/index.ts']['gate'])
        declared = analyze(files, {'modules': [{'path': 'components/billing', 'public': []}]})
        self.assertEqual(declared['shortcuts'], result['boundaryCandidates'])
        self.assertEqual(declared['boundaryCandidates'], [])

    def test_named_api_is_a_gate_and_nested_implementation_stays_with_its_owner(self):
        files = {'server/features/catalog/api.ts': 'export * from "./internal/store";',
                 'server/features/catalog/internal/store.ts': 'export const value = 1;',
                 'server/features/catalog/components/card/index.ts': '',
                 'server/features/catalog/components/card/view.ts': '',
                 'server/routes.ts': 'import "./features/catalog/api";'}
        result = analyze(files, {})
        self.assertEqual({d['id'] for d in result['districts'] if d['walled']}, {'server/features/catalog'})
        self.assertTrue(result['files']['server/features/catalog/api.ts']['gate'])
        self.assertEqual(result['shortcuts'], [])

    def test_named_react_component_can_be_a_gate(self):
        result = analyze({'src/components/Button/Button.tsx': 'export default function Button() {}',
                          'src/components/Button/styles.ts': '',
                          'src/App.tsx': 'import Button from "./components/Button/Button";'}, {})
        self.assertTrue(result['files']['src/components/Button/Button.tsx']['gate'])
        self.assertEqual(result['shortcuts'], [])

    def test_tests_and_commands_do_not_create_standalone_boundaries(self):
        files = {'bin/index.ts': '', 'bin/command.ts': '',
                 'scripts/index.py': '', 'scripts/run.py': '',
                 'tests/features/catalog/api.ts': '', 'tests/features/catalog/store.ts': '',
                 'components/only-test/main.ts': '', 'components/only-test/main.test.ts': ''}
        self.assertFalse(any(d['walled'] for d in analyze(files, {})['districts']))

    def test_declared_boundaries_override_directory_hypotheses(self):
        files = {'packages/app/features/catalog/api.ts': '',
                 'packages/app/features/catalog/private.ts': ''}
        result = analyze(files, {})
        self.assertEqual({d['id'] for d in result['districts'] if d['inferred']}, {'packages/app'})
        declared = analyze(files, {'modules': [{'path': 'packages/app/features/catalog',
                                               'public': ['packages/app/features/catalog/api.ts']}]})
        self.assertEqual({d['id'] for d in declared['districts'] if d['walled']}, {'packages/app/features/catalog'})
        self.assertFalse(any(d['inferred'] for d in declared['districts']))

    def test_relative_python_import_stays_in_its_source_root(self):
        paths = {'src/billing/a.py', 'src/billing/b.py', 'src/billing/__init__.py',
                 'backend/billing/b.py', 'backend/billing/__init__.py'}
        config = {'pythonRoots': ['backend', 'src', '']}
        self.assertEqual(self.imports('src/billing/a.py', 'from . import b', paths, config)[0], [('src/billing/b.py', 1)])
        self.assertEqual(self.imports('src/billing/a.py', 'from .b import value', paths, config)[0], [('src/billing/b.py', 1)])
        paths.remove('src/billing/b.py')
        self.assertEqual(self.imports('src/billing/a.py', 'from . import b', paths, config)[0], [('src/billing/__init__.py', 1)])

    def test_relative_import_cannot_escape_source_root(self):
        paths = {'src/billing/a.py', 'billing/b.py'}
        self.assertEqual(self.imports('src/billing/a.py', 'from ..billing import b', paths, {'pythonRoots': ['src']})[0], [])

    def test_selected_importer_analysis_keeps_target_resolution(self):
        self.files['app/tax/report.py'] = 'from app.basis.engine import calculate\n'
        self.files['app/other.py'] = 'from app.basis.engine import calculate\n'
        result = analyze(self.files, self.config, importers={'app/tax/report.py'})
        self.assertEqual(set(result['files']), set(self.files))
        self.assertEqual(result['shortcuts'], [{'source': 'app/tax/report.py', 'target': 'app/basis/engine.py', 'line': 1}])

if __name__ == '__main__':
    unittest.main()
