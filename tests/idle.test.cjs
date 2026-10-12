const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decide, IDLE_MS } = require('../scripts/idle-policy.cjs');
const { createState, reduce, SessionMetadata } = require('../scripts/session-metadata.cjs');
const id = '11111111-1111-1111-1111-111111111111';
const base = { id, busy: false, usedTokens: 200000, lastActivityAt: 1000, revision: 'turn-1' };
test('waits for a full 25 minutes, including the final millisecond', () => {
  assert.equal(decide(base, null, 1000 + IDLE_MS - 1).ready, undefined);
  assert.equal(decide(base, null, 1000 + IDLE_MS).ready, undefined);
  assert.equal(decide(base, null, 1001 + IDLE_MS).ready, true);
});
test('requires strictly more than 30,000 context tokens', () => {
  assert.equal(decide({ ...base, usedTokens: 30000 }, null, 1e9).code, 'small-context');
  assert.equal(decide({ ...base, usedTokens: 30001 }, null, 1e9).ready, true);
});
test('an active or unknown long-running turn never compacts', () => {
  for (const busy of [true, null, undefined]) assert.equal(decide({ ...base, busy }, null, 1e9).code, 'busy-or-unknown');
});
test('only one attempt per turn; a later turn may compact', () => {
  const previous = { revision: base.revision, status: 'failed' };
  assert.equal(decide(base, previous, 1e9).code, 'already-attempted');
  assert.equal(decide({ ...base, revision: 'turn-2' }, previous, 1e9).ready, true);
});
test('small contexts and already compacted contexts are skipped', () => {
  assert.equal(decide({ ...base, usedTokens: 1000 }, null, 1e9).code, 'small-context');
  assert.equal(decide({ ...base, compactedAfterTurn: true }, null, 1e9).code, 'already-compacted');
  assert.equal(decide({ ...base, usedTokens: null }, null, 1e9).code, 'unknown-usage');
});
test('new user activity resets the entire idle window', () => {
  assert.equal(decide({ ...base, lastActivityAt: IDLE_MS }, null, IDLE_MS + 1000).code, 'waiting');
});
test('metadata uses per-request tokens, does not confuse cumulative billing with context', () => {
  const state = createState(id);
  const row = (type, payload) => ({ timestamp: '2026-10-12T06:00:00Z', type: 'event_msg', payload: { type, ...payload } });
  reduce(state, row('task_started', { turn_id: 't1' }));
  reduce(state, row('token_count', { info: { total_token_usage: { input_tokens: 2000000 }, last_token_usage: { input_tokens: 20000 } } }));
  assert.equal(state.usedTokens, 20000); assert.equal(state.busy, true);
  reduce(state, row('task_complete', { turn_id: 't1' })); assert.equal(state.busy, false);
  reduce(state, { timestamp: '2026-10-12T06:01:00Z', type: 'compacted', payload: {} });
  assert.equal(state.compactedAfterTurn, true);
  reduce(state, row('task_started', { turn_id: 't2' })); assert.equal(state.compactedAfterTurn, false);
});
test('incremental logs preserve split UTF-8 and incomplete records without exposing text', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-test-'));
  try {
    const file = path.join(root, 'rollout-' + id + '.jsonl');
    const line = Buffer.from(JSON.stringify({ timestamp: '2026-10-12T06:00:00Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: '中文秘密' } }) + '\n');
    const split = line.indexOf(Buffer.from('中')) + 1;
    fs.writeFileSync(file, line.subarray(0, split));
    const reader = new SessionMetadata(root);
    assert.equal(reader.read(id).busy, null);
    fs.appendFileSync(file, line.subarray(split));
    const result = reader.read(id);
    assert.equal(result.busy, false); assert.equal(result.revision, 't1');
    assert.equal(JSON.stringify(result).includes('秘密'), false);
    assert.equal(reader.read('../invalid'), null);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('idle-test-'));
    fs.rmSync(root, { recursive: true });
  }
});
