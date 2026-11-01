import contextlib
import hashlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import analyze, check, history_evidence, scan


class SwiftAnalysis(unittest.TestCase):
    def test_type_references_are_inferred_and_never_import_shortcuts(self):
        config = {'modules': [{'path': 'Models', 'public': []}]}
        for declaration in ('struct', 'class', 'enum', 'protocol', 'actor', 'typealias'):
            with self.subTest(declaration=declaration):
                definition = 'typealias Record = String' if declaration == 'typealias' else declaration + ' Record {}'
                result = analyze({'Models/Record.swift': definition,
                                  'Views/Screen.swift': 'import Foundation\nlet record: Record? = nil\n'}, config)
                self.assertEqual(result['inferredReferences'], [{
                    'source': 'Views/Screen.swift', 'target': 'Models/Record.swift', 'line': 2,
                    'kind': 'swift_type_reference', 'inferred': True}])
                self.assertEqual(result['imports'], [])
                self.assertEqual(result['shortcuts'], [])
                self.assertTrue(any('Swift' in warning and 'unavailable' in warning for warning in result['warnings']))

    def test_comments_strings_and_inaccessible_declarations_do_not_create_edges(self):
        sources = {
            'Models/Types.swift': 'struct Record {}\nprivate struct Secret {}\nfileprivate class Hidden {}\n'
                                  'struct Outer { struct Nested {} }\n// struct Ghost {}\n',
            'Views/Screen.swift': '// Record\n/* Record /* nested Record */ */\n'
                                 'let plain = "Record"\nlet raw = #"Record"#\n'
                                 'let multiline = """\nRecord\n"""\n'
                                 'let rawMultiline = #"""\nRecord\n"""#\n'
                                 'let interpolated = "\\(format("Record"))"\nimport Record\n'
                                 'let a: Secret? = nil\nlet b: Hidden? = nil\nlet c: Nested? = nil\n'
                                 'let ghost: Ghost? = nil\n',
        }
        result = analyze(sources, {})
        self.assertEqual(result['inferredReferences'], [])
        self.assertEqual(result['warnings'], [])

    def test_ambiguous_type_names_are_not_resolved(self):
        result = analyze({'One/Record.swift': 'struct Record {}',
                          'Two/Record.swift': 'struct Record {}',
                          'Views/Screen.swift': 'let record: Record? = nil'}, {})
        self.assertEqual(result['inferredReferences'], [])

    def test_selected_importer_still_sees_declarations_in_other_files(self):
        sources = {'Models/Record.swift': 'struct Record {}',
                   'Views/One.swift': 'let first: Record? = nil',
                   'Views/Two.swift': 'let second: Record? = nil'}
        result = analyze(sources, {}, importers={'Views/One.swift'})
        self.assertEqual(set(result['files']), set(sources))
        self.assertEqual([(edge['source'], edge['target']) for edge in result['inferredReferences']],
                         [('Views/One.swift', 'Models/Record.swift')])

    def test_same_path_symbol_rename_refreshes_cached_reference_resolution(self):
        sources = {'Models/Record.swift': 'struct Record {}', 'Views/Screen.swift': 'let record: Record? = nil'}
        cache = {}
        self.assertEqual(len(analyze(sources, {}, import_cache=cache)['inferredReferences']), 1)
        sources['Models/Record.swift'] = 'struct Renamed {}'
        cache.pop('Models/Record.swift', None)
        self.assertEqual(analyze(sources, {}, import_cache=cache)['inferredReferences'], [])

    def test_incomplete_lexical_input_has_explicit_warning(self):
        for source in ('/* unterminated', 'let text = "unterminated', 'struct Record {'):
            with self.subTest(source=source):
                result = analyze({'Models/Record.swift': source}, {})
                self.assertIn('Models/Record.swift', result['files'])
                self.assertTrue(result['warnings'])


class SwiftHistory(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Private Swift Author')
        self.git('config', 'user.email', 'swift-author@example.invalid')
        self.count = 0

    def git(self, *args, env=None):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], env=env,
                                       stderr=subprocess.PIPE).decode().strip()

    def write(self, path, source):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source)

    def commit(self, timestamp=None):
        self.git('add', '.')
        timestamp = timestamp or '2026-01-01T10:%02d:00+00:00' % self.count
        self.git('commit', '-qm', 'Private Swift commit subject',
                 env={**os.environ, 'GIT_AUTHOR_DATE': timestamp, 'GIT_COMMITTER_DATE': timestamp})
        self.count += 1
        return self.git('rev-parse', 'HEAD')

    def test_swift_history_is_visible_and_evidence_stays_separate_from_scan(self):
        self.write('Models/Record.swift', 'struct Record { let value = "private_source_marker" }\n')
        before = self.commit()
        self.write('Views/Screen.swift', 'let record: Record? = nil\n')
        after = self.commit()
        self.write('.env', 'EXCLUDED_SECRET=private_secret_marker\n')
        status_env = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}
        status = self.git('status', '--porcelain', env=status_env)
        index = hashlib.sha256((self.repo / '.git/index').read_bytes()).digest()
        with contextlib.redirect_stderr(io.StringIO()):
            data = scan(self.repo, {'private': True}, history_analysis=True)
        self.assertEqual([s['revision'] for s in data['snapshots']], [before[:12], after[:12]])
        self.assertEqual(set(data['snapshots'][-1]['files']), {'Models/Record.swift', 'Views/Screen.swift'})
        self.assertEqual(len(data['snapshots'][-1]['inferredReferences']), 1)
        self.assertTrue(data['meta']['private'])
        for private in ('private_source_marker', 'Private Swift commit subject', 'Private Swift Author',
                        'swift-author@example.invalid', 'private_secret_marker'):
            self.assertNotIn(private, str(data))
        changes = history_evidence(self.repo, {}, [before, after])['changes']
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]['files'], ['Views/Screen.swift'])
        self.assertIn('+let record: Record? = nil', changes[0]['patch'])
        self.assertNotIn('private_secret_marker', str(changes))
        self.write('Views/Screen.swift', 'let records: [Record] = []\n')
        result = check(self.repo, {'modules': [{'path': 'Models', 'public': []}]})
        self.assertEqual(result['added'], [])
        self.assertTrue(any('Swift' in warning and 'unavailable' in warning for warning in result['warnings']))
        checked = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'core/scan.py'),
                                  'check', '--repo', str(self.repo)], capture_output=True, text=True)
        self.assertEqual(checked.returncode, 2, checked.stderr)
        self.assertEqual((self.repo / 'Views/Screen.swift').read_text(), 'let records: [Record] = []\n')
        self.write('Views/Screen.swift', 'let record: Record? = nil\n')
        self.assertEqual(self.git('status', '--porcelain', env=status_env), status)
        self.assertEqual(self.git('rev-parse', 'HEAD'), after)
        self.assertEqual(hashlib.sha256((self.repo / '.git/index').read_bytes()).digest(), index)

    def test_native_test_changes_without_an_owner_do_not_count_as_production_scatter(self):
        self.write('Models/Record.swift', 'struct Record {}\n')
        self.commit()
        tests = ['ios/FlowTests.swift', 'ios/AppTests/Behavior.swift']
        for index, path in enumerate(tests):
            self.write(path, 'let record%d: Record? = nil\n' % index)
        self.commit()
        with contextlib.redirect_stderr(io.StringIO()):
            data = scan(self.repo, {}, history_analysis=True)
        latest = data['snapshots'][-1]
        self.assertEqual(len(latest['inferredReferences']), 2)
        scatter = latest['entropy']['signals']['scatter']
        self.assertEqual(scatter['status'], 'unknown_test_ownership')
        self.assertIsNone(scatter['value'])
        self.assertCountEqual(scatter['unknownTestPaths'], tests)
        self.assertEqual(scatter['unknownTestLines'], 2)
        self.assertEqual(scatter['attributedLines'], 0)
        self.assertEqual(scatter['excludedChanges'], 1)

    def test_swift_only_mature_history_cannot_report_a_complete_entropy_score(self):
        self.write('Models/Record.swift', 'struct Record {}\n')
        self.commit('2026-01-01T00:00:00+00:00')
        self.write('Views/Screen.swift', 'let record: Record? = nil\n')
        self.commit('2026-01-02T00:00:00+00:00')
        self.write('Models/Other.swift', 'struct Other {}\n')
        self.commit('2026-01-04T00:00:00+00:00')
        config = {'entropy': {'reworkDays': 1, 'reworkCohortDays': 30}}
        with contextlib.redirect_stderr(io.StringIO()):
            data = scan(self.repo, config, history_analysis=True)
        latest = data['snapshots'][-1]
        self.assertEqual(latest['entropy']['signals']['rework']['status'], 'available')
        self.assertEqual(latest['entropy']['signals']['scatter']['status'], 'available')
        for entropy in [latest['entropy'], *(district['entropy'] for district in latest['districts'])]:
            self.assertIsNone(entropy['signals']['shortcuts']['value'])
            self.assertEqual(entropy['signals']['shortcuts']['status'], 'unsupported_language')
            self.assertIsNone(entropy['score'])

    def test_mixed_language_shortcuts_preserve_measurements_with_partial_coverage(self):
        self.write('lib/__init__.py', '')
        self.write('lib/core.py', 'value = 1\n')
        self.write('app.py', 'from lib.core import value\n')
        self.write('ios/App.swift', 'struct App {}\n')
        self.commit()
        for full_history in (False, True):
            with self.subTest(full_history=full_history), contextlib.redirect_stderr(io.StringIO()):
                data = scan(self.repo, {}, history_analysis=full_history)
                latest = data['snapshots'][-1]
                shortcuts = latest['entropy']['signals']['shortcuts']
                self.assertEqual(shortcuts['coverage'], 'partial')
                self.assertEqual((shortcuts['imports'], shortcuts['shortcuts']), (1, 1))
                self.assertEqual(shortcuts['value'] if full_history else shortcuts['rawRatio'],
                                 2 if full_history else 1)
                swift = next(d for d in latest['districts'] if d['id'] == 'ios')['entropy']['signals']['shortcuts']
                self.assertIsNone(swift['value'])
                self.assertEqual(swift['status'], 'unsupported_language')
                if not full_history:
                    self.assertIsNone(swift['rawRatio'])


if __name__ == '__main__':
    unittest.main()
