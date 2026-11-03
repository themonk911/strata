import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const destination = process.argv[2] || '.local/strata-plugin';
// Explicit allowlist: never package a workspace, .env, scan, or generated image.
for (const path of ['plugin.json', 'core/__init__.py', 'core/scan.py', 'core/swift.py', 'core/entropy.py', 'core/rework.py', 'core/boundaries.py', 'core/change_history.py', 'core/gate_graph.py', 'hooks/check.py', 'hooks/hooks.json', 'skills/strata/SKILL.md', 'bin/strata.mjs']) {
  await mkdir(dirname(destination + '/' + path), { recursive: true });
  await copyFile(path, destination + '/' + path);
}
await writeFile(destination + '/package.json', JSON.stringify({name:'strata-plugin',type:'module',private:true,version:'0.1.0'}));
await build({
  entryPoints: ['core/parse-js.mjs'], bundle: true, platform: 'node', format: 'esm', minify: true,
  outfile: destination + '/core/parse-js.mjs', legalComments: 'linked',
  // TypeScript's CommonJS runtime needs these even though the parser entry point
  // is ESM. Keep the bundled parser usable without a sibling node_modules tree.
  banner: { js: 'import { createRequire } from "node:module"; import { fileURLToPath } from "node:url"; import { dirname } from "node:path"; const require = createRequire(import.meta.url); const __filename = fileURLToPath(import.meta.url); const __dirname = dirname(__filename);' },
});
console.log('Packaged standalone local plugin: ' + destination);
