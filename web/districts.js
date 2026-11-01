// Presentation only: source-file extensions provide a stable language legend.
export const DISTRICT_PALETTE = Object.freeze([
  { language: 'swift', title: 'Swift', color: '#668fa9', lot: '#dbe5eb', darkLot: '#344954' },
  { language: 'typescript', title: 'TypeScript', color: '#779781', lot: '#dce5dc', darkLot: '#344a3c' },
  { language: 'javascript', title: 'JavaScript', color: '#ad9a70', lot: '#e9e2d4', darkLot: '#514735' },
  { language: 'python', title: 'Python', color: '#ad838c', lot: '#eadfe2', darkLot: '#503c43' },
  { language: 'mixed', title: 'Mixed', color: '#92928a', lot: '#e2e2dc', darkLot: '#41413d' },
]);

function contextFor(path) {
  const parts = path.split('/');
  if (parts.some(part => /^(tests?|__tests__|__smoke__)$/.test(part) || part.endsWith('Tests'))) return 'tests';
  if (parts[0].toLowerCase() === 'ios') return 'iOS';
  if (path.startsWith('src/features/')) return 'features';
  if (path.startsWith('src/app/api/')) return 'API';
  if (path.startsWith('src/server/')) return 'server';
  return parts.at(-2) || 'root';
}

const languageFor = path => ({ swift: 'swift', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python' })[path.split('.').at(-1).toLowerCase()] || 'mixed';

export function districtPresentation(data) {
  const groups = new Map(), names = new Map(), result = new Map();
  for (const file of data.files) {
    if (!groups.has(file.district)) groups.set(file.district, []);
    groups.get(file.district).push(file);
  }
  for (const id of groups.keys()) {
    const name = id.split('/').at(-1).toLowerCase();
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(id);
  }
  for (const [id, files] of groups) {
    const basename = id.split('/').at(-1), peers = names.get(basename.toLowerCase());
    let context = contextFor(id);
    if (peers.filter(peer => contextFor(peer) === context).length > 1) context = id.split('/').slice(0, -1).join('/') || 'root';
    const counts = new Map();
    for (const file of files) { const language = languageFor(file.path); counts.set(language, (counts.get(language) || 0) + 1); }
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    const language = ranked.length > 1 && ranked[0][1] === ranked[1][1] ? 'mixed' : ranked[0][0];
    result.set(id, { ...DISTRICT_PALETTE.find(item => item.language === language), context,
      label: peers.length > 1 ? `${basename} · ${context}` : basename });
  }
  return result;
}
