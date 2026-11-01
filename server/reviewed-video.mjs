import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const IDS = ['origin', 'boundaries', 'growth', 'pressure', 'findings', 'focus', 'outlook'];
function identity(data) { const { historyDecisions: _history, ...scan } = data; return createHash('sha256').update(JSON.stringify(scan)).digest('hex'); }
function object(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error('Reviewed video plan has invalid fields.');
}
function text(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f{}\[\]<>]/.test(value)) throw new Error(`Reviewed video ${label} must be bounded plain text.`);
  return value.trim();
}
function importSnippet(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x09\x0b-\x1f\x7f]/.test(value) || value.split('\n').length > 2) throw new Error(`Reviewed video ${label} must be bounded text on at most two lines.`);
  return value.trim();
}
function sourceLabel(value, label) {
  const result = text(value, 160, label);
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(result) || result.includes('\\') || result.split('/').includes('..')) throw new Error(`Reviewed video ${label} must not contain an absolute or escaping path.`);
  return result;
}
function labels(value, label, maximum) {
  if (!Array.isArray(value) || !value.length || value.length > maximum) throw new Error(`Reviewed video ${label} must contain one to ${maximum} labels.`);
  return value.map(item => sourceLabel(item, label));
}
function count(value, label) { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Reviewed video ${label} is invalid.`); return value; }

// This local-only plan is an explicit human-reviewed exception to generated
// qualitative prose. It never changes the generic Astra story validator.
export function validateReviewedVideoStory(plan, data) {
  if (data?.schemaVersion !== 1 || !data.meta || !Array.isArray(data.snapshots) || !data.snapshots.length) throw new Error('A scanned history is required for a reviewed video.');
  object(plan, ['datasetHash', 'revision', 'story', 'reviewedBoundaryStory']);
  if (plan.datasetHash !== identity(data) || plan.revision !== data.meta.revision) throw new Error('Reviewed video plan does not match the current scan and revision.');
  object(plan.story, ['title', 'subtitle', 'chapters']);
  if (!Array.isArray(plan.story.chapters) || plan.story.chapters.length !== IDS.length) throw new Error('Reviewed video needs the seven canonical chapters.');
  const last = data.snapshots.length - 1;
  const focusDistrict = [...data.snapshots[last].districts].filter(d => d.walled).sort((a, b) => b.incoming - a.incoming || a.id.localeCompare(b.id))[0]?.id ?? null;
  const chapters = plan.story.chapters.map((chapter, index) => {
    object(chapter, ['id', 'title', 'caption', 'snapshot', 'district']);
    if (chapter.id !== IDS[index] || !Number.isInteger(chapter.snapshot) || !data.snapshots[chapter.snapshot]) throw new Error('Reviewed video chapter order or snapshot is invalid.');
    if (chapter.snapshot !== (index < 2 ? 0 : last)) throw new Error('Reviewed video endpoints do not match the captured city views.');
    if (chapter.district !== null && (typeof chapter.district !== 'string' || !data.snapshots[chapter.snapshot].districts.some(d => d.id === chapter.district))) throw new Error('Reviewed video references an unknown district.');
    if (chapter.id === 'focus' && chapter.district !== focusDistrict) throw new Error('Reviewed video focus must match the highest-incoming captured district.');
    return { id: chapter.id, title: text(chapter.title, 60, 'chapter title'), caption: text(chapter.caption, 200, 'caption'), snapshot: chapter.snapshot, district: chapter.district };
  });
  const words = chapters.reduce((sum, chapter) => sum + chapter.caption.split(/\s+/).length, 0);
  if (words > 105) throw new Error('Reviewed video narration exceeds 105 spoken words.');
  const boundary = plan.reviewedBoundaryStory;
  object(boundary, ['baseline', 'focus', 'repair']);
  object(boundary.baseline, ['date', 'snapshot', 'shortcuts']);
  const baseline = boundary.baseline, point = Number.isInteger(baseline.snapshot) ? data.snapshots[baseline.snapshot] : null;
  if (!point || baseline.date !== point.date || count(baseline.shortcuts, 'baseline shortcuts') !== point.shortcuts.length) throw new Error('Reviewed video baseline does not match measured history.');
  object(boundary.focus, ['title', 'entryPoint', 'callers', 'targets', 'caption', 'district'], ['title', 'entryPoint', 'callers', 'targets', 'caption']);
  if (boundary.focus.district !== undefined && boundary.focus.district !== focusDistrict) throw new Error('Reviewed video focus district does not match the captured district.');
  const focus = { title: text(boundary.focus.title, 60, 'focus title'), entryPoint: sourceLabel(boundary.focus.entryPoint, 'entry point'), callers: labels(boundary.focus.callers, 'callers', 2), targets: labels(boundary.focus.targets, 'targets', 4), caption: text(boundary.focus.caption, 200, 'focus caption'), district: focusDistrict };
  object(boundary.repair, ['district', 'title', 'count', 'total', 'before', 'after', 'caption']);
  const repair = boundary.repair, latest = data.snapshots[last];
  if (typeof repair.district !== 'string' || !latest.districts.some(d => d.id === repair.district && d.walled)) throw new Error('Reviewed video repair district is invalid.');
  const measured = latest.shortcuts.filter(edge => latest.files[edge.target]?.district === repair.district).length;
  if (count(repair.count, 'repair count') > count(repair.total, 'repair total') || repair.total > measured) throw new Error('Reviewed video repair counts exceed the measured district shortcuts.');
  const reviewedBoundaryStory = { baseline: { date: baseline.date, snapshot: baseline.snapshot, shortcuts: baseline.shortcuts }, focus,
    repair: { district: repair.district, title: text(repair.title, 60, 'repair title'), count: repair.count, total: repair.total,
      before: importSnippet(repair.before, 'before import'), after: importSnippet(repair.after, 'after import'), caption: text(repair.caption, 200, 'repair caption') } };
  return { title: text(plan.story.title, 60, 'title'), subtitle: text(plan.story.subtitle, 160, 'subtitle'), chapters,
    model: 'Reviewed script', effort: null, reviewedBoundaryStory, reviewedVideoPlan: structuredClone(plan) };
}

export async function loadReviewedVideoStory(root, data) {
  const path = join(root, '.local/video-scripts', identity(data) + '.json');
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 100_000) throw new Error('Reviewed video plan must be a small local JSON file.');
  let plan; try { plan = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Reviewed video plan is not valid JSON.'); }
  return validateReviewedVideoStory(plan, data);
}
