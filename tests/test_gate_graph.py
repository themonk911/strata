import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import Repository, analyze, gate_evidence


class GateGraphEvidence(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        subprocess.run(['git', '-C', str(self.repo), 'init', '-q'], check=True)

    def write(self, path, content):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def evidence(self, module='billing', config=None, **options):
        return gate_evidence(self.repo, config or {}, module, **options)

    def candidates(self, result):
        return {candidate['path']: candidate for candidate in result['modules'][0]['candidates']}

    def facade(self):
        self.write('billing/index.ts', 'export { value } from "./store";\n')
        self.write('billing/store.ts', 'export { value } from "./model";\n')
        self.write('billing/model.ts', 'export const value = 1;\n')
        self.write('billing/unused.ts', 'export const unused = true;\n')
        self.write('app/main.ts', 'import { value } from "../billing";\n')

    def test_facade_and_existing_deep_import_remain_candidates_without_blessing_shortcut(self):
        self.facade()
        self.write('other/run.ts', 'import { value } from "../billing/store";\n')
        result = self.evidence()
        candidates = self.candidates(result)
        self.assertEqual(list(candidates), ['billing/index.ts', 'billing/store.ts'])
        facade = candidates['billing/index.ts']
        self.assertEqual((facade['internallyReachableFiles'], facade['dominatedFiles']), (2, 0))
        self.assertEqual(facade['alternateEntries'], {'count': 1, 'examples': [
            {'source': 'other/run.ts', 'target': 'billing/store.ts', 'line': 1}]})
        self.assertEqual(candidates['billing/store.ts']['dominatedFiles'], 1)
        self.assertEqual(result['modules'][0]['public'], ['billing/index.ts'])
        self.assertEqual(result['modules'][0]['internalImportCount'], 2)
        self.assertEqual(result['modules'][0]['externalImportCount'], 2)
        facts = analyze(Repository(self.repo).working(), {})
        self.assertEqual(facts['shortcuts'], [{'source': 'other/run.ts', 'target': 'billing/store.ts', 'line': 1}])

    def test_leaf_and_unbounded_district_entries_are_retained_with_distinct_callers(self):
        self.write('sdk/script.ts', 'export const value = 1;\n')
        self.write('sdk/unused.ts', 'export const unused = 1;\n')
        self.write('app/a.ts', 'import { value } from "../sdk/script";\nimport "../sdk/script";\n')
        self.write('app/b.ts', 'import { value } from "../sdk/script";\n')
        self.write('other/run.ts', 'import { value } from "../sdk/script";\n')
        result = self.evidence('sdk')
        leaf = self.candidates(result)['sdk/script.ts']
        self.assertEqual((leaf['externalCallerFiles'], leaf['externalCallerModules']), (3, 2))
        self.assertEqual((leaf['internallyReachableFiles'], leaf['dominatedFiles']), (0, 0))
        self.assertEqual(result['modules'][0]['gateStatus'], 'unbounded')

    def test_scc_members_stay_ambiguous_and_isolated_files_do_not_inflate_dominance(self):
        self.write('billing/index.ts', 'import type { B } from "./types";\nexport type A = B;\n')
        self.write('billing/types.ts', 'import type { A } from "./index";\nexport type { Value } from "./model";\nexport type B = A;\n')
        self.write('billing/model.ts', 'export type Value = string;\n')
        self.write('billing/isolated.ts', 'export const unrelated = 1;\n')
        self.write('app/a.ts', 'import type { A } from "../billing";\n')
        self.write('other/run.ts', 'import type { B } from "../billing/types";\n')
        candidates = self.candidates(self.evidence())
        self.assertEqual(set(candidates), {'billing/index.ts', 'billing/types.ts'})
        for candidate in candidates.values():
            self.assertEqual(candidate['component'], ['billing/index.ts', 'billing/types.ts'])
            self.assertEqual(candidate['componentSize'], 2)
            self.assertEqual((candidate['internallyReachableFiles'], candidate['dominatedFiles']), (1, 1))

    def test_tests_and_swift_do_not_create_graph_entries(self):
        self.facade()
        self.write('tests/private.test.ts', 'import { value } from "../billing/store";\n')
        self.write('app/Screen.swift', 'struct Screen {}\n')
        result = self.evidence()
        self.assertEqual(set(self.candidates(result)), {'billing/index.ts'})
        self.assertEqual(result['coverage']['excludedTestFiles'], 1)
        self.assertEqual(result['coverage']['uncheckedSwiftFiles'], 1)

    def test_declared_policy_and_repository_are_unchanged_and_evidence_excludes_private_content(self):
        self.facade()
        self.write('billing/model.ts', 'export const value = "PRIVATE_SOURCE_SENTINEL";\n')
        self.write('billing/README.md', 'PRIVATE_README_SENTINEL\n')
        self.write('billing/SKILL.md', 'PRIVATE_SKILL_SENTINEL\n')
        self.write('.env', 'SECRET=PRIVATE_ENV_SENTINEL\n')
        config = {'modules': [{'path': 'billing', 'public': ['billing/index.ts']}]}
        original = copy.deepcopy(config)
        self.write('strata.config.json', json.dumps(config))
        before = {path.relative_to(self.repo).as_posix(): path.read_bytes() for path in self.repo.rglob('*') if path.is_file()}
        result = self.evidence(config=config)
        after = {path.relative_to(self.repo).as_posix(): path.read_bytes() for path in self.repo.rglob('*') if path.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(config, original)
        self.assertEqual(result['modules'][0]['gateStatus'], 'declared')
        for marker in ('PRIVATE_SOURCE_SENTINEL', 'PRIVATE_README_SENTINEL', 'PRIVATE_SKILL_SENTINEL', 'PRIVATE_ENV_SENTINEL'):
            self.assertNotIn(marker, json.dumps(result))
        self.assertNotIn('documentation', result['modules'][0])
        for candidate in result['modules'][0]['candidates']:
            self.assertNotIn('source', candidate)
            self.assertNotIn('sourceTruncated', candidate)

    def test_candidate_samples_are_bounded_and_deterministic(self):
        self.facade()
        for i in range(8):
            self.write('caller%d/main.ts' % i, 'import { value } from "../billing/store";\n')
        result = self.evidence(maximum=1)
        item = result['modules'][0]
        self.assertEqual(item['candidateCount'], 2)
        self.assertEqual(len(item['candidates']), 1)
        self.assertEqual(item['candidates'][0]['path'], 'billing/store.ts')
        full = self.evidence()
        facade = self.candidates(full)['billing/index.ts']
        self.assertEqual(facade['alternateEntries']['count'], 8)
        self.assertEqual(len(facade['alternateEntries']['examples']), 5)
        self.assertEqual(result, self.evidence(maximum=1))

    def test_unknown_modules_and_invalid_limits_fail(self):
        self.facade()
        with self.assertRaises(ValueError):
            self.evidence('missing')
        for maximum in (0, 101, True, '1'):
            with self.subTest(maximum=maximum), self.assertRaises(ValueError):
                self.evidence(maximum=maximum)

    def test_cli_matches_public_api_and_rejects_source_collection(self):
        self.facade()
        self.write('billing/index.ts', 'export { value } from "./store";\n// PRIVATE_SOURCE_SENTINEL\n')
        self.write('billing/README.md', 'PRIVATE_DOCUMENTATION_SENTINEL\n')
        command = ['node', str(Path(__file__).resolve().parents[1] / 'bin/strata.mjs'),
                   'gates', '--repo', str(self.repo), '--module', 'billing']
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), self.evidence())
        self.assertNotIn('PRIVATE_SOURCE_SENTINEL', result.stdout)
        self.assertNotIn('PRIVATE_DOCUMENTATION_SENTINEL', result.stdout)
        explicit = subprocess.run(command + ['--include-source'], capture_output=True, text=True)
        self.assertEqual(explicit.returncode, 2)
        self.assertEqual(explicit.stdout, '')


if __name__ == '__main__':
    unittest.main()
