import { City } from './city.js';
import { FILM_SECONDS, defaultStory, measures, filmPosition } from './film-data.js';
import { signalValue } from './entropy.js';
import { narratedVideo } from './video.js';
import { fixWebmDuration } from '@fix-webm-duration/fix';
import './film.css';

const ink = '#23372e', muted = '#778276', violet = '#8261b4', paper = '#f4f3ee';
const fmt = n => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(n);
const shortDate = s => s === 'Working tree' ? s : new Date(s + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const el = (tag, cls, text) => { const node = document.createElement(tag); node.className = cls || ''; if (text) node.textContent = text; return node; };

export function openFilm(data, { api, pollJob, local, busy }) {
  const dialog = el('dialog', 'film-dialog');
  const heading = el('div', 'film-heading');
  const headingText = el('div'); headingText.append(el('span', 'eyebrow', 'STRATA / MOTION ATLAS'), el('h2', '', 'Your codebase on film.'));
  const close = el('button', 'film-close', '×'); close.ariaLabel = 'Close codebase film'; heading.append(headingText, close);
  const stage = el('div', 'film-stage'), canvas = el('canvas'); canvas.width = 1280; canvas.height = 720; canvas.ariaLabel = 'Animated infographic of codebase history'; stage.append(canvas);
  const host = el('div', 'film-render-host'); host.ariaHidden = 'true'; document.body.append(host);
  const controls = el('div', 'film-controls'), play = el('button', 'film-play', 'Play film'), scrub = el('input'), clock = el('span', 'film-clock', `00:00 / 00:${FILM_SECONDS}`);
  scrub.type = 'range'; scrub.min = 0; scrub.max = FILM_SECONDS; scrub.step = .05; scrub.value = 0; scrub.ariaLabel = 'Film position'; controls.append(play, scrub, clock);
  const actions = el('div', 'film-actions'), enrich = el('button', 'film-action', '✧ Write with Astra'), illustrate = el('button', 'film-action', '◇ Illustrate ending'), record = el('button', 'film-action', `Export ${FILM_SECONDS}s silent video`);
  actions.append(enrich, illustrate, record);
  const message = el('p', 'film-message', `Measured preview · ${FILM_SECONDS} seconds · silent, with on-screen captions.`); message.setAttribute('role', 'status');
  const privacy = el('p', 'film-privacy', data.meta.private !== false ? 'Private workspace. Downloads contain codebase structure; keep this film private.' : 'Public sample · generated artwork is an interpretation of the measured city.');
  const transcript = el('details', 'film-transcript'); transcript.append(el('summary', '', 'Edit the script'));
  const transcriptBody = el('div'); transcript.append(transcriptBody);
  const silentPreview = el('details', 'film-silent-preview'); silentPreview.open = true;
  silentPreview.append(el('summary', '', 'Silent preview & script'), stage, controls, actions, message, privacy, transcript);
  dialog.append(heading, silentPreview); document.body.append(dialog); dialog.showModal();
  const city = new City(host, data, { hover() {}, select() {} });
  city.renderer.setPixelRatio(1); city.resize();
  const ctx = canvas.getContext('2d');
  let story = defaultStory(data), seconds = 0, running = false, previous = performance.now(), frameId, lastSnapshot = -1, lastChapter = -1;
  let portrait = null, recorder = null, stream = null, disposed = false, busyHere = false, exportURL = null, savedSelect = null, videoReview = null, edited = false;
  let narrated = null, narratedRunning = false, selectedPortraitId = null, capturing = false;
  const series = data.snapshots.map(measures);
  function writeTranscript() {
    transcriptBody.replaceChildren();
    const field = (name, value, max, change, multiline = false) => {
      const label = el('label', 'film-script-field'); label.append(el('span', '', name));
      const input = el(multiline ? 'textarea' : 'input'); input.value = value; input.maxLength = max;
      input.oninput = () => { if (busyHere) return; change(input.value); edited = true; message.textContent = 'Script edited. Preview and export use your wording.'; };
      label.append(input); return label;
    };
    transcriptBody.append(field('Film title', story.title, 60, value => story.title = value));
    for (const [i, chapter] of story.chapters.entries()) {
      const part = el('fieldset', 'film-script-part'); part.append(el('legend', '', String(i + 1).padStart(2, '0') + ' / ' + chapter.id));
      part.append(field('Heading', chapter.title, 60, value => chapter.title = value), field('Caption', chapter.caption, 200, value => chapter.caption = value, true));
      const preview = el('button', 'film-action', 'Preview this slide'); preview.onclick = () => { if (busyHere) return; seconds = i * 8 + 1; running = false; play.textContent = 'Play film'; };
      part.append(preview); transcriptBody.append(part);
    }
  }
  writeTranscript();
  function label(text, x, y, color = muted, size = 12) { ctx.fillStyle = color; ctx.font = `500 ${size}px ui-monospace, SFMono-Regular, monospace`; ctx.fillText(text, x, y); }
  function wrap(text, x, y, width, line, font, color, limit = 5) {
    let size = Number(font.match(/\d+/)[0]), rows;
    do {
      ctx.font = font.replace(/\d+px/, size + 'px'); rows = []; let row = '';
      for (const word of text.split(/\s+/)) { const next = row ? row + ' ' + word : word; if (ctx.measureText(next).width > width && row) { rows.push(row); row = word; } else row = next; }
      if (row) rows.push(row);
      if (rows.length <= limit || size <= 14) break;
      size -= 1;
    } while (true);
    if (rows.length > limit) rows[limit - 1] = rows[limit - 1].replace(/\s+\S*$/, '') + '…';
    ctx.fillStyle = color;
    for (const row of rows.slice(0, limit)) { ctx.fillText(row, x, y); y += line; }
    return y;
  }
  function metric(value, title, x, y, color = ink) {
    ctx.fillStyle = color; ctx.font = '46px Georgia, serif'; ctx.fillText(value, x, y); label(title.toUpperCase(), x, y + 25, muted, 10);
  }
  function drawChart(key, index, x, y, w, h) {
    const values = series.map(s => s[key]), max = Math.max(1, ...values);
    ctx.strokeStyle = '#d6dccf'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.stroke();
    ctx.strokeStyle = '#c6cbbf'; ctx.beginPath(); values.forEach((v, i) => { const xx = x + i / Math.max(1, values.length - 1) * w, yy = y + h - v / max * h; i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }); ctx.stroke();
    ctx.strokeStyle = violet; ctx.lineWidth = 2.5; ctx.beginPath(); values.slice(0, index + 1).forEach((v, i) => { const xx = x + i / Math.max(1, values.length - 1) * w, yy = y + h - v / max * h; i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }); ctx.stroke();
    const xx = x + index / Math.max(1, values.length - 1) * w, yy = y + h - values[index] / max * h;
    ctx.fillStyle = violet; ctx.beginPath(); ctx.arc(xx, yy, 5, 0, Math.PI * 2); ctx.fill();
    label(shortDate(data.snapshots[0].date), x, y + h + 24, muted, 10); label(shortDate(data.snapshots.at(-1).date), x + w - 78, y + h + 24, muted, 10);
  }
  function entropyMeasures(entropy) {
    const signals = entropy.signals || {};
    const ids = ['rework', 'scatter', 'shortcuts'];
    const available = id => signals[id]?.status === 'available' && Number.isFinite(signals[id]?.value);
    const ready = ids.filter(available).length;
    const scored = ['complete', 'partial'].includes(entropy.status) && Number.isFinite(entropy.score);
    label('INDEX / FIXED SCALES', 54, 493, muted, 10);
    ctx.fillStyle = scored ? violet : ink;
    ctx.font = scored ? '40px Georgia, serif' : '29px Georgia, serif';
    ctx.fillText(scored ? entropy.score.toFixed(2) : 'Incomplete', 54, 537);
    if (scored) label('/ 1.00', 149, 535, muted, 12);
    label(entropy.status === 'partial' ? 'Partial coverage' : `${ready}/3 signals measured`, 247, 533, muted, 10);
    const titles = { rework: 'REWORK', scatter: 'SCATTER / 1', shortcuts: 'WEIGHTED SHORTCUTS' };
    for (const [index, id] of ids.entries()) {
      const y = 575 + index * 31;
      ctx.strokeStyle = '#dce1d5'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(54, y - 20); ctx.lineTo(399, y - 20); ctx.stroke();
      label(titles[id], 54, y, muted, 10);
      ctx.save(); ctx.textAlign = 'right'; ctx.fillStyle = available(id) ? ink : muted;
      ctx.font = available(id) ? '18px Georgia, serif' : '13px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(available(id) ? signalValue(id, signals[id].value) : 'Unavailable', 399, y);
      ctx.restore();
    }
  }
  function boundaryDiagram(progress) {
    ctx.fillStyle = paper; ctx.fillRect(470, 90, 810, 565);
    ctx.fillStyle = '#e4e9dd'; ctx.strokeStyle = '#9eae95'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(850, 185, 325, 330, 20); ctx.fill(); ctx.stroke();
    label('A MODULE', 885, 220, ink, 12);
    ctx.fillStyle = '#ced8c6'; ctx.fillRect(952, 264, 160, 68); label('private file', 974, 305, ink, 13);
    ctx.fillStyle = '#fffef8'; ctx.strokeStyle = '#8a9b80'; ctx.beginPath(); ctx.roundRect(815, 378, 145, 62, 8); ctx.fill(); ctx.stroke();
    label('public API', 840, 415, ink, 12);
    ctx.fillStyle = '#e5e8df'; ctx.beginPath(); ctx.roundRect(530, 350, 145, 95, 9); ctx.fill(); label('caller', 574, 402, ink, 15);
    ctx.strokeStyle = '#637e62'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(675, 410); ctx.lineTo(815, 410); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(805, 403); ctx.lineTo(815, 410); ctx.lineTo(805, 417); ctx.stroke();
    label('through the API', 673, 469, '#637e62', 11);
    ctx.strokeStyle = violet; ctx.lineWidth = 3; ctx.setLineDash([7, 6]); ctx.beginPath(); ctx.moveTo(606, 350); ctx.bezierCurveTo(650, 170, 920, 130, 994, 264); ctx.stroke(); ctx.setLineDash([]);
    label('shortcut', 695, 225, violet, 13);
    const t = progress % 1; ctx.fillStyle = '#637e62'; ctx.beginPath(); ctx.arc(683 + t * 124, 410, 5, 0, Math.PI * 2); ctx.fill();
    label('The wall marks ownership. The gate marks the public API.', 533, 578, muted, 12);
  }
  function findings(snapshot) {
    ctx.fillStyle = paper; ctx.fillRect(470, 90, 810, 565);
    const ranked = [...snapshot.districts].filter(d => d.walled && d.incoming > 0).sort((a, b) => b.incoming - a.incoming).slice(0, 3);
    if (!ranked.length) { wrap('No shortcuts detected.', 560, 300, 560, 42, '32px Georgia, serif', ink); return; }
    label('MODULE', 560, 165, muted, 11); label('INCOMING SHORTCUTS', 980, 165, muted, 11);
    for (const [i, district] of ranked.entries()) {
      const y = 218 + i * 130;
      label(String(i + 1).padStart(2, '0'), 560, y, muted, 12);
      wrap(district.name.replaceAll('_', ' '), 607, y, 340, 35, '28px Georgia, serif', ink, 1);
      ctx.fillStyle = violet; ctx.font = '38px Georgia, serif'; ctx.fillText(String(district.incoming), 1080, y);
      const sources = new Set(snapshot.shortcuts.filter(e => snapshot.files[e.target]?.district === district.id).map(e => snapshot.files[e.source]?.district)).size;
      label(`${sources} calling districts${district.inferred ? ' · inferred gate' : ''}`, 607, y + 31, muted, 11);
      ctx.fillStyle = '#e1e5da'; ctx.fillRect(607, y + 52, 515, 4); ctx.fillStyle = violet; ctx.fillRect(607, y + 52, 515 * district.incoming / ranked[0].incoming, 4);
    }
  }
  function draw() {
    const pos = filmPosition(seconds, story, data.snapshots.length), chapter = story.chapters[pos.chapter], s = data.snapshots[pos.snapshot], m = series[pos.snapshot];
    if (lastSnapshot !== pos.snapshot) { city.setSnapshot(pos.snapshot, true); lastSnapshot = pos.snapshot; }
    if (lastChapter !== pos.chapter) { city.select(chapter.id === 'focus' ? chapter.district : null); city.setMode(chapter.id === 'pressure' || chapter.id === 'focus' ? 'shortcuts' : 'city'); lastChapter = pos.chapter; }
    city.setCinematic(seconds / FILM_SECONDS, chapter.id === 'focus' ? chapter.district : undefined);
    ctx.fillStyle = paper; ctx.fillRect(0, 0, 1280, 720);
    ctx.save(); ctx.beginPath(); ctx.rect(440, 80, 840, 585); ctx.clip();
    if (chapter.id === 'outlook' && portrait) {
      const scale = Math.max(840 / portrait.width, 585 / portrait.height) * (1 + pos.progress * .035);
      ctx.drawImage(portrait, 860 - portrait.width * scale / 2, 370 - portrait.height * scale / 2, portrait.width * scale, portrait.height * scale);
    } else ctx.drawImage(city.captureCanvas(), 340, 80, 1040, 585);
    ctx.restore();
    const fade = ctx.createLinearGradient(420, 0, 570, 0); fade.addColorStop(0, paper); fade.addColorStop(1, '#f4f3ee00'); ctx.fillStyle = fade; ctx.fillRect(420, 80, 150, 585);
    if (chapter.id === 'boundaries') boundaryDiagram(pos.progress);
    if (chapter.id === 'findings') findings(s);
    label('s t r a t a', 52, 48, ink, 19); label('MOTION ATLAS  /  ' + data.meta.name.toUpperCase().slice(0, 38), 235, 46, muted, 11);
    label(`${String(pos.chapter + 1).padStart(2, '0')}  /  ${String(story.chapters.length).padStart(2, '0')}`, 1160, 46, muted, 11);
    ctx.strokeStyle = '#d8ddcf'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(52, 72); ctx.lineTo(1228, 72); ctx.stroke();
    const alpha = running ? Math.min(1, pos.progress * 7 + .2) : 1; ctx.save(); ctx.globalAlpha = alpha;
    label(chapter.id === 'pressure' && s.entropy ? 'EXPERIMENTAL ENTROPY' : ['REPOSITORY HISTORY', 'READING THE MAP', 'CODE GROWTH', 'BOUNDARY PRESSURE', 'REVIEW QUEUE', 'ONE EXAMPLE', 'NEXT STEPS'][pos.chapter], 54, 130, violet, 11);
    const title = pos.chapter === 0 ? story.title : chapter.title;
    let y = wrap(title, 50, 194, 405, 49, '42px Georgia, serif', ink, 3);
    y = Math.max(y + 15, 325);
    wrap(chapter.caption, 54, y, 355, 27, '17px -apple-system, BlinkMacSystemFont, sans-serif', muted, 5);
    ctx.restore();
    if (chapter.id === 'origin' || chapter.id === 'growth') { metric(fmt(m.files), 'source files', 54, 530); metric(fmt(m.lines), 'lines of code', 244, 530); drawChart('files', pos.snapshot, 54, 580, 345, 45); }
    if (chapter.id === 'boundaries') { label('MODULE = RELATED CODE', 54, 530, ink, 12); label('PUBLIC API = INTENDED ENTRY POINT', 54, 561, ink, 12); label('SHORTCUT = DIRECT PRIVATE IMPORT', 54, 592, violet, 12); }
    if (chapter.id === 'findings') { metric(fmt(m.shortcuts), 'shortcuts in this snapshot', 54, 530, violet); metric(fmt(m.shared), 'private files shared across districts', 54, 618); }
    if (chapter.id === 'pressure') {
      if (s.entropy) entropyMeasures(s.entropy);
      else { metric(m.pressure.toFixed(1) + '%', 'boundary pressure', 54, 530, violet); metric(fmt(m.shortcuts), 'shortcuts', 280, 530); drawChart('pressure', pos.snapshot, 54, 580, 345, 45); }
    }
    if (chapter.id === 'focus') {
      const d = s.districts.find(d => d.id === chapter.district);
      metric(fmt(d?.incoming || 0), 'incoming shortcuts', 54, 530, violet);
      wrap(d?.name.replaceAll('_', ' ') || 'Open neighborhood', 54, 595, 350, 27, '25px Georgia, serif', ink, 2);
      label(d?.inferred ? 'INFERRED GATE · CONFIRM INTENT' : d?.walled ? 'DECLARED PUBLIC GATE' : 'NO DECLARED GATE', 54, 644, muted, 9);
    }
    if (chapter.id === 'outlook') { metric(m.pressure.toFixed(1) + '%', 'boundary pressure', 54, 530, violet); metric(fmt(m.shared), 'shared private files', 262, 530); label(portrait ? 'CODEX-GENERATED INTERPRETATION' : 'MEASURED CODE CITY', 54, 599, muted, 10);  }
    label(shortDate(s.date).toUpperCase(), 1080, 640, ink, 12);
    ctx.fillStyle = '#e1e4da'; ctx.fillRect(52, 678, 1176, 2); ctx.fillStyle = violet; ctx.fillRect(52, 678, 1176 * seconds / FILM_SECONDS, 2);
    label(data.meta.private !== false ? 'PRIVATE WORKSPACE' : 'PUBLIC SAMPLE', 52, 704, muted, 9);
    label(chapter.id === 'pressure' ? s.entropy ? 'Experimental index · not validated as a maintenance-cost predictor' : 'Shortcuts / resolved imports · current gates applied across history' : edited ? 'Edited script / metrics from git' : story.model ? 'Story by Astra · medium / metrics from git' : 'Measured history / editorial preview', 420, 704, muted, 9);
    scrub.value = seconds; clock.textContent = `00:${String(Math.floor(seconds)).padStart(2, '0')} / 00:${FILM_SECONDS}`;
  }
  function animate(now) {
    if (disposed) return;
    if (running) { seconds = Math.min(FILM_SECONDS, seconds + (now - previous) / 1000); if (seconds >= FILM_SECONDS) { running = false; play.textContent = 'Replay film'; if (recorder?.state === 'recording') recorder.stop(); } }
    previous = now; if (silentPreview.open && !capturing) draw(); frameId = requestAnimationFrame(animate);
  }
  function toggle() { if (seconds >= FILM_SECONDS) seconds = 0; running = !running; previous = performance.now(); play.textContent = running ? 'Pause' : 'Play film'; }
  play.onclick = toggle; scrub.oninput = () => { running = false; seconds = Number(scrub.value); play.textContent = 'Play film'; };
  function disabled(value) { busyHere = value; enrich.disabled = value || !local || narratedRunning; illustrate.disabled = value || !local || narratedRunning; record.disabled = value; if (savedSelect) savedSelect.disabled = value; for (const input of transcriptBody.querySelectorAll('input, textarea, button')) input.disabled = value; narrated?.setBlocked(value); }
  async function work(action) {
    if (busyHere || busy()) { message.textContent = 'Let the current Codex request finish first.'; return; }
    disabled(true);
    try { await action(); } catch (error) { message.textContent = error.message; } finally { if (!disposed) disabled(false); }
  }
  const loadPortrait = async url => {
    const img = new Image(); img.src = url; await img.decode();
    if (!disposed) { portrait = img; selectedPortraitId = new URL(url, location.href).pathname.match(/^\/generated\/([a-f0-9-]{36})\.png$/)?.[1] || null; }
  };
  enrich.onclick = () => work(async () => {
    running = false; play.textContent = 'Play film'; message.textContent = 'Astra is reading the shape of your history…';
    const job = await pollJob(await api('story', {}), j => { if (!disposed) message.textContent = j.activity || 'Writing the storyboard…'; });
    if (disposed) return; story = job.story; edited = false; seconds = 0; lastChapter = -1; writeTranscript(); message.textContent = 'Story by Astra · medium. Captions explain the history; chart values and counts come from your scan.';
  });
  illustrate.onclick = () => work(async () => {
    running = false; play.textContent = 'Play film'; seconds = FILM_SECONDS - 4; draw();
    const s = data.snapshots.at(-1), district = [...s.districts].sort((a, b) => b.incoming - a.incoming)[0]?.id;
    const job = await pollJob(await api('postcard', { snapshot: data.snapshots.length - 1, district, screenshot: city.capture() }), j => { if (!disposed) message.textContent = j.activity || 'Illustrating your city…'; });
    if (disposed) return; await loadPortrait(job.image); message.textContent = 'Illustrated ending ready · generated through your Codex plan.';
  });
  record.onclick = () => {
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/mp4', 'video/webm'].find(t => window.MediaRecorder?.isTypeSupported(t));
    if (!type || !canvas.captureStream) { message.textContent = 'Video export is unavailable in this browser. Open Strata in Chrome or Edge to export.'; return; }
    let failed = false, startedAt = 0; const chunks = [];
    const cleanup = () => { stream?.getTracks().forEach(t => t.stop()); disabled(false); scrub.disabled = play.disabled = close.disabled = false; running = false; play.textContent = 'Replay film'; };
    try {
      disabled(true); scrub.disabled = true; play.disabled = true; close.disabled = true;
      seconds = 0; lastSnapshot = -1; lastChapter = -1; draw(); stream = canvas.captureStream(30);
      recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000 });
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => { failed = true; cleanup(); message.textContent = 'Recording failed. Try another browser.'; };
      recorder.onstop = async () => {
        const duration = performance.now() - startedAt;
        cleanup(); if (disposed || failed) return;
        if (!chunks.length) { message.textContent = 'The browser returned an empty recording. Please try another browser.'; return; }
        if (exportURL) URL.revokeObjectURL(exportURL);
        let blob = new Blob(chunks, { type });
        if (type.includes('webm')) {
          disabled(true); message.textContent = 'Finishing video metadata…';
          try { blob = await fixWebmDuration(blob, duration, { logger: false }); }
          catch { message.textContent = 'Could not finish the video metadata. Please export again.'; return; }
          finally { disabled(false); }
          if (disposed) return;
        }
        exportURL = URL.createObjectURL(blob); const link = el('a', '', 'Download film ↗'); link.href = exportURL; link.download = 'strata-codebase-film.' + (type.includes('mp4') ? 'mp4' : 'webm');
        videoReview?.remove(); videoReview = el('details', 'film-transcript'); videoReview.append(el('summary', '', 'Review exported video')); const video = el('video', 'film-output'); video.controls = true; video.playsInline = true; video.preload = 'metadata'; video.src = exportURL; videoReview.append(video); message.after(videoReview);
        message.replaceChildren(document.createTextNode(`Your ${FILM_SECONDS}-second film is ready. `), link); link.click();
      };
      recorder.start(1000); startedAt = performance.now(); running = true; previous = startedAt; play.textContent = 'Recording…'; message.textContent = `Rendering ${FILM_SECONDS} seconds of video. Keep this tab visible until the download is ready.`;
    } catch (error) { failed = true; cleanup(); message.textContent = 'Could not start video export: ' + error.message; }
  };
  async function captureViews() {
    if (disposed) throw new Error('Reopen the film window to capture the city.');
    const wasRunning = running; running = false; capturing = true; disabled(true);
    play.disabled = scrub.disabled = close.disabled = true;
    try {
      // Let the disabled controls paint before rendering the four raw city views.
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (disposed) throw new Error('The film window closed before the city was captured.');
      const latest = data.snapshots.length - 1;
      const district = [...data.snapshots[latest].districts].filter(d => d.walled).sort((a, b) => b.incoming - a.incoming || a.id.localeCompare(b.id))[0]?.id;
      const view = (index, progress, focus, mode = 'city') => {
        city.setSnapshot(index, true); city.select(focus || null); city.setMode(mode); city.setCinematic(progress, focus); return city.capture();
      };
      return { origin: view(0, 0), growth: view(latest, .35), focus: view(latest, .65, district, 'shortcuts'), outlook: view(latest, 1) };
    } finally {
      capturing = false;
      if (!disposed) { lastSnapshot = lastChapter = -1; draw(); running = wasRunning; previous = performance.now(); play.disabled = scrub.disabled = close.disabled = false; disabled(false); }
    }
  }
  narrated = narratedVideo(data, {
    api, local, capture: captureViews, portraitId: () => selectedPortraitId, busy: () => busyHere || busy(),
    onRunning(value) { narratedRunning = value; disabled(busyHere); },
    onReady() { if (recorder?.state === 'recording') return; running = false; play.textContent = 'Play film'; silentPreview.open = false; }
  });
  heading.after(narrated.element);
  silentPreview.addEventListener('toggle', () => {
    if (!silentPreview.open && recorder?.state === 'recording') { silentPreview.open = true; return; }
    if (!silentPreview.open) { running = false; play.textContent = 'Play film'; }
  });
  dialog.addEventListener('cancel', e => { if (recorder?.state === 'recording' || capturing) e.preventDefault(); });
  close.onclick = () => dialog.close();
  dialog.addEventListener('close', () => { disposed = true; narrated.dispose(); cancelAnimationFrame(frameId); if (recorder?.state === 'recording') recorder.stop(); stream?.getTracks().forEach(t => t.stop()); city.dispose(); host.remove(); dialog.remove(); if (exportURL) setTimeout(() => URL.revokeObjectURL(exportURL), 60000); });
  disabled(false); if (!local) message.textContent = 'Measured preview · AI story and illustration are available in the local app.';
  if (local) api('portraits').then(result => {
    const portraits = (result.portraits || []).filter(p => !p.unverifiedDataset);
    if (!portraits.length || disposed) return;
    const saved = el('select', 'film-action'); savedSelect = saved; saved.disabled = busyHere; saved.ariaLabel = 'Choose an existing city illustration';
    saved.append(new Option('Use a saved illustration…', ''));
    for (const [i, p] of portraits.entries()) saved.append(new Option('City portrait ' + (i + 1), p.image));
    saved.onchange = async () => { if (busyHere) return; try { if (saved.value) { await loadPortrait(saved.value); seconds = FILM_SECONDS - 4; message.textContent = 'Saved illustration selected for the ending.'; } else { portrait = null; selectedPortraitId = null; } } catch { message.textContent = 'This illustration could not be loaded.'; } };
    actions.insertBefore(saved, record);
  }).catch(() => {});
  frameId = requestAnimationFrame(animate);
}
