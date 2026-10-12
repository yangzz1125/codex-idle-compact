const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-plugin-test-'));
process.env.CODEX_HOME = path.join(root, 'codex');
process.env.IDLE_COMPACT_DATA = path.join(root, 'data');
fs.mkdirSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
const store = require('../scripts/store.cjs');
const { Monitor } = require('../scripts/monitor.cjs');
const { DesktopIPC } = require('../scripts/ipc-client.cjs');
const { MonitorLease } = require('../scripts/monitor-lease.cjs');
const { createState, reduce } = require('../scripts/session-metadata.cjs');
test('one-shot verification is restricted to one turn and expires to production settings', () => {
  const id = randomUUID(), now = Date.now();
  store.atomic(store.fileFor('verification', id), { revision: 'a', armedAt: now, expiresAt: now + 60000 });
  assert.equal(store.settingsFor(id, 'a', now).idleMinutes, 1);
  assert.equal(store.settingsFor(id, 'a', now).minContextTokens, 0);
  for (const config of [store.settingsFor(id, 'b', now), store.settingsFor(randomUUID(), 'a', now), store.settingsFor(id, 'a', now + 60000)]) {
    assert.equal(config.idleMinutes, 25); assert.equal(config.minContextTokens, 30000);
  }
});
test('work after in-turn compaction remains eligible and keeps its completion timestamp', () => {
  const state = createState(randomUUID());
  reduce(state, { timestamp: '2026-10-12T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'a' } });
  reduce(state, { timestamp: '2026-10-12T00:01:00Z', type: 'compacted' });
  reduce(state, { timestamp: '2026-10-12T00:02:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 40000 } } } });
  assert.equal(state.compactedAfterTurn, false);
  assert.equal(state.lastCompactionAt, Date.parse('2026-10-12T00:01:00Z'));
});
test('only one MCP process owns monitoring and the lease transfers after shutdown', async () => {
  const a = new MonitorLease(root), b = new MonitorLease(root);
  try {
    assert.equal(await a.acquire(), true);
    assert.equal(await b.acquire(), false);
    a.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await b.acquire(), true);
  } finally { a.close(); b.close(); }
});
after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('idle-plugin-test-')); fs.rmSync(root, { recursive: true }); });
function transcript({ busy = false, age = 26 * 60000 } = {}) {
  const id = randomUUID(); const filename = path.join(store.sessionsRoot, 'rollout-' + id + '.jsonl');
  const at = new Date(Date.now() - age).toISOString();
  const rows = [
    { timestamp: at, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn1' } },
    { timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100000 } } } }
  ];
  if (!busy) rows.push({ timestamp: at, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn1' } });
  fs.writeFileSync(filename, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  store.register(id, filename, 'Stop'); return { id, filename };
}
test('native IPC uses the Windows frame format and targets the discovered owner', async () => {
  const pipe = '\\\\.\\pipe\\idle-compact-test-' + randomUUID();
  const methods = [];
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0); const msg = JSON.parse(buffer.subarray(4, 4 + length)); buffer = buffer.subarray(4 + length);
        methods.push(msg.method);
        assert.equal(msg.version, msg.method === 'initialize' ? 0 : 1);
        if (msg.method === 'thread-follower-compact-thread') assert.equal(msg.targetClientId, 'desktop-owner');
        const result = msg.method === 'initialize' ? { clientId: 'test-plugin' } : msg.method === 'thread-owner-discovery' ? {} : { ok: true };
        const body = Buffer.from(JSON.stringify({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'desktop-owner', result }));
        const frame = Buffer.alloc(4 + body.length); frame.writeUInt32LE(body.length); body.copy(frame, 4);
        socket.write(frame.subarray(0, 3)); socket.write(frame.subarray(3));
      }
    });
  });
  await new Promise(resolve => server.listen(pipe, resolve));
  const ipc = new DesktopIPC(pipe);
  try { await ipc.initialize(); const owner = await ipc.findOwner(randomUUID()); assert.equal((await ipc.compact(randomUUID(), owner)).accepted, true); }
  finally { ipc.close(); await new Promise(resolve => server.close(resolve)); }
  assert.deepEqual(methods, ['initialize', 'thread-owner-discovery', 'thread-follower-compact-thread']);
});
test('two MCP instances compact an eligible completed turn only once', async () => {
  const { id } = transcript(); let count = 0;
  class FakeIPC { async initialize() {} async findOwner() { return 'desktop'; } async compact() { count++; return { accepted: true }; } close() {} }
  const a = new Monitor({ IPC: FakeIPC }), b = new Monitor({ IPC: FakeIPC });
  await Promise.all([a.sweep(), b.sweep()]); await a.sweep();
  assert.equal(count, 1); assert.equal(store.read(store.fileFor('attempts', id)).status, 'dispatched');
  store.register(id, null, 'SessionEnd');
});
test('fresh and busy conversations never invoke native compaction', async () => {
  const a = transcript({ busy: true }); const b = transcript({ age: 60000 });
  class NeverIPC { constructor() { assert.fail('must not create native client'); } }
  await new Monitor({ IPC: NeverIPC }).sweep();
  store.register(a.id, null, 'SessionEnd'); store.register(b.id, null, 'SessionEnd');
});
test('new user submission while discovering the owner cancels compaction', async () => {
  const { id } = transcript(); let count = 0;
  class FakeIPC { async initialize() {} async findOwner() { store.register(id, null, 'UserPromptSubmit'); return 'desktop'; } async compact() { count++; } close() {} }
  await new Monitor({ IPC: FakeIPC }).sweep(); assert.equal(count, 0);
  store.register(id, null, 'SessionEnd');
});
test('MCP closes its timer when the plugin connection closes', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '../scripts/server.cjs')], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; });
  const code = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const timer = setTimeout(() => child.kill(), 5000);
  try { assert.equal(await code, 0); } finally { clearTimeout(timer); }
  const messages = output.trim().split('\n').map(JSON.parse);
  assert.equal(messages.find(row => row.id === 2).result.tools.length, 2);
});
