const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const codexRoot = process.env.CODEX_HOME || path.join(process.env.USERPROFILE, '.codex');
const dataRoot = process.env.IDLE_COMPACT_DATA || path.join(codexRoot, 'plugin-data', 'idle-compact');
const sessionsRoot = path.join(codexRoot, 'sessions');
const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file);
}
function read(file, missing = null) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : missing; }
function fileFor(kind, id) { if (!idPattern.test(id)) throw Error('Invalid local thread ID'); return path.join(dataRoot, kind, id + '.json'); }
function register(id, transcriptPath, event = 'manual') {
  const file = fileFor('watches', id);
  const previous = read(file, {});
  let transcript = transcriptPath || previous.transcript;
  if (transcript) {
    transcript = path.resolve(transcript);
    const relative = path.relative(path.resolve(sessionsRoot), transcript);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(transcript).endsWith(id + '.jsonl')) throw Error('Transcript must belong to this local Codex session');
  }
  const watch = { ...previous, id, transcript, enabled: event !== 'SessionEnd', lastHook: event, updatedAt: Date.now() };
  if (event === 'UserPromptSubmit') watch.userSubmittedAt = Date.now();
  atomic(file, watch); return watch;
}
function settings() {
  const value = read(path.join(dataRoot, 'settings.json'), { idleMinutes: 25, minContextTokens: 30000, dryRun: false });
  if (!Number.isInteger(value.idleMinutes) || value.idleMinutes < 1 || value.idleMinutes > 1440 || !Number.isInteger(value.minContextTokens) || value.minContextTokens < 0 || typeof value.dryRun !== 'boolean') throw Error('Invalid idle-compact settings');
  return value;
}
function log(kind, data) { fs.mkdirSync(dataRoot, { recursive: true }); fs.appendFileSync(path.join(dataRoot, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + '\n'); }
function settingsFor(id, revision, now = Date.now()) {
  const normal = settings();
  const test = read(fileFor('verification', id));
  if (!test || test.revision !== revision || now >= test.expiresAt) return normal;
  if (!Number.isFinite(test.armedAt) || !Number.isFinite(test.expiresAt) || test.expiresAt - test.armedAt > 15 * 60000 || test.expiresAt <= test.armedAt || now < test.armedAt) throw Error('Invalid verification deadline');
  return { ...normal, idleMinutes: 1, minContextTokens: 0, verification: true };
}
module.exports = { dataRoot, sessionsRoot, idPattern, atomic, read, fileFor, register, settings, settingsFor, log };
