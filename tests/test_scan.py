import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'core'))
from scan import analyze, extract_imports

class Boundaries(unittest.TestCase):
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
        imports, _ = extract_imports('src/a.ts', 'import { b } from "./b.js";', {'src/a.ts', 'src/b.ts'}, {})
        self.assertEqual(imports, [('src/b.ts', 1)])

    def test_typescript_multiline_import_and_comment(self):
        text = '// import { fake } from "./fake";\nimport {\n b,\n} from "./b";\nconst s = "import nope from \'./fake\'";'
        imports, _ = extract_imports('src/a.ts', text, {'src/a.ts', 'src/b.ts', 'src/fake.ts'}, {})
        self.assertEqual(imports, [('src/b.ts', 4)])

    def test_invalid_python_is_disclosed(self):
        self.files['app/tax/report.py'] = 'def broken('
        self.assertTrue(analyze(self.files, self.config)['warnings'])

if __name__ == '__main__':
    unittest.main()
