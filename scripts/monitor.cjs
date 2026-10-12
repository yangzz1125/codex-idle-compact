const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DesktopIPC } = require('./ipc-client.cjs');
const { SessionMetadata } = require('./session-metadata.cjs');
const { decide } = require('./idle-policy.cjs');
const store = require('./store.cjs');
const { MonitorLease } = require('./monitor-lease.cjs');
class Monitor {
  constructor({ IPC = DesktopIPC } = {}) { this.IPC = IPC; this.reader = new SessionMetadata(store.sessionsRoot); this.running = false; this.closed = false; this.lastError = null; }
  async inspect(id) {
    const watch = store.read(store.fileFor('watches', id));
    if (!watch?.enabled) return { threadId: id, code: 'not-watched' };
    if (watch.transcript) this.reader.paths.set(id, watch.transcript);
    const snapshot = this.reader.read(id);
    if (snapshot && watch.userSubmittedAt) snapshot.lastActivityAt = Math.max(snapshot.lastActivityAt || 0, watch.userSubmittedAt);
    const config = store.settingsFor(id, snapshot?.revision);
    const attempt = store.read(store.fileFor('attempts', id));
    const decision = decide(snapshot, attempt, Date.now(), { idleMs: config.idleMinutes * 60000, minTokens: config.minContextTokens });
    if (attempt?.status === 'dispatched' && snapshot?.lastCompactionAt >= attempt.at) {
      store.atomic(store.fileFor('attempts', id), { ...attempt, status: 'compacted', completedAt: Date.now() });
      store.log('compaction-confirmed', { threadId: id });
    }
    return { threadId: id, idleMinutes: config.idleMinutes, minContextTokens: config.minContextTokens, verification: config.verification === true, dryRun: config.dryRun, usedTokens: snapshot?.usedTokens, lastActivityAt: snapshot?.lastActivityAt, revision: snapshot?.revision, ...decision };
  }
  async sweep() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      const directory = path.join(store.dataRoot, 'watches');
      if (!fs.existsSync(directory)) return;
      for (const file of fs.readdirSync(directory)) {
        if (!file.endsWith('.json')) continue;
        const id = file.slice(0, -5);
        const result = await this.inspect(id);
        store.atomic(store.fileFor('status', id), { ...result, checkedAt: Date.now() });
        if (!result.ready || result.dryRun || this.closed) continue;
        // Exclusive file creation prevents multiple MCP instances from dispatching twice.
        const revisionKey = createHash('sha256').update(result.revision).digest('hex').slice(0, 20);
        const lock = path.join(store.dataRoot, 'locks', `${id}-${revisionKey}.lock`);
        fs.mkdirSync(path.dirname(lock), { recursive: true });
        let fd;
        try { fd = fs.openSync(lock, 'wx'); } catch (error) { if (error.code === 'EEXIST') continue; throw error; }
        const ipc = new this.IPC();
        try {
          const checked = await this.inspect(id);
          if (!checked.ready || this.closed) continue;
          await ipc.initialize();
          const owner = await ipc.findOwner(id);
          const finalCheck = await this.inspect(id);
          if (!finalCheck.ready || this.closed || finalCheck.revision !== checked.revision) continue;
          const dispatchedAt = Date.now();
          store.atomic(store.fileFor('attempts', id), { revision: checked.revision, status: 'reserved', at: dispatchedAt });
          const reply = await ipc.compact(id, owner);
          store.atomic(store.fileFor('attempts', id), { revision: checked.revision, status: 'dispatched', at: dispatchedAt, reply });
          store.log('compaction-dispatched', { threadId: id, beforeTokens: checked.usedTokens });
        } catch (error) {
          // Persist one failure per completed turn: never loop paid requests.
          store.atomic(store.fileFor('attempts', id), { revision: result.revision, status: 'failed', at: Date.now(), error: error.message });
          store.log('compaction-error', { threadId: id, error: error.message });
        } finally { ipc.close(); fs.closeSync(fd); fs.unlinkSync(lock); }
      }
    } finally { this.running = false; }
  }
  start() {
    this.lease = new MonitorLease(store.dataRoot);
    const check = async () => {
      try { if (await this.lease.acquire()) await this.sweep(); }
      catch (error) { if (error.message !== this.lastError) store.log('monitor-error', { error: error.message }); this.lastError = error.message; }
    };
    this.timer = setInterval(check, 5000); check();
  }
  stop() { this.closed = true; clearInterval(this.timer); this.lease?.close(); }
}
module.exports = { Monitor };
