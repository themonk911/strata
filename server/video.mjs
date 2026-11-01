import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, delimiter, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { NarrationService, NARRATION_MODEL, NARRATION_VOICE, NARRATION_LIMITS, atomicWrite, readJSON, validateScenes } from './narration.mjs';
import { createVideoProject } from './video-template.mjs';
import { loadReviewedVideoStory } from './reviewed-video.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ASSETS = ['origin', 'growth', 'focus', 'outlook'];
const MEDIA = { 'video.mp4': ['out/video.mp4', 'video/mp4'], 'video.srt': ['out/video.srt', 'application/x-subrip'], 'video.cover.jpg': ['out/video.cover.jpg', 'image/jpeg'], 'script.md': ['script.md', 'text/markdown; charset=utf-8'], 'CREDITS.md': ['CREDITS.md', 'text/markdown; charset=utf-8'] };
export const datasetHash = data => {
  // The browser attaches reviewed history for display; it is not scan data.
  const { historyDecisions: _historyDecisions, ...scan } = data;
  return createHash('sha256').update(JSON.stringify(scan)).digest('hex');
};
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc32 = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function validatePNG(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > 6_000_000 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('A valid PNG city capture is required.');
  let offset = 8, header = false, pixels = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8), end = offset + 12 + size;
    if (end > bytes.length || size > 6_000_000 || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('PNG image chunks are invalid.');
    if (!header) {
      if (type !== 'IHDR' || size !== 13) throw new Error('PNG image header is invalid.');
      const width = bytes.readUInt32BE(offset + 8), height = bytes.readUInt32BE(offset + 12);
      const bitDepth = bytes[offset + 16], color = bytes[offset + 17], validDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 4096 || height > 4096 || width * height > 12_000_000 || !validDepths[color]?.includes(bitDepth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) throw new Error('PNG image dimensions or format are unsupported.');
      header = true;
    } else if (type === 'IHDR') throw new Error('PNG has duplicate headers.');
    if (type === 'IDAT' && size) pixels = true;
    if (type === 'IEND') { if (size || end !== bytes.length) throw new Error('PNG image ending is invalid.'); ended = true; break; }
    offset = end;
  }
  if (!header || !pixels || !ended) throw new Error('PNG image is incomplete.');
  return bytes;
}
export function validateVideoInput(data, input) {
  if (!data?.meta || !Array.isArray(data.snapshots) || !data.snapshots.length) throw new Error('Scan a repository before creating its video.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['revision', 'datasetHash', 'assets', 'portraitId', 'retryNarration', 'includeHistory'].includes(k))) throw new Error('Invalid video request.');
  if (input.retryNarration !== undefined && typeof input.retryNarration !== 'boolean') throw new Error('Narration retry must be explicitly true or false.');
  if (input.includeHistory !== undefined && typeof input.includeHistory !== 'boolean') throw new Error('History classification must be explicitly true or false.');
  if (typeof input.revision !== 'string' || input.revision !== data.meta.revision || input.datasetHash !== datasetHash(data)) throw new Error('The code city changed. Capture it again before creating the video.');
  if (!input.assets || typeof input.assets !== 'object' || Array.isArray(input.assets) || Object.keys(input.assets).length !== 4 || Object.keys(input.assets).some(k => !ASSETS.includes(k))) throw new Error('Four city views are required.');
  if (input.portraitId != null && (typeof input.portraitId !== 'string' || !UUID.test(input.portraitId))) throw new Error('Invalid saved illustration.');
  const assets = {}; let total = 0;
  for (const id of ASSETS) {
    const value = input.assets[id];
    if (typeof value !== 'string' || value.length > 8_000_024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('City captures must be PNG data URLs.');
    const encoded = value.slice(22), bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error('PNG base64 encoding is invalid.');
    total += bytes.length; if (total > 6_000_000) throw new Error('City captures exceed the 6 MB video limit.');
    assets[id] = validatePNG(bytes);
  }
  return { assets, portraitId: input.portraitId || null, retryNarration: input.retryNarration === true, includeHistory: input.includeHistory === true };
}
export function cleanVideoEnv(root) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PLAYWRIGHT_BROWSERS_PATH', 'EXPLAINROO_CHROME', 'CHROME_PATH']) if (process.env[key]) env[key] = process.env[key];
  env.EXPLAINROO_CACHE = process.env.EXPLAINROO_CACHE || join(root, '.local/tools/explainroo-cache');
  env.HF_HUB_OFFLINE = '1'; env.TRANSFORMERS_OFFLINE = '1';
  return env;
}
export function runVideoProcess(command, args, { cwd, env, signal, timeoutMs = 600000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', stopped = false;
    const stop = () => { stopped = true; try { process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500).unref(); };
    const timer = setTimeout(stop, timeoutMs); timer.unref(); signal?.addEventListener('abort', stop, { once: true });
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.stdout.on('data', b => { stdout += b.toString(); if (stdout.length > 2_000_000) { stdout = stdout.slice(0, 2_000_000); stop(); } });
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-6000); });
    child.on('error', error => { finish(); reject(new Error('Could not start the local video renderer: ' + error.code)); });
    child.on('close', code => { finish(); if (stopped || code) { const error = new Error(stopped ? 'Video rendering stopped or exceeded its time limit.' : 'The local video renderer failed. Review its saved report.'); error.diagnostics = { stdout: stdout.slice(-12000), stderr, code }; return reject(error); } resolvePromise({ stdout, stderr, code }); });
  });
}
async function executable(name) {
  for (const dir of (process.env.PATH || '').split(delimiter)) { try { await access(join(dir, name), constants.X_OK); return true; } catch {} }
  return false;
}
function safeError(error) { return String(error?.message || 'Video generation failed.').replace(/sk-[\w-]+/g, '[redacted]').slice(0, 500); }
function summarizeHistory(history, data) {
  if (history?.status !== 'ready' || history.datasetHash !== datasetHash(data) || typeof history.model !== 'string' || !history.model || !Array.isArray(history.entries) || !Number.isInteger(history.skipped) || history.skipped < 0) throw new Error('History classifications do not match this scanned dataset.');
  const counts = { feature: 0, repair: 0, reversal: 0, unclear: 0, refused: 0 };
  for (const entry of history.entries) {
    if (entry.type === 'refusal' && entry.status === 'refused') { counts.refused++; continue; }
    if (entry.type !== 'choice' || entry.status !== 'classified' || !['feature', 'repair', 'reversal', 'unclear'].includes(entry.label) || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) throw new Error('History classifications contain an invalid result.');
    counts[entry.label]++;
  }
  return { status: 'ready', model: history.model, reviewed: history.entries.length, classified: history.entries.length - counts.refused, counts, skipped: history.skipped, cached: history.cached === true, interpretation: 'Model classifications of sampled commits, not measured defects.' };
}
function validateCaptureMapping(story, data) {
  const latest = data.snapshots.length - 1, chapters = story?.chapters;
  const expectedFocus = [...data.snapshots[latest].districts].filter(d => d.walled).sort((a, b) => b.incoming - a.incoming || a.id.localeCompare(b.id))[0]?.id ?? null;
  if (!Array.isArray(chapters) || ['origin', 'boundaries'].some(id => chapters.find(c => c.id === id)?.snapshot !== 0)
    || ['growth', 'pressure', 'findings', 'focus', 'outlook'].some(id => chapters.find(c => c.id === id)?.snapshot !== latest)
    || (chapters.find(c => c.id === 'focus')?.district ?? null) !== expectedFocus) {
    throw new Error('The storyboard does not match the captured city views. Regenerate it using the latest snapshots and the module receiving the most shortcuts. No narration was purchased.');
  }
}
function abortable(promise, signal) {
  return new Promise((yes, no) => { const abort = () => no(new Error('Video generation stopped or exceeded ten minutes.')); if (signal.aborted) return abort(); signal.addEventListener('abort', abort, { once: true }); Promise.resolve(promise).then(yes, no).finally(() => signal.removeEventListener('abort', abort)); });
}

export class VideoService {
  constructor({ root, loadKey, writeStory, getHistory, createProject = createVideoProject, narration, runner = runVideoProcess, readiness, timeoutMs = 600000 }) {
    this.root = resolve(root); this.directory = join(this.root, '.local/videos'); this.tool = resolve(process.env.STRATA_EXPLAINROO_HOME || join(this.root, '.local/tools/explainroo'));
    this.loadKey = loadKey; this.writeStory = writeStory; this.getHistory = getHistory; this.createProject = createProject; this.runner = runner; this.readiness = readiness; this.timeoutMs = Math.min(timeoutMs, 600000);
    this.narration = narration || new NarrationService({ directory: join(this.directory, 'narration-cache'), loadKey });
    this.jobs = new Map(); this.current = null; this.closed = false; this.initialized = this.restore();
  }
  get active() { return this.current ? this.current.job || { id: this.current.id, status: 'running', activity: 'Preparing video…' } : null; }
  async restore() {
    await mkdir(this.directory, { recursive: true });
    for (const id of await readdir(this.directory)) {
      if (!UUID.test(id)) continue;
      try { const job = await readJSON(join(this.directory, id, 'job.json')); if (job?.id !== id || job.kind !== 'video') continue;
        if (job.status === 'running') { job.status = 'error'; job.activity = 'Interrupted'; job.error = 'The server restarted before the video finished. Paid narration was not retried.'; await this.persist(job); }
        this.jobs.set(id, job);
      } catch { /* Partial local jobs are not exposed. */ }
    }
  }
  async persist(job) { await atomicWrite(join(this.directory, job.id, 'job.json'), JSON.stringify(job, null, 2)); }
  async get(id) { await this.initialized; if (!UUID.test(id || '')) return null; const job = this.jobs.get(id); return job ? structuredClone(job) : null; }
  async latest(data) { await this.initialized; const identity = datasetHash(data); return structuredClone([...this.jobs.values()].filter(j => j.datasetHash === identity).sort((a, b) => b.startedAt - a.startedAt)[0] || null); }
  async savedVideo(data) {
    await this.initialized; const identity = datasetHash(data);
    return structuredClone([...this.jobs.values()].filter(job => job.status === 'done' && job.datasetHash === identity)
      .sort((a, b) => (b.completedAt || b.startedAt) - (a.completedAt || a.startedAt))[0] || null);
  }
  async status(data) {
    await this.initialized;
    let checks;
    if (this.readiness) checks = await this.readiness();
    else {
      let tool = false, chrome = false, key = false;
      try { await access(join(this.tool, 'bin/explainroo.js')); tool = true; const browser = await import(pathToFileURL(join(this.tool, 'src/browser.js')).href); chrome = Boolean(browser.findChrome()); } catch {}
      try { key = Boolean(await this.loadKey()); } catch {}
      checks = { tool, chrome, key, ffmpeg: await executable('ffmpeg') };
    }
    const labels = { tool: 'Install Explainroo in .local/tools/explainroo or set STRATA_EXPLAINROO_HOME.', chrome: 'Install Chrome or configure EXPLAINROO_CHROME.', ffmpeg: 'Install ffmpeg and put it on PATH.', key: 'Add OPENAI_API_KEY to .env.local for narration.' };
    return { ready: !this.closed && Object.values(checks).every(Boolean), checks, issues: Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => labels[key] || key), model: NARRATION_MODEL, voice: NARRATION_VOICE, estimateUSD: .25, maxUSD: 1, localBudgetUSD: 5, targetSeconds: NARRATION_LIMITS.targetSeconds, maxSeconds: NARRATION_LIMITS.productionSeconds, latest: data ? await this.latest(data) : null, savedVideo: data ? await this.savedVideo(data) : null };
  }
  async start(data, input) {
    await this.initialized;
    if (this.closed || this.current) throw new Error('A video is already running or the service is closing.');
    const captured = structuredClone(data), validated = validateVideoInput(captured, input);
    // Claim the slot before readiness awaits so concurrent starts cannot race.
    const id = randomUUID(), controller = new AbortController(); this.current = { id, controller, job: null };
    try {
      const status = await this.status(); if (!status.ready) throw new Error(status.issues.join(' '));
      controller.signal.throwIfAborted(); if (this.closed) throw new Error('The video service is closing.');
      const directory = join(this.directory, id); await mkdir(join(directory, 'captures'), { recursive: true });
      const assets = {};
      for (const name of ASSETS) { assets[name] = join(directory, 'captures', name + '.png'); await writeFile(assets[name], validated.assets[name]); }
      let portrait;
      if (validated.portraitId) {
        const generated = join(this.root, '.local/generated'), saved = await readJSON(join(generated, validated.portraitId + '.json'));
        if (saved?.kind !== 'postcard' || saved.status !== 'done' || saved.dataset?.hash !== input.datasetHash) throw new Error('The saved illustration does not belong to this exact code city.');
        const source = join(generated, validated.portraitId + '.png'), bytes = validatePNG(await readFile(source));
        portrait = join(directory, 'captures/portrait.png'); await writeFile(portrait, bytes);
      }
      const job = { id, kind: 'video', status: 'running', activity: 'Writing the video script with Astra…', startedAt: Date.now(), revision: captured.meta.revision, datasetHash: input.datasetHash, name: captured.meta.name, private: captured.meta.private !== false, publicSafe: captured.meta.private === false, model: NARRATION_MODEL, voice: NARRATION_VOICE, estimateUSD: .25, maxUSD: 1, includeHistory: validated.includeHistory, targetSeconds: NARRATION_LIMITS.targetSeconds, maxSeconds: NARRATION_LIMITS.productionSeconds };
      this.jobs.set(id, job); this.current.job = job; await this.persist(job);
      this.current.promise = this.perform(job, captured, { directory, assets, portrait, retryNarration: validated.retryNarration, includeHistory: validated.includeHistory, signal: controller.signal }).catch(error => {
        job.status = 'error'; job.activity = 'Video stopped'; job.error = safeError(error); if (this.current?.id === job.id) this.current = null;
      });
      return structuredClone(job);
    } catch (error) { this.current = null; throw error; }
  }
  async perform(job, data, options) {
    const { directory, assets, portrait, signal, retryNarration, includeHistory } = options;
    const timer = setTimeout(() => this.current?.id === job.id && this.current.controller.abort(), this.timeoutMs); timer.unref();
    const activity = text => { if (job.status === 'running') job.activity = String(text).slice(0, 180); };
    const stage = async (command, extra = []) => {
      signal.throwIfAborted();
      let output;
      try { output = await this.runner(process.execPath, [join(this.tool, 'bin/explainroo.js'), command, directory, ...extra, '--json'], { cwd: this.tool, env: cleanVideoEnv(this.root), signal, timeoutMs: this.timeoutMs }); }
      catch (error) {
        await atomicWrite(join(directory, command + '-failure.json'), JSON.stringify({ message: safeError(error), code: error.diagnostics?.code,
          stdout: String(error.diagnostics?.stdout || '').slice(-12000).replace(/sk-[\w-]+/g, '[redacted]'),
          stderr: String(error.diagnostics?.stderr || '').slice(-6000).replace(/sk-[\w-]+/g, '[redacted]') }, null, 2)); throw error;
      }
      let result; try { result = JSON.parse(output.stdout); } catch { throw new Error('The video renderer returned an invalid ' + command + ' report.'); }
      await atomicWrite(join(directory, command + '-report.json'), JSON.stringify(result, null, 2)); return result;
    };
    try {
      const reviewed = await loadReviewedVideoStory(this.root, data); signal.throwIfAborted();
      let history;
      if (!reviewed && includeHistory && this.getHistory) {
        job.activity = 'Classifying sampled commits with Decisions…'; await this.persist(job);
        try { history = await abortable(this.getHistory(data, activity), signal); signal.throwIfAborted(); job.history = summarizeHistory(history, data); }
        catch (error) { throw new Error('Requested Decisions history could not be prepared: ' + safeError(error)); }
      }
      job.activity = reviewed ? 'Preparing the reviewed script for this codebase…' : 'Writing the video script with Astra…'; await this.persist(job);
      const story = reviewed || await abortable(this.writeStory(data, activity, history), signal); signal.throwIfAborted(); validateCaptureMapping(story, data);
      const project = await this.createProject({ directory, data, story, assets, portrait, history }); validateScenes(project.scenes);
      job.storyModel = story.model; job.storyEffort = story.effort; job.activity = 'Recording the narration…'; await this.persist(job);
      job.narration = await this.narration.generate({ jobId: job.id, scenes: project.scenes, directory: join(directory, 'assets/narration'), onActivity: activity, signal, retryNarration });
      job.estimatedUSD = job.narration.estimatedUSD; job.activity = 'Checking every spoken word…'; await this.persist(job);
      const voice = await stage('voice');
      if (!Number.isFinite(voice.duration) || voice.duration > NARRATION_LIMITS.productionSeconds || !Array.isArray(voice.scenes) || voice.scenes.length !== project.scenes.length || voice.scenes.some(s => s.confirmed !== 1 || !Array.isArray(s.unconfirmed) || s.unconfirmed.length)) throw new Error('The local speech check could not confirm the complete script, or the video exceeds 50 seconds. No full render was started.');
      job.durationSeconds = voice.duration; job.activity = 'Checking layout and timing…'; await this.persist(job);
      const check = await stage('check');
      if (!Array.isArray(check.issues) || check.issues.some(i => ['error', 'warn', 'warning'].includes(i.level)) || !Number.isFinite(check.duration) || check.duration > NARRATION_LIMITS.productionSeconds) throw new Error('Video layout or speech checks need attention. No full render was started.');
      job.activity = 'Rendering the video…'; await this.persist(job); await stage('render', ['--workers', '2']);
      job.activity = 'Verifying the finished video…'; await this.persist(job); const verified = await stage('verify');
      const speech = verified.speech, speechScenes = speech?.scenes;
      // The independent final-mix ASR can differ slightly after encoding. Keep
      // stricter thresholds than Explainroo's own 85% overall / 80% per scene.
      if (!Number.isFinite(verified.duration) || verified.duration > NARRATION_LIMITS.productionSeconds || !verified.video || !verified.audio || !Array.isArray(verified.issues) || verified.issues.some(i => ['error', 'warn', 'warning'].includes(i.level)) || !Number.isFinite(speech?.matchRate) || speech.matchRate < .95 || !Array.isArray(speechScenes) || speechScenes.length !== project.scenes.length || speechScenes.some(s => !Number.isFinite(s.matchRate) || s.matchRate < .9 || !project.scenes.some(p => p.id === s.id))) throw new Error('The finished video did not pass verification or exceeds 50 seconds. Its files remain local for review.');
      for (const [relative] of Object.values(MEDIA)) { const info = await stat(join(directory, relative)); if (!info.isFile() || !info.size) throw new Error('A finished video asset is missing.'); }
      job.status = 'done'; job.activity = 'Video ready'; job.durationSeconds = verified.duration;
      job.warnings = verified.duration > NARRATION_LIMITS.targetSeconds ? [`This video is ${verified.duration.toFixed(1)} seconds; the target is about 40 seconds.`] : [];
      job.media = Object.fromEntries(Object.keys(MEDIA).map(name => [name, `/api/video/assets/${job.id}/${name}`]));
      job.video = job.media['video.mp4']; job.captions = job.media['video.srt']; job.cover = job.media['video.cover.jpg']; job.script = job.media['script.md']; job.credits = job.media['CREDITS.md'];
      job.verification = { speechMatchRate: speech.matchRate, scenes: speechScenes, warnings: 0, errors: 0 };
    } catch (error) { job.status = 'error'; job.activity = 'Video stopped'; job.error = safeError(error);
      if (this.narration.usage) { const usage = await this.narration.usage(job.id).catch(() => null); if (usage) { job.estimatedUSD = usage.estimatedUSD; job.narrationUsage = usage; } }
    }
    finally { clearTimeout(timer); job.completedAt = Date.now(); await this.persist(job); if (this.current?.id === job.id) this.current = null; }
  }
  async media(id, name) {
    const job = await this.get(id); if (job?.status !== 'done' || !Object.hasOwn(MEDIA, name)) return null;
    const [relative, type] = MEDIA[name], directory = await realpath(join(this.directory, id)), path = await realpath(join(directory, relative));
    if (!path.startsWith(directory + sep) || !(await stat(path)).isFile()) return null;
    return { path, type };
  }
  async close() { this.closed = true; if (this.current) { this.current.controller.abort(); await this.current.promise; } }
}
