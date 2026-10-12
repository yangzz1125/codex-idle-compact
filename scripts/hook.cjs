const { register } = require('./store.cjs');
let input = '';
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    if (!event.session_id) throw Error('Hook lacks session_id');
    register(event.session_id, event.transcript_path, event.hook_event_name);
    // In particular, Stop must never return a continuation decision.
    process.stdout.write('{}\n');
  } catch (error) { console.error('Idle Compact hook: ' + error.message); process.exitCode = 1; }
});
