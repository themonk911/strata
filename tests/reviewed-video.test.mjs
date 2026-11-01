import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReviewedVideoStory, validateReviewedVideoStory } from '../server/reviewed-video.mjs';

const ids = ['origin', 'boundaries', 'growth', 'pressure', 'findings', 'focus', 'outlook'];
function fixture() {
  const snapshot = { date: '2026-06-11', districts: [{ id: 'basis', incoming: 3, walled: true }, { id: 'notifications', incoming: 2, walled: true }], files: { 'basis/engine.py': { district: 'basis' }, 'notifications/store.py': { district: 'notifications' } }, shortcuts: [{ source: 'caller.py', target: 'notifications/store.py' }, { source: 'other.py', target: 'notifications/store.py' }] };
  const data = { schemaVersion: 1, meta: { name: 'Example', revision: 'abc' }, snapshots: [snapshot, { ...structuredClone(snapshot), date: 'Working tree' }] };
  const plan = { datasetHash: createHash('sha256').update(JSON.stringify(data)).digest('hex'), revision: 'abc', story: { title: 'Example in 30 seconds', subtitle: 'A reviewed account of measured changes.', chapters: ids.map((id, index) => ({ id, title: 'Measured view', caption: 'There are 2 shortcuts.', snapshot: index < 2 ? 0 : 1, district: id === 'focus' ? 'basis' : null })) },
    reviewedBoundaryStory: { baseline: { date: '2026-06-11', snapshot: 0, shortcuts: 2 }, focus: { title: 'Basis entry point', entryPoint: 'basis/__init__.py', callers: ['tax', 'storage'], targets: ['engine.py'], caption: 'Review the intended public interface.' }, repair: { district: 'notifications', title: 'Reuse the public imports', count: 1, total: 2, before: 'from notifications.store import NotificationStore', after: 'from notifications import NotificationStore', caption: 'Reroute imports and run affected tests.' } } };
  return { data, plan };
}
test('reviewed numeric narration is scan-bound and survives revalidation', () => {
  const { data, plan } = fixture(), story = validateReviewedVideoStory(plan, data);
  assert.equal(story.model, 'Reviewed script'); assert.equal(story.effort, null); assert.equal(story.chapters[0].caption, 'There are 2 shortcuts.');
  assert.equal(story.reviewedBoundaryStory.focus.district, 'basis'); assert.deepEqual(validateReviewedVideoStory(story.reviewedVideoPlan, data).chapters, story.chapters);
  assert.equal(validateReviewedVideoStory(plan, { ...data, historyDecisions: { entries: [] } }).model, 'Reviewed script');
  story.reviewedVideoPlan.story.title = 'Changed'; assert.equal(plan.story.title, 'Example in 30 seconds');
});
test('reviewed plan rejects stale scans, invented counts, bad references and script controls', () => {
  const edits = [p => p.datasetHash = 'old', p => p.revision = 'old', p => p.story.chapters.reverse(), p => p.story.chapters[2].snapshot = 0,
    p => p.story.chapters[5].district = 'notifications', p => p.reviewedBoundaryStory.baseline.shortcuts = 99,
    p => p.reviewedBoundaryStory.baseline.date = 'yesterday', p => p.reviewedBoundaryStory.repair.total = 99,
    p => p.reviewedBoundaryStory.repair.count = 3, p => p.reviewedBoundaryStory.repair.district = 'missing',
    p => p.story.chapters[0].caption = '[#injected] words', p => p.reviewedBoundaryStory.focus.entryPoint = '/Users/private/file.py'];
  for (const edit of edits) { const { data, plan } = fixture(); edit(plan); assert.throws(() => validateReviewedVideoStory(plan, data)); }
});
test('reviewed narration retains the 105-word limit', () => {
  const { data, plan } = fixture(); plan.story.chapters.forEach(c => c.caption = Array(16).fill('word').join(' '));
  assert.throws(() => validateReviewedVideoStory(plan, data), /105/);
});
test('reviewed repairs preserve literal named imports and two-line snippets', () => {
  const { data, plan } = fixture(), repair = plan.reviewedBoundaryStory.repair;
  repair.before = "import { NotificationStore } from './notifications/store.js';";
  repair.after = "import { NotificationStore }\nfrom './notifications/index.js';";
  const story = validateReviewedVideoStory(plan, data);
  assert.equal(story.reviewedBoundaryStory.repair.before, repair.before);
  assert.equal(story.reviewedBoundaryStory.repair.after, repair.after);
});
test('reviewed repairs reject oversized snippets, extra lines and control characters', () => {
  for (const field of ['before', 'after']) {
    for (const value of ['', 'x'.repeat(201), 'first\nsecond\nthird', 'import\tvalue', 'import\r\nvalue', 'import\x00value', 'import\x7fvalue']) {
      const { data, plan } = fixture(); plan.reviewedBoundaryStory.repair[field] = value;
      assert.throws(() => validateReviewedVideoStory(plan, data), /bounded text on at most two lines/);
    }
  }
});
test('local loader returns null only when absent and validates the exact hash-named plan', async t => {
  const root = await mkdtemp(join(tmpdir(), 'strata-reviewed-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { data, plan } = fixture(); assert.equal(await loadReviewedVideoStory(root, data), null);
  const directory = join(root, '.local/video-scripts'); await mkdir(directory, { recursive: true }); const path = join(directory, plan.datasetHash + '.json');
  await writeFile(path, JSON.stringify(plan)); assert.equal((await loadReviewedVideoStory(root, data)).model, 'Reviewed script');
  await writeFile(path, '{broken'); await assert.rejects(loadReviewedVideoStory(root, data), /valid JSON/);
  plan.reviewedBoundaryStory.repair.total = 99; await writeFile(path, JSON.stringify(plan)); await assert.rejects(loadReviewedVideoStory(root, data), /counts/);
});
