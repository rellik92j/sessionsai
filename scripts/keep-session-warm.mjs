// Keeps one Claude Code session's prompt cache warm from a terminal, through the extension's own keep-warm module
// (out/keepWarm.js, SA-35): the same schedule, ping text, skips, retry, expiry stop and spend cap the extension uses.
// For SA-72's timed check (scripts/prepare-keep-warm-check.mjs --check sa72 writes its README). Not part of the
// extension: it is not bundled, not tested, and not packaged. Every ping is a real `claude -p` run and costs money.
//
//   node scripts/keep-session-warm.mjs --cwd <folder> --id <session id> --minutes <n> [--ping-now] [--cap <usd>]
//                                      [--claude <command>]
//
//   --cwd <folder>     The session's folder: the ping runs there, as the terminal did.
//   --id <id>          The session.
//   --minutes <n>      Stop after this long. Required, so a forgotten window does not ping for ever.
//   --ping-now         Refresh once straight away, then on the schedule from that ping.
//   --cap <usd>        Spend cap for this run (default: the extension's, $1.00).
//   --claude <cmd>     The claude command (default: claude, found as the extension finds it).
//
// It needs a compile first (npm run compile), since it loads out/. It prints each ping's model, permission mode,
// cache read and write, and cost as it goes, and a table of them when it stops. Ctrl+C stops it.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

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
      case '--minutes': opts.minutes = Number(next()); break;
      case '--ping-now': opts.pingNow = true; break;
      case '--cap': opts.cap = Number(next()); break;
      case '--claude': opts.claude = next(); break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (!opts.cwd || !opts.id) throw new Error('give --cwd <folder> and --id <session id>');
  if (!(opts.minutes > 0)) throw new Error('give --minutes <n>, how long to keep it warm');
  if (opts.cap !== undefined && !(opts.cap > 0)) throw new Error('--cap needs a positive number of dollars');
  return opts;
}

function load(name) {
  const file = fileURLToPath(new URL(`../out/${name}.js`, import.meta.url));
  if (!existsSync(file)) throw new Error(`out/${name}.js is missing: run npm run compile in this checkout first`);
  return require(file);
}

const stamp = () => new Date().toLocaleTimeString();
const say = (line) => console.log(`${stamp()}  ${line}`);

/** Claude Code's folder for a working directory: every character other than a letter or digit becomes `-`. */
function projectDir(cwd) {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(config, 'projects', resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

function main(opts) {
  const { KeepWarm, sessionCacheState, estimateKeepWarm } = load('keepWarm');
  const { parseSession } = load('sessionParser');
  const { resolveClaudeExecutable } = load('claudeChat');

  const cwd = resolve(opts.cwd);
  const dir = projectDir(cwd);
  const file = join(dir, `${opts.id}.jsonl`);
  if (!existsSync(file)) throw new Error(`no log for session ${opts.id} at ${file}`);

  const state = () => {
    if (!existsSync(file)) return undefined;
    const info = parseSession(readFileSync(file, 'utf8'), file, dir, opts.id);
    return { ...sessionCacheState(info), logWrittenAt: statSync(file).mtimeMs };
  };

  // The e2e stand-in for claude.exe (docs/dev/e2e.md), for a smoke run that calls no model.
  const standIn = process.env.SESSIONSAI_E2E_CLAUDE;
  const found = standIn
    ? { exe: standIn }
    : resolveClaudeExecutable(opts.claude ?? 'claude', {
        platform: process.platform,
        pathEnv: process.env.PATH ?? process.env.Path ?? '',
        home: homedir(),
        isFile: (p) => !!statSync(p, { throwIfNoEntry: false })?.isFile(),
      });
  if ('error' in found) throw new Error(found.error);
  const spawner = (exe, args, at) =>
    standIn && exe === standIn
      ? spawn(process.execPath, [standIn, ...args], { cwd: at, shell: false, windowsHide: true, stdio: 'pipe' })
      : spawn(exe, args, { cwd: at, shell: false, windowsHide: true, stdio: 'pipe' });

  const shared = new Map();
  let reported = false;
  const kw = new KeepWarm({
    windowId: `script-${process.pid}`,
    now: Date.now,
    setTimer: (f, ms) => setTimeout(f, ms),
    clearTimer: (h) => clearTimeout(h),
    state: () => state(),
    launch: () => ({ exe: found.exe, cwd }),
    spawn: spawner,
    shared: { get: (k) => shared.get(k), update: (k, v) => void shared.set(k, v) },
    log: (line) => {
      // ClaudeChat's own diagnostics (spawns, stderr, exits) are long; the keep-warm lines are what the check needs.
      if (line.startsWith('keep-warm ')) say(line.slice(`keep-warm ${opts.id}: `.length));
    },
    onChange: () => {
      const k = kw.get(opts.id);
      if (k && !k.active && !reported) {
        reported = true;
        report(k);
      }
    },
  });

  const s = state();
  say(`session ${opts.id} in ${cwd}`);
  say(`log: ${file}`);
  if (s?.model) say(`model ${s.model}, context ${s.contextTokens ?? '?'} tokens, TTL ${s.ttlMs ? `${s.ttlMs / 60_000} min` : '?'}`);
  if (s?.lastRequest) say(`last request ${new Date(s.lastRequest).toLocaleTimeString()}, cache expires ${new Date(s.lastRequest + (s.ttlMs ?? 0)).toLocaleTimeString()}`);
  const est = s?.model && s.contextTokens !== undefined && s.ttlMs ? estimateKeepWarm({ model: s.model, contextTokens: s.contextTokens, ttlMs: s.ttlMs }) : undefined;
  if (est) say(`estimate: $${est.perPing.toFixed(4)} per ping; a cold resume would cost $${est.coldResumeExtra.toFixed(4)} more than a warm one`);

  const started = kw.start(opts.id, { durationMs: opts.minutes * 60_000, spendCapUsd: opts.cap, pingNow: opts.pingNow });
  if (!started.ok) throw new Error(started.error);
  const k = kw.get(opts.id);
  if (!opts.pingNow && k?.nextPingAt) say(`first ping due ${new Date(k.nextPingAt).toLocaleTimeString()}`);
  say(`running for ${opts.minutes} min; Ctrl+C stops it`);

  process.on('SIGINT', () => {
    kw.stop(opts.id);
    // A ping still running finishes on its own; a second Ctrl+C leaves at once.
    process.once('SIGINT', () => process.exit(130));
  });
}

/** The table of pings, once keep-warm has stopped (its own log line has already said why). */
function report(k) {
  console.log('');
  console.log('  #  time         ok   model                      permissionMode  cache read  cache write  cost');
  for (const p of k.pings) {
    console.log(
      `${String(p.n).padStart(3)}  ${new Date(p.at).toLocaleTimeString().padEnd(11)}  ${(p.ok ? 'yes' : 'no').padEnd(3)}  ${(p.model ?? '?').padEnd(25)}  ` +
        `${(p.permissionMode ?? '?').padEnd(14)}  ${String(p.cacheRead).padStart(10)}  ${String(p.cacheWrite).padStart(11)}  ` +
        `${p.cost === undefined ? '?' : `$${p.cost.toFixed(4)}`}${p.error ? `  (${p.error})` : ''}`,
    );
  }
  console.log('');
  console.log(`spent $${k.spent.toFixed(4)} on ${k.pings.length} ping(s)`);
  if (k.expiresAt) console.log(`the cache expires ${new Date(k.expiresAt).toLocaleTimeString()} unless something else uses it first`);
}

try {
  main(parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(`keep-session-warm: ${err.message}`);
  process.exit(1);
}
