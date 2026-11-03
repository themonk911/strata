import { City } from './city.js';
import { openFilm } from './film.js';
import { openBoundaries } from './boundaries.js';
import { entropyCard, metricHistory, historyPath } from './entropy.js';
import { openTour } from './tour.js';
import { escape } from './html.js';
import { openHistoryDecisions } from './history-decisions.js';
import { districtPresentation } from './districts.js';
import './history-decisions.css';

const $ = id => document.getElementById(id);
const number = n => new Intl.NumberFormat('en-GB', { notation: n > 99999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
const date = value => value === 'Working tree' ? value : new Date(value + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
let districtStyles = new Map();
let data, city, selected, selectedFile = null, current = 0, playing = false, speed = 1, lastTick = 0, status = {}, toastTimer, activeJob = null, closeTour = null, closeHistory = null, historyResults = null;
const snapshot = () => data.snapshots[Math.round(current)];
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
async function api(path, input) {
  const response = await fetch('/api/' + path, input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {});
  const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Request failed.'); return body;
}
function chartPath(values, width, h) {
  const max = Math.max(1, ...values); return values.map((v, i) => `${i ? 'L' : 'M'}${i / Math.max(1, values.length - 1) * width},${h - v / max * (h - 5)}`).join(' ');
}
function renderTimeline() {
  const metric = $('history-signal').value, values = metricHistory(data, metric), path = historyPath(values);
  $('history-chart').innerHTML = `<path d="${path}" fill="none" stroke="${metric === 'shortcuts' ? 'var(--violet)' : 'var(--ink)'}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
  $('history-chart').ariaLabel = metric + ' over history';
  $('timeline-note').textContent = values.some(Number.isFinite) ? metric === 'shortcuts' ? 'RESOLVED IMPORTS INTO PRIVATE FILES' : 'FIXED SCALE 0–1 · GAPS MEAN INCOMPLETE DATA' : data.meta.entropy?.analysisMode === 'sampled' ? 'HISTORICAL METRICS OPTIONAL · RUN WITH --history-analysis' : 'NO COMPLETE VALUES YET · INSPECT SIGNAL COVERAGE';
  $('first-date').textContent = date(data.snapshots[0].date); $('last-date').textContent = date(data.snapshots.at(-1).date);
  $('scrubber').max = data.snapshots.length - 1; $('snapshot-count').textContent = `${data.snapshots.length} snapshots · ${data.changes.length.toLocaleString()} commits`;
  const sampling = data.meta.sampling;
  if (sampling) {
    $('snapshot-count').textContent = `${sampling.historicalSnapshots} of ${sampling.availableCommits} commits${sampling.workingTreeIncluded ? ' + working tree' : ''}${sampling.limitedByRecordBudget ? ' · size-limited' : ''}`;
    $('snapshot-count').title = `First-parent history. Up to ${sampling.maxSnapshots} snapshots, with an estimated budget of ${number(sampling.recordBudget)} file/import records.`;
  }
}
function renderDistrictList() {
  const search = $('search').value.toLowerCase(); const s = snapshot();
  const districts = [...s.districts].sort((a, b) => Number(b.walled) - Number(a.walled) || b.incoming - a.incoming || a.name.localeCompare(b.name));
  $('district-count').textContent = districts.length;
  $('district-list').innerHTML = districts.filter(d => d.id.toLowerCase().includes(search)).map(d => {
    const style = districtStyles.get(d.id);
    return `<button class="district-button ${selected === d.id ? 'active' : ''}" data-district="${escape(d.id)}" title="${escape(d.id)} · ${escape(style.title)}" aria-pressed="${selected === d.id}"><span class="district-icon" style="color:${style.color}">${d.walled ? '▥' : '▧'}</span><span class="district-name">${escape(style.label)}</span><span class="count">${d.incoming || '·'}</span></button>`;
  }).join('');
  for (const button of $('district-list').querySelectorAll('button')) button.onclick = () => select(button.dataset.district);
}
function selectedFacts() {
  const s = snapshot(), district = s.districts.find(d => d.id === selected);
  return { district, shortcuts: s.shortcuts.filter(e => s.files[e.source]?.district === selected || s.files[e.target]?.district === selected), desirePaths: s.desirePaths.filter(d => s.files[d.target]?.district === selected) };
}
function renderInspector() {
  const { district: d, shortcuts, desirePaths } = selectedFacts();
  $('district-entropy').hidden = !d;
  $('district-entropy').innerHTML = entropyCard(d?.entropy, 'District entropy');
  if (!d) { $('gate-badge').textContent = ''; $('district-path').textContent = selected || ''; $('district-trend').innerHTML = ''; $('district-title').textContent = selected?.split('/').pop() || 'Choose a district'; $('district-meaning').textContent = 'This district does not exist at this point in history.'; $('incoming').textContent = '0'; $('desire-path').textContent = ''; $('gate-detail').textContent = ''; $('evidence-list').textContent = ''; return; }
  $('district-title').textContent = districtStyles.get(d.id)?.label || d.name.replaceAll('_', ' '); $('district-path').textContent = d.id;
  $('gate-badge').textContent = d.gateStatus === 'unknown' ? 'Candidate boundary · public API unknown' : d.walled ? d.inferred ? 'Inferred gate · review the boundary' : 'Declared public gate' : 'Open neighborhood';
  $('incoming').textContent = d.incoming;
  const values = data.snapshots.map(s => s.districts.find(g => g.id === selected)?.incoming || 0);
  $('district-trend').innerHTML = `<path d="${chartPath(values, 120, 45)}" fill="none" stroke="var(--violet)" stroke-width="1.6"/><circle cx="${Math.round(current) / Math.max(1, values.length - 1) * 120}" cy="${45 - values[Math.round(current)] / Math.max(1, ...values) * 40}" r="3" fill="var(--violet)"/>`;
  const sourceModules = new Set(shortcuts.filter(e => snapshot().files[e.target]?.district === selected).map(e => snapshot().files[e.source]?.district)).size;
  $('district-meaning').textContent = d.incoming ? `${sourceModules} ${sourceModules === 1 ? 'district reaches' : 'districts reach'} past this gate. ${d.shortcuts} outgoing ${d.shortcuts === 1 ? 'shortcut' : 'shortcuts'} from ${d.outgoing} resolved imports.` : d.walled ? 'No other district reaches past this gate in this snapshot.' : 'This folder has no declared wall. Imports into it are not counted as shortcuts.';
  if (Object.values(snapshot().files).some(f => f.district === selected && f.path.endsWith('.swift'))) $('district-meaning').textContent += ' Swift import and gate checks are unavailable; its type links are inferred.';
  const desire = desirePaths[0];
  $('desire-path').innerHTML = desire ? `<span class="file-chip">${escape(desire.target.split('/').slice(-2).join('/'))}</span><p><b>${desire.sources.length} importers across ${desire.districts.length} districts.</b><br>A repeated need might deserve a place in the public API.</p>` : '<p>No private file is reached by two or more distinct districts here.</p>';
  $('gate-detail').textContent = d.public.length ? 'Gate → ' + d.public.map(p => p.split('/').pop()).join(', ') : 'Declare gates in strata.config.json';
  $('evidence-list').innerHTML = shortcuts.slice(0, 25).map(e => `<p>${escape(e.source)}:${e.line}<br><span class="violet">↳ ${escape(e.target)}</span></p>`).join('') || '<p>No detected shortcuts.</p>';
  const candidates = (snapshot().boundaryCandidates || []).filter(e => snapshot().files[e.target]?.district === selected);
  if (candidates.length) $('evidence-list').insertAdjacentHTML('beforeend', `<p><b>${candidates.length} ${candidates.length === 1 ? 'import crosses' : 'imports cross'} this candidate boundary.</b><br>The public API is unknown. Review these imports before declaring gates; they are not counted as shortcuts.</p>${candidates.slice(0, 25).map(e => `<p>${escape(e.source)}:${e.line}<br>↳ ${escape(e.target)}</p>`).join('')}`);
  if (shortcuts.length > 25) $('evidence-list').insertAdjacentHTML('beforeend', `<p>Showing 25 of ${shortcuts.length}. Full evidence is in the city JSON.</p>`);
  const references = (snapshot().inferredReferences || []).filter(e => snapshot().files[e.source]?.district === selected || snapshot().files[e.target]?.district === selected);
  if (references.length) $('evidence-list').insertAdjacentHTML('beforeend', `<p><b>${references.length} inferred Swift type links</b><br>Type-name matches guide layout; build targets and compiler resolution are not checked. Showing up to 25.</p>${references.slice(0, 25).map(e => `<p>${escape(e.source)}:${e.line}<br>↳ ${escape(e.target)}</p>`).join('')}`);
}
function renderMinimap() {
  const { w, d } = city.bounds; const scale = Math.min(145 / w, 105 / d);
  $('minimap').innerHTML = [...city.lots.values()].map(l => `<polygon data-district="${escape(l.id)}" points="${l.hull.map(p => `${(p[0] + w / 2) * scale + 2},${(p[1] + d / 2) * scale + 2}`).join(' ')}" fill="${l.id === selected ? 'var(--violet)' : districtStyles.get(l.id).color}" opacity="${l.id === selected ? 1 : .65}"/>`).join('');
  for (const rect of $('minimap').querySelectorAll('polygon')) rect.onclick = () => select(rect.dataset.district, true);
}
function select(id, focus = false) {
  selected = id; city.select(id, focus); $('intelligence').textContent = ''; renderDistrictList(); renderInspector(); renderMinimap();
}
function selectFile(path) {
  selectedFile = path;
  closeHistory?.setContext({ file: path, mode: 'file' });
}
function update(index, followTimeline = false) {
  const old = Math.round(current); current = Math.max(0, Math.min(data.snapshots.length - 1, index));
  $('scrubber').value = current; $('chart-cursor').style.left = `${current / Math.max(1, data.snapshots.length - 1) * 100}%`;
  if (old !== Math.round(current) || !$('current-date').textContent) {
    const s = snapshot(); city.setSnapshot(current); $('file-count').textContent = number(Object.keys(s.files).length); $('line-count').textContent = number(Object.values(s.files).reduce((n, f) => n + f.lines, 0));
    $('swift-coverage').hidden = !Object.keys(s.files).some(path => path.endsWith('.swift'));
    $('repo-entropy').innerHTML = entropyCard(s.entropy);
    $('shortcut-badge').textContent = s.shortcuts.length; $('current-date').textContent = date(s.date);
    renderDistrictList(); renderInspector();
  }
  closeHistory?.setContext({ snapshot: Math.round(current), ...(followTimeline ? { mode: 'timeline' } : {}) });
}
function play(value) { playing = value; lastTick = performance.now(); $('play').textContent = value ? 'Ⅱ' : '▶'; $('play').ariaLabel = value ? 'Pause history' : 'Play history'; }
function frame(now) {
  if (!playing) return;
  const next = current + (now - lastTick) / 1000 * 2.4 * speed; lastTick = now;
  update(next, true); if (current >= data.snapshots.length - 1) play(false);
}
function hover(file) {
  if (!file) { $('tooltip').hidden = true; return; }
  $('tooltip').innerHTML = `<b>${escape(file.path)}</b><span>${file.deleted ? 'Not present at this point in history' : `${number(file.lines)} lines · ${file.gate ? 'public gate' : 'source file'}`}</span><span>${closeHistory ? 'Click to see classified commits touching this file' : 'Click to inspect the district'}</span>`;
  $('tooltip').style.left = Math.min(innerWidth - 315, Math.max(10, file.x + 16)) + 'px'; $('tooltip').style.top = Math.min(innerHeight - 110, file.y + 16) + 'px'; $('tooltip').hidden = false;
}
function repairTask() {
  const { district, shortcuts, desirePaths } = selectedFacts();
  return `Use Strata to investigate the ${selected} boundary. Snapshot: ${snapshot().revision}. ${district?.inferred ? 'The gate is inferred: confirm the intended API first.' : 'Respect the declared public gate.'}\n\nGate: ${district?.public.join(', ') || 'not declared'}\n\nObserved imports:\n${shortcuts.slice(0, 15).map(e => `${e.source}:${e.line} -> ${e.target}`).join('\n')}\n\n${desirePaths[0] ? `Repeated need: ${desirePaths[0].target}, imported from ${desirePaths[0].districts.length} districts.\n\n` : ''}Inspect the source and tests. Propose the smallest behavior-preserving repair: use an existing public entry point, or expose a narrow stable operation through it. Do not simply mark every private file public. Run the relevant tests and Strata check before and after. Report added/removed shortcuts and any remaining uncertainty.`;
}
async function pollJob(job, onUpdate) {
  activeJob = job.id;
  while (job.status === 'running') { onUpdate(job); await new Promise(r => setTimeout(r, 900)); job = await api('jobs/' + job.id); }
  activeJob = null; onUpdate(job); if (job.status === 'error') throw new Error(job.error); return job;
}
function modal(content) { $('modal-content').innerHTML = content; if (!$('modal').open) $('modal').showModal(); }
async function illustrate() {
  if (activeJob) return toast('Let the current Codex request finish first.');
  if (!status.local) return toast('Image generation needs the local Strata app and a Codex login.');
  play(false); $('postcard').disabled = true;
  const screenshot = city.capture();
  modal('<div class="eyebrow modal-eyebrow">CODEX / CITY PORTRAIT</div><h2>From code to a sense of place.</h2><p>An illustrated interpretation of this exact city view, generated through your Codex login.</p><div id="postcard-status" class="postcard-status"><span class="progress-dot">Connecting to Codex…</span></div>');
  try {
    let job = await api('postcard', { snapshot: Math.round(current), district: selected, screenshot });
    job = await pollJob(job, j => { if ($('postcard-status')) $('postcard-status').textContent = j.activity || 'Generating…'; });
    modal(`<div class="eyebrow modal-eyebrow">CODEX / CITY PORTRAIT</div><h2>The shape of your code.</h2><p>${escape(job.imageLabel)}. Artistic interpretation; the interactive city remains the measured source of truth.</p><img class="postcard-image" alt="Codex illustration of the measured code city" src="${escape(job.image)}"><p><a href="${escape(job.image)}" download="strata-city.png">Save this portrait ↗</a></p>`);
  } catch (error) { if ($('postcard-status')) $('postcard-status').textContent = error.message; toast(error.message); }
  finally { $('postcard').disabled = false; }
}
async function explain() {
  if (activeJob) return toast('Let the current Codex request finish first.');
  if (!status.local) return toast('Investigation needs the local Strata app and a Codex login.');
  play(false);
  $('explain').disabled = true; $('intelligence').textContent = 'Connecting to Codex…';
  const district = selected, index = Math.round(current);
  try {
    const job = await api('explain', { snapshot: index, district });
    await pollJob(job, j => { if (selected === district && Math.round(current) === index) $('intelligence').textContent = j.text || j.activity; });
  } catch (error) { $('intelligence').textContent = error.message; }
  finally { $('explain').disabled = false; }
}
function showAbout() {
  modal(`<div class="eyebrow modal-eyebrow">A FIELD GUIDE TO STRATA</div><h2>Your codebase has a landscape.</h2><p>Strata turns git history into a city you can explore, and gives coding agents the same boundary facts. Find a repeated shortcut, investigate the gate, make a focused repair, and rescan.</p><div class="about-grid"><div><h3>Buildings & districts</h3><p>A building is a source file. Its height grows with the square root of its line count. Deleted files leave an empty plot. Lots stay in the same place across history.</p></div><div><h3>Walls & violet arcs</h3><p>A gate is a module’s public entry point. An arc is a detected import into another module’s private file. Bundles separate into individual imports when you select a district.</p></div><div><h3>Heat & desire paths</h3><p>Warm buildings changed since the previous sampled snapshot. Rings mark private files imported by at least two other districts. Activity dots represent commits, not identified agents.</p></div><div><h3>Evidence & judgment</h3><p>Python and JS/TS imports use AST parsing; computed runtime imports remain outside coverage. Boundaries may be inferred. Codex investigates district boundaries; Decisions classifies historical changes from commit evidence.</p></div></div><p class="code" style="font-size:10px">The optional experimental entropy index combines rework, scatter and shortcuts using uncalibrated scales. Partial coverage is labeled; missing signals leave it incomplete. Run strata scan --history-analysis for historical metrics. It has not been validated as a predictor of maintenance cost. Gate definitions are applied consistently across history. ${escape(data.meta.coverage)}</p>`);
}
function exploreHistory() {
  play(false); closeTour?.(); closeHistory?.();
  closeHistory = openHistoryDecisions({ ...data, historyDecisions: historyResults || data.historyDecisions }, {
    api: status.local ? api : undefined,
    context: { snapshot: Math.round(current), file: selectedFile, mode: selectedFile ? 'file' : 'all' },
    onContext: context => selectedFile = context.file,
    onResults: result => historyResults = result,
    showSnapshot: value => { play(false); update(value); },
    focus: id => select(id, true), close: () => closeHistory = null,
  });
}
async function init() {
  try {
    const local = await fetch('/api/city');
    const localCity = local.ok && local.headers.get('content-type')?.includes('application/json');
    if (localCity) data = await local.json();
    else { const response = await fetch('./city.json'); if (!response.ok) throw new Error('No city data found. Run strata scan first.'); data = await response.json(); }
    status.local = Boolean(localCity);
    if (data.schemaVersion !== 1 || !data.snapshots?.length) throw new Error('Unsupported or empty city data.');
    districtStyles = districtPresentation(data);
    const languages = [...new Map([...districtStyles.values()].map(style => [style.language, style])).values()];
    $('language-legend').innerHTML = languages.map(style => `<span title="${escape(style.title)}"><i style="background:${style.color}"></i>${escape(({typescript:'TS',javascript:'JS',python:'Py',swift:'Swift',mixed:'Mixed'})[style.language])}</span>`).join('');
    current = data.snapshots.length - 1;
    $('repo-name').textContent = data.meta.name; $('repo-privacy').textContent = data.meta.private ? 'Private workspace' : 'Public sample';
    city = new City($('viewport'), data, { select, selectFile, hover, frame });
    if (!data.snapshots.some(s => Number.isFinite(s.entropy?.score))) $('history-signal').value = 'shortcuts';
    if (!metricHistory(data, 'entropy').some(Number.isFinite) && metricHistory(data, 'rework').some(Number.isFinite)) $('history-signal').value = 'rework';
    renderTimeline();
    const ranked = [...snapshot().districts].sort((a, b) => b.incoming - a.incoming);
    select(ranked.find(d => d.walled)?.id || ranked[0]?.id); update(current);
    // Force first statistics paint even though the selected index is unchanged.
    $('current-date').textContent = ''; update(current);
    $('loading').hidden = true;
    $('scrubber').oninput = e => { play(false); update(Number(e.target.value), true); $('intelligence').textContent = ''; };
    $('play').onclick = () => { if (!playing && current >= data.snapshots.length - 1) update(0); play(!playing); };
    $('speed').onclick = () => { speed = speed === 1 ? 2 : speed === 2 ? 4 : 1; $('speed').textContent = speed + '×'; };
    $('search').oninput = renderDistrictList;
    $('history-signal').onchange = renderTimeline;
    $('reset').onclick = () => city.reset(); $('focus').onclick = () => city.select(selected, true);
    $('theme').onclick = () => { const dark = document.body.classList.toggle('dark'); city.theme(dark); };
    $('about').onclick = showAbout; $('close-modal').onclick = () => $('modal').close();
    $('modal').addEventListener('click', e => { if (e.target === $('modal')) $('modal').close(); });
    $('copy-task').onclick = async () => { try { await navigator.clipboard.writeText(repairTask()); toast('Repair task copied. Paste it into Codex.'); } catch { modal('<h2>Repair task</h2><pre style="white-space:pre-wrap">' + escape(repairTask()) + '</pre>'); } };
    $('postcard').onclick = illustrate; $('explain').onclick = explain;
    $('film').onclick = () => { play(false); openFilm(data, { api, pollJob, local: Boolean(status.local), busy: () => Boolean(activeJob) }); };
    $('history-decisions').onclick = exploreHistory;
    $('tour').onclick = () => {
      play(false); closeTour?.(); closeHistory?.();
      closeTour = openTour(data, { showSnapshot: value => { play(false); update(value); }, replay: () => { update(0); play(true); }, focus: id => select(id, true), overview: () => city.overview(), setMode: mode => document.querySelector(`[data-mode="${mode}"]`).click(), exploreHistory, close: () => closeTour = null });
    };
    if (localCity) {
      $('edit-boundaries').hidden = false;
      $('edit-boundaries').onclick = () => {
        if (activeJob) return toast('Let the current request finish first.');
        play(false);
        openBoundaries({ api, refreshCity: async onUpdate => {
          const job = await api('rescan', {});
          await pollJob(job, j => onUpdate(j.activity || 'Refreshing the city…'));
        } });
      };
    }
    $('rescan').onclick = async () => {
      if (activeJob) return toast('Let the current request finish first.');
      $('rescan').disabled = true;
      try { const job = await api('rescan', {}); await pollJob(job, j => { $('connection').textContent = j.activity; }); location.reload(); }
      catch (error) { toast(error.message); $('rescan').disabled = false; }
    };
    for (const button of document.querySelectorAll('[data-mode]')) button.onclick = () => {
      for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('active', b === button);
      city.setMode(button.dataset.mode);
      $('scene-caption').textContent = { city: 'Buildings are files. Walls are module boundaries.', shortcuts: 'Violet arcs reach past a public gate. Follow the repeated paths.', activity: 'Warmth is recent change. Moving dots trace real commits.' }[button.dataset.mode];
    };
    api('status').then(s => { status = s; $('connection').innerHTML = `<span class="status-dot"></span>${s.signedIn ? 'Codex connected' : 'Local workspace'}`; }).catch(() => { status = { local: Boolean(localCity) }; $('connection').textContent = localCity ? 'Local workspace' : 'Static city'; });
  } catch (error) { $('loading').innerHTML = `<p>${escape(error.message)}</p><p>Run the scanner, then <code>npm run build && npm run dev</code>.</p>`; }
}
init();
