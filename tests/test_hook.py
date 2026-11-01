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

if __name__ == '__main__':
    unittest.main()
