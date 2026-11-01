import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundaryEditor } from '../server/api.mjs';

const modules = [{ path: 'billing', public: ['billing/__init__.py'] }];
const edge = { source: 'orders/run.py', target: 'billing/private.py', line: 1 };

async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), 'strata-boundaries-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = spawnSync('git', ['init', '-q', repo], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  assert.equal(git.status, 0, git.stderr);
  await Promise.all(['billing', 'orders'].map(path => mkdir(join(repo, path))));
  await Promise.all([
    writeFile(join(repo, 'billing/__init__.py'), 'from .private import value\n'),
    writeFile(join(repo, 'billing/private.py'), 'value = 1\n'),
    writeFile(join(repo, 'orders/run.py'), 'from billing.private import value\n'),
    writeFile(join(repo, 'strata.config.json'), JSON.stringify({ name: 'private project', private: true, modules: [], aliases: { '@/': 'ui/' }, allow: [] })),
  ]);
  const editor = new BoundaryEditor({ workspace: async () => ({ repo }) });
  t.after(() => editor.close());
  return { repo, editor };
}

test('boundary service previews real imports and saves only reviewed rules while preserving config', async t => {
  const { repo, editor } = await fixture(t);
  const original = await readFile(join(repo, 'strata.config.json'), 'utf8');
  const state = await editor.read();
  assert.equal(state.configured, true);
  assert.deepEqual(state.modules, []);
  assert.ok(state.files.includes('billing/private.py'));
  const preview = await editor.preview({ modules, revision: state.revision });
  assert.deepEqual(preview.shortcuts, [edge]);
  assert.deepEqual(preview.added, [edge]);
  assert.deepEqual(preview.counts, { before: 0, after: 1, added: 1, removed: 0 });
  assert.equal(await readFile(join(repo, 'strata.config.json'), 'utf8'), original);
  const saved = await editor.save({ modules, revision: state.revision, previewToken: preview.previewToken });
  assert.equal(saved.saved, true);
  assert.notEqual(saved.revision, state.revision);
  const config = JSON.parse(await readFile(join(repo, 'strata.config.json'), 'utf8'));
  assert.deepEqual(config, { name: 'private project', private: true, modules, aliases: { '@/': 'ui/' }, allow: [] });
  assert.deepEqual((await editor.read()).modules, modules);
});

test('source changes and concurrent config edits invalidate a preview without overwriting rules', async t => {
  const { repo, editor } = await fixture(t);
  const state = await editor.read();
  const preview = await editor.preview({ modules, revision: state.revision });
  await writeFile(join(repo, 'orders/run.py'), 'from billing import value\n');
  await assert.rejects(editor.save({ modules, revision: state.revision, previewToken: preview.previewToken }), /preview|changed|stale/i);
  assert.deepEqual(JSON.parse(await readFile(join(repo, 'strata.config.json'), 'utf8')).modules, []);
  const refreshed = await editor.preview({ modules, revision: state.revision });
  const edited = JSON.stringify({ modules: [], private: true, name: 'edited outside Strata' });
  await writeFile(join(repo, 'strata.config.json'), edited);
  await assert.rejects(editor.save({ modules, revision: state.revision, previewToken: refreshed.previewToken }), /changed|reload|revision/i);
  assert.equal(await readFile(join(repo, 'strata.config.json'), 'utf8'), edited);
});

test('requests cannot choose another repository, skip preview, or save during another job', async t => {
  const { repo, editor } = await fixture(t);
  const state = await editor.read();
  const original = await readFile(join(repo, 'strata.config.json'), 'utf8');
  await assert.rejects(editor.preview({ modules, revision: state.revision, repo: '/tmp/other' }), /current revision only/);
  await assert.rejects(editor.preview(null), /Expected boundary/);
  await assert.rejects(editor.save({ modules, revision: state.revision }), /Preview these rules/);
  const busy = new BoundaryEditor({ workspace: () => ({ repo }), busy: () => true });
  await assert.rejects(busy.save({ modules, revision: state.revision, previewToken: 'irrelevant' }), /finish before saving/);
  assert.equal(await readFile(join(repo, 'strata.config.json'), 'utf8'), original);
});

test('boundary operations serialize and recover after a failed operation', async t => {
  const { editor } = await fixture(t);
  const pending = editor.read();
  await assert.rejects(editor.read(), /already running/);
  const state = await pending;
  await assert.rejects(editor.preview({ modules: [{ path: '../outside', public: [] }], revision: state.revision }), /relative|path|outside/i);
  assert.equal((await editor.read()).revision, state.revision);
  const unavailable = new BoundaryEditor({ workspace: () => ({ repo: '/tmp' }), python: '/missing/strata-python' });
  await assert.rejects(unavailable.read(), /Could not start the boundary scanner/);
  await assert.rejects(unavailable.read(), /Could not start the boundary scanner/);
});

test('external configs require explicit import and switch the workspace to saved hook rules', async t => {
  const { repo } = await fixture(t);
  const config = join(repo, 'separate.json');
  const original = JSON.stringify({ name: 'external settings', modules, pythonRoots: [''] });
  await writeFile(config, original);
  const workspaceFile = join(repo, 'workspace.json');
  await writeFile(workspaceFile, JSON.stringify({ repo, config, retained: true }));
  const external = new BoundaryEditor({ workspace: () => ({ repo, config }), workspaceFile, externalConfigOverride: true });
  const state = await external.read();
  assert.equal(state.importRequired, true);
  assert.deepEqual(state.modules, modules);
  const preview = await external.preview({ modules, revision: state.revision });
  const request = { modules, revision: state.revision, previewToken: preview.previewToken };
  await assert.rejects(external.save(request), /import|confirm/i);
  const saved = await external.save({ ...request, importConfig: true });
  assert.equal(saved.saved, true);
  assert.match(saved.workspaceWarning, /STRATA_CONFIG/);
  // Core returns a canonical path; macOS temporary roots may use /var aliases.
  const targetConfig = await realpath(join(repo, 'strata.config.json'));
  assert.deepEqual(await external.workspace(), { repo, config: targetConfig });
  assert.deepEqual(JSON.parse(await readFile(workspaceFile, 'utf8')), { repo, config: targetConfig, retained: true });
  assert.equal((await external.read()).importRequired, false);
  assert.equal(await readFile(config, 'utf8'), original);
});

test('saved rules stay successful if remembering the workspace fails', async t => {
  const { repo } = await fixture(t);
  const editor = new BoundaryEditor({ workspace: () => ({ repo }), workspaceFile: join(repo, 'missing', 'workspace.json') });
  const state = await editor.read();
  const preview = await editor.preview({ modules, revision: state.revision });
  const saved = await editor.save({ modules, revision: state.revision, previewToken: preview.previewToken });
  assert.equal(saved.saved, true);
  assert.match(saved.workspaceWarning, /could not be remembered/);
  assert.deepEqual(JSON.parse(await readFile(join(repo, 'strata.config.json'), 'utf8')).modules, modules);
  assert.deepEqual((await editor.read()).modules, modules);
});

test('saving an overridden repository preserves another saved workspace selection', async t => {
  const { repo } = await fixture(t);
  const workspaceFile = join(repo, 'workspace.json');
  const original = JSON.stringify({ repo: '/other/repository', config: '/other/rules.json' });
  await writeFile(workspaceFile, original);
  const editor = new BoundaryEditor({ workspace: () => ({ repo }), workspaceFile });
  const state = await editor.read();
  const preview = await editor.preview({ modules, revision: state.revision });
  assert.equal((await editor.save({ modules, revision: state.revision, previewToken: preview.previewToken })).saved, true);
  assert.equal(await readFile(workspaceFile, 'utf8'), original);
  assert.deepEqual((await editor.read()).modules, modules);
});

test('boundary editing reports a missing local workspace', async () => {
  const absent = new BoundaryEditor({ workspace: () => ({}) });
  assert.equal(await absent.available(), false);
  await assert.rejects(absent.read(), /STRATA_REPO/);
});

test('closing the service cancels an active scanner and prevents later starts', async t => {
  const { repo } = await fixture(t);
  // The interpreter is the external boundary; this stand-in stays alive until
  // interrupted, without running inspected code or requiring a live service.
  const interpreter = join(repo, 'slow-python');
  await writeFile(interpreter, '#!/bin/sh\nexec sleep 60\n', { mode: 0o700 });
  const editor = new BoundaryEditor({ workspace: () => ({ repo }), python: interpreter });
  t.after(() => editor.close());
  const pending = editor.read();
  await new Promise(setImmediate);
  editor.close();
  await assert.rejects(pending, /interrupted/);
  await assert.rejects(editor.read(), /closed/);
});

test('an interpreter that closes stdin cannot strand the service or its process', { timeout: 5000 }, async t => {
  const { repo } = await fixture(t);
  const interpreter = join(repo, 'closed-stdin-python');
  const pidFile = join(repo, 'interpreter.pid');
  await writeFile(interpreter, `#!/usr/bin/env python3\nimport os, time\nwith open(${JSON.stringify(pidFile)}, 'w') as output:\n    output.write(str(os.getpid()))\nos.close(0)\ntime.sleep(60)\n`, { mode: 0o700 });
  const editor = new BoundaryEditor({ workspace: () => ({ repo }), python: interpreter });
  t.after(async () => {
    editor.close();
    // Also clean up if this regression fails, without leaving a sleeping process.
    try { process.kill(-Number(await readFile(pidFile, 'utf8')), 'SIGKILL'); }
    catch { /* The service normally already reaped the interpreter. */ }
  });
  await assert.rejects(editor.preview({
    modules: [{ path: 'billing', public: ['billing/' + 'x'.repeat(1_000_000)] }],
    revision: 'test-revision',
  }), /Could not send rules to the scanner/);
  assert.equal(editor.active, false);
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('analysis never imports Python modules from the inspected repository', async t => {
  const { repo, editor } = await fixture(t);
  const marker = join(repo, 'executed.txt');
  await writeFile(join(repo, 'json.py'), `open(${JSON.stringify(marker)}, 'w').write('unexpected execution')\n`);
  const state = await editor.read();
  await editor.preview({ modules, revision: state.revision });
  await assert.rejects(access(marker), { code: 'ENOENT' });
});
