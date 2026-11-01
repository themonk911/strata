import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const destination = '.local/strata-plugin';
// Explicit allowlist: never package a workspace, .env, scan, or generated image.
for (const path of ['plugin.json', 'core/__init__.py', 'core/scan.py', 'hooks/check.py', 'hooks/hooks.json', 'skills/strata/SKILL.md', 'bin/strata.mjs']) {
  await mkdir(dirname(destination + '/' + path), { recursive: true });
  await copyFile(path, destination + '/' + path);
}
await writeFile(destination + '/package.json', JSON.stringify({name:'strata-plugin',type:'module',private:true,version:'0.1.0'}));
await build({entryPoints:['core/parse-js.mjs'],bundle:true,platform:'node',format:'esm',minify:true,outfile:destination+'/core/parse-js.mjs',banner:{js:'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'},legalComments:'linked'});
console.log('Packaged standalone local plugin: ' + destination);
