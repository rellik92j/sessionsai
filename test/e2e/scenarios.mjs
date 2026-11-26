// The end-to-end scenarios. Each gets its own synthetic session, titled by its `prompt`, so one scenario's chat or
// terminal never gets in another's way. See docs/dev/e2e.md for how to add one.

import { events, frameWith, logText, waitEvent, waitFor } from './harness.mjs';

const FIRST_LINE = 'Line 2 of the stand-in reply.';
const LAST_LINE = 'Line 12 of the stand-in reply. Done.';

// ---------- steps scenarios share ----------

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

// The page is rebuilt (a new frame) when the transcript's shape changes, a tool call for one, so everything below
// looks the frame up again rather than holding on to one.
const liveText = async (ctx) => (await transcript(ctx)).$eval('#chat-live', (el) => el.textContent || '');
const chatState = async (ctx) => (await transcript(ctx)).$eval('#chat-state', (el) => el.textContent || '');
const click = async (ctx, selector) => (await transcript(ctx)).click(selector);

/** True when the logged conversation (not the chat's pending part) shows `needle`. */
const logged = async (ctx, needle) =>
  (await transcript(ctx)).evaluate((n) => [...document.querySelectorAll('.msg')].some((m) => !m.closest('#chat-live') && (m.textContent || '').includes(n)), needle);

/** Waits until part of the reply has streamed into the pending part, and the turn is still running. */
async function midReply(ctx) {
  await waitFor('the reply to start streaming in', async () => (await liveText(ctx)).includes(FIRST_LINE));
  if (events(ctx.s, ctx.id).some((e) => e.event === 'turn-end')) {
    throw new Error('the turn had already ended: the stand-in reply is too quick for this check');
  }
}

/** The tab of the session's transcript in the editor area. */
const tab = (ctx) => ctx.page.locator('.tabs-container .tab', { hasText: ctx.title }).first();

/** Right-clicks the session's card in the sidebar and picks `label` from the context menu. */
async function sidebarMenu(ctx, label) {
  const side = await sidebar(ctx);
  await side.click(`.card[data-id$=":${ctx.id}"]`, { button: 'right' });
  const item = ctx.page.locator('.monaco-menu .action-item', { hasText: label }).first();
  await item.waitFor({ state: 'visible', timeout: 10_000 });
  await item.click();
}

/** Waits for the in-page modal (window.dialogStyle custom) and returns it. */
async function modal(ctx, text) {
  const box = ctx.page.locator('.monaco-dialog-box', { hasText: text }).first();
  await box.waitFor({ state: 'visible', timeout: 10_000 });
  return box;
}

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

// ---------- the scenarios ----------

export const SCENARIOS = [
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
];
