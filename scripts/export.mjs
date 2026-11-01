import { readFile, writeFile } from 'node:fs/promises';
const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/export.mjs path/to/public-city.json');
const data = JSON.parse(await readFile(path, 'utf8'));
if (data.schemaVersion !== 1 || data.meta?.private !== false) throw new Error('Export refused: city data must be explicitly marked public. Never mark private data public without reviewing it.');
await writeFile('dist/city.json', JSON.stringify(data));
console.log('Static city exported to dist/. Review the dataset before publication.');
