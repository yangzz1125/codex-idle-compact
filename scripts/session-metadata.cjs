const fs = require('node:fs');
const path = require('node:path');

// Only metadata leaves this parser. No message text is saved or sent anywhere.
function createState(id) {
  return { id, busy: null, usedTokens: null, lastActivityAt: null, revision: null, compactedAfterTurn: false };
}
function reduce(state, row) {
  const at = Date.parse(row.timestamp);
  if (!Number.isFinite(at)) return;
  const event = row.type === 'event_msg' ? row.payload : null;
  if (event?.type === 'task_started') {
    state.busy = true;
    state.lastActivityAt = at;
    state.revision = event.turn_id || row.timestamp;
    state.compactedAfterTurn = false;
  } else if (event?.type === 'task_complete' || event?.type === 'task_completed' || event?.type === 'turn_aborted') {
    state.busy = false;
    state.lastActivityAt = at;
    state.revision = event.turn_id || state.revision || row.timestamp;
  } else if (event?.type === 'token_count') {
    const usage = event.info?.last_token_usage;
    if (Number.isFinite(usage?.input_tokens)) {
      state.usedTokens = usage.input_tokens;
      state.cachedTokens = usage.cached_input_tokens;
    }
    // Work continuing after an in-turn compaction can grow the context again.
    if (state.busy === true && at > (state.lastCompactionAt || Infinity)) state.compactedAfterTurn = false;
    // Token count updates alone don't prove the turn has ended.
    state.lastActivityAt = Math.max(state.lastActivityAt || 0, at);
  } else if (row.type === 'compacted' || event?.type === 'context_compacted') {
    state.compactedAfterTurn = true;
    state.lastCompactionAt = at;
    state.lastActivityAt = at;
  }
}
class SessionMetadata {
  constructor(root) { this.root = root; this.paths = new Map(); this.cache = new Map(); this.scannedAt = 0; }
  locate(id) {
    if (this.paths.has(id)) return this.paths.get(id);
    if (Date.now() - this.scannedAt < 30000) return null;
    this.scannedAt = Date.now();
    for (const entry of fs.readdirSync(this.root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const match = entry.name.match(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$/i);
      if (match) this.paths.set(match[1], path.join(entry.parentPath, entry.name));
    }
    return this.paths.get(id) || null;
  }
  read(id) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) return null;
    const file = this.locate(id);
    if (!file) return null;
    const stat = fs.statSync(file);
    let record = this.cache.get(id);
    if (!record || stat.size < record.offset) record = { offset: 0, state: createState(id) };
    if (stat.size > record.offset) {
      const fd = fs.openSync(file, 'r');
      try {
        // Stream chunks: a long transcript should never be duplicated in memory.
        let tail = record.tail || '';
        const decoder = record.decoder || new (require('node:string_decoder').StringDecoder)('utf8');
        const buffer = Buffer.alloc(256 * 1024);
        while (record.offset < stat.size) {
          const bytes = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - record.offset), record.offset);
          if (!bytes) break;
          record.offset += bytes;
          tail += decoder.write(buffer.subarray(0, bytes));
          let end;
          while ((end = tail.indexOf('\n')) >= 0) {
            const line = tail.slice(0, end); tail = tail.slice(end + 1);
            if (!line.trim()) continue;
            // Parse only event metadata and the compaction marker, never content items.
            if (/"type"\s*:\s*"(?:event_msg|compacted)"/.test(line)) reduce(record.state, JSON.parse(line));
          }
        }
        // Preserve partial UTF-8 sequences across polls as well as partial lines.
        record.tail = tail;
        record.decoder = decoder;
      } finally { fs.closeSync(fd); }
    }
    this.cache.set(id, record);
    return { ...record.state };
  }
}
module.exports = { createState, reduce, SessionMetadata };
