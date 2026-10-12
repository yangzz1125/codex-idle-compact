// One local observation process; the installed MCP monitor performs compaction.
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.cjs');
const { SessionMetadata } = require('./session-metadata.cjs');
const [id, reportPath] = process.argv.slice(2);
if (!store.idPattern.test(id || '') || !reportPath || !path.isAbsolute(reportPath)) throw Error('Usage: node verify-once.cjs <thread-id> <absolute-report.json>');
const reader = new SessionMetadata(store.sessionsRoot);
const watch = store.read(store.fileFor('watches', id));
if (!watch?.enabled || !watch.transcript) throw Error('Chat must already be watched');
reader.paths.set(id, watch.transcript);
const initial = reader.read(id);
if (!initial?.revision) throw Error('Cannot identify the current turn');
const requestPath = store.fileFor('verification', id);
if (store.read(requestPath)?.expiresAt > Date.now()) throw Error('A verification is already pending');
const armedAt = Date.now();
const request = { revision: initial.revision, armedAt, expiresAt: armedAt + 15 * 60000 };
const normal = { idleMinutes: 25, minContextTokens: 30000, dryRun: false };
store.atomic(path.join(store.dataRoot, 'settings.json'), normal);
const result = { threadId: id, armedAt, expiresAt: request.expiresAt, revision: initial.revision, status: 'waiting-for-turn-end', testIdleMinutes: 1, testMinContextTokens: 0, normalSettings: normal };
function save() { store.atomic(reportPath, { ...result, updatedAt: Date.now() }); }
function restore() {
  if (store.read(requestPath)?.armedAt === armedAt) fs.unlinkSync(requestPath);
  result.restoredSettings = store.settingsFor(id, initial.revision);
  result.restored = result.restoredSettings.idleMinutes === 25 && result.restoredSettings.minContextTokens === 30000 && !result.restoredSettings.verification;
}
async function run() {
  store.atomic(requestPath, request); save();
  try {
    while (Date.now() < request.expiresAt) {
      const state = reader.read(id);
      const attempt = store.read(store.fileFor('attempts', id));
      const ownAttempt = attempt?.revision === initial.revision && attempt.at >= armedAt;
      if (ownAttempt && attempt.status === 'failed') { result.status = 'failed'; result.error = attempt.error; break; }
      if (ownAttempt && ['dispatched', 'compacted'].includes(attempt.status)) {
        if (!result.dispatchedAt) {
          result.dispatchedAt = attempt.at; result.idleMillisecondsAtDispatch = attempt.at - result.idleSince;
          result.nativeReply = attempt.reply; result.status = 'awaiting-compaction-marker'; restore(); save();
        }
        if (state.lastCompactionAt >= attempt.at) {
          result.status = 'passed'; result.completedAt = state.lastCompactionAt;
          result.evidence = 'Installed MCP dispatched native compaction; a newer compacted/context_compacted record exists in the real session log.';
          break;
        }
      } else if (state.revision !== initial.revision) { result.status = 'cancelled-new-turn'; break; }
      else if (state.busy === false && result.status === 'waiting-for-turn-end') {
        result.status = 'waiting-for-idle'; result.idleSince = state.lastActivityAt; result.beforeTokens = state.usedTokens; save();
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!['passed', 'failed', 'cancelled-new-turn'].includes(result.status)) result.status = 'timed-out';
  } catch (error) { result.status = 'error'; result.error = error.message; }
  finally { restore(); save(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
