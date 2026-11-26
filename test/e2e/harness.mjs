// The end-to-end harness: an isolated VS Code with this extension, driven by Playwright, with a stand-in claude behind
// the transcript view's chat. See docs/dev/e2e.md for how to run it and how to write a scenario.
//
// Isolation: a VS Code downloaded once into a shared folder outside the checkout (see cacheDir), a throwaway user-data and extensions folder, a throwaway
// CLAUDE_CONFIG_DIR holding synthetic sessions, and settings that point every source of sessions into that sandbox.
// The user's own VS Code, settings and ~/.claude are never read or written, and the real claude CLI is never run: the
// chat starts the stand-in (SESSIONSAI_E2E_CLAUDE) and Resume's terminal runs a stub that only records it was called.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const OUT = path.join(ROOT, '.e2e-out');
const STAND_IN = path.join(ROOT, 'test', 'e2e', 'stand-in-claude.mjs');
/** Stands in for the Claude Code extension, so "Open in Claude Code Chat" is offered; it only records being asked. */
const CLAUDE_CODE_STUB = path.join(ROOT, 'test', 'e2e', 'claude-code-stub');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Claude Code's folder name for a project: every character that is not a letter or digit becomes '-'. */
const projectDirName = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/** A synthetic session id; `n` keeps them apart. */
export const sessionIdFor = (n) => `e2e00000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * The sandbox: folders, synthetic sessions, the terminal stub and the VS Code settings. `sessions` is a list of
 * { id, prompt } and each becomes a two-record log (the prompt and a short reply) dated a day ago, so the chat's
 * "written moments ago" guard does not fire.
 */
export function makeSandbox(sessions) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sessionsai-e2e-'));
  const s = {
    dir,
    userData: path.join(dir, 'user-data'),
    extensions: path.join(dir, 'extensions'),
    claudeConfig: path.join(dir, 'claude-config'),
    copilot: path.join(dir, 'copilot'),
    vscodeUser: path.join(dir, 'vscode-user'),
    work: path.join(dir, 'work', 'demo'),
    bin: path.join(dir, 'bin'),
    events: path.join(dir, 'events.jsonl'),
  };
  // Claude Code's registry of running processes, one <pid>.json each; scenarios write synthetic ones here.
  s.registry = path.join(s.claudeConfig, 'sessions');
  for (const d of [s.userData, s.extensions, s.claudeConfig, s.copilot, s.vscodeUser, s.work, s.bin, s.registry]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(s.events, '');
  const projectDir = path.join(s.claudeConfig, 'projects', projectDirName(s.work));
  mkdirSync(projectDir, { recursive: true });
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  for (const { id, prompt } of sessions) {
    const common = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: s.work, sessionId: id, version: '2.1.332', gitBranch: 'main' };
    const u1 = `${id.slice(0, 8)}-0000-4000-8000-000000000001`;
    const u2 = `${id.slice(0, 8)}-0000-4000-8000-000000000002`;
    const records = [
      { parentUuid: null, ...common, type: 'user', message: { role: 'user', content: prompt }, uuid: u1, timestamp: new Date(dayAgo).toISOString() },
      {
        parentUuid: u1,
        ...common,
        type: 'assistant',
        message: { model: 'claude-stand-in', id: `msg_seed_${id.slice(-4)}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Ready when you are.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 5 } },
        uuid: u2,
        timestamp: new Date(dayAgo + 2000).toISOString(),
      },
    ];
    const file = path.join(projectDir, `${id}.jsonl`);
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    utimesSync(file, new Date(dayAgo), new Date(dayAgo));
  }
  // Resume runs `<claudeCommand> --resume <id>` in a terminal. This stub stands in for claude there: it records the
  // call in the events file and does nothing else.
  if (process.platform === 'win32') {
    s.terminalStub = path.join(s.bin, 'claude-terminal.cmd');
    writeFileSync(s.terminalStub, `@echo off\r\necho stand-in claude terminal %*\r\necho {"event":"terminal-resume","args":"%*"}>>"${s.events}"\r\n`);
  } else {
    s.terminalStub = path.join(s.bin, 'claude-terminal');
    writeFileSync(s.terminalStub, `#!/bin/sh\necho "stand-in claude terminal $*"\necho "{\\"event\\":\\"terminal-resume\\",\\"args\\":\\"$*\\"}" >> '${s.events}'\n`, { mode: 0o755 });
  }
  const settings = {
    // Modals and menus drawn in the page, so Playwright can see and click them.
    'window.dialogStyle': 'custom',
    'window.titleBarStyle': 'custom',
    'window.menuStyle': 'custom',
    'window.restoreWindows': 'none',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.enableExperiments': false,
    'security.workspace.trust.enabled': false,
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'telemetry.telemetryLevel': 'off',
    'git.enabled': false,
    'chat.disableAIFeatures': true,
    'terminal.integrated.defaultProfile.windows': 'Command Prompt',
    // Every source of sessions points into the sandbox.
    'claudeSessions.projectsDir': path.join(s.claudeConfig, 'projects'),
    'claudeSessions.sources': ['claude'],
    'claudeSessions.copilotDir': s.copilot,
    'claudeSessions.vscodeUserDir': s.vscodeUser,
    'claudeSessions.claudeCommand': s.terminalStub,
    // The transcript's Resume and Open in chat buttons keep the tab open, so a scenario can see what is left in it.
    'claudeSessions.closeTranscriptOnResume': false,
  };
  mkdirSync(path.join(s.userData, 'User'), { recursive: true });
  writeFileSync(path.join(s.userData, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
  return s;
}

/** The environment VS Code starts with: this process's, minus anything that would tie it to a running VS Code. */
function vscodeEnv(s) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(VSCODE_|ELECTRON_)/i.test(k)) env[k] = v;
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: s.claudeConfig,
    COPILOT_HOME: s.copilot,
    SESSIONSAI_E2E_CLAUDE: STAND_IN,
    SESSIONSAI_E2E_EVENTS: s.events,
  };
}

/**
 * Where the downloaded VS Code lives: one folder shared by every checkout and worktree, outside all of them (about
 * 1 GB, and its deep paths break `git worktree remove` on Windows when it sits inside one). SESSIONSAI_E2E_CACHE
 * overrides it.
 */
export function cacheDir() {
  if (process.env.SESSIONSAI_E2E_CACHE) return path.resolve(process.env.SESSIONSAI_E2E_CACHE);
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') : path.join(os.homedir(), '.cache');
  return path.join(base, 'sessionsai-e2e', 'vscode');
}

const LOCK_STALE_MS = 60_000;
const LOCK_BEAT_MS = 10_000;

/**
 * Runs `fn` while holding a lock on the cache folder, so two runs (two worktrees) never unpack into the same folder
 * at once: @vscode/test-electron unpacks in place and marks it complete only at the end, with no lock of its own. The
 * lock is a folder whose mtime is refreshed while it is held; one not refreshed for a minute belongs to a run that
 * died, and is taken over.
 */
export async function withCacheLock(dir, fn) {
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released between the two calls
      }
      if (age > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      else await sleep(500);
    }
  }
  const beat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lock, now, now);
    } catch {}
  }, LOCK_BEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Downloads VS Code into the shared cache once (stable, or E2E_VSCODE_VERSION) and returns its executable. */
export async function vscodeExecutable() {
  const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
  const cachePath = cacheDir();
  return withCacheLock(cachePath, () => downloadAndUnzipVSCode({ cachePath, version: process.env.E2E_VSCODE_VERSION || 'stable' }));
}

/** Starts the isolated VS Code on the sandbox's work folder and waits for the workbench. */
export async function launch(s) {
  const { _electron } = await import('playwright-core');
  const exe = await vscodeExecutable();
  const app = await _electron.launch({
    executablePath: exe,
    args: [
      s.work,
      `--extensionDevelopmentPath=${ROOT}`,
      `--extensionDevelopmentPath=${CLAUDE_CODE_STUB}`,
      `--user-data-dir=${s.userData}`,
      `--extensions-dir=${s.extensions}`,
      '--new-window',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--disable-telemetry',
      '--disable-updates',
      '--no-cached-data',
    ],
    env: vscodeEnv(s),
    timeout: 90_000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.monaco-workbench', { timeout: 90_000 });
  return { app, page };
}

// ---------- what scenarios use ----------

/** Polls `check` until it returns something truthy, or throws `what` after `timeout` ms. */
export async function waitFor(what, check, timeout = 15_000, every = 150) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await check();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) {
      throw new Error(`Timed out after ${timeout} ms waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
    }
    await sleep(every);
  }
}

/**
 * The webview frame whose document has `selector`. VS Code puts each webview in two nested iframes; Playwright lists
 * every frame, so this finds the inner one by what is in it rather than by VS Code's own markup.
 */
export function frameWith(page, selector, what = selector, timeout = 20_000) {
  return waitFor(`a webview with ${what}`, async () => {
    for (const f of page.frames()) {
      if (f.isDetached()) continue;
      if (await f.$(selector).catch(() => null)) return f;
    }
    return undefined;
  }, timeout, 250);
}

/**
 * What the stand-in (and the terminal stub) recorded about one session, or every session, oldest first. `i` is the
 * event's position in the file, which orders events from different processes.
 */
export function events(s, sessionId) {
  const text = existsSync(s.events) ? readFileSync(s.events, 'utf8') : '';
  const all = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return { ...JSON.parse(l), i };
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
  return sessionId ? all.filter((e) => e.session === sessionId || (e.event === 'terminal-resume' && String(e.args).includes(sessionId))) : all;
}

/** Waits for the stand-in to record `name` for the session (matching `match` when given); returns the event. */
export function waitEvent(s, sessionId, name, match = () => true, timeout = 20_000) {
  return waitFor(`the stand-in to record "${name}" for ${sessionId}`, () => events(s, sessionId).find((e) => e.event === name && match(e)), timeout);
}

/** The session's log file. */
export function logPath(s, sessionId) {
  return path.join(s.claudeConfig, 'projects', projectDirName(s.work), `${sessionId}.jsonl`);
}

/** The session's log text. */
export function logText(s, sessionId) {
  return readFileSync(logPath(s, sessionId), 'utf8');
}

/** Removes the sandbox; Windows may hold a file a moment after VS Code exits, so it retries. */
export async function removeSandbox(s) {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(s.dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(500);
    }
  }
}

export function resetOut() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
}

// ---------- steps scenarios share, whatever the area ----------

/** Shows the SessionsAI sidebar and returns its webview frame once the session's card is in it. */
export async function sidebar(ctx) {
  const { page, id } = ctx;
  const selector = `.card[data-id$=":${id}"]`;
  const visible = async () => {
    for (const f of page.frames()) {
      if (!f.isDetached() && (await f.$(selector).catch(() => null))) return f;
    }
    return undefined;
  };
  const frame = await visible();
  if (frame) return frame;
  // Clicking the activity bar icon of a view that is already showing hides it, so only click when it is not.
  const item = page.locator('.activitybar .action-item', { has: page.locator('[aria-label^="SessionsAI"]') }).first();
  if (!/\bchecked\b/.test((await item.getAttribute('class')) ?? '')) {
    await item.click();
  }
  return frameWith(page, selector, `the sidebar card of ${ctx.title}`);
}

/** Opens the session's transcript from its sidebar card and returns the transcript's webview frame. */
export async function openTranscript(ctx) {
  const side = await sidebar(ctx);
  await side.click(`.card[data-id$=":${ctx.id}"]`);
  return transcript(ctx);
}

/** The session's open transcript frame. */
export function transcript(ctx) {
  return frameWith(ctx.page, `body[data-session*="${ctx.id}"] #composer`, `the transcript of ${ctx.title}`);
}

/** Picks "Chat here" in the message box's ⌄ menu, unless it is the target already. */
export async function chatHere(frame) {
  if (await frame.$eval('#chat-bar', (el) => !el.hidden)) return;
  await frame.click('#composer-more');
  await frame.click('#composer-menu [data-target="here"]');
  await frame.click('#composer-more');
  await waitFor('the chat bar to show', () => frame.$eval('#chat-bar', (el) => !el.hidden));
}

/** Types `text` in the message box and sends it with Enter. */
export async function send(frame, text) {
  await frame.fill('#composer-input', text);
  await frame.press('#composer-input', 'Enter');
}

export const click = async (ctx, selector) => (await transcript(ctx)).click(selector);

/** True when the logged conversation (not the chat's pending part) shows `needle`. */
export const logged = async (ctx, needle) =>
  (await transcript(ctx)).evaluate((n) => [...document.querySelectorAll('.msg')].some((m) => !m.closest('#chat-live') && (m.textContent || '').includes(n)), needle);

/** The tab of the session's transcript in the editor area. */
export const tab = (ctx) => ctx.page.locator('.tabs-container .tab', { hasText: ctx.title }).first();

/** Right-clicks the session's card in the sidebar and picks `label` from the context menu. */
export async function sidebarMenu(ctx, label) {
  const side = await sidebar(ctx);
  await side.click(`.card[data-id$=":${ctx.id}"]`, { button: 'right' });
  const item = ctx.page.locator('.monaco-menu .action-item', { hasText: label }).first();
  await item.waitFor({ state: 'visible', timeout: 10_000 });
  await item.click();
}

/** Waits for the in-page modal (window.dialogStyle custom) and returns it. */
export async function modal(ctx, text) {
  const box = ctx.page.locator('.monaco-dialog-box', { hasText: text }).first();
  await box.waitFor({ state: 'visible', timeout: 10_000 });
  return box;
}

export function assert(ok, message) {
  if (!ok) throw new Error(message);
}
