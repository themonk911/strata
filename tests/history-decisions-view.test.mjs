import test from 'node:test';
import assert from 'node:assert/strict';
import { historyDecisionView } from '../web/history-decisions.js';

const beforeRevision = 'a'.repeat(40), revision = 'b'.repeat(40);
const data = { meta: { private: false }, snapshots: [
  { revision: beforeRevision.slice(0, 12), date: '2026-01-01', shortcuts: [{ source: 'orders/use.py', target: 'billing/private.py' }], files: { 'orders/use.py': { district: 'orders' } }, districts: [{ id: 'orders' }] },
  { revision: revision.slice(0, 12), date: '2026-01-02', shortcuts: [], files: { 'orders/use.py': { district: 'orders' }, 'billing/api.py': { district: 'billing' } }, districts: [{ id: 'orders' }, { id: 'billing' }] },
] };
const entry = overrides => ({ id: revision, beforeRevision, revision, beforeSnapshot: 0, afterSnapshot: 1,
  date: '2026-01-02', subject: 'Expose a public operation', patch: '-from billing.private import run\n+from billing import run',
  files: ['orders/use.py'], status: 'classified', label: 'repair', confidence: .82, ...overrides });

test('history view separates model labels from measured before/after counts and real code evidence', () => {
  const result = historyDecisionView(data, { entries: [entry()] });
  assert.equal(result.entries.length, 1);
  assert.match(result.cards, /Repair/);
  assert.match(result.cards, /82% model confidence/);
  assert.match(result.cards, /1 → 0/);
  assert.match(result.cards, /1 → 2/);
  assert.match(result.cards, /from billing\.private import run/);
  assert.match(result.cards, /model interpretation/);
  assert.match(result.cards, /data-snapshot="before"/);
  assert.match(result.cards, /data-snapshot="after"/);
});

test('stale, out-of-range, working-tree and malformed labels cannot target a different snapshot', () => {
  const entries = [entry({ revision: 'c'.repeat(40) }), entry({ beforeSnapshot: -1 }), entry({ afterSnapshot: 50 }),
    entry({ beforeSnapshot: 1 }), entry({ revision: 'working' }), entry({ label: 'proven_fix' })];
  const result = historyDecisionView(data, { entries });
  assert.deepEqual(result.entries, []);
  assert.equal(result.excluded, entries.length);
  assert.equal(result.cards, '');
});

test('private cities can display real saved classifications and absent caches fabricate nothing', () => {
  assert.equal(historyDecisionView({ ...data, meta: { private: true } }, { entries: [entry()] }).entries.length, 1);
  assert.equal(historyDecisionView(data, null).cards, '');
  assert.equal(historyDecisionView(data, { entries: [] }).cards, '');
});

test('sparse scan views are anchored to stored revisions and never presented as this commit alone', () => {
  const sparse = entry({ beforeRevision: 'c'.repeat(40), beforeSnapshotRevision: beforeRevision, exactSnapshots: false });
  const result = historyDecisionView(data, { entries: [sparse] });
  assert.equal(result.entries.length, 1);
  assert.match(result.cards, /Earlier scan/);
  assert.match(result.cards, /Commit view/);
  assert.match(result.cards, /Across these scan views/);
  assert.match(result.cards, /views span several commits; the label describes only this commit/);
  assert.equal(historyDecisionView(data, { entries: [{ ...sparse, beforeSnapshotRevision: 'd'.repeat(40) }] }).entries.length, 0);
  assert.equal(historyDecisionView(data, { entries: [{ ...sparse, exactSnapshots: true }] }).entries.length, 0);
});

test('repository subjects and patches are escaped and refusals stay unlabeled', () => {
  const result = historyDecisionView(data, { entries: [entry({ status: 'refused', confidence: 1, subject: '<img src=x onerror=alert(1)>', patch: '</code><script>alert(1)</script>', truncated: true })] });
  assert.match(result.cards, /Not classified/);
  assert.ok(!result.cards.includes('model confidence'));
  assert.ok(!result.cards.includes('<img'));
  assert.ok(!result.cards.includes('<script>'));
  assert.match(result.cards, /&lt;script&gt;/);
  assert.match(result.cards, /diff was shortened/);
});

test('missing or malformed scan measurements stay unavailable rather than becoming zero or markup', () => {
  const incomplete = structuredClone(data);
  incomplete.snapshots[0].shortcuts = { length: '<img src=x onerror=alert(1)>' };
  delete incomplete.snapshots[0].files;
  const result = historyDecisionView(incomplete, { entries: [entry()] });
  assert.match(result.cards, /— → 0/);
  assert.match(result.cards, /— → 2/);
  assert.ok(!result.cards.includes('<img'));
});

test('repair and reversal interpretations appear before feature and unclear labels', () => {
  const result = historyDecisionView(data, { entries: ['unclear', 'feature', 'reversal', 'repair'].map(label => entry({ label })) });
  assert.deepEqual(result.entries.map(item => item.label), ['repair', 'reversal', 'feature', 'unclear']);
});

test('within a label, stronger model confidence precedes recency without changing labels', () => {
  const newerRevision = 'c'.repeat(40);
  const longer = { ...data, snapshots: [...data.snapshots, { ...data.snapshots[1], revision: newerRevision.slice(0, 12) }] };
  const low = entry({ id: 'newer-low', confidence: .25, revision: newerRevision, afterSnapshot: 2 });
  const strong = entry({ id: 'older-strong', confidence: .79 });
  const tiedNewer = entry({ id: 'newer-strong', confidence: .79, revision: newerRevision, afterSnapshot: 2 });
  const unavailable = entry({ id: 'missing-confidence', confidence: null });
  const refused = entry({ id: 'refused', status: 'refused', confidence: 1 });
  const result = historyDecisionView(longer, { entries: [low, refused, strong, unavailable, tiedNewer] });
  assert.deepEqual(result.entries.map(item => item.id), ['newer-strong', 'older-strong', 'newer-low', 'missing-confidence', 'refused']);
  assert.equal(result.entries[2].label, 'repair');
  assert.equal(result.entries[2].confidence, .25);
});
