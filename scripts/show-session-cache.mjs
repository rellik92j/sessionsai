// Prints what each API request of a Claude Code session did to the prompt cache, read from the session's .jsonl, so a
// manual cache check (SA-33, docs/dev/keep-alive.md section 8) does not need the log opened by hand. Not part of the
// extension: it is not bundled, not tested, and not packaged.
//
//   node scripts/show-session-cache.mjs --cwd <folder> --latest-id     print only the newest session id in that folder
//   node scripts/show-session-cache.mjs --cwd <folder>                 list that folder's sessions, newest first
//   node scripts/show-session-cache.mjs [--cwd <folder>] --id <id>     one line per main-thread API request
//
// The numbers are the assistant records' `message.usage`: `cache_read_input_tokens` (read from the cache),
// `cache_creation_input_tokens` (written to it, split by TTL in `cache_creation`) and `input_tokens` (sent uncached).
// Their sum is the request's context. One request can be logged as several records (one per content block) that
// share a message id; they are counted once. Lines that are not JSON, and records of other types, are skipped.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--cwd': opts.cwd = next(); break;
      case '--id': opts.id = next(); break;
      case '--latest-id': opts.latestId = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (!opts.cwd && !opts.id) throw new Error('give --cwd <folder>, --id <session id>, or both');
  if (opts.latestId && !opts.cwd) throw new Error('--latest-id needs --cwd <folder>');
  return opts;
}

const PROJECTS = join(homedir(), '.claude', 'projects');

/** Claude Code's folder for a working directory: every character other than a letter or digit becomes `-`. */
function projectDir(cwd) {
  return join(PROJECTS, resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

/** The folder's sessions, newest log first. */
function sessionsIn(cwd) {
  const dir = projectDir(cwd);
  if (!existsSync(dir)) throw new Error(`no Claude Code sessions for ${resolve(cwd)} (looked in ${dir})`);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const file = join(dir, f);
      return { id: f.slice(0, -'.jsonl'.length), file, mtime: statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function findLog(id, cwd) {
  if (cwd) {
    const p = join(projectDir(cwd), `${id}.jsonl`);
    if (existsSync(p)) return p;
  }
  if (existsSync(PROJECTS)) {
    for (const dir of readdirSync(PROJECTS)) {
      const p = join(PROJECTS, dir, `${id}.jsonl`);
      if (existsSync(p)) return p;
    }
  }
  throw new Error(`no log for session ${id} under ${PROJECTS}`);
}

const n = (v) => (typeof v === 'number' ? v : 0);

/** Main-thread API requests in log order, one per message id, with the last usage logged for it. */
function requests(file) {
  const byId = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type !== 'assistant' || rec.isSidechain === true) continue;
    const msg = rec.message;
    if (!msg || typeof msg !== 'object' || !msg.usage || typeof msg.usage !== 'object') continue;
    if (msg.model === '<synthetic>') continue;
    const key = typeof msg.id === 'string' ? msg.id : `line-${byId.size}`;
    byId.delete(key);
    byId.set(key, { time: rec.timestamp, entrypoint: rec.entrypoint, model: msg.model, usage: msg.usage });
  }
  return [...byId.values()];
}

function describe(q) {
  const u = q.usage;
  const read = n(u.cache_read_input_tokens);
  const write = n(u.cache_creation_input_tokens);
  const input = n(u.input_tokens);
  const split = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : {};
  const context = read + write + input;
  const pct = context ? Math.round((read / context) * 100) : 0;
  const when = typeof q.time === 'string' ? new Date(q.time).toLocaleString() : '?';
  return (
    `${when}  ${q.entrypoint ?? '?'}  ${q.model ?? '?'}  context ${context}: cache read ${read} (${pct}%), ` +
    `cache write ${write} (5m ${n(split.ephemeral_5m_input_tokens)}, 1h ${n(split.ephemeral_1h_input_tokens)}), ` +
    `uncached ${input}, output ${n(u.output_tokens)}`
  );
}

function main(opts) {
  if (opts.latestId) {
    const [latest] = sessionsIn(opts.cwd);
    if (!latest) throw new Error(`no sessions for ${resolve(opts.cwd)}`);
    console.log(latest.id);
  } else if (!opts.id) {
    for (const s of sessionsIn(opts.cwd)) console.log(`${s.id}  last written ${new Date(s.mtime).toLocaleString()}`);
  } else {
    const file = findLog(opts.id, opts.cwd);
    const qs = requests(file);
    console.log(`log: ${file}`);
    console.log(`${qs.length} API request(s); entrypoint "cli" is an interactive terminal, "sdk-cli" a -p process`);
    qs.forEach((q, i) => console.log(`${String(i + 1).padStart(3)}. ${describe(q)}`));
    if (qs.length) console.log(`last: ${describe(qs[qs.length - 1])}`);
  }
}

try {
  main(parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(`show-session-cache: ${err.message}`);
  process.exit(1);
}
