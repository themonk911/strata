import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateStory } from './story.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const IDS = ['origin', 'growth', 'boundaries', 'pressure', 'findings', 'focus', 'outlook'];
const finite = value => Number.isFinite(value) ? value : null;
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const count = snapshot => ({ files: Object.keys(snapshot.files).length, lines: Object.values(snapshot.files).reduce((sum, file) => sum + file.lines, 0), imports: snapshot.imports.length, shortcuts: snapshot.shortcuts.length });
function entropy(value) {
  if (!value) return null;
  return { score: finite(value.score), status: clean(value.status), signals: Object.fromEntries(['rework', 'scatter', 'shortcuts'].map(id => {
    const signal = value.signals?.[id];
    return [id, signal ? { value: finite(signal.value), score: finite(signal.score), status: clean(signal.status), coverage: clean(signal.coverage), windowDays: finite(signal.windowDays) } : null];
  })) };
}
function narration(value) {
  const text = clean(value);
  if (!text || /\[#|\[pause\b|[{}]/i.test(text)) throw new Error('Video narration contains script control syntax. Regenerate the storyboard using plain sentences.');
  return text;
}
function spoken(value) { return value.replace(/\bAPI\b/g, 'A, P, I'); }
function marked(value, id) {
  const words = value.split(/\s+/);
  const middle = id === 'boundaries' ? words.indexOf('public') : Math.floor(words.length * .4);
  const end = id === 'boundaries' ? words.indexOf('Violet') : Math.floor(words.length * .75);
  return words.map((word, i) => `${i === 0 ? '[#start] ' : ''}${i === middle ? '[#detail] ' : ''}${i === end ? '[#finish] ' : ''}${word.replace(/\bAPI\b/g, '{API|A, P, I}')}`).join(' ');
}
function historySummary(history, data) {
  if (!history || history.status !== 'ready') return null;
  if (history.datasetHash !== createHash('sha256').update(JSON.stringify(data)).digest('hex') || !Array.isArray(history.entries)) throw new Error('History labels do not match this scanned dataset.');
  const counts = { feature: 0, repair: 0, reversal: 0, unclear: 0, refused: 0 }, revisions = new Set();
  for (const entry of history.entries) {
    if (!/^[a-f0-9]{40}$/.test(entry.revision || '') || entry.id !== entry.revision || revisions.has(entry.revision)
        || !Number.isInteger(entry.beforeSnapshot) || !Number.isInteger(entry.afterSnapshot)
        || entry.beforeSnapshot < 0 || entry.beforeSnapshot >= entry.afterSnapshot || entry.afterSnapshot >= data.snapshots.length
        || !entry.beforeSnapshotRevision?.startsWith(data.snapshots[entry.beforeSnapshot]?.revision || '!')
        || !entry.revision.startsWith(data.snapshots[entry.afterSnapshot]?.revision || '!')) throw new Error('History labels contain an unmatched commit.');
    revisions.add(entry.revision);
    const label = entry.status === 'refused' ? 'refused' : entry.status === 'classified' ? entry.label : null;
    if (!Object.hasOwn(counts, label)) throw new Error('History labels contain an unsupported classification.');
    counts[label] += 1;
  }
  if (!Number.isInteger(history.skipped) || history.skipped < 0) throw new Error('History labels have an invalid skipped count.');
  return { model: clean(history.model), reviewed: history.entries.length, skipped: history.skipped, counts };
}

/** Build an isolated, data-driven Explainroo project. Caller validates image paths. */
export async function createVideoProject({ directory, data, story, assets, portrait, history }) {
  if (!directory || !data?.snapshots?.length) throw new Error('A project directory and scanned history are required.');
  const validated = validateStory({ title: story?.title, subtitle: story?.subtitle, chapters: story?.chapters }, data);
  for (const id of ['origin', 'growth', 'focus', 'outlook']) if (!assets?.[id]) throw new Error(`Missing ${id} city capture.`);
  const points = data.snapshots.map(snapshot => ({ date: clean(snapshot.date), ...count(snapshot), entropy: entropy(snapshot.entropy) }));
  const chapters = Object.fromEntries(validated.chapters.map(chapter => [chapter.id, { title: clean(chapter.title), caption: clean(chapter.caption), snapshot: chapter.snapshot }]));
  // Captures are fixed to the beginning and current state, independently of the
  // model's narrative selection. Keep every displayed figure on those endpoints.
  for (const id of ['origin', 'growth', 'pressure', 'findings', 'focus', 'outlook']) chapters[id].snapshot = points.length - 1;
  chapters.origin.title = `${clean(data.meta.name)} today`;
  const decisions = historySummary(history, data);
  const findingSnapshot = data.snapshots[chapters.findings.snapshot];
  const ranked = [...findingSnapshot.districts].filter(d => d.walled && d.incoming > 0).sort((a, b) => b.incoming - a.incoming || a.id.localeCompare(b.id)).slice(0, 3)
    .map(d => ({ id: clean(d.id), name: clean(d.name), incoming: d.incoming, inferred: Boolean(d.inferred) }));
  const focusChapter = validated.chapters.find(chapter => chapter.id === 'focus'), focusSnapshot = data.snapshots.at(-1);
  const district = focusSnapshot.districts.find(d => d.id === focusChapter.district) || null;
  const incoming = district ? focusSnapshot.shortcuts.filter(edge => focusSnapshot.files[edge.target]?.district === district.id) : [];
  const repeated = district ? focusSnapshot.desirePaths.find(path => focusSnapshot.files[path.target]?.district === district.id) : null;
  const target = repeated?.target || incoming[0]?.target || null;
  const targetImports = target ? incoming.filter(edge => edge.target === target) : [];
  const focus = district ? { id: clean(district.id), name: clean(district.name), incoming: district.incoming, inferred: Boolean(district.inferred),
    walled: Boolean(district.walled), target: target ? clean(target) : null,
    importers: new Set(targetImports.map(edge => edge.source)).size,
    callingDistricts: new Set(targetImports.map(edge => focusSnapshot.files[edge.source]?.district).filter(Boolean)).size } : null;
  const captions = { ...Object.fromEntries(validated.chapters.map(chapter => [chapter.id, chapter.caption])),
    origin: `Here's ${clean(data.meta.name)} today.`,
    boundaries: 'Modules have public entry points. Violet imports bypass them.' };
  if (!ranked.length) captions.findings = 'No private-import shortcuts are detected here. Static scan coverage still applies.';
  if (focus?.inferred && !/inferred|intended/i.test(captions.focus)) captions.focus += ' Confirm the intended entry point.';
  if (!focus) captions.focus = 'Define the intended public entry points before choosing a module to review.';
  const scenes = IDS.map(id => ({ id, text: spoken(narration(captions[id])) }));
  const wordCount = scenes.reduce((sum, scene) => sum + scene.text.split(/\s+/).length, 0);
  if (wordCount > 105) throw new Error(`Video narration has ${wordCount} words; the limit is 105. Regenerate the storyboard with shorter captions for a forty-second video.`);
  const projectPath = resolve(directory), assetDirectory = join(projectPath, 'assets');
  await mkdir(join(assetDirectory, 'narration'), { recursive: true });
  for (const id of ['origin', 'growth', 'focus', 'outlook']) await copyFile(assets[id], join(assetDirectory, `${id}.png`));
  if (portrait) await copyFile(portrait, join(assetDirectory, 'portrait.png'));
  const report = { version: 1, name: clean(data.meta.name), private: data.meta.private !== false, privacyLabel: data.meta.private === false ? 'Public repository' : 'Private workspace',
    title: clean(validated.title), model: clean(story.model || 'Astra'), chapters, history: points, decisions, ranked, focus, portrait: Boolean(portrait), wordCount };
  const serialized = JSON.stringify(report);
  // Explainroo serves JS modules but deliberately refuses project JSON files.
  // Parse a JSON string literal; repository text never becomes executable code.
  await writeFile(join(projectPath, 'data.mjs'), `export default JSON.parse(${JSON.stringify(serialized)});\n`);
  await writeFile(join(projectPath, 'report.json'), JSON.stringify(report, null, 2));
  await copyFile(join(here, 'video-scenes.mjs'), join(projectPath, 'scenes.js'));
  await copyFile(join(here, 'video-look.json'), join(projectPath, 'look.json'));
  const scriptPath = join(projectPath, 'script.md');
  await writeFile(scriptPath, '# Strata codebase review\n\n' + IDS.map(id => `## ${id} {lead=0.05 hold=0.15 transition=fade}\n${marked(narration(captions[id]), id)}\n`).join('\n'));
  await writeFile(join(projectPath, 'video.json'), JSON.stringify({ title: 'Strata codebase review', theme: './look.json', size: '1920x1080', fps: 30, language: 'en',
    voice: { provider: 'recording', src: 'assets/narration/' }, pace: 1.2, music: false, sfx: 'minimal', captions: true,
    transition: 'fade', camera: 'still', motionBlur: true, watermark: false, cover: 'origin@1.0', end: .6 }, null, 2));
  await writeFile(join(projectPath, 'CREDITS.md'), `# Video credits\n\nGenerated by Strata from the selected repository's measured scan. ${report.privacyLabel}.\n\n- Explainroo 0.4.1, MIT license: https://github.com/vincentsch/explainroo\n- Explainroo's bundled fonts: Instrument Serif, Inter and JetBrains Mono, distributed under their SIL Open Font License terms.\n- Narration: AI-generated OpenAI speech.\n- Storyboard: ${clean(story.model || 'Astra')}; measured figures come from the scan.\n- City captures: Strata's measured 3D renderer.\n${decisions ? `- Historical classifications: OpenAI Decisions (${decisions.model}); model interpretations of ${decisions.reviewed} submitted commits, not a classification of all history. Refusals and skipped commits remain separate.\n` : ''}${portrait ? '- Ending illustration: generated through Codex. It is an artistic interpretation, not measured geometry.\n' : ''}\nThe experimental entropy index has not been validated as a predictor of maintenance cost or defects. Missing measurements are not zero.\n`);
  return { scenes, scriptPath, projectPath };
}
