import test from 'node:test';
import assert from 'node:assert/strict';
import { storyEvidence, storyCacheKey, validateStory, storyPrompt, STORY_MODEL, STORY_EFFORT } from '../server/story.mjs';
import { CodexClient } from '../server/api.mjs';

const snapshot = (lines, imports, shortcuts, inferred = true) => ({ date: '2026-09-01',
  files: { 'a.js': { lines, source: 'SENSITIVE_SOURCE_NOT_FOR_STORY' } },
  imports: Array(imports).fill({ source: 'secret-filename.js' }), shortcuts: Array(shortcuts).fill({}), desirePaths: [{}],
  districts: [{ id: 'billing', name: 'billing', incoming: shortcuts, shortcuts: 0, inferred, walled: true, public: ['billing/index.js'] }]
});
const data = { schemaVersion: 1, meta: { name: 'sample', private: true, gatePolicy: 'inferred', coverage: 'AST imports' }, snapshots: [snapshot(10, 0, 0), snapshot(30, 8, 2)] };
const storyboard = () => ({ title: 'The shape of growth', subtitle: 'A city shaped by its connections.', chapters: ['origin', 'boundaries', 'growth', 'pressure', 'findings', 'focus', 'outlook'].map((id, index) => ({ id, title: id, caption: 'Inspect the public boundary before changing it.', snapshot: index ? 1 : 0, district: index === 5 ? 'billing' : null })) });

test('story evidence uses observed denominators and excludes file contents and import paths', () => {
  const evidence = storyEvidence(data);
  assert.deepEqual(evidence.history.map(s => [s.files, s.lines, s.imports, s.shortcuts, s.shortcutRate]), [[1, 10, 0, 0, 0], [1, 30, 8, 2, .25]]);
  assert.equal(evidence.history[1].inferredGates, 1);
  assert.equal(evidence.topDistricts[0].id, 'billing');
  assert.ok(!JSON.stringify(evidence).includes('SENSITIVE_SOURCE'));
  assert.ok(!JSON.stringify(evidence).includes('secret-filename'));
  assert.match(evidence.definitions.limitations, /not a validated entropy/);
});
test('story cache responds to evidence changes and model is explicitly Astra medium', () => {
  const evidence = storyEvidence(data);
  assert.equal(storyCacheKey(evidence), storyCacheKey(storyEvidence(data)));
  assert.notEqual(storyCacheKey(evidence), storyCacheKey({ ...evidence, private: false }));
  assert.equal(STORY_MODEL, 'gpt-6-astra'); assert.equal(STORY_EFFORT, 'medium');
});
test('story receives entropy measurements without local ownership diagnostics', () => {
  const entropy = { score: null, status: 'incomplete', signals: { rework: { value: .08, score: .08 / .3, status: 'available' }, scatter: { value: null, score: null, status: 'unknown_test_ownership', unknownTestPaths: ['private-tests/identity.py'] } } };
  const evidence = storyEvidence({ ...data, snapshots: [{ ...data.snapshots[0], entropy }] });
  assert.equal(evidence.history[0].entropy.signals.rework.value, .08);
  assert.equal(evidence.history[0].entropy.score, null);
  assert.equal(evidence.history[0].entropy.signals.scatter.status, 'unknown_test_ownership');
  assert.ok(!JSON.stringify(evidence).includes('private-tests'));
});
test('valid story carries measured evidence and declared generation settings', () => {
  const story = validateStory(JSON.stringify(storyboard()), data);
  assert.equal(story.model, 'gpt-6-astra'); assert.equal(story.effort, 'medium');
  assert.equal(story.chapters.length, 7); assert.equal(story.evidence.history.length, 2);
});
test('generated prose cannot invent figures, dates, or spell quantities around validation', () => {
  const captions = [
    'There are 999 shortcuts.', 'There are 2 files.', 'Pressure reached 50%.',
    'There are ９９９ shortcuts.', 'There are ٩٩٩ shortcuts.', 'Pressure reached ½.',
    'There are two shortcuts.', 'There are twenty-one modules.',
    'There are 𝘵𝘸𝘰 shortcuts.', 'Imports doubled.', 'A quarter of imports bypass gates.',
    'The third district needs review.', 'Growth peaked in September.', 'Growth peaked in May.',
  ];
  for (const caption of captions) {
    const value = storyboard();
    value.chapters[2].caption = caption;
    assert.throws(() => validateStory(value, data), /qualitative prose/, caption);
  }
  for (const field of ['title', 'subtitle']) {
    const value = storyboard(); value[field] = 'Two shortcuts';
    assert.throws(() => validateStory(value, data), /qualitative prose/, field);
  }
  const value = storyboard(); value.chapters[2].title = '50% more code';
  assert.throws(() => validateStory(value, data), /qualitative prose/);
});
test('exact numeric repository, district and code identifiers remain usable', () => {
  const named = structuredClone(data);
  named.meta.name = 'sample2';
  for (const snapshot of named.snapshots) {
    snapshot.files = { 'src/api2/client2.js': { lines: 10, district: 'src/api2' } };
    snapshot.districts[0] = { ...snapshot.districts[0], id: 'src/api2', name: 'api2' };
    snapshot.desirePaths = [{ target: 'src/api2/client2.js', sources: ['caller.js'], districts: ['caller'] }];
  }
  const value = storyboard();
  value.title = 'sample2 / code history';
  value.chapters[5].district = 'src/api2';
  value.chapters[5].title = 'Review src/api2';
  value.chapters[5].caption = 'Inspect api2/client2.js before extending api2.';
  assert.equal(validateStory(value, named).chapters[5].caption, value.chapters[5].caption);
  value.chapters[5].caption = 'Inspect api20 before extending the gate.';
  assert.throws(() => validateStory(value, named), /qualitative prose/);
});
test('qualitative narration invalidates previous numeric-caption caches', () => {
  const evidence = storyEvidence(data);
  assert.notEqual(storyCacheKey(evidence), storyCacheKey({ ...evidence, version: 3 }));
  assert.match(storyPrompt(evidence), /renderer owns all measured figures/);
});
test('story rejects hallucinated snapshot, district, metric fields and overlong text', () => {
  let value = storyboard(); value.chapters[2].snapshot = 99;
  assert.throws(() => validateStory(value, data), /unknown snapshot/);
  value = storyboard(); value.chapters[3].district = 'imaginary';
  assert.throws(() => validateStory(value, data), /unknown district/);
  value = storyboard(); value.chapters[2].entropy = .9;
  assert.throws(() => validateStory(value, data), /chapter order/);
  value = storyboard(); value.chapters[2].caption = 'x'.repeat(201);
  assert.throws(() => validateStory(value, data), /caption/);
  value = storyboard(); value.chapters[0].snapshot = 1;
  assert.throws(() => validateStory(value, data), /endpoints/);
  assert.throws(() => validateStory('not JSON', data), /valid storyboard/);
});
test('Codex turn uses the requested model and effort, and returns the final answer without commentary', async () => {
  class Client extends CodexClient {
    calls = [];
    async connect() { return { signedIn: true, authType: 'chatgpt' }; }
    async request(method, params) {
      this.calls.push([method, params]);
      if (method === 'thread/start') return { thread: { id: 'test' }, model: STORY_MODEL };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          const emit = (method, extra) => this.emit('notification', { method, params: { threadId: 'test', ...extra } });
          emit('item/agentMessage/delta', { delta: 'Working on the story.' });
          emit('item/completed', { item: { type: 'agentMessage', phase: 'commentary', text: 'Working on the story.' } });
          emit('item/completed', { item: { type: 'agentMessage', phase: 'final_answer', text: '{"title":"Final"}' } });
          emit('turn/completed', { turn: { status: 'completed' } });
        });
        return { turn: { id: 'turn' } };
      }
    }
  }
  const client = new Client();
  const result = await client.run({ prompt: 'story', model: STORY_MODEL, effort: STORY_EFFORT, outputSchema: { type: 'object' } });
  assert.equal(result.text, '{"title":"Final"}');
  const start = client.calls.find(([method]) => method === 'turn/start')[1];
  assert.equal(start.model, STORY_MODEL); assert.equal(start.effort, 'medium');
  assert.deepEqual(start.outputSchema, { type: 'object' });
  client.connect = async () => ({ signedIn: true, authType: 'apiKey' });
  await assert.rejects(client.run({ prompt: 'story' }), /ChatGPT account/);
});
