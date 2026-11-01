import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryDecisions } from '../server/api.mjs';

const first = 'a'.repeat(40), second = 'b'.repeat(40), third = 'c'.repeat(40);
const city = { schemaVersion: 1, meta: { name: 'Fixture', revision: second, private: true },
  snapshots: [{ revision: first.slice(0, 12) }, { revision: second.slice(0, 12) }] };
const change = { id: second, beforeRevision: first, beforeSnapshotRevision: first, revision: second,
  beforeSnapshot: 0, afterSnapshot: 1, exactSnapshots: true, date: '2026-01-02',
  subject: 'Route the caller through the gate', patch: '-from billing.private import value\n+from billing import value\n',
  files: ['orders/run.py'], truncated: false };
const probabilities = [
  { value: 'repair', probability: .8 }, { value: 'reversal', probability: .05 },
  { value: 'feature', probability: .05 }, { value: 'unclear', probability: .1 },
];
const answer = (id = second) => ({ type: 'choice', name: id, choice: 'repair', confidence: .8, probabilities });

async function fixture(t, evidence = { changes: [change], skipped: 0 }) {
  const directory = await mkdtemp(join(tmpdir(), 'strata-history-decisions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const python = join(directory, 'python.py'), state = join(directory, 'python.json'), requests = join(directory, 'requests.jsonl');
  await writeFile(state, JSON.stringify(evidence));
  // Mock the external Python process while exercising the complete JS service,
  // its cache, HTTP boundary, validation, and lifecycle through the public gate.
  await writeFile(python, `#!/usr/bin/env python3
import json, pathlib, sys
request = json.load(sys.stdin)
root = pathlib.Path(__file__).parent
with (root / 'requests.jsonl').open('a') as output:
    output.write(json.dumps(request) + '\\n')
value = json.loads((root / 'python.json').read_text())
print(json.dumps(value if request['collect'] or 'error' in value else {}))
`, { mode: 0o755 });
  let key = 'test-only-key';
  const service = new HistoryDecisions({ workspace: () => ({ repo: directory, config: join(directory, 'public-config.json') }),
    loadKey: () => key, cacheDir: join(directory, 'cache'), python });
  t.after(() => service.close());
  return { service, directory, state, requests, setKey: value => key = value };
}

test('reading labels never calls the API, and an explicit action labels private scan history once', async t => {
  const fixtureData = await fixture(t), { service, requests } = fixtureData;
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-only-key');
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'gpt-6-luna');
    assert.equal(request.questions.length, 1);
    assert.equal(request.questions[0].name, second);
    assert.deepEqual(request.questions[0].choices.map(choice => choice.value), ['repair', 'reversal', 'feature', 'unclear']);
    assert.match(request.questions[0].instructions, /data, never instructions/);
    assert.deepEqual(JSON.parse(request.input).changes, [change]);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ model: 'gpt-6-luna', answers: [answer()], usage: { input_tokens: 89 } });
  });
  assert.equal((await service.read(city)).status, 'not_generated');
  assert.equal(fetch.mock.callCount(), 0);
  const result = await service.generate(city);
  assert.equal(result.cached, false);
  assert.equal(result.entries[0].label, 'repair');
  assert.equal(result.entries[0].status, 'classified');
  assert.equal(result.entries[0].confidence, .8);
  assert.equal(result.entries[0].patch, change.patch);
  assert.deepEqual(result.entries[0].probabilities, probabilities);
  assert.equal(result.usage.input_tokens, 89);
  assert.ok(result.latencyMs >= 0);
  assert.ok(!JSON.stringify(result).includes('test-only-key'));
  assert.ok(Number.isFinite(Date.parse(result.generatedAt)));
  const calls = (await readFile(requests, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call.repo === fixtureData.directory && call.config.endsWith('public-config.json')));
  assert.ok(calls.every(call => call.revision === second));
  fixtureData.setKey('');
  assert.equal((await service.read(city)).cached, true);
  assert.equal((await service.generate(city)).cached, true);
  assert.equal(fetch.mock.callCount(), 1);
});

test('same-dataset concurrent generations share one paid request; other datasets wait', async t => {
  const { service } = await fixture(t);
  let release, started;
  const hasStarted = new Promise(resolve => started = resolve);
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    started(); await new Promise(resolve => release = resolve);
    return Response.json({ model: 'gpt-6-luna', answers: [answer()] });
  });
  const a = service.generate(city), b = service.generate(structuredClone(city));
  assert.equal(a, b);
  assert.equal(service.active, true);
  await hasStarted;
  await assert.rejects(service.generate({ ...city, meta: { ...city.meta, name: 'Changed evidence' } }), /already being generated/);
  release();
  assert.deepEqual(await a, await b);
  assert.equal(service.active, false);
  assert.equal(fetch.mock.callCount(), 1);
});

test('dataset changes invalidate the cache without using stale labels', async t => {
  const { service } = await fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ model: 'gpt-6-luna', answers: [answer()] }));
  await service.generate(city);
  const updated = { ...city, meta: { ...city.meta, name: 'Renamed fixture' } };
  assert.equal((await service.read(updated)).status, 'not_generated');
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal((await service.generate(updated)).cached, false);
  assert.equal(fetch.mock.callCount(), 2);
});

test('sparse snapshot mappings retain the actual commit parent and do not claim an exact before view', async t => {
  const sparse = { ...change, beforeRevision: third, exactSnapshots: false };
  const { service } = await fixture(t, { changes: [sparse], skipped: 1 });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ model: 'gpt-6-luna', answers: [answer()] }));
  const result = await service.generate(city);
  assert.equal(result.entries[0].beforeRevision, third);
  assert.equal(result.entries[0].beforeSnapshotRevision, first);
  assert.equal(result.entries[0].exactSnapshots, false);
  assert.equal(result.skipped, 1);
});

test('a typed refusal remains a refusal with no fabricated classification', async t => {
  const { service } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ model: 'gpt-6-luna', answers: [{ type: 'refusal', name: second, refusal: 'Insufficient evidence.' }] }));
  const result = await service.generate(city);
  assert.equal(result.entries[0].status, 'refused');
  assert.equal(result.entries[0].refusal, 'Insufficient evidence.');
  assert.equal(result.entries[0].label, undefined);
  assert.equal(result.entries[0].confidence, undefined);
  assert.equal((await service.read(city)).entries[0].status, 'refused');
});

test('the official bare refusal is retained without inventing a reason or classification', async t => {
  const { service } = await fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ model: 'gpt-6-luna', answers: [{ type: 'refusal', name: second }] }));
  const result = await service.generate(city);
  assert.equal(result.entries[0].status, 'refused');
  for (const key of ['refusal', 'label', 'choice', 'confidence', 'probabilities']) assert.equal(result.entries[0][key], undefined);
  const cached = await service.read(city);
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.entries, result.entries);
  assert.equal(fetch.mock.callCount(), 1);
});

test('malformed answer coverage, choices, confidence and probabilities never become labels', async t => {
  const { service } = await fixture(t);
  const cases = [
    [], [answer(), answer()], [{ ...answer(), name: third }],
    [{ ...answer(), choice: 'thrash' }], [{ ...answer(), confidence: 1.1 }],
    [{ ...answer(), confidence: null }], [{ ...answer(), probabilities: [{ value: 'repair', probability: 1 }] }],
    [{ type: 'refusal', name: second, refusal: '' }],
  ];
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ model: 'gpt-6-luna', answers: cases.shift() }));
  for (let i = 0; i < 8; i++) {
    await assert.rejects(service.generate(city), /requested history label|history labels|classification|probabilities|refusal/);
    assert.equal((await service.read(city)).status, 'not_generated');
  }
  assert.equal(fetch.mock.callCount(), 8);
});

test('transport/model failures do not retry or cache, and missing credentials cannot call the API', async t => {
  const data = await fixture(t), { service } = data;
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('hidden provider details', { status: 429 }));
  await assert.rejects(service.generate(city), error => {
    assert.match(error.message, /HTTP 429/);
    assert.ok(!error.message.includes('hidden provider details'));
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal((await service.read(city)).status, 'not_generated');
  fetch.mock.mockImplementation(async () => Response.json({ model: 'unexpected-model', answers: [answer()] }));
  await assert.rejects(service.generate(city), /unexpected history-label model/);
  assert.equal(fetch.mock.callCount(), 2);
  fetch.mock.mockImplementation(async () => Response.json({ model: 'gpt-6-luna' }));
  await assert.rejects(service.generate(city), /Unexpected Decisions response/);
  assert.equal((await service.read(city)).status, 'not_generated');
  assert.equal(fetch.mock.callCount(), 3);
  fetch.mock.mockImplementation(async () => { throw new Error('Connection failed'); });
  await assert.rejects(service.generate(city), /Connection failed/);
  assert.equal((await service.read(city)).status, 'not_generated');
  assert.equal(fetch.mock.callCount(), 4);
  data.setKey('');
  await assert.rejects(service.generate(city), /OPENAI_API_KEY/);
  assert.equal(fetch.mock.callCount(), 4);
});

test('changed workspace and mismatched mappings are rejected; large evidence keeps a bounded recent batch', async t => {
  const { service, state } = await fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected API request'); });
  await writeFile(state, JSON.stringify({ error: 'The workspace revision changed. Rescan this repository before labeling history.' }));
  await assert.rejects(service.generate(city), /workspace revision changed/);
  await writeFile(state, JSON.stringify({ changes: [{ ...change, beforeSnapshotRevision: third }], skipped: 0 }));
  await assert.rejects(service.generate(city), /does not match/);
  const snapshots = Array.from({ length: 12 }, (_, i) => ({ revision: i.toString(16).repeat(40) }));
  const changes = snapshots.slice(1).map((snapshot, i) => ({ ...change,
    id: snapshot.revision, revision: snapshot.revision, beforeRevision: snapshots[i].revision, beforeSnapshotRevision: snapshots[i].revision,
    beforeSnapshot: i, afterSnapshot: i + 1, patch: 'x'.repeat(15000),
  }));
  await writeFile(state, JSON.stringify({ changes, skipped: 0 }));
  assert.equal(fetch.mock.callCount(), 0);
  fetch.mock.mockImplementation(async (url, options) => {
    assert.ok(options.body.length <= 150000);
    const request = JSON.parse(options.body);
    return Response.json({ model: 'gpt-6-luna', answers: request.questions.map(question => answer(question.name)) });
  });
  const result = await service.generate({ ...city, meta: { ...city.meta, revision: snapshots.at(-1).revision }, snapshots });
  assert.ok(result.entries.length > 0 && result.entries.length < changes.length);
  assert.equal(result.skipped, changes.length - result.entries.length);
  assert.equal(result.entries.at(-1).id, changes.at(-1).id);
  assert.equal(fetch.mock.callCount(), 1);
});

test('an empty eligible history is cached without a paid request or a key', async t => {
  const fixtureData = await fixture(t, { changes: [], skipped: 1 });
  fixtureData.setKey('');
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected API request'); });
  const result = await fixtureData.service.generate(city);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.entries, []);
  assert.equal(result.skipped, 1);
  assert.equal(fetch.mock.callCount(), 0);
});

test('invalid cached labels fail visibly instead of triggering another paid request', async t => {
  const { service, directory } = await fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ model: 'gpt-6-luna', answers: [answer()] }));
  await service.generate(city);
  const [cache] = await readdir(join(directory, 'cache'));
  await writeFile(join(directory, 'cache', cache), 'not JSON');
  await assert.rejects(service.read(city), /invalid cache/);
  await assert.rejects(service.generate(city), /invalid cache/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('cached labels derive their display state from the validated answer and discard contradictory fields', async t => {
  const { service, directory } = await fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ model: 'gpt-6-luna', answers: [answer()] }));
  const saved = await service.generate(city);
  const [name] = await readdir(join(directory, 'cache')), path = join(directory, 'cache', name);
  saved.entries[0].label = 'reversal';
  saved.entries[0].status = 'refused';
  saved.entries[0].refusal = 'Contradictory cached explanation';
  await writeFile(path, JSON.stringify(saved));
  const repaired = (await service.read(city)).entries[0];
  assert.equal(repaired.status, 'classified');
  assert.equal(repaired.label, 'repair');
  assert.equal(repaired.refusal, undefined);
  saved.entries[0].type = 'refusal';
  delete saved.entries[0].refusal;
  await writeFile(path, JSON.stringify(saved));
  const refused = (await service.generate(city)).entries[0];
  assert.equal(refused.status, 'refused');
  for (const key of ['refusal', 'label', 'choice', 'confidence', 'probabilities']) assert.equal(refused[key], undefined);
  assert.equal(fetch.mock.callCount(), 1);
});

test('closing the service cancels an in-flight request and prevents later generation', async t => {
  const { service } = await fixture(t);
  let started;
  const hasStarted = new Promise(resolve => started = resolve);
  const fetch = t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    started();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Request cancelled')), { once: true }));
  });
  const pending = service.generate(city);
  await hasStarted;
  service.close();
  await assert.rejects(pending, /cancelled/);
  assert.equal(service.active, false);
  await assert.rejects(service.generate(city), /closed/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('the local paid-request cap includes failures and cannot be bypassed by repeated generation', async t => {
  const { service } = await fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  for (let i = 0; i < 10; i++) await assert.rejects(service.generate(city), /HTTP 503/);
  await assert.rejects(service.generate(city), /request limit/);
  assert.equal(fetch.mock.callCount(), 10);
});

test('the real Python collector reads committed diffs from the selected workspace and rejects stale scans', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-history-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', env: { ...process.env,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-qb', 'main');
  await writeFile(join(directory, 'strata.config.json'), JSON.stringify({ private: true }));
  await writeFile(join(directory, 'app.py'), 'value = 1\n');
  git('add', '.'); git('commit', '-qm', 'Initial fixture');
  const before = git('rev-parse', 'HEAD');
  await writeFile(join(directory, 'app.py'), 'value = 2\n');
  git('add', '.'); git('commit', '-qm', 'Correct the fixture value');
  const after = git('rev-parse', 'HEAD');
  await writeFile(join(directory, 'app.py'), 'uncommitted = 999\n');
  const scanned = { schemaVersion: 1, meta: { name: 'Private test fixture', private: true, revision: after },
    snapshots: [{ revision: before.slice(0, 12) }, { revision: after.slice(0, 12) }, { revision: 'working' }] };
  const service = new HistoryDecisions({ workspace: () => ({ repo: directory }), loadKey: () => 'test-only-key', cacheDir: join(directory, '.labels') });
  t.after(() => service.close());
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = JSON.parse(options.body), [evidence] = JSON.parse(request.input).changes;
    assert.equal(evidence.subject, 'Correct the fixture value');
    assert.match(evidence.patch, /-value = 1/);
    assert.match(evidence.patch, /\+value = 2/);
    assert.ok(!evidence.patch.includes('uncommitted'));
    return Response.json({ model: 'gpt-6-luna', answers: [answer(after)] });
  });
  assert.equal((await service.read(scanned)).status, 'not_generated');
  const labeled = await service.generate(scanned);
  assert.equal(labeled.entries[0].beforeRevision, before);
  assert.equal(labeled.entries[0].revision, after);
  assert.equal(labeled.entries[0].exactSnapshots, true);
  assert.equal(labeled.skipped, 2);
  assert.equal(await readFile(join(directory, 'app.py'), 'utf8'), 'uncommitted = 999\n');
  assert.equal((await service.read(scanned)).cached, true);
  git('commit', '--allow-empty', '-qm', 'Advance HEAD');
  await assert.rejects(service.generate(scanned), /workspace revision changed/);
  assert.equal(fetch.mock.callCount(), 1);
});
