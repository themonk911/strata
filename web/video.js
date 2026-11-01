const el = (tag, className = '', text) => {
  const node = document.createElement(tag); node.className = className;
  if (text) node.textContent = text;
  return node;
};
const active = job => job && !['done', 'complete', 'completed', 'error', 'failed', 'cancelled'].includes(job.status);
const done = job => ['done', 'complete', 'completed'].includes(job?.status);
const retryNarration = job => {
  if (!job || active(job) || done(job)) return false;
  if (typeof job.retryNarrationAvailable === 'boolean') return job.retryNarrationAvailable;
  const error = typeof job.error === 'string' ? job.error : job.error?.message || '';
  return /No automatic paid retry|Narration differs/i.test(error);
};
const dollars = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const localURL = value => {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value, location.href); return url.origin === location.origin && ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
};

// Owns the narrated-video lifecycle. Closing this view stops polling, not the
// server's job; the matching latest job is restored on the next open.
export function narratedVideo(data, { api, local, capture, portraitId, busy, onRunning, onReady }) {
  const section = el('section', 'narrated-video'); section.ariaLabel = 'Narrated codebase video';
  const top = el('div', 'narrated-video-top'), intro = el('div');
  intro.append(el('span', 'eyebrow', 'YOUR CODEBASE / WITH A VOICE'), el('h3', '', 'Make the story easy to share.'));
  const generate = el('button', 'primary', 'Generate narrated video'); generate.type = 'button';
  top.append(intro, generate);
  const price = el('p', 'narrated-video-price', 'AI voice · usually < $0.25 · max $1 per film');
  const disclosure = el('p', 'narrated-video-disclosure', 'Narration uses your OpenAI API credits. Narration text is sent to OpenAI. Video stays on this computer.');
  const privacy = el('p', 'narrated-video-privacy', data.meta.private !== false ? 'Private video · contains your codebase structure. Review before sharing a download.' : 'Public sample · measured history with AI narration.');
  const status = el('p', 'narrated-video-status', local ? 'Checking video availability…' : 'Narrated videos require the local Strata app.'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const issues = el('ul', 'narrated-video-issues'); issues.hidden = true;
  const retryInfo = el('p', 'narrated-video-disclosure', 'Retry narration reuses the approved script and completed clips. The $1 film limit still applies.'); retryInfo.hidden = true;
  const usage = el('p', 'narrated-video-disclosure'); usage.hidden = true;
  const progress = el('ol', 'narrated-video-progress'); progress.hidden = true; progress.ariaLabel = 'Video generation stages';
  const stages = ['Codex story', 'AI narration', 'Render video', 'Ready'].map(text => { const item = el('li', '', text); progress.append(item); return item; });
  const retry = el('button', 'film-action narrated-video-refresh', 'Check availability'); retry.type = 'button'; retry.hidden = true;
  const output = el('div', 'narrated-video-result'); output.hidden = true;
  section.append(top, price, disclosure, privacy, status, issues, retryInfo, usage, progress, retry, output);
  let disposed = false, blocked = false, starting = false, availability = null, job = null, timer, renderedJob = null, requestSequence = 0;
  const setRunning = () => onRunning?.(starting || active(job));
  function controls() {
    generate.disabled = disposed || blocked || starting || active(job) || !availability?.ready || !local;
    generate.textContent = starting ? 'Preparing city views…' : active(job) ? 'Making your video…' : done(job) ? 'Generate another video' : retryNarration(job) ? 'Retry narration' : 'Generate narrated video';
    retryInfo.hidden = !retryNarration(job) || starting;
    retry.disabled = starting || active(job);
  }
  function phase(current) {
    if (done(current)) return 3;
    const classify = value => {
      if (Number.isInteger(value) && value >= 0 && value <= 2) return value;
      const text = String(value || '').toLowerCase();
      if (/render|encode|export|composit|mux|finish|verif|checking (?:layout|timing)/.test(text)) return 2;
      if (/story|script|writ/.test(text)) return 0;
      if (/narrat|speech|spoken|audio|voice|tts/.test(text)) return 1;
      return null;
    };
    for (const value of [current.stage, current.phase, current.activity]) {
      const result = classify(value); if (result !== null) return result;
    }
    return 0;
  }
  function showOutput(current) {
    const url = localURL(current.video);
    if (!url) { status.textContent = 'The render finished without a playable video link. Check availability to reload its result.'; retry.hidden = false; return; }
    if (renderedJob === current.id) return;
    renderedJob = current.id; output.replaceChildren(); output.hidden = false;
    const label = el('div', 'narrated-video-result-label');
    label.append(el('strong', '', data.meta.private !== false ? 'Your private video is ready' : 'Your codebase video is ready'), el('span', '', 'AI voice · 1080p MP4'));
    const video = el('video', 'film-output'); video.controls = true; video.playsInline = true; video.preload = 'metadata'; video.src = url; video.ariaLabel = 'Narrated codebase video';
    const cover = localURL(current.cover); if (cover) video.poster = cover;
    const captions = localURL(current.captions);
    if (captions && new URL(captions).pathname.endsWith('.vtt')) { const track = document.createElement('track'); track.kind = 'captions'; track.label = 'English'; track.srclang = 'en'; track.src = captions; video.append(track); }
    video.addEventListener('error', () => { if (!disposed) status.textContent = 'This browser could not play the video. Download the MP4 to view it locally.'; });
    const links = el('div', 'narrated-video-downloads');
    for (const [href, text, name] of [[url, 'Download MP4 ↗', 'strata-narrated-video.mp4'], [captions, 'Captions', null], [localURL(current.script), 'Script', null]]) {
      if (!href) continue;
      const link = el('a', text.startsWith('Download') ? 'primary' : 'film-action', text); link.href = href; if (name) link.download = name; else link.download = ''; links.append(link);
    }
    output.append(label, video, links); onReady?.();
  }
  function showJob(current) {
    job = current; setRunning(); controls(); progress.hidden = false; issues.hidden = true; retry.hidden = true;
    const details = [];
    if (Number.isFinite(current.durationSeconds) && current.durationSeconds >= 0) {
      const seconds = Math.round(current.durationSeconds);
      details.push(`Duration: ${seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : ''}${seconds % 60}s`);
    }
    if (Number.isFinite(current.estimatedUSD) && current.estimatedUSD >= 0) details.push(`Audio this run: ${current.estimatedUSD > 0 && current.estimatedUSD < .01 ? '< $0.01' : dollars(current.estimatedUSD)} estimated`);
    usage.textContent = details.join(' · '); usage.hidden = !details.length;
    const step = phase(current);
    stages.forEach((item, i) => { item.classList.toggle('complete', i < step || done(current)); item.classList.toggle('current', i === step && !done(current)); if (i === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current'); });
    if (done(current)) {
      status.classList.remove('has-error'); status.textContent = 'Ready to play. Your video and downloads are stored on this computer.'; showOutput(current);
    } else if (!active(current)) {
      const error = typeof current.error === 'string' ? current.error : current.error?.message;
      status.textContent = error || current.message || 'Video generation could not finish. You can try again.'; status.classList.add('has-error');
    } else {
      status.classList.remove('has-error'); status.textContent = current.activity || current.message || ['Codex is writing the story…', 'Creating the AI narration…', 'Rendering your video…'][step];
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (disposed || !active(job) || !job.id) return;
    timer = setTimeout(async () => {
      try { const next = await api('video/jobs/' + encodeURIComponent(job.id)); if (!disposed) { showJob(next); schedule(); } }
      catch (error) { if (!disposed) { status.textContent = `Connection interrupted. The video may still be rendering. ${error.message}`; retry.hidden = false; retry.disabled = false; } }
    }, 3000);
  }
  async function refresh() {
    if (!local || disposed) return;
    const sequence = ++requestSequence; retry.disabled = true;
    try {
      const result = await api('video/status'); if (disposed || sequence !== requestSequence) return;
      availability = result; issues.replaceChildren();
      for (const issue of result.issues || []) issues.append(el('li', '', typeof issue === 'string' ? issue : issue.message || 'A video dependency needs attention.'));
      issues.hidden = !issues.children.length;
      const estimate = Number.isFinite(result.estimateUSD) ? result.estimateUSD : .25, maximum = Number.isFinite(result.maxUSD) ? result.maxUSD : 1;
      price.textContent = `AI voice · usually < ${dollars(estimate)} · max ${dollars(maximum)} per film`;
      if (result.latest) {
        const latest = typeof result.latest === 'string' ? await api('video/jobs/' + encodeURIComponent(result.latest)) : result.latest;
        if (disposed || sequence !== requestSequence) return;
        showJob(latest); issues.hidden = !issues.children.length; if (!result.ready) retry.hidden = false; schedule();
      } else {
        status.classList.remove('has-error'); status.textContent = result.ready ? 'Generate a narrated MP4 from this scan. You can close this window while it renders.' : 'Video generation needs setup before you can start.';
        retry.hidden = result.ready; controls();
      }
    } catch (error) {
      if (disposed || sequence !== requestSequence) return;
      availability = null; status.textContent = `Video availability could not be checked. ${error.message}`; retry.hidden = false; controls();
    } finally { if (!disposed && sequence === requestSequence) retry.disabled = false; }
  }
  generate.onclick = async () => {
    if (generate.disabled) return;
    if (busy()) { status.textContent = 'Let the current request or export finish before generating a narrated video.'; return; }
    const narrationRetry = retryNarration(job);
    starting = true; setRunning(); controls(); status.classList.remove('has-error'); status.textContent = narrationRetry ? 'Preparing to retry the failed narration…' : 'Preparing the city views for your story…';
    try {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)));
      const datasetHash = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      if (disposed) return;
      const assets = await capture(); if (disposed) return;
      const portrait = portraitId?.();
      const started = await api('video', { revision: data.meta.revision, datasetHash, assets, ...(portrait ? { portraitId: portrait } : {}), ...(narrationRetry ? { retryNarration: true } : {}) });
      if (disposed) return;
      starting = false; showJob(started); schedule();
    } catch (error) { if (!disposed) { status.textContent = error.message || 'Could not start video generation.'; status.classList.add('has-error'); } }
    finally { starting = false; if (!disposed) { setRunning(); controls(); } }
  };
  retry.onclick = refresh; controls(); if (local) refresh();
  return { element: section, setBlocked(value) { blocked = value; controls(); }, dispose() { disposed = true; ++requestSequence; clearTimeout(timer); output.querySelector('video')?.pause(); } };
}
