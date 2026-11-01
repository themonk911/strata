import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('strata_hook', Path(__file__).resolve().parents[1] / 'hooks/check.py')
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)

class GateHook(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'server').mkdir()
        (self.root / 'server/api.mjs').write_text('export { Client } from "./internal.mjs";\n')
        (self.root / 'server/internal.mjs').write_text('export class Client {}\n')
        (self.root / 'strata.config.json').write_text(json.dumps({'modules': [{'path': 'server', 'public': ['server/api.mjs']}]}))

    def tearDown(self):
        self.temp.cleanup()

    def payload(self, tool_name, tool_input, cwd=None):
        return {'cwd': str(cwd or self.root), 'hook_event_name': 'PreToolUse',
                'tool_name': tool_name, 'tool_input': tool_input}

    def commit(self):
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Hook Test',
                        '-c', 'user.email=hook@example.invalid', 'commit', '-qm', 'fixture'], check=True)

    def test_denies_new_import_past_gate(self):
        payload = {'cwd': str(self.root), 'hook_event_name': 'PreToolUse', 'tool_name': 'apply_patch', 'tool_input': {'command': '*** Begin Patch\n*** Add File: consumer.mjs\n+import { Client } from "./server/internal.mjs";\n*** End Patch'}}
        decision = hook.evaluate(payload)['hookSpecificOutput']
        self.assertEqual(decision['permissionDecision'], 'deny')
        self.assertIn('server/internal.mjs', decision['permissionDecisionReason'])
        self.assertFalse((self.root / 'consumer.mjs').exists())

    def test_allows_public_entrypoint(self):
        payload = {'cwd': str(self.root), 'hook_event_name': 'PreToolUse', 'tool_name': 'apply_patch', 'tool_input': {'command': '*** Begin Patch\n*** Add File: consumer.mjs\n+import { Client } from "./server/api.mjs";\n*** End Patch'}}
        self.assertEqual(hook.evaluate(payload), {})

    def test_multiline_replacement_and_move(self):
        sources = {'a.py': 'a = 1\nb = 2\nc = 3\n'}
        patch = '*** Begin Patch\n*** Update File: a.py\n*** Move to: b.py\n@@\n a = 1\n-b = 2\n+b = 4\n c = 3\n*** End Patch'
        self.assertEqual(hook.patch_sources(sources, patch, self.root), {'b.py': 'a = 1\nb = 4\nc = 3\n'})

    def test_ambiguous_context_is_not_claimed_safe(self):
        patch = '*** Begin Patch\n*** Update File: a.py\n@@\n-a = 1\n+a = 2\n*** End Patch'
        with self.assertRaises(ValueError):
            hook.patch_sources({'a.py': 'a = 1\na = 1\n'}, patch, self.root)

    def test_docs_are_not_analyzed_as_code(self):
        payload = {'cwd': str(self.root), 'hook_event_name': 'PreToolUse', 'tool_name': 'apply_patch', 'tool_input': {'command': '*** Begin Patch\n*** Add File: README.md\n+import { Client } from "./server/internal.mjs";\n*** End Patch'}}
        self.assertEqual(hook.evaluate(payload), {})

    def test_write_denies_new_private_import_without_writing(self):
        decision = hook.evaluate(self.payload('Write', {
            'file_path': str(self.root / 'consumer.mjs'),
            'content': 'import { Client } from "./server/internal.mjs";\n',
        }))['hookSpecificOutput']
        self.assertEqual(decision['permissionDecision'], 'deny')
        self.assertFalse((self.root / 'consumer.mjs').exists())

    def test_edit_denies_new_private_import_without_writing(self):
        consumer = self.root / 'consumer.mjs'
        original = 'import { Client } from "./server/api.mjs";\n'
        consumer.write_text(original)
        decision = hook.evaluate(self.payload('Edit', {
            'file_path': str(consumer), 'old_string': './server/api.mjs',
            'new_string': './server/internal.mjs',
        }))['hookSpecificOutput']
        self.assertEqual(decision['permissionDecision'], 'deny')
        self.assertEqual(consumer.read_text(), original)

    def test_edit_allows_repairing_private_import(self):
        consumer = self.root / 'consumer.mjs'
        consumer.write_text('import { Client } from "./server/internal.mjs";\n')
        self.assertEqual(hook.evaluate(self.payload('Edit', {
            'file_path': 'consumer.mjs', 'old_string': './server/internal.mjs',
            'new_string': './server/api.mjs',
        })), {})

    def test_edit_replace_all_and_ambiguous_input(self):
        consumer = self.root / 'consumer.mjs'
        consumer.write_text('import { Client } from "./server/api.mjs";\nexport { Client as Other } from "./server/api.mjs";\n')
        tool_input = {'file_path': 'consumer.mjs', 'old_string': './server/api.mjs',
                      'new_string': './server/internal.mjs'}
        diagnostic = hook.evaluate(self.payload('Edit', tool_input))['hookSpecificOutput']
        self.assertIn('ambiguous', diagnostic['additionalContext'])
        self.assertNotIn('permissionDecision', diagnostic)
        decision = hook.evaluate(self.payload('Edit', {**tool_input, 'replace_all': True}))['hookSpecificOutput']
        self.assertEqual(decision['permissionDecision'], 'deny')

    def test_patch_paths_use_tool_working_directory(self):
        cwd = self.root / 'app'
        cwd.mkdir()
        patch = '*** Begin Patch\n*** Add File: consumer.mjs\n+import { Client } from "../server/internal.mjs";\n*** End Patch'
        decision = hook.evaluate(self.payload('apply_patch', {'command': patch}, cwd))['hookSpecificOutput']
        self.assertEqual(decision['permissionDecision'], 'deny')
        self.assertIn('app/consumer.mjs:1', decision['permissionDecisionReason'])

    def test_write_paths_use_tool_working_directory(self):
        cwd = self.root / 'app'
        cwd.mkdir()
        decision = hook.evaluate(self.payload('Write', {
            'file_path': 'consumer.mjs',
            'content': 'import { Client } from "../server/internal.mjs";\n',
        }, cwd))['hookSpecificOutput']
        self.assertEqual(decision['permissionDecision'], 'deny')
        self.assertIn('app/consumer.mjs:1', decision['permissionDecisionReason'])

    def test_patch_move_paths_use_tool_working_directory(self):
        cwd = self.root / 'app'
        cwd.mkdir()
        original = 'import { Client } from "../server/api.mjs";\n'
        (cwd / 'a.mjs').write_text(original)
        patch = '*** Begin Patch\n*** Update File: a.mjs\n*** Move to: b.mjs\n@@\n-import { Client } from "../server/api.mjs";\n+import { Client } from "../server/internal.mjs";\n*** End Patch'
        decision = hook.evaluate(self.payload('apply_patch', {'command': patch}, cwd))['hookSpecificOutput']
        self.assertEqual(decision['permissionDecision'], 'deny')
        self.assertIn('app/b.mjs:1', decision['permissionDecisionReason'])
        self.assertEqual((cwd / 'a.mjs').read_text(), original)
        self.assertFalse((cwd / 'b.mjs').exists())

    def test_paths_may_traverse_within_repository_but_not_outside(self):
        cwd = self.root / 'app'
        cwd.mkdir()
        content = 'import { Client } from "./server/internal.mjs";\n'
        decision = hook.evaluate(self.payload('Write', {'file_path': '../consumer.mjs', 'content': content}, cwd))['hookSpecificOutput']
        self.assertEqual(decision['permissionDecision'], 'deny')
        self.assertIn('consumer.mjs:1', decision['permissionDecisionReason'])
        diagnostic = hook.evaluate(self.payload('Write', {'file_path': '../consumer.mjs', 'content': content}))['hookSpecificOutput']
        self.assertIn('outside the repository', diagnostic['additionalContext'])
        with tempfile.TemporaryDirectory() as outside:
            (self.root / 'linked').symlink_to(outside, target_is_directory=True)
            diagnostic = hook.evaluate(self.payload('Write', {'file_path': 'linked/consumer.mjs', 'content': content}))['hookSpecificOutput']
            self.assertIn('outside the repository', diagnostic['additionalContext'])

    def test_new_target_rechecks_unchanged_importers(self):
        # Adding a file can make an existing unresolved import cross a gate.
        (self.root / 'consumer.mjs').write_text('import { Client } from "./server/new.mjs";\n')
        decision = hook.evaluate(self.payload('Write', {
            'file_path': 'server/new.mjs', 'content': 'export class Client {}\n',
        }))['hookSpecificOutput']
        self.assertEqual(decision['permissionDecision'], 'deny')
        self.assertIn('consumer.mjs:1 -> server/new.mjs', decision['permissionDecisionReason'])

    def test_unsupported_patch_input_is_diagnostic(self):
        result = hook.evaluate(self.payload('apply_patch', None))['hookSpecificOutput']
        self.assertIn('could not preview', result['additionalContext'])
        self.assertNotIn('permissionDecision', result)

    def test_noop_edit_does_not_reject_existing_shortcut(self):
        content = 'import { Client } from "./server/internal.mjs";'
        (self.root / 'consumer.mjs').write_text(content)
        self.assertEqual(hook.evaluate(self.payload('Write', {'file_path': 'consumer.mjs', 'content': content})), {})
        self.assertEqual(hook.evaluate(self.payload('Edit', {
            'file_path': 'consumer.mjs', 'old_string': content, 'new_string': content,
        })), {})

    def test_multiline_edit_reports_line_without_changing_newlines(self):
        original = '// Consumer\n\nimport { Client } from "./server/api.mjs";'
        (self.root / 'consumer.mjs').write_text(original)
        decision = hook.evaluate(self.payload('Edit', {
            'file_path': 'consumer.mjs', 'old_string': original,
            'new_string': original.replace('/api.mjs', '/internal.mjs'),
        }))['hookSpecificOutput']
        self.assertEqual(decision['permissionDecision'], 'deny')
        self.assertIn('consumer.mjs:3', decision['permissionDecisionReason'])
        self.assertEqual((self.root / 'consumer.mjs').read_text(), original)

    def test_syntax_failure_is_diagnostic(self):
        result = hook.evaluate(self.payload('Write', {
            'file_path': 'consumer.py', 'content': 'def broken(',
        }))['hookSpecificOutput']
        self.assertIn('could not fully check', result['additionalContext'])
        self.assertNotIn('permissionDecision', result)

    def test_swift_edit_discloses_unavailable_checks_without_blocking_or_writing(self):
        result = hook.evaluate(self.payload('Write', {
            'file_path': 'Screen.swift', 'content': 'struct Screen {}\n',
        }))['hookSpecificOutput']
        self.assertIn('Swift', result['additionalContext'])
        self.assertIn('unavailable', result['additionalContext'])
        self.assertNotIn('permissionDecision', result)
        self.assertFalse((self.root / 'Screen.swift').exists())

    def test_stop_blocks_new_working_tree_shortcut(self):
        self.commit()
        (self.root / 'consumer.mjs').write_text('import { Client } from "./server/internal.mjs";\n')
        result = hook.evaluate({'cwd': str(self.root), 'hook_event_name': 'Stop'})
        self.assertEqual(result['decision'], 'block')
        self.assertIn('consumer.mjs:1', result['reason'])

    def test_stop_discloses_working_tree_parse_failure(self):
        self.commit()
        (self.root / 'consumer.py').write_text('def broken(')
        result = hook.evaluate({'cwd': str(self.root), 'hook_event_name': 'Stop'})
        self.assertIn('could not fully check', result['systemMessage'])

    def test_stop_allows_existing_shortcut_and_avoids_reentry(self):
        (self.root / 'consumer.mjs').write_text('import { Client } from "./server/internal.mjs";\n')
        self.commit()
        self.assertEqual(hook.evaluate({'cwd': str(self.root), 'hook_event_name': 'Stop'}), {})
        (self.root / 'second.mjs').write_text('import { Client } from "./server/internal.mjs";\n')
        self.assertEqual(hook.evaluate({'cwd': str(self.root), 'hook_event_name': 'Stop', 'stop_hook_active': True}), {})

    def test_without_config_hook_is_inactive(self):
        (self.root / 'strata.config.json').unlink()
        self.assertEqual(hook.evaluate(self.payload('Write', {
            'file_path': 'consumer.mjs', 'content': 'import { Client } from "./server/internal.mjs";\n',
        })), {})

if __name__ == '__main__':
    unittest.main()
