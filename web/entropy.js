import { escape } from './html.js';

const names = { rework: 'Rework', scatter: 'Scatter', shortcuts: 'Shortcuts' };
export function signalReason(signal) {
  if (signal?.status === 'history_analysis_disabled') return 'Run strata scan --history-analysis for historical metrics.' + (Number.isFinite(signal.rawRatio) ? ' The raw shortcut ratio excludes the age premium.' : '');
  if (signal?.status === 'unknown_test_ownership') return signal.unknownTestFiles ? `${signal.unknownTestFiles} tests in recent changes have no single module owner.` : 'Some test lines have no single module owner.';
  return ({ no_mature_cohorts: 'No fully observed additions in the recent cohort window.', no_recent_changes: 'No changes in this observation window.', no_resolved_imports: 'No resolved imports to measure.', shallow_history: 'Full Git history is needed.', nonmonotonic_timestamps: 'Commit dates are out of order.', snapshot_precedes_history: 'This snapshot predates the observed history.' })[signal?.status] || signal?.reason || 'Needs more history data.';
}
export function signalValue(id, value) { return Number.isFinite(value) ? id === 'scatter' ? value.toFixed(2) : (value * 100).toFixed(1) + '%' : 'Unavailable'; }
function coverageNote(signal) {
  if (signal?.coverage !== 'partial') return '';
  if (Number.isFinite(signal.attributionRatio)) {
    return `Partial coverage: ${(signal.attributionRatio * 100).toFixed(1)}% of changed lines attributed; ${signal.unknownTestFiles || 0} unmatched test files. Changes with no attributed lines are excluded.`;
  }
  return signal.reason || `Partial coverage: ${signal.unassignedLines || 0} lines have no district owner. This value covers known cohorts.`;
}
export function entropyCard(entropy, title = 'Entropy') {
  const complete = Number.isFinite(entropy?.score), signals = entropy?.signals || {};
  const partial = entropy?.status === 'partial';
  const ready = Object.values(signals).filter(s => Number.isFinite(s?.score)).length;
  return `<div class="entropy-heading"><span>${escape(title)}</span><span class="entropy-version">${partial ? 'PARTIAL · ' : ''}EXPERIMENTAL</span></div><div class="entropy-score"><strong>${complete ? entropy.score.toFixed(2) : '—'}</strong><span>${complete ? '/ 1.00' : entropy ? `${ready}/3 signals ready` : 'Rescan to calculate'}</span></div><details class="entropy-details"><summary>${partial ? 'What does this partial score cover?' : complete ? 'What makes up this score?' : 'Why is this incomplete?'}</summary>${Object.entries(names).map(([id, name]) => {
    const signal = signals[id], value = signal?.value, score = signal?.score;
    const raw = id === 'shortcuts' && !Number.isFinite(value) && Number.isFinite(signal?.rawRatio) ? signalValue(id, signal.rawRatio) + ' raw' : signalValue(id, value);
    const note = coverageNote(signal) || (!Number.isFinite(score) ? signalReason(signal) : '');
    return `<div class="entropy-signal"><span>${name}</span><b>${raw}</b><div class="entropy-track"><i style="width:${Number.isFinite(score) ? Math.min(100, Math.max(0, score * 100)) : 0}%"></i></div>${note ? `<small>${escape(note)}</small>` : ''}</div>`;
  }).join('')}<p>Equal weights. Heuristic saturation scales: 30% rework, scatter 1.0, 10% weighted shortcuts. These choices are uncalibrated. Missing signals are not treated as zero; partial coverage is disclosed. This index has not been validated as a predictor of maintenance cost.</p></details>`;
}
export function metricHistory(data, metric) {
  return data.snapshots.map(s => metric === 'shortcuts' ? s.shortcuts.length : metric === 'entropy' ? s.entropy?.score ?? null : s.entropy?.signals?.[metric]?.score ?? null);
}
export function historyPath(values, width = 800, height = 36) {
  const max = Math.max(1, ...values.filter(Number.isFinite)); let connected = false;
  return values.map((v, i) => {
    if (!Number.isFinite(v)) { connected = false; return ''; }
    const cmd = connected ? 'L' : 'M'; connected = true;
    return `${cmd}${i / Math.max(1, values.length - 1) * width},${height - v / max * (height - 5)}`;
  }).join(' ');
}
