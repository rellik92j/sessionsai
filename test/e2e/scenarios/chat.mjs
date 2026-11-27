// The chat area: the transcript view's chat (Chat here), its permission cards, ending and stopping it, a message sent
// while an ended chat finishes, and what Resume and Open in Claude Code Chat do while a chat is replying or the
// session is live in another Claude Code process. See docs/dev/e2e.md for how to add a scenario.

import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assert, chatHere, click, events, logPath, logText, logged, modal, openTranscript, send, sidebar, sidebarMenu, tab, transcript, waitEvent, waitFor } from '../harness.mjs';

const FIRST_LINE = 'Line 2 of the stand-in reply.';
const LAST_LINE = 'Line 12 of the stand-in reply. Done.';

// The page is rebuilt (a new frame) when the transcript's shape changes, a tool call for one, so everything below
// looks the frame up again rather than holding on to one.
const liveText = async (ctx) => (await transcript(ctx)).$eval('#chat-live', (el) => el.textContent || '');
const chatState = async (ctx) => (await transcript(ctx)).$eval('#chat-state', (el) => el.textContent || '');

/** Waits until part of the reply has streamed into the pending part, and the turn is still running. */
async function midReply(ctx) {
  await waitFor('the reply to start streaming in', async () => (await liveText(ctx)).includes(FIRST_LINE));
  if (events(ctx.s, ctx.id).some((e) => e.event === 'turn-end')) {
    throw new Error('the turn had already ended: the stand-in reply is too quick for this check');
  }
}


// ---------- a message sent while an ended chat finishes its reply ----------

const WAITING_PILL = 'waits for the previous reply to finish';
const composerText = async (ctx) => (await transcript(ctx)).$eval('#composer-input', (el) => el.value);
const sendLabel = async (ctx) => (await transcript(ctx)).$eval('#composer-send span', (el) => el.textContent || '');
/** The text of each message in the pending part marked as waiting for the ended chat. */
const waitingShown = async (ctx) => (await transcript(ctx)).$$eval('#chat-live .chat-pending.waiting', (els) => els.map((el) => el.textContent || ''));

/** Starts a slow reply in Chat here and presses End chat during it; returns once the bar says it is finishing. */
async function endMidReply(ctx, message = 'Tell me twelve lines.') {
  const frame = await openTranscript(ctx);
  await chatHere(frame);
  await send(frame, message);
  await midReply(ctx);
  await click(ctx, '#chat-end');
  await waitFor('the chat bar to say the reply is finishing', async () => /Chat ended: Claude is finishing/.test(await chatState(ctx)), 5_000);
}

/** Sends `text` while the ended chat finishes (Enter, or the Send button); waits until the box has emptied and the message shows as waiting. */
async function sendWhileFinishing(ctx, text, { button = false } = {}) {
  const frame = await transcript(ctx);
  if (button) {
    await frame.fill('#composer-input', text);
    await frame.click('#composer-send');
  } else {
    await send(frame, text);
  }
  await waitFor(`"${text}" to show as waiting`, async () => (await waitingShown(ctx)).some((t) => t.includes(text) && t.includes(WAITING_PILL)), 5_000);
  await waitFor('the message box to empty', async () => (await composerText(ctx)) === '', 5_000);
  assert(!events(ctx.s, ctx.id).some((e) => e.event === 'exit'), 'the ended chat had already exited: the stand-in reply is too quick for this check');
}

/** The messages that started turns after the first chat process had exited, in order. */
function turnsAfterExit(ctx) {
  const ev = events(ctx.s, ctx.id);
  const exit = ev.find((e) => e.event === 'exit');
  return exit ? ev.filter((e) => e.event === 'turn-start' && e.i > exit.i).map((e) => e.text) : [];
}

/** Waits until the first chat process has exited and a new one has started a turn for each of `texts`, in order. */
async function newChatGets(ctx, texts, timeout = 30_000) {
  const exit = await waitEvent(ctx.s, ctx.id, 'exit', undefined, 30_000);
  await waitFor(`a new chat to get ${texts.map((t) => `"${t}"`).join(', ')}`, () => turnsAfterExit(ctx).length >= texts.length, timeout);
  const got = turnsAfterExit(ctx);
  assert(JSON.stringify(got) === JSON.stringify(texts), `the new chat got ${JSON.stringify(got)}, not ${JSON.stringify(texts)}`);
  const starts = events(ctx.s, ctx.id).filter((e) => e.event === 'start');
  assert(starts.length === 2 && starts[1].i > exit.i, `expected one new chat process after the first had exited, saw ${starts.length} starts`);
  assert(!events(ctx.s, ctx.id).some((e) => e.event === 'turn-start' && texts.includes(e.text) && e.i < exit.i), 'a waiting message reached the ended chat');
  await waitFor('the waiting marker to go away', async () => (await waitingShown(ctx)).length === 0, 10_000);
}

/**
 * Checks that the message never went anywhere. Nothing happens when it works, so this has to give a wrongly started
 * chat time to show up (a new stand-in records `start` within about a second of being spawned) before looking.
 */
async function neverSent(ctx, text) {
  await new Promise((r) => setTimeout(r, 3_000));
  const ev = events(ctx.s, ctx.id);
  assert(ev.filter((e) => e.event === 'start').length === 1, 'a new chat started');
  assert(!ev.some((e) => e.event === 'turn-start' && e.text === text), `"${text}" was sent`);
}

/**
 * Resume or Open in Claude Code Chat, from the sidebar's right-click menu or the transcript's top bar, while a message
 * waits for the ended chat: the "still replying" modal, then Wait for the Reply or Stop It Now. The waiting message
 * goes back to the box and no new chat starts; the session opens elsewhere once the chat process has exited.
 */
function letGoWhileWaiting({ name, prompt, from, open, choice }) {
  const terminal = open === 'resume';
  return {
    name,
    prompt,
    async run(ctx) {
      const text = `Hold this until the old chat is done (${name}).`;
      await endMidReply(ctx);
      await sendWhileFinishing(ctx, text);
      if (from === 'sidebar') {
        await sidebarMenu(ctx, terminal ? 'Resume Session' : 'Open in Claude Code Chat');
      } else {
        await click(ctx, terminal ? '[data-cmd="resume"]' : '[data-cmd="openInClaudeCode"]');
      }
      const box = await modal(ctx, 'Claude is still replying');
      await box.locator('.monaco-button', { hasText: choice === 'wait' ? 'Wait for the Reply' : 'Stop It Now' }).click();
      await waitFor('the waiting message to come back to the box', async () => (await composerText(ctx)) === text, 5_000);
      assert((await waitingShown(ctx)).length === 0, 'the message still shows as waiting after going back to the box');
      if (choice === 'wait') {
        await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'completed', 30_000);
        assert(!events(ctx.s, ctx.id).some((e) => e.event === 'interrupt'), 'Wait for the Reply interrupted it');
      } else {
        await waitEvent(ctx.s, ctx.id, 'interrupt', undefined, 5_000);
        await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'interrupted', 5_000);
      }
      const exit = await waitEvent(ctx.s, ctx.id, 'exit', undefined, 10_000);
      const opened = await waitEvent(ctx.s, ctx.id, terminal ? 'terminal-resume' : 'claude-code-open', undefined, 20_000);
      assert(exit.i < opened.i, `the session opened ${terminal ? 'in the terminal' : 'in the Claude Code chat'} before the chat process had exited`);
      await neverSent(ctx, text);
      assert((await composerText(ctx)) === text, 'the message left the box again');
    },
  };
}

// ---------- a session live in another Claude Code process ----------

const LIVE_LABEL = 'Live in a terminal · idle';
const SUBAGENT = 'Review the pull request';
const SHELL = 'Run the tests in watch mode';

/**
 * Makes the session look open in a terminal's Claude Code, idle at its prompt, with a background subagent and a
 * background shell still running: a registry entry under this runner's own pid (alive for as long as the scenario
 * runs) and the launches appended to the log. Returns a function that ends the subagent in the log, and one that
 * makes the process exit (its registry file goes).
 */
function goLive(ctx) {
  const now = Date.now();
  const at = (s) => new Date(now - s * 1000).toISOString();
  const file = path.join(ctx.s.registry, `${process.pid}.json`);
  const entry = { pid: process.pid, sessionId: ctx.id, cwd: ctx.s.work, startedAt: now - 60_000, kind: 'interactive', entrypoint: 'cli', status: 'idle', updatedAt: now };
  const common = { isSidechain: false, sessionId: ctx.id, cwd: ctx.s.work, version: '2.1.332' };
  const records = [
    { ...common, type: 'user', message: { role: 'user', content: 'Start the review and the tests in the background.' }, uuid: `${ctx.id}-l1`, timestamp: at(40) },
    {
      ...common,
      type: 'assistant',
      message: {
        id: `msg_live_${ctx.id.slice(-4)}`,
        role: 'assistant',
        model: 'claude-stand-in',
        content: [
          { type: 'tool_use', id: 'toolu_live_agent', name: 'Agent', input: { subagent_type: 'reviewer', description: SUBAGENT, prompt: 'Review it.' } },
          { type: 'tool_use', id: 'toolu_live_shell', name: 'Bash', input: { command: 'npm test -- --watch', description: SHELL, run_in_background: true } },
        ],
        usage: { input_tokens: 3, output_tokens: 5 },
      },
      uuid: `${ctx.id}-l2`,
      timestamp: at(39),
    },
    {
      ...common,
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_live_agent', type: 'tool_result', content: 'Async agent launched successfully.\nagentId: ae2e0000000000001' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'ae2e0000000000001', description: SUBAGENT },
      uuid: `${ctx.id}-l3`,
      timestamp: at(38),
    },
    {
      ...common,
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_live_shell', type: 'tool_result', content: 'Command running in background with ID: be2e00001.' }] },
      toolUseResult: { stdout: '', stderr: '', backgroundTaskId: 'be2e00001' },
      uuid: `${ctx.id}-l4`,
      timestamp: at(38),
    },
  ];
  appendFileSync(logPath(ctx.s, ctx.id), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(file, JSON.stringify(entry));
  return {
    endSubagent: () => {
      const note = `<task-notification>\n<task-id>ae2e0000000000001</task-id>\n<tool-use-id>toolu_live_agent</tool-use-id>\n<status>completed</status>\n<summary>Agent "${SUBAGENT}" finished</summary>\n</task-notification>`;
      appendFileSync(logPath(ctx.s, ctx.id), JSON.stringify({ ...common, type: 'user', message: { role: 'user', content: note }, origin: { kind: 'task-notification' }, uuid: `${ctx.id}-l5`, timestamp: new Date().toISOString() }) + '\n');
    },
    exit: () => rmSync(file, { force: true }),
  };
}

const noticeText = async (ctx) => (await transcript(ctx)).$eval('#live-elsewhere', (el) => (el.hidden ? '' : el.textContent || ''));
const cardLive = async (ctx) => (await sidebar(ctx)).$eval(`.card[data-id$=":${ctx.id}"]`, (el) => el.querySelector('.tag.live-elsewhere')?.textContent || '');

/** Waits for the "live elsewhere" modal, checks it names what runs, and closes it with Cancel or `button`. */
async function liveModal(ctx, doing, button = 'Cancel') {
  const box = await modal(ctx, 'is live in a terminal');
  const text = (await box.textContent()) || '';
  assert(text.includes(doing), `the warning does not say "${doing}": ${text}`);
  assert(text.includes(`reviewer "${SUBAGENT}"`) && text.includes(`background shell "${SHELL}"`), `the warning does not name what is running: ${text}`);
  assert(/idle at its prompt/.test(text), `the warning does not say it is idle: ${text}`);
  await box.locator('.monaco-button', { hasText: button }).first().click();
}

/** Nothing opened the session: no terminal resume and no Claude Code chat, given time for one to show up. */
async function nothingOpened(ctx) {
  await new Promise((r) => setTimeout(r, 2_500));
  const ev = events(ctx.s, ctx.id);
  assert(!ev.some((e) => e.event === 'terminal-resume' || e.event === 'claude-code-open' || e.event === 'start'), `the session was opened anyway: ${JSON.stringify(ev)}`);
}

const LIVE_SCENARIOS = [
  {
    name: 'live-indicator',
    prompt: 'E2E live elsewhere, indicator',
    async run(ctx) {
      const live = goLive(ctx);
      try {
        await waitFor('the sidebar card to say the session is live', async () => (await cardLive(ctx)).includes(LIVE_LABEL), 20_000);
        await openTranscript(ctx);
        await waitFor('the transcript notice to show where it is live and what runs', async () => {
          const t = await noticeText(ctx);
          return t.includes(LIVE_LABEL) && t.includes(SUBAGENT) && t.includes(SHELL);
        });
        // The subagent finishes: its line goes, the shell's stays.
        live.endSubagent();
        await waitFor('the finished subagent to leave the notice', async () => {
          const t = await noticeText(ctx);
          return !t.includes(SUBAGENT) && t.includes(SHELL);
        }, 20_000);
        // The process exits: the notice and the card's tag go.
        live.exit();
        await waitFor('the notice to go once the process has exited', async () => (await noticeText(ctx)) === '', 20_000);
        await waitFor('the card tag to go once the process has exited', async () => !(await cardLive(ctx)), 20_000);
      } finally {
        live.exit();
      }
    },
  },
  {
    name: 'live-sidebar-resume',
    prompt: 'E2E live elsewhere, sidebar Resume',
    async run(ctx) {
      const live = goLive(ctx);
      try {
        await waitFor('the sidebar card to say the session is live', async () => (await cardLive(ctx)).includes(LIVE_LABEL), 20_000);
        await sidebarMenu(ctx, 'Resume Session');
        await liveModal(ctx, 'Resuming it here as well');
        await sidebarMenu(ctx, 'Open in Claude Code Chat');
        await liveModal(ctx, 'Opening it in the Claude Code chat as well');
        await nothingOpened(ctx);
      } finally {
        live.exit();
      }
    },
  },
  {
    name: 'live-topbar-resume',
    prompt: 'E2E live elsewhere, top bar Resume',
    async run(ctx) {
      const live = goLive(ctx);
      try {
        await openTranscript(ctx);
        await waitFor('the transcript notice', async () => (await noticeText(ctx)).includes(LIVE_LABEL), 20_000);
        await click(ctx, '[data-cmd="openInClaudeCode"]');
        await liveModal(ctx, 'Opening it in the Claude Code chat as well');
        await click(ctx, '[data-cmd="resume"]');
        await liveModal(ctx, 'Resuming it here as well');
        await nothingOpened(ctx);
        // Resume Anyway goes ahead.
        await click(ctx, '[data-cmd="resume"]');
        await liveModal(ctx, 'Resuming it here as well', 'Resume Anyway');
        await waitEvent(ctx.s, ctx.id, 'terminal-resume', undefined, 20_000);
      } finally {
        live.exit();
      }
    },
  },
  {
    name: 'live-chat-here',
    prompt: 'E2E live elsewhere, Chat here',
    async run(ctx) {
      const live = goLive(ctx);
      const text = 'Not while the terminal has it.';
      try {
        const frame = await openTranscript(ctx);
        await waitFor('the transcript notice', async () => (await noticeText(ctx)).includes(LIVE_LABEL), 20_000);
        await chatHere(frame);
        await send(await transcript(ctx), text);
        await liveModal(ctx, 'Chatting here as well');
        await nothingOpened(ctx);
        await waitFor('the message to stay in the box', async () => (await composerText(ctx)) === text, 5_000);
      } finally {
        live.exit();
      }
    },
  },
];

// ---------- Chat here with a GitHub Copilot CLI session (stand-in-copilot.mjs) ----------

const COPILOT = 'copilot-cli';
/** True once no process has the pid any more: Stop kills a Copilot turn, so its stand-in records no exit. */
const pidGone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
};
/** The user messages in a Copilot session's log, in order. */
const copilotUsers = (ctx) =>
  logText(ctx.s, ctx.id, COPILOT)
    .split('\n')
    .filter((l) => l.includes('"type":"user.message"'))
    .map((l) => JSON.parse(l).data.content);
const starts = (ctx) => events(ctx.s, ctx.id).filter((e) => e.event === 'start');
const toastText = (ctx) => ctx.page.locator('.notifications-toasts .notification-toast').allTextContents().then((t) => t.join('\n'));

const COPILOT_SCENARIOS = [
  {
    name: 'copilot-stream',
    source: COPILOT,
    prompt: 'E2E Copilot stream a reply',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Tell me twelve lines.');
      const start = await waitEvent(ctx.s, ctx.id, 'start');
      assert(JSON.stringify(start.args) === JSON.stringify([`--resume=${ctx.id}`, '--output-format', 'json', '--stream', 'on']), `started with ${JSON.stringify(start.args)}`);
      await midReply(ctx);
      assert(!(await liveText(ctx)).includes(LAST_LINE), 'the whole reply showed at once instead of streaming in');
      assert(/Copilot is working/.test(await chatState(ctx)), `the chat bar says "${await chatState(ctx)}"`);
      await waitFor('the finished reply in the logged conversation', () => logged(ctx, LAST_LINE), 30_000);
      await waitFor('the chat bar to show the last turn', async () => /^Last turn \d/.test(await chatState(ctx)));
      await waitFor('the pending part to empty', async () => !(await liveText(ctx)).includes(LAST_LINE));
    },
  },
  {
    name: 'copilot-second-message',
    source: COPILOT,
    prompt: 'E2E Copilot second message continues the session',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Tell me twelve lines.');
      await waitEvent(ctx.s, ctx.id, 'turn-end', undefined, 30_000);
      await send(await transcript(ctx), 'And twelve more.');
      await waitFor('the second turn to end', () => events(ctx.s, ctx.id).filter((e) => e.event === 'turn-end').length === 2, 30_000);
      const [a, b] = starts(ctx);
      assert(a && b && a.pid !== b.pid, 'each message was not its own process');
      assert(a.args[0] === `--resume=${ctx.id}` && b.args[0] === a.args[0], `the turns resumed ${a.args[0]} and ${b?.args[0]}`);
      const users = copilotUsers(ctx);
      assert(JSON.stringify(users.slice(-2)) === JSON.stringify(['Tell me twelve lines.', 'And twelve more.']), `the session log has ${JSON.stringify(users)}`);
      await waitFor('both prompts in the logged conversation', async () => (await logged(ctx, 'Tell me twelve lines.')) && (await logged(ctx, 'And twelve more.')), 15_000);
    },
  },
  {
    name: 'copilot-stop',
    source: COPILOT,
    prompt: 'E2E Copilot stop the reply',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Tell me twelve lines.');
      await midReply(ctx);
      const { pid } = starts(ctx)[0];
      await click(ctx, '#chat-stop');
      await waitFor('the chat bar to say the turn stopped', async () => /Last turn stopped/.test(await chatState(ctx)), 10_000);
      await waitFor("the turn's process to be gone", () => pidGone(pid), 10_000);
      assert(!events(ctx.s, ctx.id).some((e) => e.event === 'turn-end'), 'the turn ran to its end after Stop');
      assert(!logText(ctx.s, ctx.id, COPILOT).includes(LAST_LINE), 'the reply ran to the end after Stop');
      // The chat goes on: the next message is a new turn.
      await send(await transcript(ctx), 'Tell me twelve lines again.');
      await waitFor('a new turn to start', () => starts(ctx).length === 2, 10_000);
    },
  },
  {
    name: 'copilot-message-intact',
    source: COPILOT,
    prompt: 'E2E Copilot message arrives intact',
    async run(ctx) {
      const text = 'He said "hi" & \'yo\'\nline 2: %PATH% $HOME `tick` ^caret | pipe <b>';
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, text);
      const got = await waitEvent(ctx.s, ctx.id, 'turn-start');
      assert(got.text === text, `the stand-in got ${JSON.stringify(got.text)}`);
      await waitEvent(ctx.s, ctx.id, 'turn-end', undefined, 30_000);
      assert(copilotUsers(ctx).at(-1) === text, `the log has ${JSON.stringify(copilotUsers(ctx).at(-1))}`);
      assert(!starts(ctx)[0].args.some((a) => a.includes('PATH') || a.includes('tick')), 'the message was on the command line');
    },
  },
  {
    name: 'copilot-modes',
    source: COPILOT,
    prompt: 'E2E Copilot tool modes',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      const modes = await frame.$$eval('#chat-mode option', (els) => els.map((o) => o.textContent));
      assert(JSON.stringify(modes) === JSON.stringify(['Read only', 'Allow edits', 'Allow all tools']), `the picker offers ${JSON.stringify(modes)}`);
      assert((await frame.$eval('#chat-mode', (el) => el.value)) === 'read', 'read only is not the default');
      // Allow edits: the call runs.
      await frame.selectOption('#chat-mode', 'edits');
      await send(frame, 'Make an edit.');
      const first = await waitEvent(ctx.s, ctx.id, 'start');
      assert(first.args.includes('--allow-tool=write') && !first.args.includes('--allow-all-tools'), `started with ${JSON.stringify(first.args)}`);
      const allowed = await waitEvent(ctx.s, ctx.id, 'tool');
      assert(allowed.allowed === true, 'the edit was declined with Allow edits');
      await waitEvent(ctx.s, ctx.id, 'turn-end', undefined, 30_000);
      // Read only: the same call is declined, and the tab says what would let it run.
      await (await transcript(ctx)).selectOption('#chat-mode', 'read');
      await send(await transcript(ctx), 'Make an edit again.');
      await waitFor('a second turn', () => starts(ctx).length === 2, 10_000);
      assert(!starts(ctx)[1].args.some((a) => a.startsWith('--allow')), `read only started with ${JSON.stringify(starts(ctx)[1].args)}`);
      await waitFor('the declined call to be noted in the tab', async () => /Declined apply_patch.*"Allow edits"/.test(await liveText(ctx)), 10_000);
      assert(events(ctx.s, ctx.id).filter((e) => e.event === 'tool')[1]?.allowed === false, 'the edit ran in read only');
    },
  },
  {
    name: 'copilot-resume-while-replying',
    source: COPILOT,
    prompt: 'E2E Copilot resume while replying',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Tell me twelve lines.');
      await midReply(ctx);
      const { pid } = starts(ctx)[0];
      await sidebarMenu(ctx, 'Resume Session');
      const box = await modal(ctx, 'Copilot is still replying');
      const text = (await box.textContent()) || '';
      assert(/two GitHub Copilot CLI processes/.test(text), `the modal says: ${text}`);
      await box.locator('.monaco-button', { hasText: 'Stop It Now' }).click();
      await waitFor("the turn's process to be gone", () => pidGone(pid), 10_000);
      const term = await waitEvent(ctx.s, ctx.id, 'terminal-resume', undefined, 20_000);
      assert(!events(ctx.s, ctx.id).some((e) => e.event === 'turn-end'), 'Stop It Now let the turn finish');
      assert(String(term.args).includes(ctx.id), `the terminal resumed ${term.args}`);
    },
  },
  {
    name: 'copilot-terminal-guard',
    source: COPILOT,
    prompt: 'E2E Copilot open in a terminal',
    async run(ctx) {
      const text = 'Not while the terminal has it.';
      await sidebarMenu(ctx, 'Resume Session');
      await waitEvent(ctx.s, ctx.id, 'terminal-resume', undefined, 20_000);
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, text);
      await waitFor('the warning that the session is open in a terminal', async () => /open in a terminal.*GitHub Copilot CLI/s.test(await toastText(ctx)), 10_000);
      await new Promise((r) => setTimeout(r, 2_500));
      assert(!starts(ctx).length, 'a chat turn started anyway');
      await waitFor('the message to stay in the box', async () => (await composerText(ctx)) === text, 5_000);
      await ctx.page.keyboard.press('Escape');
    },
  },
];

// ---------- the scenarios ----------
const SCENARIOS = [
  {
    name: 'stream',
    prompt: 'E2E stream a reply',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Tell me twelve lines.');
      await waitEvent(ctx.s, ctx.id, 'start');
      await midReply(ctx);
      assert(!(await liveText(ctx)).includes(LAST_LINE), 'the whole reply showed at once instead of streaming in');
      await waitFor('the finished reply in the logged conversation', () => logged(ctx, LAST_LINE), 30_000);
      await waitFor('the chat to be ready again', async () => /^Ready/.test(await chatState(ctx)));
      await waitFor('the pending part to empty', async () => !(await liveText(ctx)).includes(LAST_LINE));
    },
  },
  {
    name: 'end-chat-mid-reply',
    prompt: 'E2E end the chat mid-reply',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Tell me twelve lines.');
      await midReply(ctx);
      await click(ctx, '#chat-end');
      await waitFor('the chat bar to say the reply is finishing', async () => /Chat ended: Claude is finishing/.test(await chatState(ctx)), 5_000);
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'completed', 30_000);
      await waitEvent(ctx.s, ctx.id, 'exit');
      assert(!events(ctx.s, ctx.id).some((e) => e.event === 'interrupt'), 'End chat interrupted the reply');
      assert(logText(ctx.s, ctx.id).includes(LAST_LINE), 'the log does not have the whole reply');
      await waitFor('the finished reply in the logged conversation', () => logged(ctx, LAST_LINE), 15_000);
    },
  },
  {
    name: 'stop',
    prompt: 'E2E stop the reply',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Tell me twelve lines.');
      await midReply(ctx);
      await click(ctx, '#chat-stop');
      await waitEvent(ctx.s, ctx.id, 'interrupt', undefined, 5_000);
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'interrupted', 5_000);
      await waitFor('the chat bar to say the turn stopped', async () => /Last turn stopped/.test(await chatState(ctx)), 10_000);
      assert(!logText(ctx.s, ctx.id).includes(LAST_LINE), 'the reply ran to the end after Stop');
      assert(!events(ctx.s, ctx.id).some((e) => e.event === 'exit'), 'Stop ended the process; it should stay up for the next turn');
    },
  },
  {
    name: 'permission-allow',
    prompt: 'E2E allow a permission',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Run a command that needs permission.');
      await waitEvent(ctx.s, ctx.id, 'permission-asked');
      await (await transcript(ctx)).waitForSelector('#chat-live .chat-permission.active button[data-perm="allow"]', { timeout: 10_000 });
      await waitFor('the chat bar to wait for an answer', async () => /Waiting for your answer/.test(await chatState(ctx)));
      await click(ctx, '#chat-live button[data-perm="allow"]');
      const answer = await waitEvent(ctx.s, ctx.id, 'permission-answered', undefined, 5_000);
      assert(answer.behavior === 'allow', `the stand-in got "${answer.behavior}", not allow`);
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'completed', 15_000);
      await waitFor('the reply after Allow in the logged conversation', () => logged(ctx, 'printed the word stand-in'), 15_000);
    },
  },
  {
    name: 'permission-deny',
    prompt: 'E2E deny a permission',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Run a command that needs permission.');
      await waitEvent(ctx.s, ctx.id, 'permission-asked');
      await (await transcript(ctx)).waitForSelector('#chat-live .chat-permission.active button[data-perm="deny"]', { timeout: 10_000 });
      await click(ctx, '#chat-live button[data-perm="deny"]');
      const answer = await waitEvent(ctx.s, ctx.id, 'permission-answered', undefined, 5_000);
      assert(answer.behavior === 'deny', `the stand-in got "${answer.behavior}", not deny`);
      assert(/declined/i.test(answer.message ?? ''), `the deny message was "${answer.message}"`);
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'completed', 15_000);
      await waitFor('the reply after Deny in the logged conversation', () => logged(ctx, 'carrying on without it'), 15_000);
    },
  },
  {
    name: 'permission-allow-for-session',
    prompt: 'E2E allow a permission for the session',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Run a command that needs permission, for the session.');
      await waitEvent(ctx.s, ctx.id, 'permission-asked');
      const button = '#chat-live .chat-permission.active button[data-perm="session"]';
      await (await transcript(ctx)).waitForSelector(button, { timeout: 10_000 });
      const card = await liveText(ctx);
      assert(/Allow for this session/.test(card), 'no Allow for this session button');
      assert(/For this session: allows Bash\(echo \*\) without asking; switches the permission mode to Accept edits/.test(card), `the card does not say what it grants: ${card}`);
      const title = await (await transcript(ctx)).$eval(button, (el) => el.getAttribute('title') || '');
      assert(/Nothing is written to settings files/.test(title), `the button's title does not say it writes no settings: ${title}`);
      await click(ctx, button);
      const answer = await waitEvent(ctx.s, ctx.id, 'permission-answered', undefined, 5_000);
      assert(answer.behavior === 'allow', `the stand-in got "${answer.behavior}", not allow`);
      const grants = answer.updatedPermissions ?? [];
      assert(grants.length === 2 && grants.every((g) => g.destination === 'session'), `the grants were ${JSON.stringify(grants)}`);
      assert(!events(ctx.s, ctx.id).some((e) => e.event === 'settings-write'), 'a grant went to a settings file');
      await waitFor('the card to say it was allowed for the session', async () => /Allowed for this session/.test(await liveText(ctx)), 5_000);
      // The process is in Accept edits now, and the picker says so.
      await waitFor('the picker to follow to Accept edits', async () => (await (await transcript(ctx)).$eval('#chat-mode', (el) => el.value)) === 'acceptEdits', 5_000);
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'completed', 15_000);
      // The same command again in the same chat: no card, the grant holds, and the process was not restarted.
      await send(await transcript(ctx), 'Run that permission command again.');
      await waitEvent(ctx.s, ctx.id, 'permission-skipped', undefined, 15_000);
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'completed' && events(ctx.s, ctx.id).filter((x) => x.event === 'turn-end').length >= 2, 15_000);
      const all = events(ctx.s, ctx.id);
      assert(all.filter((e) => e.event === 'permission-asked').length === 1, 'asked again after Allow for this session');
      assert(all.filter((e) => e.event === 'start').length === 1, 'the process was restarted, which drops the session grants');
    },
  },
  {
    name: 'close-tab-mid-reply',
    prompt: 'E2E close the tab mid-reply',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Tell me twelve lines.');
      await midReply(ctx);
      const t = tab(ctx);
      await t.hover();
      await t.locator('.tab-actions .action-label').first().click();
      await waitFor('the transcript tab to close', async () => (await t.count()) === 0, 5_000);
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'completed', 30_000);
      await waitEvent(ctx.s, ctx.id, 'stdin-end');
      await waitEvent(ctx.s, ctx.id, 'exit');
      assert(!events(ctx.s, ctx.id).some((e) => e.event === 'interrupt'), 'closing the tab interrupted the reply');
      assert(logText(ctx.s, ctx.id).includes(LAST_LINE), 'the log does not have the whole reply');
    },
  },
  {
    name: 'resume-while-replying-wait',
    prompt: 'E2E resume while replying, wait',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Tell me twelve lines.');
      await midReply(ctx);
      await sidebarMenu(ctx, 'Resume Session');
      const box = await modal(ctx, 'Claude is still replying');
      await box.locator('.monaco-button', { hasText: 'Wait for the Reply' }).click();
      const end = await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'completed', 30_000);
      const exit = await waitEvent(ctx.s, ctx.id, 'exit');
      const term = await waitEvent(ctx.s, ctx.id, 'terminal-resume', undefined, 20_000);
      assert(!events(ctx.s, ctx.id).some((e) => e.event === 'interrupt'), 'Wait for the Reply interrupted it');
      assert(end.i < exit.i && exit.i < term.i, 'the terminal started before the chat process had exited');
      assert(logText(ctx.s, ctx.id).includes(LAST_LINE), 'the log does not have the whole reply');
    },
  },
  {
    name: 'resume-while-replying-stop',
    prompt: 'E2E resume while replying, stop',
    async run(ctx) {
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Tell me twelve lines.');
      await midReply(ctx);
      await sidebarMenu(ctx, 'Resume Session');
      const box = await modal(ctx, 'Claude is still replying');
      await box.locator('.monaco-button', { hasText: 'Stop It Now' }).click();
      await waitEvent(ctx.s, ctx.id, 'interrupt', undefined, 5_000);
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'interrupted', 5_000);
      const exit = await waitEvent(ctx.s, ctx.id, 'exit', undefined, 10_000);
      const term = await waitEvent(ctx.s, ctx.id, 'terminal-resume', undefined, 20_000);
      assert(exit.i < term.i, 'the terminal started before the chat process had exited');
      assert(!logText(ctx.s, ctx.id).includes(LAST_LINE), 'the reply ran to the end after Stop It Now');
    },
  },
  {
    name: 'waiting-message-enter',
    prompt: 'E2E send while the ended chat finishes',
    async run(ctx) {
      const first = 'First message for the new chat.';
      const second = 'Second message for the new chat.';
      await endMidReply(ctx);
      await sendWhileFinishing(ctx, first);
      await waitFor('the chat bar to say the message starts a new chat', async () => /Your message starts a new chat after it/.test(await chatState(ctx)), 5_000);
      await sendWhileFinishing(ctx, second);
      await waitFor('the chat bar to count 2 messages', async () => /Your 2 messages start a new chat after it/.test(await chatState(ctx)), 5_000);
      const shown = await waitingShown(ctx);
      assert(shown.length === 2 && shown[0].includes(first) && shown[1].includes(second), `the waiting messages show as ${JSON.stringify(shown)}`);
      const below = await (await transcript(ctx)).evaluate(() => {
        const reply = document.querySelector('#chat-live .msg.assistant.chat-pending');
        const waiting = document.querySelector('#chat-live .chat-pending.waiting');
        return { reply: !!reply, below: !!(reply && waiting && reply.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING) };
      });
      assert(below.reply, 'the finishing reply is not shown');
      assert(below.below, 'the waiting messages are not below the finishing reply');
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'completed', 30_000);
      assert(!events(ctx.s, ctx.id).some((e) => e.event === 'interrupt'), 'sending while it finished interrupted the reply');
      await newChatGets(ctx, [first, second]);
    },
  },
  {
    name: 'waiting-message-queue-button',
    prompt: 'E2E queue with the button while the ended chat finishes',
    async run(ctx) {
      const text = 'Queued with the button for the new chat.';
      await endMidReply(ctx);
      await waitFor('the Send button to read Queue', async () => (await sendLabel(ctx)) === 'Queue', 5_000);
      await sendWhileFinishing(ctx, text, { button: true });
      await waitFor('the chat bar to say the message starts a new chat', async () => /Your message starts a new chat after it/.test(await chatState(ctx)), 5_000);
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'completed', 30_000);
      await newChatGets(ctx, [text]);
    },
  },
  {
    name: 'waiting-message-stop',
    prompt: 'E2E stop the finishing reply with a message waiting',
    async run(ctx) {
      const text = 'Sent once the stopped chat is gone.';
      await endMidReply(ctx);
      await sendWhileFinishing(ctx, text);
      const stoppedAt = Date.now();
      await click(ctx, '#chat-stop');
      await waitEvent(ctx.s, ctx.id, 'interrupt', undefined, 5_000);
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'interrupted', 5_000);
      assert(!events(ctx.s, ctx.id).some((e) => e.event === 'turn-end' && e.how === 'completed'), 'the reply ran to the end after Stop');
      await newChatGets(ctx, [text]);
      // At once: the new chat gets the message within a couple of seconds of Stop (a new process takes about one to
      // start). About 4 s of the reply are left when Stop is pressed, so waiting for it to finish would take longer.
      const got = events(ctx.s, ctx.id).find((e) => e.event === 'turn-start' && e.text === text);
      const took = got.t - stoppedAt;
      assert(took < 2_500, `the new chat got the message ${took} ms after Stop, not at once`);
    },
  },
  {
    name: 'waiting-message-after-reply-before-exit',
    prompt: 'E2E send after the reply ends, before the chat process exits',
    async run(ctx) {
      const text = 'Sent once the lingering chat has gone.';
      // "lingering": the stand-in stays up for a few seconds after the reply, so the gap can be looked at.
      await endMidReply(ctx, 'Tell me twelve lines, lingering.');
      // The gap is short (the extension kills a process 3 s after its stdin closed), so no waiting on anything else.
      await waitFor('the chat bar to stop saying the reply is finishing', async () => !/finishing/.test(await chatState(ctx)), 15_000);
      const frame = await transcript(ctx);
      await send(frame, text);
      await waitFor('the chat bar to say the message starts a new chat once the ended one has stopped', async () => /Your message starts a new chat once the ended one has stopped/.test(await chatState(ctx)), 5_000);
      assert((await sendLabel(ctx)) === 'Queue', `the Send button reads "${await sendLabel(ctx)}", not Queue`);
      const shown = await waitingShown(ctx);
      assert(shown.length === 1 && shown[0].includes(text) && shown[0].includes(WAITING_PILL), `the waiting message shows as ${JSON.stringify(shown)}`);
      const ev = events(ctx.s, ctx.id);
      assert(ev.some((e) => e.event === 'turn-end' && e.how === 'completed'), 'the reply had not ended in the gap');
      assert(!ev.some((e) => e.event === 'exit'), 'the chat process exited before the gap could be checked');
      await newChatGets(ctx, [text]);
    },
  },
  {
    name: 'waiting-message-below-denied-card',
    prompt: 'E2E end the chat at a permission card, then send',
    async run(ctx) {
      const text = 'A message after the denied card.';
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Run a command that needs permission, slowly.');
      await waitEvent(ctx.s, ctx.id, 'permission-asked');
      await (await transcript(ctx)).waitForSelector('#chat-live .chat-permission.active button[data-perm="allow"]', { timeout: 10_000 });
      await click(ctx, '#chat-end');
      const answer = await waitEvent(ctx.s, ctx.id, 'permission-answered', undefined, 5_000);
      assert(answer.behavior === 'deny', `ending the chat answered the card with "${answer.behavior}", not deny`);
      await waitFor('the chat bar to say the reply is finishing', async () => /Chat ended: Claude is finishing/.test(await chatState(ctx)), 5_000);
      await sendWhileFinishing(ctx, text);
      const page = await (await transcript(ctx)).evaluate(() => {
        const live = document.getElementById('chat-live');
        const card = live.querySelector('.chat-permission');
        const waiting = live.querySelector('.chat-pending.waiting');
        return {
          card: !!card,
          denied: !!card?.querySelector('.perm-outcome.denied') && /Denied/.test(card.textContent || ''),
          active: !!card?.classList.contains('active'),
          buttons: live.querySelectorAll('button[data-perm]').length,
          below: !!(card && waiting && card.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING),
        };
      });
      assert(page.card, 'the permission card is gone');
      assert(page.denied && !page.active, 'the card does not show as denied');
      assert(page.buttons === 0, 'the denied card still has Allow and Deny buttons');
      assert(page.below, 'the waiting message is not below the card');
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'completed', 30_000);
      await newChatGets(ctx, [text]);
    },
  },
  {
    name: 'waiting-message-tab-closed',
    prompt: 'E2E close the tab with a message waiting',
    async run(ctx) {
      const text = 'Never to be sent: the tab closes first.';
      await endMidReply(ctx);
      await sendWhileFinishing(ctx, text);
      const t = tab(ctx);
      await t.hover();
      await t.locator('.tab-actions .action-label').first().click();
      await waitFor('the transcript tab to close', async () => (await t.count()) === 0, 5_000);
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'completed', 30_000);
      await waitEvent(ctx.s, ctx.id, 'exit');
      await neverSent(ctx, text);
    },
  },
  letGoWhileWaiting({ name: 'waiting-message-sidebar-resume-wait', prompt: 'E2E waiting, sidebar Resume, wait', from: 'sidebar', open: 'resume', choice: 'wait' }),
  letGoWhileWaiting({ name: 'waiting-message-sidebar-resume-stop', prompt: 'E2E waiting, sidebar Resume, stop', from: 'sidebar', open: 'resume', choice: 'stop' }),
  letGoWhileWaiting({ name: 'waiting-message-sidebar-open-chat-wait', prompt: 'E2E waiting, sidebar Open in chat, wait', from: 'sidebar', open: 'chat', choice: 'wait' }),
  letGoWhileWaiting({ name: 'waiting-message-sidebar-open-chat-stop', prompt: 'E2E waiting, sidebar Open in chat, stop', from: 'sidebar', open: 'chat', choice: 'stop' }),
  letGoWhileWaiting({ name: 'waiting-message-topbar-resume-wait', prompt: 'E2E waiting, top bar Resume, wait', from: 'topbar', open: 'resume', choice: 'wait' }),
  letGoWhileWaiting({ name: 'waiting-message-topbar-resume-stop', prompt: 'E2E waiting, top bar Resume, stop', from: 'topbar', open: 'resume', choice: 'stop' }),
  letGoWhileWaiting({ name: 'waiting-message-topbar-open-chat-wait', prompt: 'E2E waiting, top bar Open in chat, wait', from: 'topbar', open: 'chat', choice: 'wait' }),
  letGoWhileWaiting({ name: 'waiting-message-topbar-open-chat-stop', prompt: 'E2E waiting, top bar Open in chat, stop', from: 'topbar', open: 'chat', choice: 'stop' }),
  {
    name: 'queued-not-waiting',
    prompt: 'E2E queue a message in a running chat',
    async run(ctx) {
      const text = 'A follow-up while it replies.';
      const frame = await openTranscript(ctx);
      await chatHere(frame);
      await send(frame, 'Tell me twelve lines.');
      await midReply(ctx);
      await send(await transcript(ctx), text);
      const pills = async () =>
        (await transcript(ctx)).$$eval('#chat-live .chat-pending.user', (els) => els.map((el) => ({ text: el.textContent || '', waiting: el.classList.contains('waiting') })));
      await waitFor(`"${text}" to show as queued`, async () => (await pills()).some((p) => p.text.includes(text) && /queued/.test(p.text)), 5_000);
      const mine = (await pills()).filter((p) => p.text.includes(text));
      assert(mine.every((p) => !p.waiting && !p.text.includes(WAITING_PILL)), 'a message in a running chat shows as waiting for an ended one');
      assert(!/new chat/.test(await chatState(ctx)), 'the chat bar says a new chat starts');
      await waitEvent(ctx.s, ctx.id, 'turn-start', (e) => e.text === text, 30_000);
      assert(events(ctx.s, ctx.id).filter((e) => e.event === 'start').length === 1, 'the queued message started a new chat');
    },
  },
  ...LIVE_SCENARIOS,
  ...COPILOT_SCENARIOS,
];
/** The area: every scenario above has its own synthetic session, titled by its `prompt`. */
export default { name: 'chat', scenarios: SCENARIOS };
