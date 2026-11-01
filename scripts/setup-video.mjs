import { mkdir, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

// Pin the existing rendering engine; generated projects stay in ignored storage.
const revision = 'e95232c8d535ed2aa390e7b1caee0d1326dd9e83';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = resolve(process.env.STRATA_EXPLAINROO_HOME || join(root, '.local/tools/explainroo'));
const env = { ...process.env, EXPLAINROO_CACHE: join(root, '.local/tools/explainroo-cache') };
delete env.OPENAI_API_KEY;
const exists = path => access(path).then(() => true, () => false);
function run(command, args, cwd, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let output = '';
    child.stdout?.on('data', bytes => { output += bytes; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} exited with status ${code}.`)));
  });
}
try {
  if (!(await exists(home))) {
    await mkdir(dirname(home), { recursive: true });
    await run('git', ['clone', 'https://github.com/vincentsch/explainroo.git', home], root);
    await run('git', ['checkout', '--detach', revision], home);
  }
  const actual = await run('git', ['rev-parse', 'HEAD'], home, true);
  if (actual !== revision) throw new Error('Existing Explainroo checkout uses a different revision. Keep it, and set STRATA_EXPLAINROO_HOME to a new empty location before setup.');
  if (!(await exists(join(home, 'node_modules')))) await run('npm', ['ci'], home);
  const report = await run(process.execPath, [join(home, 'bin/explainroo.js'), 'doctor'], root, true);
  const required = report.split('\n').filter(line => /^(?:ok|FAIL)\s+(?:node|ffmpeg|chrome)\s/.test(line));
  for (const line of required) console.log(line);
  if (required.length !== 3 || required.some(line => line.startsWith('FAIL'))) throw new Error('A required video dependency is missing.');
  const models = pathToFileURL(join(home, 'src/models.js')).href;
  await run(process.execPath, ['--input-type=module', '-e', `import { loadASR } from ${JSON.stringify(models)}; await loadASR({log:console.log});`], root);
  console.log('Video renderer ready. Add OPENAI_API_KEY to .env.local, then restart Strata.');
} catch (error) {
  console.error('Video setup: ' + error.message);
  console.error('The renderer requires FFmpeg and Chrome or Chromium. On macOS: brew install ffmpeg');
  process.exitCode = 1;
}
