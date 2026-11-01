import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { CodexClient } from '../server/api.mjs';

// Exercise the real JSONL transport with a local fixture, never the Codex service.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'strata-codex-test-'));
  const command = join(directory, 'codex-fixture');
  await writeFile(command, `#!${process.execPath}
const readline = require('node:readline');
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(directory, 'starts'))}, process.pid + '\\n');
if (fs.existsSync(${JSON.stringify(join(directory, 'fail'))})) process.exit(1);
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
process.on('SIGTERM', () => {
  setTimeout(() => process.stdout.write(JSON.stringify({ method: 'fixture/retired', params: {} }) + '\\n'), 40);
  setTimeout(() => process.exit(0), 120);
});
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'hold') return;
  if (message.method === 'delay') return setTimeout(() => reply(message.id, { pid: process.pid }), 250);
  if (message.method === 'account/read') return reply(message.id, { account: { type: 'chatgpt', planType: 'pro' } });
  if (message.method === 'modelProvider/capabilities/read') return reply(message.id, { imageGeneration: true });
  reply(message.id, {});
});
`);
  await chmod(command, 0o755);
  const client = new CodexClient({ cwd: directory, command });
  const children = new Set();
  const connect = async () => {
    const pending = client.connect();
    if (client.child) children.add(client.child);
    return pending;
  };
  t.after(async () => {
    client.close();
    await Promise.all([...children].map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    await rm(directory, { recursive: true, force: true });
  });
  return { client, connect, directory };
}

test('concurrent and repeated connection probes share a healthy app-server', async t => {
  const { client, connect } = await fixture(t);
  const [first, second] = await Promise.all([connect(), connect()]);
  const child = client.child;
  assert.deepEqual(first, { signedIn: true, authType: 'chatgpt', plan: 'pro', imageGeneration: true });
  assert.deepEqual(second, first);
  assert.deepEqual(await connect(), first);
  assert.equal(client.child, child);
});

test('a retired app-server exit cannot reject replacement requests', async t => {
  const { client, connect } = await fixture(t);
  const notifications = [];
  client.on('notification', message => notifications.push(message));
  await connect();
  const oldChild = client.child;
  client.close();
  await connect();
  const newChild = client.child;
  assert.notEqual(newChild, oldChild);
  const result = await client.request('delay', {}, 1000);
  assert.equal(result.pid, newChild.pid);
  assert.equal(client.child, newChild);
  assert.deepEqual(notifications, []);
  assert.deepEqual(await connect(), { signedIn: true, authType: 'chatgpt', plan: 'pro', imageGeneration: true });
});

test('closing a connection settles pending requests immediately', async t => {
  const { client, connect } = await fixture(t);
  await connect();
  let state;
  const outcome = client.request('hold', {}, 1000).then(
    () => { state = 'resolved'; },
    () => { state = 'rejected'; },
  );
  client.close();
  await Promise.resolve();
  assert.equal(state, 'rejected');
  await outcome;
});

test('unexpected app-server exit rejects requests and allows reconnecting', async t => {
  const { client, connect } = await fixture(t);
  await connect();
  const pending = assert.rejects(client.request('hold', {}, 1000), /disconnected/);
  client.child.kill('SIGKILL');
  await pending;
  assert.equal((await connect()).signedIn, true);
});

test('an abandoned initialization cannot close its replacement', async t => {
  const { client, connect } = await fixture(t);
  const abandoned = assert.rejects(connect(), /closed/);
  client.close();
  const replacement = connect();
  await abandoned;
  assert.equal((await replacement).signedIn, true);
  assert.ok(client.child);
});

test('failed status probes back off while explicit connections can retry', async t => {
  const { client, connect, directory } = await fixture(t);
  const starts = async () => (await readFile(join(directory, 'starts'), 'utf8')).trim().split('\n').length;
  await writeFile(join(directory, 'fail'), '');
  await assert.rejects(client.status(), /disconnected/);
  await assert.rejects(client.status(), /disconnected/);
  assert.equal(await starts(), 1);
  await rm(join(directory, 'fail'));
  assert.equal((await connect()).signedIn, true);
  assert.equal(await starts(), 2);
  assert.equal((await client.status()).signedIn, true);
  assert.equal(await starts(), 2);
});
