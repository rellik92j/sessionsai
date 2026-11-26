// Trial driver for keeping a session's prompt cache warm (SA-29). It drives the CLI through the extension's own chat
// process, ClaudeChat from src/claudeChat.ts (compiled to out/ by `npm test` or `npx tsc -p .`), and reports what each
// turn did to the prompt cache: per API request, how many prompt tokens were read from the cache, written to it (and
// with which TTL), or sent uncached, and what the turn cost. The findings are in docs/dev/keep-alive.md. Not part of
// the extension: it is not bundled, not tested, and not packaged.
//
//   node scripts/trial-keep-warm.mjs --cwd <scratch-dir> (--new | --resume <id>) [options] [-- <extra claude args>]
//
// Options:
//   --cwd <dir>         Folder the CLI runs in (required). Use a throwaway folder, never a real project.
//   --new               Start a new session (a fresh uuid, passed as --session-id) instead of resuming one.
//   --resume <id>       Resume this session id.
//   --say <text>        A user turn. Repeat for several turns; ClaudeChat sends each after the previous `result`.
//   --mode <mode>       Permission mode for ClaudeChat (default: default).
//   --log <file>        Also write every stdout event as a JSON line to this file.
//
// Everything after `--` is appended to ClaudeChat's command line, e.g. `-- --model haiku --setting-sources project`,
// or `--fork-session` / `--no-session-persistence` to try a ping that leaves the session's log alone.
//
// Before and after, it prints how many lines the session's .jsonl has, so a ping's footprint in the log shows.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { ClaudeChat, resolveClaudeExecutable } = require('../out/claudeChat.js');

function parseArgs(argv) {
  const opts = { says: [], mode: 'default', extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--cwd': opts.cwd = next(); break;
      case '--new': opts.new = true; break;
      case '--resume': opts.resume = next(); break;
      case '--say': opts.says.push(next()); break;
      case '--mode': opts.mode = next(); break;
      case '--log': opts.log = next(); break;
      case '--': opts.extra = argv.slice(i + 1); i = argv.length; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (!opts.cwd) throw new Error('--cwd is required');
  if (!opts.new === !opts.resume) throw new Error('give exactly one of --new and --resume <id>');
  if (!opts.says.length) throw new Error('give at least one --say');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const sessionId = opts.resume ?? randomUUID();
const log = opts.log ? createWriteStream(opts.log, { flags: 'a' }) : undefined;

/** The session's log file, wherever the CLI put it under ~/.claude/projects. */
function sessionFile(id) {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    const p = join(root, dir, `${id}.jsonl`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function lineCount(file) {
  return file ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length : 0;
}

const before = sessionFile(sessionId);
console.log(`session ${sessionId}: log ${before ? `${lineCount(before)} lines` : 'absent'} before`);

const exe = resolveClaudeExecutable('claude', {
  platform: process.platform,
  pathEnv: process.env.PATH ?? process.env.Path ?? '',
  home: homedir(),
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
});
if ('error' in exe) throw new Error(exe.error);

// Per turn: the model from `init`, the usage of each API request (by message id), and the result.
let turn;
const turns = [];
const seenSessions = new Set();

function onEvent(ev) {
  log?.write(JSON.stringify(ev) + '\n');
  if (typeof ev.session_id === 'string' && ev.session_id) seenSessions.add(ev.session_id);
  if (ev.type === 'system' && ev.subtype === 'init') {
    turn = { model: ev.model, requests: new Map() };
  } else if (ev.type === 'assistant' && ev.message?.usage && turn) {
    turn.requests.set(ev.message.id, { model: ev.message.model, usage: ev.message.usage });
  } else if (ev.type === 'result') {
    turns.push({ ...(turn ?? { requests: new Map() }), result: ev });
    turn = undefined;
  }
}

// ClaudeChat's command line is fixed (chatArgs); the trial adds its flags here, and for --new swaps --resume for
// --session-id so the same process code also creates the session.
const spawner = (file, args, cwd) => {
  let a = [...args, ...opts.extra];
  if (opts.new) a = a.map((x) => (x === '--resume' ? '--session-id' : x));
  console.log(`spawn: claude ${a.join(' ')}`);
  const child = spawn(file, a, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += String(chunk);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        // Not JSON; ClaudeChat logs it.
      }
    }
  });
  return child;
};

let resolveIdle;
const idle = new Promise((r) => (resolveIdle = r));
const chat = new ClaudeChat({
  sessionId,
  launch: () => ({ exe: exe.exe, cwd: opts.cwd }),
  mode: opts.mode,
  spawn: spawner,
  onChange: () => {
    if (turns.length >= opts.says.length && !chat.status.busy) resolveIdle();
  },
  onUnsent: (texts) => console.log(`unsent: ${JSON.stringify(texts)}`),
  log: (line) => console.log(`[chat] ${line}`),
});

for (const text of opts.says) chat.send(text);
await idle;
await chat.end();

const n = (v) => (typeof v === 'number' ? v : 0);
turns.forEach((t, i) => {
  const r = t.result;
  console.log(`\nturn ${i + 1}: model ${t.model}, ${r.is_error ? 'ERROR' : 'ok'}, ${r.num_turns} API request(s), ${r.duration_ms} ms`);
  for (const [id, q] of t.requests) {
    const u = q.usage;
    const split = u.cache_creation ?? {};
    console.log(
      `  request ${String(id).slice(0, 12)}…: input ${n(u.input_tokens)}, cache read ${n(u.cache_read_input_tokens)}, ` +
        `cache write ${n(u.cache_creation_input_tokens)} (5m ${n(split.ephemeral_5m_input_tokens)}, 1h ${n(split.ephemeral_1h_input_tokens)}), ` +
        `output ${n(u.output_tokens)}`,
    );
  }
  for (const [model, m] of Object.entries(r.model_usage_since_last_result ?? {})) {
    console.log(
      `  turn cost ${model}: $${n(m.costUSD).toFixed(5)} (input ${n(m.inputTokens)}, cache read ${n(m.cacheReadInputTokens)}, ` +
        `cache write ${n(m.cacheCreationInputTokens)}, output ${n(m.outputTokens)})`,
    );
  }
  if (typeof r.result === 'string') console.log(`  reply: ${r.result.slice(0, 120)}`);
});
const total = turns.reduce((s, t) => s + Object.values(t.result.model_usage_since_last_result ?? {}).reduce((a, m) => a + n(m.costUSD), 0), 0);
console.log(`\ntotal this run: $${total.toFixed(5)}`);

const after = sessionFile(sessionId);
console.log(`session ${sessionId}: log ${after ? `${lineCount(after)} lines` : 'absent'} after`);
for (const other of seenSessions) {
  if (other !== sessionId) {
    const f = sessionFile(other);
    console.log(`other session id seen: ${other}: log ${f ? `${lineCount(f)} lines` : 'absent'}`);
  }
}
log?.end();
