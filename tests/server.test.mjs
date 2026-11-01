import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function unusedPort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function request(port, path, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      let content = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { content += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, content }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Test HTTP request timed out.')));
    req.end(body);
  });
}

test('local server enforces host, origin, routes, and JSON input before actions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'strata-server-test-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'server'));
  await mkdir(join(root, 'dist'));
  const modules = (await readdir(new URL('../server/', import.meta.url))).filter(name => name.endsWith('.mjs'));
  await Promise.all(modules.map(name =>
    copyFile(new URL('../server/' + name, import.meta.url), join(root, 'server', name))));
  const city = { schemaVersion: 1, meta: { name: 'test', private: true }, files: [], snapshots: [], changes: [] };
  const cityFile = join(root, 'city.json');
  await writeFile(cityFile, JSON.stringify(city));
  await writeFile(join(root, 'dist', 'index.html'), '<!doctype html><title>Test city</title>');
  await writeFile(join(root, '.env.local'), 'TEST_SERVER_PRIVATE_VALUE=not-public\n');
  const port = await unusedPort();
  const env = { ...process.env, PORT: String(port), STRATA_DATA: cityFile };
  delete env.OPENAI_API_KEY;
  delete env.STRATA_REPO;
  delete env.STRATA_CONFIG;
  child = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Test server did not start.')), 5000);
    let diagnostics = '';
    const finish = error => {
      clearTimeout(timer);
      child.off('error', finish);
      child.off('exit', exited);
      child.stdout.off('data', ready);
      error ? reject(error) : resolve();
    };
    const ready = data => { if (data.toString().includes('Strata: http://')) finish(); };
    const exited = () => finish(new Error('Test server exited: ' + diagnostics));
    child.stderr.on('data', data => { diagnostics += data; });
    child.stdout.on('data', ready);
    child.once('error', finish);
    child.once('exit', exited);
  });

  const valid = await request(port, '/api/city');
  assert.equal(valid.status, 200);
  assert.deepEqual(JSON.parse(valid.content), city);
  assert.equal(valid.headers['cache-control'], 'no-store');
  assert.equal(valid.headers['x-content-type-options'], 'nosniff');
  assert.equal((await request(port, '/', { headers: { Host: 'localhost:' + port } })).status, 200);
  assert.equal((await request(port, '/api/city', { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal((await request(port, '/api/city', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request(port, '/api/city', { headers: { Origin: 'http://localhost:' + port } })).status, 200);
  for (const path of ['/.env.local', '/server/index.mjs', '/%2e%2e/.env.local', '/generated/../../.env.local']) {
    const response = await request(port, path);
    assert.equal(response.status, 404, path);
    assert.ok(!response.content.includes('not-public'));
  }
  assert.equal((await request(port, '/api/jobs/missing')).status, 404);
  assert.equal((await request(port, '/api/city', { method: 'DELETE' })).status, 405);
  const contentType = await request(port, '/api/explain', { method: 'POST', body: '{}' });
  assert.equal(contentType.status, 400);
  assert.match(contentType.content, /application\/json/);
  const invalidJson = await request(port, '/api/explain', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(invalidJson.status, 400);
  const invalidSnapshot = await request(port, '/api/explain', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"snapshot":99}',
  });
  assert.equal(invalidSnapshot.status, 400);
  assert.match(invalidSnapshot.content, /valid snapshot/);
});
