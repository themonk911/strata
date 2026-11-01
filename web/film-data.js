export const FILM_SECONDS = 40;
export const CHAPTER_IDS = ['origin', 'growth', 'pressure', 'focus', 'outlook'];
export function measures(s) {
  const files = Object.values(s.files), imports = s.imports.length;
  return { files: files.length, lines: files.reduce((sum, f) => sum + f.lines, 0), imports,
    shortcuts: s.shortcuts.length, pressure: imports ? s.shortcuts.length / imports * 100 : 0,
    shared: s.desirePaths.length };
}
export function defaultStory(data) {
  const last = data.snapshots.length - 1;
  const peak = data.snapshots.reduce((best, s, i) => measures(s).pressure > measures(data.snapshots[best]).pressure ? i : best, 0);
  const district = [...data.snapshots[last].districts].filter(d => d.walled).sort((a, b) => b.incoming - a.incoming)[0];
  return { title: 'A codebase, becoming.', subtitle: 'The shape of change, told by your repository.', model: null, chapters: [
    { id: 'origin', title: 'Every codebase starts somewhere.', caption: 'The earliest snapshot in this window. Every building is a source file; its height follows line count.', snapshot: 0 },
    { id: 'growth', title: 'Then the landscape changes.', caption: 'Watch the source files accumulate, grow, and disappear across the recorded history.', snapshot: last },
    { id: 'pressure', title: 'Growth has a shape.', caption: 'Boundary pressure is the share of resolved imports that reach into another module’s private files. A signal to inspect, not a defect score.', snapshot: peak },
    { id: 'focus', title: district ? 'Follow the repeated paths.' : 'Look for an intentional boundary.', caption: district ? 'This district receives the most shortcuts in the latest snapshot. Confirm the intended public API before changing callers.' : 'No walled district is present. Declare the public entry points before drawing conclusions about shortcuts.', snapshot: last, district: district?.id },
    { id: 'outlook', title: 'Make the next change intentional.', caption: 'Inspect the busiest boundary. Decide what belongs in its public gate, then compare the next snapshot.', snapshot: last }
  ] };
}
export function filmPosition(seconds, story, count) {
  const chapter = Math.min(4, Math.floor(Math.max(0, seconds) / 8));
  const progress = Math.min(1, Math.max(0, (seconds - chapter * 8) / 8));
  const snapshot = chapter === 1 ? Math.round(progress * story.chapters[chapter].snapshot) : story.chapters[chapter].snapshot;
  return { chapter, progress, snapshot: Math.min(count - 1, Math.max(0, snapshot)) };
}
