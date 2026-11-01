import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['web/app.js'], bundle: true, minify: true, format: 'esm', outfile: 'dist/app.js', target: ['es2022'], legalComments: 'linked' });
await Promise.all(['index.html', 'style.css'].map(name => copyFile('web/' + name, 'dist/' + name)));
console.log('Built static city in dist/');
