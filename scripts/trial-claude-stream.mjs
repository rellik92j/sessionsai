// Trial driver for Claude Code's stream-json mode (SA-24). Spawns the `claude` CLI as a child process with no
// shell, writes user turns to its stdin as stream-json, and logs every stdout line. The findings it produced are
// in docs/dev/claude-stream-json.md. Not part of the extension: it is not bundled, not tested, and not packaged.
//
//   node scripts/trial-claude-stream.mjs --cwd <scratch-dir> [options] [-- <extra claude args>]
//
// Options:
//   --cwd <dir>              Folder the CLI runs in (required). Use a throwaway folder, never a real project.
//   --bin <path>             CLI to spawn (default: claude). A .cmd shim needs --via-cmd on Windows.
//   --via-cmd                Spawn through `cmd.exe /d /s /c` instead of directly (how a .cmd shim has to run).
//   --resume <id>            Resume this session id.
//   --say <text>             A user turn. Repeat for several turns; each is sent after the previous `result`.
//   --interrupt <how>        Interrupt a turn (the last unless --interrupt-turn): control | sigint | close | kill.
//   --interrupt-after <ms>   How long after that turn is sent to interrupt (default 4000).
//   --interrupt-turn <n>     Interrupt turn n (1-based) instead of the last one, so later turns test recovery.
//   --permissions <answer>   Answer `can_use_tool` requests: allow | deny | ignore (default: ignore).
//   --burst                  Send every --say at once instead of one per `result`; stdin closes at the first `result`
//                            that reports nothing queued (the queued turns still run).
//   --initialize             Send an `initialize` control request before the first turn.
//   --log <file>             Also write every event, in and out, as JSON lines to this file.
//   --timeout <ms>           Give up and kill the process after this long (default 180000).
//
// Everything after `--` is passed to the CLI after the fixed flags:
//   -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

function parseArgs(argv) {
  const opts = { bin: 'claude', says: [], interruptAfter: 4000, permissions: 'ignore', timeout: 180000, extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--cwd': opts.cwd = next(); break;
      case '--bin': opts.bin = next(); break;
      case '--via-cmd': opts.viaCmd = true; break;
      case '--resume': opts.resume = next(); break;
      case '--say': opts.says.push(next()); break;
      case '--interrupt': opts.interrupt = next(); break;
      case '--interrupt-after': opts.interruptAfter = Number(next()); break;
      case '--interrupt-turn': opts.interruptTurn = Number(next()); break;
      case '--permissions': opts.permissions = next(); break;
      case '--initialize': opts.initialize = true; break;
      case '--burst': opts.burst = true; break;
      case '--log': opts.log = next(); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--': opts.extra = argv.slice(i + 1); i = argv.length; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (!opts.cwd) throw new Error('--cwd is required');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const started = Date.now();
const logFile = opts.log ? createWriteStream(opts.log, { flags: 'a' }) : undefined;

function record(dir, data) {
  const entry = { t: Date.now() - started, dir, data };
  logFile?.write(JSON.stringify(entry) + '\n');
  console.log(`${String(entry.t).padStart(6)} ${dir.padEnd(4)} ${summarize(dir, data)}`);
}

/** One readable line per event; the log file keeps the whole thing. */
function summarize(dir, data) {
  if (typeof data === 'string') return data.trimEnd();
  if (dir !== 'out') return JSON.stringify(data);
  const parts = [data.type, data.subtype].filter(Boolean);
  if (data.type === 'stream_event') {
    const e = data.event ?? {};
    parts.push(e.type);
    if (e.delta?.type) parts.push(e.delta.type);
    if (e.delta?.text) parts.push(JSON.stringify(e.delta.text));
    if (e.content_block?.type) parts.push(e.content_block.type, e.content_block.name ?? '');
  } else if (data.type === 'assistant' || data.type === 'user') {
    for (const b of data.message?.content ?? []) {
      if (b.type === 'text') parts.push(`text:${JSON.stringify(b.text.slice(0, 80))}`);
      else if (b.type === 'tool_use') parts.push(`tool_use:${b.name}`);
      else if (b.type === 'tool_result') parts.push(`tool_result${b.is_error ? '(error)' : ''}`);
      else parts.push(b.type);
    }
    if (typeof data.message?.content === 'string') parts.push(JSON.stringify(data.message.content.slice(0, 80)));
  } else if (data.type === 'result') {
    parts.push(`is_error=${data.is_error}`, `cost=${data.total_cost_usd}`, `turns=${data.num_turns}`);
    if (data.permission_denials?.length) parts.push(`denials=${data.permission_denials.length}`);
  } else if (data.type === 'control_request') {
    parts.push(data.request?.subtype, data.request?.tool_name ?? '');
  }
  if (data.session_id) parts.push(`session=${data.session_id}`);
  return parts.join(' ');
}

const fixed = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
if (opts.resume) fixed.push('--resume', opts.resume);
const cliArgs = [...fixed, ...opts.extra];

// No shell: arguments reach the CLI as written. A .cmd shim cannot be spawned that way on current Node (EINVAL),
// so --via-cmd runs it through cmd.exe explicitly, which is what `shell: true` would do under the hood.
const [command, args] = opts.viaCmd
  ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', opts.bin, ...cliArgs]]
  : [opts.bin, cliArgs];

record('info', `spawn ${command} ${args.join(' ')}`);
let child;
try {
  child = spawn(command, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
} catch (err) {
  record('err', `spawn threw synchronously: ${err.code ?? ''} ${err.message}`);
  process.exit(1);
}
child.on('error', (err) => record('err', `spawn error: ${err.code ?? ''} ${err.message}`));
child.stdin.on('error', (err) => record('err', `stdin error: ${err.code ?? ''} ${err.message}`));

let requestSeq = 0;
function send(obj) {
  record('in', obj);
  child.stdin.write(JSON.stringify(obj) + '\n');
}

function sendTurn(text) {
  send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
}

let turn = 0;
function nextTurn(result) {
  if (opts.burst && turn === 0) {
    // Every turn at once, without waiting for a result: what happens when the user types while Claude works.
    while (turn < opts.says.length) sendTurn(opts.says[turn++]);
    return;
  }
  // Queued turns can be merged into one, so stop at the first result that reports nothing left queued.
  if (opts.burst && result?.queued_turn_count > 0) return;
  if (turn >= opts.says.length) {
    record('info', 'no more turns: closing stdin');
    child.stdin.end();
    return;
  }
  sendTurn(opts.says[turn++]);
  if (opts.interrupt && turn === (opts.interruptTurn ?? opts.says.length)) setTimeout(interrupt, opts.interruptAfter);
}

function interrupt() {
  record('info', `interrupting with ${opts.interrupt}`);
  switch (opts.interrupt) {
    case 'control':
      send({ type: 'control_request', request_id: `trial-${++requestSeq}`, request: { subtype: 'interrupt' } });
      break;
    case 'sigint': child.kill('SIGINT'); break;
    case 'close': child.stdin.end(); break;
    case 'kill': child.kill(); break;
    default: record('err', `unknown --interrupt ${opts.interrupt}`);
  }
}

function answerPermission(msg) {
  const req = msg.request;
  if (opts.permissions === 'ignore') return;
  const response = opts.permissions === 'allow'
    ? { behavior: 'allow', updatedInput: req.input }
    : { behavior: 'deny', message: 'Denied by the trial script.' };
  send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
}

createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    record('out', `(not JSON) ${line}`);
    return;
  }
  record('out', msg);
  if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') answerPermission(msg);
  if (msg.type === 'result') nextTurn(msg);
});
createInterface({ input: child.stderr }).on('line', (line) => record('err', line));

child.on('exit', (code, signal) => {
  record('exit', `code=${code} signal=${signal}`);
  clearTimeout(timer);
  logFile?.end();
});

const timer = setTimeout(() => {
  record('info', 'timeout: killing');
  child.kill();
}, opts.timeout);

if (opts.initialize) {
  send({ type: 'control_request', request_id: `trial-${++requestSeq}`, request: { subtype: 'initialize' } });
}
nextTurn();
