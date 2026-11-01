export async function requestDecisions(request, key, { maxCharacters = 40000, signal } = {}) {
  if (!key) throw new Error('Add OPENAI_API_KEY to .env.local to use the Decisions API. The city and Codex work without it.');
  const payload = JSON.stringify(request);
  if (payload.length > maxCharacters) throw new Error('Too much evidence for a single Decisions request. Choose a smaller history.');
  const start = performance.now();
  const timeout = AbortSignal.timeout(20000);
  const response = await fetch('https://api.openai.com/v1/decisions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: payload, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`Decisions API returned HTTP ${response.status}. Check API access and available credits.`);
  const body = await response.json();
  if (!Array.isArray(body.answers)) throw new Error('Unexpected Decisions response.');
  return { answers: body.answers, model: body.model, usage: body.usage, latencyMs: Math.round(performance.now() - start), cached: false };
}
