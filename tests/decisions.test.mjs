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
