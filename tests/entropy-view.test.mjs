import test from 'node:test';
import assert from 'node:assert/strict';
import { entropyCard, historyPath } from '../web/entropy.js';

test('partial entropy remains visible with its attribution coverage', () => {
  const html = entropyCard({ score: 0.42, status: 'partial', signals: {
    rework: { score: 0.4, value: 0.12 },
    scatter: { score: 0.3, value: 0.3, coverage: 'partial', attributionRatio: 0.8, unknownTestFiles: 2 },
    shortcuts: { score: 0.56, value: 0.056 },
  } });
  assert.match(html, /0\.42/);
  assert.match(html, /PARTIAL/);
  assert.match(html, /80\.0% of changed lines attributed/);
  assert.match(html, /2 unmatched test files/);
  assert.match(html, /uncalibrated/);
});

test('sampled history labels raw shortcuts separately from unavailable historical scores', () => {
  const html = entropyCard({ score: null, status: 'incomplete', signals: {
    rework: { score: null, value: null, status: 'history_analysis_disabled' },
    scatter: { score: null, value: null, status: 'history_analysis_disabled' },
    shortcuts: { score: null, value: null, status: 'history_analysis_disabled', rawRatio: 0.25 },
  } });
  assert.match(html, /25\.0% raw/);
  assert.match(html, /0\/3 signals ready/);
  assert.match(html, /--history-analysis/);
  assert.match(html, /excludes the age premium/);
});

test('coverage explanations escape repository-controlled text and missing chart points remain gaps', () => {
  const html = entropyCard({ score: 0.5, status: 'partial', signals: {
    rework: { score: 0.5, value: 0.15, coverage: 'partial', reason: '<img src=x onerror="alert(1)">' },
  } }, 'A <script> title');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;img/);
  assert.equal((historyPath([0.2, null, 0.4]).match(/M/g) || []).length, 2);
  assert.ok(!historyPath([0.2, null, 0.4]).includes('L'));
});
