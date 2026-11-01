import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionRequest, decisionCacheKey, decide } from '../server/api.mjs';

test('decision request has typed actions and retains uncertainty', () => {
  const request = decisionRequest({ district: { inferred: true }, shortcuts: [] });
  assert.equal(request.model, 'gpt-6-luna');
  assert.equal(request.questions[0].type, 'choice');
  assert.ok(request.questions[0].choices.some(c => c.value === 'inspect'));
  assert.equal(JSON.parse(request.input).district.inferred, true);
});
test('cache distinguishes evidence changes', () => {
  assert.equal(decisionCacheKey({ n: 1 }), decisionCacheKey({ n: 1 }));
  assert.notEqual(decisionCacheKey({ n: 1 }), decisionCacheKey({ n: 2 }));
});
test('missing key cannot trigger a request', async () => {
  await assert.rejects(decide({}, ''), /OPENAI_API_KEY/);
});

// Contract: https://developers.openai.com/api/docs/guides/decisions
// Mock transport keeps regression tests offline and avoids using API credits.
test('decision transport sends bounded facts and returns typed answers', async t => {
  const facts = { district: { inferred: true }, shortcuts: [] };
  const answers = [
    { name: 'gate_action', type: 'choice', choice: 'inspect', confidence: 0.8 },
    { name: 'shared_need', type: 'predicate', probability: 0.1 },
  ];
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-only-key');
    assert.deepEqual(JSON.parse(options.body), decisionRequest(facts));
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ model: 'gpt-6-luna', answers, usage: { input_tokens: 42 } });
  });
  const result = await decide(facts, 'test-only-key');
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(result.answers, answers);
  assert.equal(result.usage.input_tokens, 42);
  assert.equal(result.cached, false);
  assert.ok(result.latencyMs >= 0);
  assert.ok(!JSON.stringify(result).includes('test-only-key'));
});

test('missing credentials and oversized evidence never call the API', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected API call'); });
  await assert.rejects(decide({}, ''), /OPENAI_API_KEY/);
  await assert.rejects(decide({ evidence: 'x'.repeat(40_000) }, 'test-only-key'), /Too much evidence/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('transport errors and invalid responses cannot look like successful judgments', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('private upstream diagnostics', { status: 429 }));
  await assert.rejects(decide({}, 'test-only-key'), error => {
    assert.match(error.message, /HTTP 429/);
    assert.ok(!error.message.includes('private upstream diagnostics'));
    return true;
  });
  fetch.mock.mockImplementation(async () => Response.json({ model: 'gpt-6-luna' }));
  await assert.rejects(decide({}, 'test-only-key'), /Unexpected Decisions response/);
  fetch.mock.mockImplementation(async () => { throw new Error('Connection failed'); });
  await assert.rejects(decide({}, 'test-only-key'), /Connection failed/);
});

test('a typed refusal is preserved for the UI', async t => {
  const answers = [{ type: 'refusal', name: 'gate_action', refusal: 'Cannot judge these facts.' }];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ model: 'gpt-6-luna', answers }));
  assert.deepEqual((await decide({}, 'test-only-key')).answers, answers);
});
