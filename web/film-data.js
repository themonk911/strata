export const CHAPTER_IDS = ['origin', 'boundaries', 'growth', 'pressure', 'findings', 'focus', 'outlook'];
export const FILM_SECONDS = CHAPTER_IDS.length * 8;
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
  const first = measures(data.snapshots[0]), latest = measures(data.snapshots[last]), pressure = measures(data.snapshots[peak]);
  const target = data.snapshots[last].desirePaths.find(p => data.snapshots[last].files[p.target]?.district === district?.id);
  const name = target?.target.split('/').pop();
  return { title: data.meta.name + ' / code history', subtitle: 'Source files, imports and module boundaries.', model: null, chapters: [
    { id: 'origin', title: 'The first snapshot', caption: 'Each building is a source file. Taller buildings contain more code.', snapshot: 0 },
    { id: 'boundaries', title: 'What is a boundary?', caption: 'A module groups related code. Its public API is the way in. A shortcut imports a private file directly.', snapshot: 0 },
    { id: 'growth', title: `${first.files} → ${latest.files} files`, caption: `The repository now contains ${latest.lines.toLocaleString('en-GB')} lines of code, compared with ${first.lines.toLocaleString('en-GB')} in the first snapshot.`, snapshot: last },
    { id: 'pressure', title: 'Imports bypassing module APIs', caption: `${pressure.shortcuts} of ${pressure.imports} resolved imports reach private files in another module at this point.`, snapshot: peak },
    { id: 'findings', title: 'Boundaries to review', caption: district ? `${district.name} receives ${district.incoming} shortcuts. The ranking shows where callers bypass the public entry points most often.` : 'No module boundaries are declared in this scan.', snapshot: last },
    { id: 'focus', title: district ? 'Shared files in ' + district.name : 'Define the public APIs', caption: target ? `${name} is imported by ${target.sources.length} files across ${target.districts.length} districts.` : 'Check which private operations callers use across this boundary.', snapshot: last, district: district?.id },
    { id: 'outlook', title: name ? 'Start with ' + name : 'Review the public API', caption: name ? `Check whether the public API exposes the operation these callers need from ${name}.` : 'Group callers that need the same operation before changing the public API.', snapshot: last }
  ] };
}
export function filmPosition(seconds, story, count) {
  const chapter = Math.min(story.chapters.length - 1, Math.floor(Math.max(0, seconds) / 8));
  const progress = Math.min(1, Math.max(0, (seconds - chapter * 8) / 8));
  const snapshot = story.chapters[chapter].id === 'growth' ? Math.round(progress * story.chapters[chapter].snapshot) : story.chapters[chapter].snapshot;
  return { chapter, progress, snapshot: Math.min(count - 1, Math.max(0, snapshot)) };
}
