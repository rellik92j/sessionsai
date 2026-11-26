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

// ---------- a message sent while an ended chat finishes its reply ----------

const WAITING_PILL = 'waits for the previous reply to finish';
const composerText = async (ctx) => (await transcript(ctx)).$eval('#composer-input', (el) => el.value);
const sendLabel = async (ctx) => (await transcript(ctx)).$eval('#composer-send span', (el) => el.textContent || '');
/** The text of each message in the pending part marked as waiting for the ended chat. */
const waitingShown = async (ctx) => (await transcript(ctx)).$$eval('#chat-live .chat-pending.waiting', (els) => els.map((el) => el.textContent || ''));

/** Starts a slow reply in Chat here and presses End chat during it; returns once the bar says it is finishing. */
async function endMidReply(ctx) {
  const frame = await openTranscript(ctx);
  await chatHere(frame);
  await send(frame, 'Tell me twelve lines.');
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
      await click(ctx, '#chat-stop');
      await waitEvent(ctx.s, ctx.id, 'interrupt', undefined, 5_000);
      await waitEvent(ctx.s, ctx.id, 'turn-end', (e) => e.how === 'interrupted', 5_000);
      assert(!events(ctx.s, ctx.id).some((e) => e.event === 'turn-end' && e.how === 'completed'), 'the reply ran to the end after Stop');
      // At once: the new chat gets the message within seconds of Stop, not after the reply would have finished.
      await newChatGets(ctx, [text], 5_000);
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
];
