import test from 'node:test';
import assert from 'node:assert/strict';
import { measures, defaultStory, filmPosition } from '../web/film-data.js';
const snap = (imports, shortcuts) => ({ files: { a: { lines: 4 } }, imports: Array(imports).fill({}), shortcuts: Array(shortcuts).fill({}), desirePaths: [], districts: [] });
test('boundary pressure normalizes for repository import growth and handles no imports', () => {
  assert.equal(measures(snap(10, 2)).pressure, 20);
  assert.equal(measures(snap(100, 3)).pressure, 3);
  assert.equal(measures(snap(0, 0)).pressure, 0);
});
test('film selects measured pressure peak and traverses full growth window', () => {
  const data = { snapshots: [snap(0, 0), snap(10, 2), snap(100, 3)] };
  const story = defaultStory(data);
  assert.equal(story.chapters[2].snapshot, 1);
  assert.equal(filmPosition(8, story, 3).snapshot, 0);
  assert.equal(filmPosition(15.9, story, 3).snapshot, 2);
  assert.equal(filmPosition(40, story, 3).chapter, 4);
  assert.equal(story.chapters[3].district, undefined);
  story.chapters[1].snapshot = 1;
  assert.equal(filmPosition(15.9, story, 3).snapshot, 1, 'growth stops at the evidence chosen by the narrator');
});
