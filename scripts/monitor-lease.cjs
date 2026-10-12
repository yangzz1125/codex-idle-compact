const net = require('node:net');
const { createHash } = require('node:crypto');
// Codex starts an MCP process per chat. A named-pipe lease lets exactly one
// process check the shared watch list; Windows releases it if that process exits.
class MonitorLease {
  constructor(dataRoot) {
    this.pipe = '\\\\.\\pipe\\codex-idle-compact-' + createHash('sha256').update(dataRoot.toLowerCase()).digest('hex').slice(0, 20);
    this.server = null; this.pending = null; this.closed = false;
  }
  async acquire() {
    if (this.closed) return false;
    if (this.server) return true;
    if (this.pending) return this.pending;
    this.pending = new Promise((resolve, reject) => {
      const server = net.createServer(socket => socket.end());
      server.once('error', error => { if (error.code === 'EADDRINUSE') resolve(false); else reject(error); });
      server.listen(this.pipe, () => {
        if (this.closed) { server.close(); resolve(false); return; }
        this.server = server; resolve(true);
      });
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  close() { this.closed = true; this.server?.close(); this.server = null; }
}
module.exports = { MonitorLease };
