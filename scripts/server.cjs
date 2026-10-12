const readline = require('node:readline');
const { Monitor } = require('./monitor.cjs');
const { DesktopIPC } = require('./ipc-client.cjs');
const store = require('./store.cjs');
const monitor = new Monitor();
let initialized = false;
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
const tools = [
  { name: 'idle_compact_status', description: 'Read idle compaction status for a local Codex chat; probe its native desktop owner without compacting.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'idle_compact_watch', description: 'Enable 25-minute idle native compaction for this local Codex chat. Use when the user requests automatic compaction or enables this plugin for an existing chat.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'], additionalProperties: false } }
];
async function handle(message) {
  if (message.method === 'initialize') {
    send(message.id, { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'idle-compact', version: '0.6.5' } }); return;
  }
  if (message.method === 'notifications/initialized') {
    if (!initialized) { initialized = true; monitor.start(); store.log('mcp-connected', { pid: process.pid }); } return;
  }
  if (message.id == null) return;
  if (message.method === 'ping') { send(message.id, {}); return; }
  if (message.method === 'tools/list') { send(message.id, { tools }); return; }
  if (message.method !== 'tools/call') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return; }
  try {
    const id = message.params?.arguments?.threadId;
    if (!store.idPattern.test(id || '')) throw Error('Valid threadId is required');
    if (!tools.some(tool => tool.name === message.params.name)) throw Error('Unknown tool');
    const ipc = new DesktopIPC();
    try { await ipc.initialize(); await ipc.findOwner(id); } finally { ipc.close(); }
    if (message.params.name === 'idle_compact_watch') store.register(id);
    const status = await monitor.inspect(id);
    send(message.id, { content: [{ type: 'text', text: JSON.stringify({ ...status, nativeOwnerFound: true }) }] });
  } catch (error) { send(message.id, { isError: true, content: [{ type: 'text', text: error.message }] }); }
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); return; }
  handle(message).catch(error => { console.error(error.message); process.exitCode = 1; monitor.stop(); input.close(); });
});
input.on('close', () => { monitor.stop(); });
process.on('SIGTERM', () => { monitor.stop(); input.close(); process.exit(0); });
