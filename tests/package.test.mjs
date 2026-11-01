import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 8_000_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, (result.stderr || result.stdout).slice(-3000));
  return result.stdout;
}

test('standalone plugin scans TypeScript and Swift without installed dependencies', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'strata-package-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const plugin = join(temporary, 'plugin');
  run(process.execPath, ['scripts/package-plugin.mjs', plugin], root);

  const repo = join(temporary, 'repository');
  await mkdir(repo);
  run('git', ['init', '-q'], repo);
  const files = {
    'strata.config.json': JSON.stringify({ modules: [
      { path: 'src/billing', public: ['src/billing/index.ts'] },
      { path: 'src/orders', public: ['src/orders/index.ts'] },
    ] }),
    'src/billing/index.ts': "export { charge } from './private.js';\n",
    'src/billing/private.ts': 'export const charge = () => 1;\n',
    'src/orders/index.ts': "export { submit } from './main.js';\n",
    'src/orders/main.ts': "import { charge } from '../billing/private.js';\nexport const submit = charge;\n",
    'ios/Models/Record.swift': 'struct Record {}\n',
    'ios/Views/Screen.swift': 'let record: Record? = nil\n',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  run('git', ['add', '.'], repo);
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], repo);
  const cli = join(plugin, 'bin', 'strata.mjs');
  const output = join(temporary, 'city.json');
  run(process.execPath, [cli, 'scan', '--repo', repo, '--working', '--out', output], temporary);
  const city = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(city.snapshots.length, 2);
  assert.deepEqual(city.snapshots.at(-1).inferredReferences, [
    { source: 'ios/Views/Screen.swift', target: 'ios/Models/Record.swift', line: 1, kind: 'swift_type_reference', inferred: true },
  ]);
  assert.deepEqual(city.snapshots.at(-1).shortcuts, [
    { source: 'src/orders/main.ts', target: 'src/billing/private.ts', line: 1 },
  ]);
  await writeFile(join(repo, 'src/orders/main.ts'), "import { charge } from '../billing/index.js';\nexport const submit = charge;\n");
  const result = spawnSync(process.execPath, [cli, 'check', '--repo', repo], { cwd: temporary, encoding: 'utf8' });
  assert.equal(result.status, 2, 'Swift boundary coverage must not look like a passed check');
  const checked = JSON.parse(result.stdout);
  assert.match(checked.warnings.join(' '), /Swift.*unavailable/);
  assert.equal(checked.before, 1);
  assert.equal(checked.after, 0);
  assert.equal(checked.added.length, 0);
  assert.equal(checked.removed.length, 1);
});
