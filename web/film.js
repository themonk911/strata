import { City } from './city.js';
import { FILM_SECONDS, defaultStory, measures, filmPosition } from './film-data.js';
import { fixWebmDuration } from '@fix-webm-duration/fix';
import './film.css';

const ink = '#23372e', muted = '#778276', violet = '#8261b4', paper = '#f4f3ee';
const fmt = n => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(n);
const shortDate = s => s === 'Working tree' ? s : new Date(s + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const el = (tag, cls, text) => { const node = document.createElement(tag); node.className = cls || ''; if (text) node.textContent = text; return node; };

export function openFilm(data, { api, pollJob, local, busy }) {
  const dialog = el('dialog', 'film-dialog');
  const heading = el('div', 'film-heading');
  const headingText = el('div'); headingText.append(el('span', 'eyebrow', 'STRATA / MOTION ATLAS'), el('h2', '', 'Your code has a story.'));
  const close = el('button', 'film-close', '×'); close.ariaLabel = 'Close codebase film'; heading.append(headingText, close);
  const stage = el('div', 'film-stage'), canvas = el('canvas'); canvas.width = 1280; canvas.height = 720; canvas.ariaLabel = 'Animated infographic of codebase history'; stage.append(canvas);
  const host = el('div', 'film-render-host'); host.ariaHidden = 'true'; document.body.append(host);
  const controls = el('div', 'film-controls'), play = el('button', 'film-play', 'Play film'), scrub = el('input'), clock = el('span', 'film-clock', '00:00 / 00:40');
  scrub.type = 'range'; scrub.min = 0; scrub.max = FILM_SECONDS; scrub.step = .05; scrub.value = 0; scrub.ariaLabel = 'Film position'; controls.append(play, scrub, clock);
  const actions = el('div', 'film-actions'), enrich = el('button', 'film-action', '✧ Write with Astra'), illustrate = el('button', 'film-action', '◇ Illustrate ending'), record = el('button', 'primary', 'Export 40s video');
  actions.append(enrich, illustrate, record);
  const message = el('p', 'film-message', 'Measured preview · 40 seconds · silent, with on-screen captions.'); message.setAttribute('role', 'status');
  const privacy = el('p', 'film-privacy', data.meta.private ? 'Private workspace. Downloads contain codebase structure; keep this film private.' : 'Public sample · generated artwork is an interpretation of the measured city.');
  const transcript = el('details', 'film-transcript'); transcript.append(el('summary', '', 'Read the film transcript'));
  const transcriptBody = el('div'); transcript.append(transcriptBody);
  dialog.append(heading, stage, controls, actions, message, privacy, transcript); document.body.append(dialog); dialog.showModal();
  const city = new City(host, data, { hover() {}, select() {} });
  city.renderer.setPixelRatio(1); city.resize();
  const ctx = canvas.getContext('2d');
  let story = defaultStory(data), seconds = 0, running = false, previous = performance.now(), frameId, lastSnapshot = -1, lastChapter = -1;
  let portrait = null, recorder = null, stream = null, disposed = false, busyHere = false, exportURL = null, savedSelect = null, videoReview = null;
  const series = data.snapshots.map(measures);
  function writeTranscript() {
    transcriptBody.replaceChildren();
    for (const chapter of story.chapters) { const part = el('p'); part.append(el('strong', '', chapter.title), document.createTextNode(' ' + chapter.caption)); transcriptBody.append(part); }
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
  function draw() {
    const pos = filmPosition(seconds, story, data.snapshots.length), chapter = story.chapters[pos.chapter], s = data.snapshots[pos.snapshot], m = series[pos.snapshot];
    if (lastSnapshot !== pos.snapshot) { city.setSnapshot(pos.snapshot, true); lastSnapshot = pos.snapshot; }
    if (lastChapter !== pos.chapter) { city.select(pos.chapter === 3 ? chapter.district : null); city.setMode(pos.chapter === 2 || pos.chapter === 3 ? 'shortcuts' : 'city'); lastChapter = pos.chapter; }
    city.setCinematic(seconds / FILM_SECONDS, pos.chapter === 3 ? chapter.district : undefined);
    ctx.fillStyle = paper; ctx.fillRect(0, 0, 1280, 720);
    ctx.save(); ctx.beginPath(); ctx.rect(440, 80, 840, 585); ctx.clip();
    if (pos.chapter === 4 && portrait) {
      const scale = Math.max(840 / portrait.width, 585 / portrait.height) * (1 + pos.progress * .035);
      ctx.drawImage(portrait, 860 - portrait.width * scale / 2, 370 - portrait.height * scale / 2, portrait.width * scale, portrait.height * scale);
    } else ctx.drawImage(city.captureCanvas(), 340, 80, 1040, 585);
    ctx.restore();
    const fade = ctx.createLinearGradient(420, 0, 570, 0); fade.addColorStop(0, paper); fade.addColorStop(1, '#f4f3ee00'); ctx.fillStyle = fade; ctx.fillRect(420, 80, 150, 585);
    label('s t r a t a', 52, 48, ink, 19); label('MOTION ATLAS  /  ' + data.meta.name.toUpperCase().slice(0, 38), 235, 46, muted, 11);
    label(`${String(pos.chapter + 1).padStart(2, '0')}  /  05`, 1160, 46, muted, 11);
    ctx.strokeStyle = '#d8ddcf'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(52, 72); ctx.lineTo(1228, 72); ctx.stroke();
    const alpha = running ? Math.min(1, pos.progress * 7 + .2) : 1; ctx.save(); ctx.globalAlpha = alpha;
    label(['THE BEGINNING', 'A LIVING LANDSCAPE', 'BOUNDARY PRESSURE', 'A CLOSER LOOK', 'THE NEXT CHAPTER'][pos.chapter], 54, 130, violet, 11);
    const title = pos.chapter === 0 ? story.title : chapter.title;
    let y = wrap(title, 50, 194, 405, 49, '42px Georgia, serif', ink, 3);
    y = Math.max(y + 15, 325);
    wrap(chapter.caption, 54, y, 355, 27, '17px -apple-system, BlinkMacSystemFont, sans-serif', muted, 5);
    ctx.restore();
    if (pos.chapter === 0 || pos.chapter === 1) { metric(fmt(m.files), 'source files', 54, 530); metric(fmt(m.lines), 'lines of code', 244, 530); drawChart('files', pos.snapshot, 54, 580, 345, 45); }
    if (pos.chapter === 2) { metric(m.pressure.toFixed(1) + '%', 'boundary pressure', 54, 530, violet); metric(fmt(m.shortcuts), 'shortcuts', 280, 530); drawChart('pressure', pos.snapshot, 54, 580, 345, 45); }
    if (pos.chapter === 3) {
      const d = s.districts.find(d => d.id === chapter.district);
      metric(fmt(d?.incoming || 0), 'incoming shortcuts', 54, 530, violet);
      wrap(d?.name.replaceAll('_', ' ') || 'Open neighborhood', 54, 595, 350, 27, '25px Georgia, serif', ink, 2);
      label(d?.inferred ? 'INFERRED GATE · CONFIRM INTENT' : d?.walled ? 'DECLARED PUBLIC GATE' : 'NO DECLARED GATE', 54, 644, muted, 9);
    }
    if (pos.chapter === 4) { metric(m.pressure.toFixed(1) + '%', 'boundary pressure', 54, 530, violet); metric(fmt(m.shared), 'shared private files', 262, 530); label(portrait ? 'CODEX-GENERATED INTERPRETATION' : 'MEASURED CODE CITY', 54, 599, muted, 10); label('Explore. Understand. Evolve.', 54, 635, ink, 13); }
    label(shortDate(s.date).toUpperCase(), 1080, 640, ink, 12);
    ctx.fillStyle = '#e1e4da'; ctx.fillRect(52, 678, 1176, 2); ctx.fillStyle = violet; ctx.fillRect(52, 678, 1176 * seconds / FILM_SECONDS, 2);
    label(data.meta.private ? 'PRIVATE WORKSPACE' : 'PUBLIC SAMPLE', 52, 704, muted, 9);
    label(pos.chapter === 2 ? 'Shortcuts / resolved imports · current gates applied across history' : story.model ? 'Story by Astra · medium / metrics from git' : 'Measured history / editorial preview', 420, 704, muted, 9);
    scrub.value = seconds; clock.textContent = `00:${String(Math.floor(seconds)).padStart(2, '0')} / 00:40`;
  }
  function animate(now) {
    if (disposed) return;
    if (running) { seconds = Math.min(FILM_SECONDS, seconds + (now - previous) / 1000); if (seconds >= FILM_SECONDS) { running = false; play.textContent = 'Replay film'; if (recorder?.state === 'recording') recorder.stop(); } }
    previous = now; draw(); frameId = requestAnimationFrame(animate);
  }
  function toggle() { if (seconds >= FILM_SECONDS) seconds = 0; running = !running; previous = performance.now(); play.textContent = running ? 'Pause' : 'Play film'; }
  play.onclick = toggle; scrub.oninput = () => { running = false; seconds = Number(scrub.value); play.textContent = 'Play film'; };
  function disabled(value) { busyHere = value; enrich.disabled = value || !local; illustrate.disabled = value || !local; record.disabled = value; if (savedSelect) savedSelect.disabled = value; }
  async function work(action) {
    if (busyHere || busy()) { message.textContent = 'Let the current Codex request finish first.'; return; }
    disabled(true);
    try { await action(); } catch (error) { message.textContent = error.message; } finally { if (!disposed) disabled(false); }
  }
  const loadPortrait = async url => { const img = new Image(); img.src = url; await img.decode(); if (!disposed) portrait = img; };
  enrich.onclick = () => work(async () => {
    running = false; play.textContent = 'Play film'; message.textContent = 'Astra is reading the shape of your history…';
    const job = await pollJob(await api('story', {}), j => { if (!disposed) message.textContent = j.activity || 'Writing the storyboard…'; });
    if (disposed) return; story = job.story; seconds = 0; lastChapter = -1; writeTranscript(); message.textContent = 'Story by Astra · medium. All numbers are drawn from your scan.';
  });
  illustrate.onclick = () => work(async () => {
    running = false; play.textContent = 'Play film'; seconds = 36; draw();
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
        message.replaceChildren(document.createTextNode('Your 40-second film is ready. '), link); link.click();
      };
      recorder.start(1000); startedAt = performance.now(); running = true; previous = startedAt; play.textContent = 'Recording…'; message.textContent = 'Rendering 40 seconds of video. Keep this tab visible until the download is ready.';
    } catch (error) { failed = true; cleanup(); message.textContent = 'Could not start video export: ' + error.message; }
  };
  dialog.addEventListener('cancel', e => { if (recorder?.state === 'recording') e.preventDefault(); });
  close.onclick = () => dialog.close();
  dialog.addEventListener('close', () => { disposed = true; cancelAnimationFrame(frameId); if (recorder?.state === 'recording') recorder.stop(); stream?.getTracks().forEach(t => t.stop()); city.dispose(); host.remove(); dialog.remove(); if (exportURL) setTimeout(() => URL.revokeObjectURL(exportURL), 60000); });
  disabled(false); if (!local) message.textContent = 'Measured preview · AI story and illustration are available in the local app.';
  if (local) api('portraits').then(result => {
    const portraits = (result.portraits || []).filter(p => !p.unverifiedDataset);
    if (!portraits.length || disposed) return;
    const saved = el('select', 'film-action'); savedSelect = saved; saved.disabled = busyHere; saved.ariaLabel = 'Choose an existing city illustration';
    saved.append(new Option('Use a saved illustration…', ''));
    for (const [i, p] of portraits.entries()) saved.append(new Option('City portrait ' + (i + 1), p.image));
    saved.onchange = async () => { if (busyHere) return; try { if (saved.value) { await loadPortrait(saved.value); seconds = 36; message.textContent = 'Saved illustration selected for the ending.'; } else portrait = null; } catch { message.textContent = 'This illustration could not be loaded.'; } };
    actions.insertBefore(saved, record);
  }).catch(() => {});
  frameId = requestAnimationFrame(animate);
}
