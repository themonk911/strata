import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createVideoProject } from '../server/video-template.mjs';

const ids = ['origin', 'boundaries', 'growth', 'pressure', 'findings', 'focus', 'outlook'];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
function fixture({ shortcuts = true, inferred = false, entropy, name = 'Lighthouse', privateRepo = false, selected = true } = {}) {
  const make = (latest) => ({ date: latest ? '2026-10-01' : '2026-09-01',
    files: { 'caller/index.js': { district: 'caller', lines: 10 }, 'ledger/private.js': { district: 'ledger', lines: latest ? 30 : 10 } },
    imports: [{ source: 'caller/index.js', target: 'ledger/private.js' }],
    shortcuts: latest && shortcuts ? [{ source: 'caller/index.js', target: 'ledger/private.js' }] : [], desirePaths: [],
    districts: [{ id: 'ledger', name: 'ledger', incoming: latest && shortcuts ? 1 : 0, shortcuts: 0, inferred, walled: true, public: ['ledger/index.js'] }], ...(latest && entropy ? { entropy } : {}) });
  const data = { schemaVersion: 1, meta: { name, private: privateRepo, coverage: 'Static imports' }, snapshots: [make(false), make(true)] };
  const story = { title: 'What changed here?', subtitle: 'Look at the measured history.', chapters: ids.map((id, index) => ({ id, title: id, caption: 'Review the public boundary before changing callers.', snapshot: index ? 1 : 0, district: id === 'focus' && selected ? 'ledger' : null })) };
  return { data, story };
}
async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'strata-video-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = join(directory, 'capture.png'); await writeFile(image, png);
  return { directory: join(directory, 'project'), assets: Object.fromEntries(['origin', 'growth', 'focus', 'outlook'].map(id => [id, image])) };
}
async function report(result) { return JSON.parse(await readFile(join(result.projectPath, 'report.json'), 'utf8')); }

test('builds a portable recording project using measured current endpoints and no source contents', async t => {
  const input = { ...await sandbox(t), ...fixture() };
  input.story.chapters[2].snapshot = 0; input.story.chapters[3].snapshot = 0;
  input.data.snapshots[1].files['new.js'] = { district: 'ledger', lines: 7, source: 'DO_NOT_EXPORT_SOURCE' };
  const result = await createVideoProject(input), value = await report(result);
  assert.deepEqual(result.scenes.map(s => s.id), ids);
  assert.equal(value.chapters.growth.snapshot, 1); assert.equal(value.chapters.pressure.snapshot, 1);
  assert.equal(value.history[1].files, 3); assert.equal(value.history[1].lines, 47);
  assert.match(result.scenes[2].text, /from 2 to 3 source files/);
  assert.equal(value.privacyLabel, 'Public repository'); assert.equal(value.history[1].entropy, null);
  assert.equal(value.focus.target, 'ledger/private.js'); assert.equal(value.focus.importers, 1);
  assert.ok(!JSON.stringify(value).includes('DO_NOT_EXPORT_SOURCE'));
  const config = JSON.parse(await readFile(join(result.projectPath, 'video.json'), 'utf8'));
  assert.equal(config.voice.provider, 'recording'); assert.equal(config.captions, true);
  const script = await readFile(result.scriptPath, 'utf8');
  assert.equal((script.match(/\[#start\]/g) || []).length, 7);
  assert.equal((script.match(/\[#detail\]/g) || []).length, 7);
  assert.equal((script.match(/\[#finish\]/g) || []).length, 7);
  assert.match(script, /\{API\|A, P, I\}/);
  assert.match(result.scenes[1].text, /A, P, I/);
  const credits = await readFile(join(result.projectPath, 'CREDITS.md'), 'utf8');
  assert.match(credits, /Explainroo 0.4.1/); assert.match(credits, /AI-generated OpenAI/);
  assert.ok(!credits.includes(input.directory));
});

test('preserves partial and unavailable entropy signals without replacing missing values by zero', async t => {
  const entropy = { status: 'partial', score: .25485, signals: {
    rework: { value: 0, score: 0, status: 'available', coverage: 'complete', windowDays: 14 },
    scatter: { value: .734, score: .734, status: 'available', coverage: 'partial', unknownTestPaths: ['sensitive/path.py'] },
    shortcuts: { value: .003, score: .03, status: 'available' }
  } };
  const input = { ...await sandbox(t), ...fixture({ entropy, privateRepo: true }) };
  const result = await createVideoProject(input), value = await report(result);
  assert.equal(value.history[1].entropy.status, 'partial'); assert.equal(value.history[1].entropy.score, .25485);
  assert.equal(value.history[1].entropy.signals.scatter.coverage, 'partial');
  assert.equal(value.history[1].entropy.signals.rework.value, 0);
  assert.equal(value.privacyLabel, 'Private workspace');
  assert.ok(!JSON.stringify(value).includes('sensitive/path'));
  input.data.snapshots[1].entropy = { status: 'incomplete', score: null, signals: { rework: { status: 'no_mature_cohorts', value: null, score: null } } };
  const missing = await report(await createVideoProject(input));
  assert.equal(missing.history[1].entropy.score, null);
  assert.equal(missing.history[1].entropy.signals.rework.value, null);
  assert.equal(missing.history[1].entropy.signals.scatter, null);
});

test('zero shortcuts and no selected district stay explicit without fabricating a repair', async t => {
  const result = await createVideoProject({ ...await sandbox(t), ...fixture({ shortcuts: false, selected: false }) });
  const value = await report(result);
  assert.deepEqual(value.ranked, []); assert.equal(value.focus, null);
  assert.match(result.scenes[4].text, /No private-import shortcuts are detected/);
  assert.match(result.scenes[5].text, /No module is selected/);
});

test('inferred gates remain qualified in narration and visual data', async t => {
  const result = await createVideoProject({ ...await sandbox(t), ...fixture({ inferred: true }) });
  assert.equal((await report(result)).focus.inferred, true);
  assert.match(result.scenes[5].text, /inferred gate/);
});

test('repository text is serialized as inert data and portraits are credited as generated', async t => {
  const name = "'); globalThis.strataTemplateInjected = true; // </script>";
  const input = { ...await sandbox(t), ...fixture({ name }) };
  const result = await createVideoProject({ ...input, portrait: input.assets.origin });
  const module = await import(pathToFileURL(join(result.projectPath, 'data.mjs')).href);
  assert.equal(module.default.name, name); assert.equal(globalThis.strataTemplateInjected, undefined);
  assert.equal(module.default.portrait, true);
  assert.match(await readFile(join(result.projectPath, 'CREDITS.md'), 'utf8'), /artistic interpretation/);
  assert.ok(!(await readFile(join(result.projectPath, 'scenes.js'), 'utf8')).includes(name));
});

test('rejects overlong narration and script control syntax before creating the project', async t => {
  const input = { ...await sandbox(t), ...fixture() };
  for (const chapter of input.story.chapters) chapter.caption = 'code '.repeat(39).trim();
  await assert.rejects(createVideoProject(input), /limit is 180/);
  await assert.rejects(access(input.directory));
  input.story = fixture().story; input.story.chapters[0].caption = 'Review [#evil] the public boundary.';
  await assert.rejects(createVideoProject(input), /script control syntax/);
  await assert.rejects(access(input.directory));
});
