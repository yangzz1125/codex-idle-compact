const net = require('node:net');
const { randomUUID } = require('node:crypto');
class DesktopIPC {
  constructor(pipe = '\\\\.\\pipe\\codex-ipc') {
    this.socket = net.createConnection(pipe);
    this.pending = new Map(); this.buffer = Buffer.alloc(0); this.clientId = 'uninitialized';
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.socket.destroy(); reject(Error('IPC connection timeout')); }, 3000);
      this.socket.once('connect', () => { clearTimeout(timeout); resolve(); });
      this.socket.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    this.socket.on('data', data => {
      this.buffer = Buffer.concat([this.buffer, data]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE(0);
        if (length === 0 || length > 268435456) { this.socket.destroy(Error('Invalid IPC frame')); return; }
        if (this.buffer.length < length + 4) return;
        const body = this.buffer.subarray(4, length + 4); this.buffer = this.buffer.subarray(length + 4);
        let message;
        try { message = JSON.parse(body.toString('utf8')); } catch (error) { this.socket.destroy(error); return; }
        if (message.type === 'client-discovery-request') {
          this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
        } else if (message.type === 'response') {
          const task = this.pending.get(message.requestId);
          if (task) { clearTimeout(task.timer); this.pending.delete(message.requestId); task.resolve(message); }
        }
        // Broadcast bodies are neither retained nor logged.
      }
    });
    this.socket.on('error', error => this.rejectAll(error));
    this.socket.on('close', () => this.rejectAll(Error('Desktop IPC closed')));
  }
  rejectAll(error) { for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); } this.pending.clear(); }
  write(message) { const payload = Buffer.from(JSON.stringify(message)); const frame = Buffer.alloc(4 + payload.length); frame.writeUInt32LE(payload.length); payload.copy(frame, 4); this.socket.write(frame); }
  async request(method, params, options = {}) {
    await this.ready;
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error('IPC request timed out: ' + method)); }, 6000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.write({ type: 'request', requestId, sourceClientId: this.clientId, method, params, version: method === 'initialize' ? 0 : 1, timeoutMs: 5000, ...options });
    });
  }
  async initialize() {
    const result = await this.request('initialize', { clientType: 'codex-idle-compact' });
    if (result.resultType !== 'success') throw Error('IPC initialize: ' + result.error);
    this.clientId = result.result.clientId;
  }
  async findOwner(id) {
    const result = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: id });
    if (result.resultType !== 'success') throw Error('Owner discovery: ' + result.error);
    return result.handledByClientId;
  }
  async compact(id, owner) {
    const result = await this.request('thread-follower-compact-thread', { conversationId: id }, { targetClientId: owner });
    if (result.resultType !== 'success' || result.result?.ok !== true) throw Error('Native compaction: ' + (result.error || 'invalid acknowledgement'));
    return { accepted: true };
  }
  close() { this.socket.destroy(); }
}
module.exports = { DesktopIPC };
if (require.main === module) (async () => {
  const ipc = new DesktopIPC();
  try { await ipc.initialize(); const owner = await ipc.findOwner(process.argv[2] || process.env.CODEX_THREAD_ID); console.log(JSON.stringify({ connected: true, ownerFound: !!owner })); }
  finally { ipc.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
