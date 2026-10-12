// Pure scheduling policy, shared by the Windows loader and its regression tests.
// The upstream MIT license applies; this file adds inactivity-based scheduling.
const IDLE_MS = 25 * 60 * 1000;
function decide(snapshot, ledger, now, options = {}) {
  const idleMs = options.idleMs ?? IDLE_MS;
  const minTokens = options.minTokens ?? 30000;
  if (!snapshot || !snapshot.id || !Number.isFinite(snapshot.lastActivityAt)) return { code: 'unknown-session' };
  if (snapshot.busy !== false) return { code: 'busy-or-unknown' };
  if (!Number.isFinite(snapshot.usedTokens)) return { code: 'unknown-usage' };
  if (snapshot.usedTokens <= minTokens) return { code: 'small-context' };
  if (!snapshot.revision || ledger?.revision === snapshot.revision) return { code: 'already-attempted' };
  if (snapshot.compactedAfterTurn) return { code: 'already-compacted' };
  const remainingMs = Math.max(0, idleMs + 1 - (now - snapshot.lastActivityAt));
  if (remainingMs) return { code: 'waiting', remainingMs };
  return { code: 'ready', ready: true };
}
module.exports = { IDLE_MS, decide };
