import { escape } from './html.js';

const labels = { repair: 'Repair', reversal: 'Reversal', feature: 'Feature', unclear: 'Unclear' };
const priority = { repair: 0, reversal: 1, feature: 2, unclear: 3 };
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
};
const sameRevision = (a, b) => typeof a === 'string' && typeof b === 'string'
  && /^[a-f\d]{12,40}$/i.test(a) && /^[a-f\d]{12,40}$/i.test(b)
  && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));
const shortcutCount = snapshot => Array.isArray(snapshot.shortcuts) ? snapshot.shortcuts.length : '—';
const fileCount = snapshot => snapshot.files && typeof snapshot.files === 'object' && !Array.isArray(snapshot.files) ? Object.keys(snapshot.files).length : '—';
const confidenceFor = entry => entry.status === 'classified' && Number.isFinite(entry.confidence)
  && entry.confidence >= 0 && entry.confidence <= 1 ? entry.confidence : -1;

function entriesFor(data, result) {
  if (!Array.isArray(result?.entries)) return [];
  return result.entries.filter(entry => {
    if (!entry || !Number.isInteger(entry.beforeSnapshot) || !Number.isInteger(entry.afterSnapshot)
        || entry.beforeSnapshot < 0 || entry.beforeSnapshot >= entry.afterSnapshot) return false;
    const before = data.snapshots?.[entry.beforeSnapshot], after = data.snapshots?.[entry.afterSnapshot];
    return before && after && sameRevision(before.revision, entry.beforeSnapshotRevision || entry.beforeRevision)
      && sameRevision(after.revision, entry.revision) && sameRevision(entry.beforeRevision, entry.beforeRevision)
      && (entry.exactSnapshots === false || sameRevision(before.revision, entry.beforeRevision))
      && (entry.status === 'refused' || (entry.status === 'classified' && Object.hasOwn(labels, entry.label)));
  }).sort((a, b) => (a.status === 'refused' ? 4 : priority[a.label]) - (b.status === 'refused' ? 4 : priority[b.label])
    || confidenceFor(b) - confidenceFor(a)
    || b.afterSnapshot - a.afterSnapshot);
}

function districtFor(data, entry, snapshotIndex) {
  const snapshot = data.snapshots[snapshotIndex], counts = new Map();
  for (const path of Array.isArray(entry.files) ? entry.files : []) {
    if (typeof path !== 'string') continue;
    const district = snapshot.files?.[path]?.district;
    if (district && snapshot.districts?.some(item => item.id === district)) counts.set(district, (counts.get(district) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

// Render only entries anchored to this scan. Snapshot measurements remain
// independent of the model's interpretation of the commit and its code diff.
export function historyDecisionView(data, result, context = {}) {
  const allEntries = entriesFor(data, result);
  const mode = context.mode === 'timeline' || (context.mode === 'file' && context.file) ? context.mode : 'all';
  const entries = allEntries.filter(entry => mode === 'timeline' ? entry.afterSnapshot === context.snapshot
    : mode === 'file' ? Array.isArray(entry.files) && entry.files.includes(context.file) : true);
  const cards = entries.map((entry, index) => {
    const before = data.snapshots[entry.beforeSnapshot], after = data.snapshots[entry.afterSnapshot];
    const exact = entry.exactSnapshots !== false;
    const confidence = confidenceFor(entry) >= 0 ? `${Math.round(entry.confidence * 100)}% model confidence` : '';
    const district = districtFor(data, entry, entry.afterSnapshot);
    const subject = typeof entry.subject === 'string' ? entry.subject : 'Untitled commit';
    const patch = typeof entry.patch === 'string' ? entry.patch : '';
    const files = Array.isArray(entry.files) ? entry.files.filter(path => typeof path === 'string') : [];
    return `<article class="history-change" data-change="${index}">
      <div class="history-change-meta"><span class="history-label">${entry.status === 'refused' ? 'Not classified' : labels[entry.label]}</span><span>${escape(confidence)}</span></div>
      ${entry.afterSnapshot === context.snapshot ? '<span class="history-current-badge">Current city snapshot</span>' : ''}
      <h3>${escape(subject)}</h3>
      <p class="history-change-revision">${escape(entry.date || after.date || '')} · ${escape(entry.revision.slice(0, 12))}</p>
      ${exact ? '' : '<p class="history-view-scope">Across these scan views</p>'}
      <div class="history-measurements" aria-label="${exact ? 'Measured snapshot changes' : 'Measurements across these scan views'}"><div><strong>${shortcutCount(before)} → ${shortcutCount(after)}</strong><span>shortcuts</span></div><div><strong>${fileCount(before)} → ${fileCount(after)}</strong><span>source files</span></div></div>
      <div class="history-change-actions"><button type="button" class="secondary-button" data-snapshot="before" data-entry="${index}">${exact ? 'Before' : 'Earlier scan'}</button><button type="button" class="primary" data-snapshot="after" data-entry="${index}">${exact ? 'After' : 'Commit view'} ↗</button>${district ? `<button type="button" class="text-button" data-focus="${index}">Focus district</button>` : ''}</div>
      ${exact ? '' : '<p class="history-view-note">These views span several commits; the label describes only this commit.</p>'}
      <details class="history-changed-files"><summary>${files.length} changed ${files.length === 1 ? 'file' : 'files'} in this commit</summary>${files.length ? `<ul>${files.map(path => `<li><code>${escape(path)}</code></li>`).join('')}</ul>` : '<p>No changed file list was included.</p>'}</details>
      <details class="history-diff"><summary>Read the code diff${entry.truncated ? ' · excerpt' : ''}</summary><p>Commit subject and diff are repository evidence. The label above is a model interpretation.</p>${patch ? `<pre><code>${escape(patch)}</code></pre>` : '<p>No code diff was included for this change.</p>'}${entry.truncated ? '<p>The diff was shortened before classification.</p>' : ''}</details>
    </article>`;
  }).join('');
  const snapshot = data.snapshots?.[context.snapshot];
  const emptyMessage = mode === 'timeline' ? (snapshot?.date === 'Working tree' || snapshot?.revision === 'working' ? 'Working tree is not a commit.' : 'No classification for this snapshot.')
    : mode === 'file' ? 'No cached classifications include this file. Other commits may not have been classified yet.' : '';
  return { entries, cards, total: allEntries.length, emptyMessage,
    excluded: Array.isArray(result?.entries) ? result.entries.length - allEntries.length : 0 };
}

export function openHistoryDecisions(data, { api, showSnapshot, focus, close: onClose, context: initialContext = {}, onResults, onContext } = {}) {
  const previousFocus = document.activeElement;
  const panel = el('aside', 'history-decisions-panel'); panel.ariaLabel = 'Classified code changes'; panel.tabIndex = -1;
  const header = el('div', 'history-decisions-header'), heading = el('div');
  heading.append(el('span', 'eyebrow', 'DECISIONS / CHANGE HISTORY'), el('h2', '', 'Commit history'));
  const close = el('button', 'icon-button', '×'); close.type = 'button'; close.ariaLabel = 'Close classified changes'; header.append(heading, close);
  const intro = el('p', 'history-decisions-intro', 'Labels describe whole commits. Scrub to follow a commit; click a building to filter by file.');
  const status = el('p', 'history-decisions-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const source = el('p', 'history-decisions-source');
  const contextLine = el('div', 'history-decisions-context'), cityContext = el('p'), fileContext = el('p');
  const clearFile = el('button', 'text-button', 'Clear file'); clearFile.type = 'button';
  contextLine.append(cityContext, fileContext, clearFile);
  const scopeRow = el('label', 'history-decisions-filter', 'Scope'), scope = el('select'); scope.ariaLabel = 'Commit history scope';
  for (const [value, title] of [['all', 'All classified commits'], ['timeline', 'Timeline selection'], ['file', 'Selected file']]) {
    const option = el('option', '', title); option.value = value; scope.append(option);
  }
  scopeRow.append(scope);
  const filterRow = el('label', 'history-decisions-filter', 'Show'), filter = el('select'); filter.ariaLabel = 'Filter classified changes';
  for (const [value, title] of [['all', 'All changes'], ['repair', 'Repairs'], ['reversal', 'Reversals'], ['feature', 'Features'], ['unclear', 'Unclear']]) {
    const option = el('option', '', title); option.value = value; filter.append(option);
  }
  filterRow.append(filter);
  const emptyFilter = el('p', 'history-decisions-empty'); emptyFilter.setAttribute('role', 'status');
  const browseAll = el('button', 'secondary-button history-browse-all', 'Browse all classified commits'); browseAll.type = 'button';
  const list = el('div', 'history-decisions-list');
  const consent = el('p', 'history-decisions-consent', 'Sends commit subjects and bounded code diffs to OpenAI; results stay local.');
  const classify = el('button', 'secondary-button history-classify', 'Classify changes'); classify.type = 'button';
  const action = el('div', 'history-decisions-classify'); action.append(consent, classify);
  panel.append(header, intro, contextLine, scopeRow, filterRow, status, source, emptyFilter, browseAll, list, action);
  (document.querySelector('main') || document.body).append(panel); document.body.classList.add('reviewing-history'); panel.focus();
  let disposed = false, busy = false, result = data.historyDecisions, entries = [], view;
  let context = { snapshot: Number.isInteger(initialContext.snapshot) && initialContext.snapshot >= 0 && initialContext.snapshot < data.snapshots.length ? initialContext.snapshot : data.snapshots.length - 1,
    file: typeof initialContext.file === 'string' && initialContext.file ? initialContext.file : null,
    mode: ['all', 'timeline', 'file'].includes(initialContext.mode) ? initialContext.mode : 'all' };
  if (context.mode === 'file' && !context.file) context.mode = 'all';

  function message(text) { status.textContent = text; status.hidden = !text; }
  function controls() {
    classify.disabled = busy || typeof api !== 'function';
    classify.textContent = busy ? 'Reading changes…' : 'Classify changes';
    action.hidden = typeof api !== 'function';
    panel.setAttribute('aria-busy', String(busy));
  }
  function applyFilter() {
    let visible = 0;
    for (const card of list.querySelectorAll('[data-change]')) {
      const entry = entries[Number(card.dataset.change)];
      card.hidden = filter.value !== 'all' && (entry.status !== 'classified' || entry.label !== filter.value);
      if (!card.hidden) visible += 1;
    }
    filterRow.hidden = !view.total;
    emptyFilter.hidden = visible > 0 || (!view.total && context.mode === 'all');
    emptyFilter.textContent = visible ? '' : !entries.length && view.emptyMessage ? view.emptyMessage : 'No commits match this label filter.';
    browseAll.hidden = visible > 0 || !view.total || (context.mode === 'all' && filter.value === 'all');
  }
  function render() {
    view = historyDecisionView(data, result, context); entries = view.entries; list.innerHTML = view.cards;
    const city = data.snapshots[context.snapshot];
    cityContext.textContent = city ? `City view · ${city.date || 'Undated'} · ${String(city.revision || '').slice(0, 12)}` : 'City view · no snapshot selected';
    fileContext.textContent = context.file ? `Selected file · ${context.file}` : ''; fileContext.hidden = !context.file; clearFile.hidden = !context.file;
    const fileOption = scope.querySelector('[value="file"]'); fileOption.hidden = !context.file; fileOption.disabled = !context.file; scope.value = context.mode;
    const skipped = Number.isInteger(result?.skipped) && result.skipped >= 0 ? result.skipped : 0;
    source.textContent = view.total ? `${entries.length} of ${view.total} classified commits${skipped ? ` · ${skipped} skipped` : ''} · ${typeof result.model === 'string' ? result.model : 'Decisions'} · model labels, measured counts` : '';
    source.hidden = !view.total;
    if (view.excluded) message(`${view.excluded} saved ${view.excluded === 1 ? 'entry does' : 'entries do'} not match this scan and cannot be shown.`);
    else if (view.total) message('');
    else if (typeof api !== 'function') message('No classifications are saved in this city. Open the local app to classify changes.');
    else message('No changes have been classified yet.');
    for (const button of list.querySelectorAll('[data-snapshot]')) button.onclick = () => {
      const entry = entries[Number(button.dataset.entry)], index = entry?.[button.dataset.snapshot === 'before' ? 'beforeSnapshot' : 'afterSnapshot'];
      if (!Number.isInteger(index)) return;
      const side = button.dataset.snapshot;
      setContext({ snapshot: index, mode: context.mode === 'timeline' ? 'all' : context.mode });
      showSnapshot?.(index);
      const district = districtFor(data, entry, index); if (district) focus?.(district);
      const currentEntry = entries.findIndex(item => item.revision === entry.revision);
      for (const other of list.querySelectorAll('[data-snapshot]')) other.setAttribute('aria-pressed', String(Number(other.dataset.entry) === currentEntry && other.dataset.snapshot === side));
      const name = entry.exactSnapshots === false ? (side === 'before' ? 'earlier scan' : 'commit view') : side;
      message(`${side === 'before' ? 'Comparison view' : 'Commit view'} · ${name}: ${data.snapshots[index].date || data.snapshots[index].revision}. Label: ${entry.revision.slice(0, 12)}.`);
    };
    for (const button of list.querySelectorAll('[data-focus]')) button.onclick = () => {
      const entry = entries[Number(button.dataset.focus)], district = entry && districtFor(data, entry, entry.afterSnapshot);
      if (district) { setContext({ snapshot: entry.afterSnapshot }); showSnapshot?.(entry.afterSnapshot); focus?.(district); }
    };
    applyFilter();
  }
  async function request(classifying) {
    if (busy || typeof api !== 'function') return;
    busy = true; controls(); message(classifying ? 'Decisions is reading the selected changes…' : 'Loading saved classifications…');
    try {
      const loaded = classifying ? await api('history-decisions', {}) : await api('history-decisions');
      if (disposed) return;
      if (loaded || classifying) result = loaded;
      if (loaded) onResults?.(loaded);
      render();
      if (classifying && !view.total && !view.excluded) message('No changes were classified. The selected history may not have classifiable code diffs.');
    } catch (error) { if (!disposed) message(error.message || 'Could not load history classifications.'); }
    finally { busy = false; if (!disposed) controls(); }
  }
  function setContext(next = {}) {
    if (disposed) return;
    const updated = { ...context };
    if (Number.isInteger(next.snapshot) && next.snapshot >= 0 && next.snapshot < data.snapshots.length) updated.snapshot = next.snapshot;
    if (Object.hasOwn(next, 'file')) updated.file = typeof next.file === 'string' && next.file ? next.file : null;
    if (['all', 'timeline', 'file'].includes(next.mode)) updated.mode = next.mode;
    if (updated.mode === 'file' && !updated.file) updated.mode = 'all';
    if (updated.snapshot === context.snapshot && updated.file === context.file && updated.mode === context.mode) return;
    context = updated; render(); onContext?.({ ...context });
  }
  function dispose() {
    if (disposed) return; disposed = true;
    document.removeEventListener('keydown', onKey); panel.remove(); document.body.classList.remove('reviewing-history');
    if (previousFocus?.isConnected) previousFocus.focus(); onClose?.();
  }
  function onKey(event) { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.preventDefault(); dispose(); } }
  document.addEventListener('keydown', onKey); close.onclick = dispose; classify.onclick = () => request(true); filter.onchange = applyFilter;
  scope.onchange = () => setContext({ mode: scope.value }); clearFile.onclick = () => setContext({ file: null, mode: 'all' });
  browseAll.onclick = () => { filter.value = 'all'; setContext({ mode: 'all' }); applyFilter(); };
  render(); controls(); if (typeof api === 'function') request(false);
  dispose.setContext = setContext;
  return dispose;
}
