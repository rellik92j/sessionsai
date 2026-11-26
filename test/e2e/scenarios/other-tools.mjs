// The other-tools area: README's "GitHub Copilot CLI and VS Code Chat sessions too". A Copilot CLI session and a VS Code
// Chat session in the sidebar with their tool marked, read in the transcript view, found by search, and what Resume,
// Continue and Chat here offer for them (and do not). The chat itself is the `chat` area's; here it is only checked to
// be offered. See docs/dev/e2e.md for how to add a scenario.
//
// The two sessions are synthetic, in the record shapes of test/fixtures/copilot-cli and test/fixtures/vscode-chat, and
// written by `seed` into the sandbox before VS Code starts. They show beside every other area's sessions, so the
// scenarios find theirs by id (and by the word "otools" in their titles) and ignore every other card. Each puts back
// what it changed (source chips, search box, tabs).

import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, events, frameWith, waitFor, sidebar } from '../harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;

// ---------- the synthetic sessions ----------

const COPILOT = 'e2e0070a-0000-4000-8000-000000000001';
const VSCHAT = 'e2e0070a-0000-4000-8000-000000000002';
const COPILOT_TITLE = 'Otools Copilot router redirect';
const VSCHAT_TITLE = 'Otools VS Code login walkthrough';
/** Words only the sessions' replies contain, so a search that finds them found the conversation. */
const COPILOT_WORD = 'quokkapath';
const VSCHAT_WORD = 'narwhalmount';
const FIRST_PROMPT = 'Why does the router bounce the visitor twice?';
const SECOND_PROMPT = 'Change the guard to run once';

// Taken once, when the module loads, so the files' times and what the scenarios expect agree.
const NOW = Date.now();

/** A GitHub Copilot CLI session: session-state/<id>/workspace.yaml and events.jsonl, as Copilot CLI writes them. */
function writeCopilot(s, folder) {
  const dir = path.join(s.copilot, 'session-state', COPILOT);
  mkdirSync(dir, { recursive: true });
  const start = NOW - 2 * DAY;
  const at = (sec) => new Date(start + sec * 1000).toISOString();
  let n = 0;
  const rec = (sec, type, data) => ({ type, data, id: `ot${String(++n).padStart(4, '0')}`, timestamp: at(sec) });
  const records = [
    rec(0, 'session.start', { sessionId: COPILOT, version: 1, producer: 'copilot-agent', copilotVersion: '0.0.330', context: { cwd: folder, branch: 'feature/router' } }),
    rec(1, 'session.model_change', { newModel: 'claude-sonnet-4.5' }),
    // transformedContent is what the model saw, with context injected; the transcript shows what the person typed.
    rec(5, 'user.message', { content: FIRST_PROMPT, transformedContent: `<context>injected-context</context>\n${FIRST_PROMPT}`, attachments: [] }),
    rec(6, 'assistant.turn_start', { turnId: '0' }),
    rec(7, 'assistant.reasoning', { reasoningId: 'r1', content: 'hidden-reasoning-text' }),
    rec(8, 'assistant.message_delta', { messageId: 'm1', deltaContent: 'Let me' }),
    rec(9, 'assistant.message', { messageId: 'm1', content: 'Let me look at the router.', toolRequests: [{ toolCallId: 'call_1', name: 'view', arguments: { path: 'src/router.ts' }, type: 'function' }] }),
    rec(10, 'tool.execution_start', { toolCallId: 'call_1', toolName: 'view', arguments: { path: 'src/router.ts' } }),
    rec(11, 'tool.execution_complete', { toolCallId: 'call_1', success: true, result: { content: '1. export const home = "/home";', detailedContent: 'full' } }),
    rec(12, 'tool.execution_start', { toolCallId: 'call_2', toolName: 'bash', arguments: { command: 'npm test', description: 'Run tests' } }),
    rec(13, 'tool.execution_complete', { toolCallId: 'call_2', success: false, error: { message: 'exit code 1' } }),
    rec(60, 'assistant.message', { messageId: 'm2', content: `The guard runs twice because of ${COPILOT_WORD}.`, toolRequests: [] }),
    rec(61, 'assistant.turn_end', { turnId: '0' }),
    rec(90, 'user.message', { content: SECOND_PROMPT, attachments: [] }),
    rec(100, 'assistant.message', { messageId: 'm3', content: '', toolRequests: [{ toolCallId: 'call_3', name: 'edit', arguments: { path: 'src/router.ts', old_str: '/home', new_str: '/dashboard' }, type: 'function' }] }),
    rec(101, 'tool.execution_complete', { toolCallId: 'call_3', success: true, result: { content: 'File edited.' } }),
    rec(120, 'assistant.message', { messageId: 'm4', content: 'Done, the guard now runs once.', toolRequests: [] }),
    // A record type this version does not know: skipped, not a crash.
    rec(120, 'some.future_event', { x: 1 }),
  ];
  const file = path.join(dir, 'events.jsonl');
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(
    path.join(dir, 'workspace.yaml'),
    [`id: ${COPILOT}`, `cwd: ${folder}`, `branch: feature/router`, `summary: "${COPILOT_TITLE}"`, `created_at: ${at(0)}`, `updated_at: ${at(120)}`, ''].join('\n'),
  );
  utimesSync(file, new Date(start + 120_000), new Date(start + 120_000));
}

/** A VS Code Chat session: <user>/workspaceStorage/<hash>/chatSessions/<id>.jsonl, a log of patches to one object. */
function writeVsCodeChat(s, folder) {
  const storage = path.join(s.vscodeUser, 'workspaceStorage', 'otoolshash');
  const dir = path.join(storage, 'chatSessions');
  mkdirSync(dir, { recursive: true });
  // Which folder the chats in this workspace belong to.
  writeFileSync(path.join(storage, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(folder).href }));
  const start = NOW - 3 * DAY;
  const t = (sec) => start + sec * 1000;
  const lines = [
    { kind: 0, v: { version: 3, creationDate: t(0), initialLocation: 'panel', responderUsername: 'GitHub Copilot', sessionId: VSCHAT, hasPendingEdits: false, requests: [], pendingRequests: [], inputState: {} } },
    { kind: 2, k: ['requests'], v: [{ requestId: 'request_1', timestamp: t(10), modelId: 'copilot/gpt-5', message: { text: 'Explain the login flow in #file:auth.ts', parts: [] }, response: [], result: {} }] },
    { kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'thinking', value: 'Considering the file' }, { value: 'The login flow starts in ', supportThemeIcons: false }] },
    { kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'inlineReference', inlineReference: { scheme: 'file', path: '/c:/repo/src/auth.ts' } }, { kind: 'markdownContent', content: { value: ` and ${VSCHAT_WORD} sends the person on.` } }] },
    {
      kind: 2,
      k: ['requests', 0, 'response'],
      v: [
        {
          kind: 'toolInvocationSerialized',
          toolId: 'copilot_readFile',
          toolCallId: 'tc1',
          invocationMessage: { value: 'Reading auth.ts' },
          pastTenseMessage: { value: 'Read auth.ts' },
          isComplete: true,
          resultDetails: { input: '{"filePath":"/c:/repo/src/auth.ts"}', output: [{ type: 'embed', isText: true, value: 'export function login() {}' }], isError: false },
        },
      ],
    },
    { kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'markdownContent', content: { value: ' It ends at the router.' } }] },
    { kind: 1, k: ['requests', 0, 'result'], v: { timings: { totalElapsed: 5000 }, metadata: {} } },
    { kind: 1, k: ['customTitle'], v: VSCHAT_TITLE },
    { kind: 2, k: ['requests'], v: [{ requestId: 'request_2', timestamp: t(100), modelId: 'copilot/gpt-5', message: { text: 'Thanks, that covers it', parts: [] }, response: [{ kind: 'markdownContent', content: { value: 'You are welcome.' } }] }] },
    { kind: 7, k: ['whatever'], v: 1 }, // a patch kind this version does not know: skipped
    { kind: 1, k: ['lastMessageDate'], v: t(105) },
  ];
  const file = path.join(dir, `${VSCHAT}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  utimesSync(file, new Date(t(105)), new Date(t(105)));
}

/** Writes both sessions into the sandbox. Run by the runner once, before VS Code starts. */
function seed(s) {
  const cli = path.join(s.dir, 'work', 'otools-cli');
  const chat = path.join(s.dir, 'work', 'otools-chat');
  mkdirSync(cli, { recursive: true });
  mkdirSync(chat, { recursive: true });
  writeCopilot(s, cli);
  writeVsCodeChat(s, chat);
}

// ---------- steps ----------

const cardSel = (id) => `.card[data-id$=":${id}"]`;
const chipSel = (source) => `#sources .chip[data-source="${source}"]`;
const chipPressed = async (frame, source) => (await frame.getAttribute(chipSel(source), 'aria-pressed')) === 'true';

/** The titles of the cards the sidebar lists, for a failure message. */
const shownTitles = async (frame) => (await frame.$$eval('.card:not(.skeleton) .title', (els) => els.map((e) => e.textContent.trim()))).join(' | ') || 'none';

/** The ids of every session the sidebar lists, sorted. */
const shownIds = async (frame) => (await frame.$$eval('.card:not(.skeleton)', (els) => els.map((e) => e.dataset.id.split(':').pop()))).sort();

/** Waits until the list shows exactly these sessions (of any tool), and keeps showing them. */
async function expectCards(frame, expected, what) {
  const want = [...expected].sort();
  const same = async () => {
    const got = await shownIds(frame);
    return got.length === want.length && got.every((id, i) => id === want[i]);
  };
  try {
    await waitFor(`${what} to show ${want.join(', ')}`, same, 10_000);
  } catch (err) {
    throw new Error(`${err.message}. Showing: ${await shownTitles(frame)}`);
  }
  await sleep(400);
  assert(await same(), `${what}: the list changed after it settled, now showing ${await shownTitles(frame)}`);
}

/** Types a search and checks which sessions it leaves. */
async function searchShows(frame, query, expected) {
  await frame.fill('#q', query);
  await expectCards(frame, expected, `searching ${query}`);
}

async function clearSearch(frame) {
  await frame.fill('#q', '');
  await frame.press('#q', 'Escape');
  await waitFor('the search box to be empty', async () => (await frame.$eval('#q', (el) => el.value)) === '');
}

/**
 * Switches every tool's sessions on and returns what puts the source chips back as they were: the window starts on
 * Claude Code (or, when another area's Copilot session is around, on that too), and the next scenario expects it so.
 */
async function showEveryTool(frame) {
  await frame.waitForSelector('#sources:not([hidden])');
  const wasAll = await chipPressed(frame, '*');
  const before = await frame.$$eval('#sources .chip[aria-pressed="true"]', (els) => els.map((e) => e.dataset.source).filter((id) => id !== '*'));
  if (!wasAll) await frame.click(chipSel('*'));
  await waitFor('every source to show', () => chipPressed(frame, '*'));
  return async () => {
    if (!(await chipPressed(frame, '*'))) await frame.click(chipSel('*'));
    if (wasAll) return;
    // From everything on, the first click picks one source, and each next one adds it.
    for (const id of before) await frame.click(chipSel(id));
    await waitFor('the sources to be as they were', async () => !(await chipPressed(frame, '*')));
  };
}

/** Runs `fn` with every tool's sessions showing, then puts the chips and the search box back. */
async function withEveryTool(ctx, fn) {
  const side = await sidebar(ctx);
  const restore = await showEveryTool(side);
  try {
    return await fn(side);
  } finally {
    await clearSearch(side).catch(() => undefined);
    await restore().catch(() => undefined);
  }
}

/** Shows only the "otools" sessions: a search expands every group, so their cards can be clicked. */
async function onlyMine(side) {
  await searchShows(side, 'otools', [COPILOT, VSCHAT]);
}

/** The webview frame of an open transcript of `id`. */
const transcriptOf = (ctx, id, title) => frameWith(ctx.page, `body[data-session*="${id}"] #composer`, `the transcript of ${title}`);

/** Opens the session by clicking its card (the list must be showing it), and returns the transcript's frame. */
async function open(ctx, side, id, title) {
  await side.click(cardSel(id));
  return transcriptOf(ctx, id, title);
}

const tabsWith = (page, text) => page.locator('.tabs-container .tab', { hasText: text });

async function closeTab(page, title) {
  for (let i = 0; i < 5 && (await tabsWith(page, title).count()); i++) {
    const t = tabsWith(page, title).first();
    await t.hover();
    await t.locator('.tab-actions .action-label').first().click();
    await sleep(200);
  }
  await waitFor(`the ${title} tab to close`, async () => (await tabsWith(page, title).count()) === 0, 5_000);
}

/** Right-clicks the session's card and returns the context menu's item titles. */
async function menuTitles(ctx, side, id) {
  await side.click(cardSel(id), { button: 'right' });
  const items = ctx.page.locator('.monaco-menu .action-item .action-label');
  await items.first().waitFor({ state: 'visible', timeout: 10_000 });
  return (await items.allTextContents()).map((t) => t.trim()).filter(Boolean);
}

/** Right-clicks the session's card and picks `label` (exactly) from the context menu. */
async function cardMenu(ctx, side, id, label) {
  await side.click(cardSel(id), { button: 'right' });
  const item = ctx.page.locator('.monaco-menu .action-item', { hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
  await item.waitFor({ state: 'visible', timeout: 10_000 });
  await item.click();
}

const text = async (frame, selector) => frame.$$eval(selector, (els) => els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()));
const toastText = (ctx) => ctx.page.locator('.notifications-toasts .notification-toast').allTextContents().then((t) => t.join('\n'));
const has = async (frame, selector) => (await frame.$(selector)) !== null;

// ---------- the scenarios ----------

const scenarios = [
  {
    name: 'other-tools-sidebar-marking',
    prompt: 'E2E other tools sidebar',
    async run(ctx) {
      await withEveryTool(ctx, async (side) => {
        await onlyMine(side);
        // Each card names its tool, in a tag of its own tool's kind.
        const cli = side.locator(cardSel(COPILOT));
        const chat = side.locator(cardSel(VSCHAT));
        assert((await cli.locator('.tag.source.copilot-cli').textContent()).includes('Copilot CLI'), 'the Copilot CLI card has no tag naming its tool');
        assert((await chat.locator('.tag.source.vscode-chat').textContent()).includes('VS Code Chat'), 'the VS Code Chat card has no tag naming its tool');
        assert((await cli.locator('.title').textContent()).trim() === COPILOT_TITLE, 'the Copilot CLI card does not show its summary as the title');
        assert((await chat.locator('.title').textContent()).trim() === VSCHAT_TITLE, 'the VS Code Chat card does not show its title');
        // What a card knows about each: Copilot CLI has a branch and two prompts; a chat has two prompts and no branch.
        assert((await cli.locator('.tag[title="Git branch"]').textContent()).trim() === 'feature/router', 'the Copilot CLI card does not show its branch');
        assert((await cli.locator('.tag[title$="prompts"]').textContent()).trim() === '2', 'the Copilot CLI card does not count its 2 prompts');
        assert((await chat.locator('.tag[title$="prompts"]').textContent()).trim() === '2', 'the VS Code Chat card does not count its 2 prompts');
        assert((await chat.locator('.tag[title="Git branch"]').count()) === 0, 'the VS Code Chat card shows a branch');
        // The source chips list both tools; a click on one shows just that tool's sessions.
        for (const id of ['copilot-cli', 'vscode-chat']) assert(await has(side, chipSel(id)), `there is no ${id} source chip`);
        await clearSearch(side);
        await side.click(chipSel('vscode-chat'));
        await waitFor('the VS Code Chat chip to show only chats', async () => (await chipPressed(side, 'vscode-chat')) && !(await chipPressed(side, '*')));
        const onlyChats = await side.$$eval('.card .tag.source', (els) => [...new Set(els.map((e) => e.textContent.trim()))]);
        assert(onlyChats.length === 1 && onlyChats[0].includes('VS Code Chat'), `the VS Code Chat chip shows ${onlyChats.join(', ')}`);
        assert((await shownIds(side)).includes(VSCHAT) && !(await shownIds(side)).includes(COPILOT), 'the VS Code Chat chip does not show just chats');
        await side.click(chipSel('*'));
        await waitFor('All to light again', () => chipPressed(side, '*'));
        // Hovering shows the actions each tool has: Resume worded for the tool, and no Claude Code chat.
        await onlyMine(side);
        await cli.hover();
        assert((await cli.locator('[data-action="resume"]').getAttribute('title')).startsWith('Resume this session with the GitHub Copilot CLI'), 'the Copilot CLI card does not offer Resume');
        assert(await cli.locator('[data-action="continueInNewSession"]').isVisible(), 'the Copilot CLI card does not offer Continue');
        await chat.hover();
        assert((await chat.locator('[data-action="resume"]').getAttribute('title')).startsWith('Open this conversation in VS Code Chat'), 'the VS Code Chat card does not offer Open in Chat');
        assert(/new chat/i.test(await chat.locator('[data-action="continueInNewSession"]').getAttribute('title')), 'the VS Code Chat card does not offer a new chat');
        for (const card of [cli, chat]) assert((await card.locator('[data-action="openInClaudeCode"]').count()) === 0, 'a card that is not a Claude Code session offers Open in Claude Code chat');
      });
    },
  },
  {
    name: 'other-tools-menu-offers',
    prompt: 'E2E other tools menu',
    async run(ctx) {
      await withEveryTool(ctx, async (side) => {
        await onlyMine(side);
        const cli = await menuTitles(ctx, side, COPILOT);
        await ctx.page.keyboard.press('Escape');
        const chat = await menuTitles(ctx, side, VSCHAT);
        await ctx.page.keyboard.press('Escape');
        const common = ['Resume Session', 'Continue in New Session', 'Open Transcript', 'Open Raw Log', 'Copy Session ID'];
        for (const want of common) {
          assert(cli.includes(want), `the Copilot CLI menu does not offer ${want} (${cli.join(' | ')})`);
          assert(chat.includes(want), `the VS Code Chat menu does not offer ${want} (${chat.join(' | ')})`);
        }
        // Copilot CLI has a command to resume with; a chat has none. Neither can be renamed here or opened in Claude Code.
        assert(cli.includes('Copy Resume Command'), `the Copilot CLI menu does not offer Copy Resume Command (${cli.join(' | ')})`);
        assert(!chat.includes('Copy Resume Command'), 'the VS Code Chat menu offers Copy Resume Command, though a chat has no command');
        for (const [name, menu] of [['Copilot CLI', cli], ['VS Code Chat', chat]]) {
          for (const not of ['Rename Session…', 'Open in Claude Code Chat']) assert(!menu.includes(not), `the ${name} menu offers ${not}`);
        }
      });
    },
  },
  {
    name: 'other-tools-copilot-transcript',
    prompt: 'E2E other tools copilot transcript',
    async run(ctx) {
      await withEveryTool(ctx, async (side) => {
        await searchShows(side, 'source:copilot otools', [COPILOT]);
        const frame = await open(ctx, side, COPILOT, COPILOT_TITLE);
        try {
          // What the person typed and what Copilot replied, in order.
          await waitFor('the conversation to show', async () => (await frame.$$('.msg')).length >= 4);
          const users = await text(frame, '.msg.user .bubble');
          assert(users.join('|') === [FIRST_PROMPT, SECOND_PROMPT].join('|'), `the prompts read ${JSON.stringify(users)}`);
          const replies = await text(frame, '.msg.assistant .md, .msg.assistant .bubble');
          const all = replies.join(' ');
          for (const want of ['Let me look at the router.', `The guard runs twice because of ${COPILOT_WORD}.`, 'Done, the guard now runs once.']) {
            assert(all.includes(want), `Copilot's replies do not include "${want}": ${JSON.stringify(replies)}`);
          }
          const page = await frame.evaluate(() => document.body.textContent || '');
          for (const hidden of ['injected-context', 'hidden-reasoning-text']) assert(!page.includes(hidden), `the page shows ${hidden}, which is not part of the conversation`);
          assert((await text(frame, '.msg.assistant .msg-meta strong')).every((n) => n === 'Copilot'), 'the replies are not from Copilot');
          // The tool calls: a view, a failing command and an edit, with the failure marked.
          const tools = await text(frame, 'details.tool .tool-name');
          assert(tools.join(',') === 'view,bash,edit', `the tool calls read ${tools.join(',')}`);
          assert((await frame.$$eval('details.tool.failed', (els) => els.length)) === 1, 'the failing command is not the one failed call');
          assert((await text(frame, 'details.tool.failed .tool-name'))[0] === 'bash', 'the failed call is not the command');
          await frame.click('details.tool.failed summary');
          await waitFor('the failed call to open', () => frame.$eval('details.tool.failed', (d) => d.open));
          assert((await text(frame, 'details.tool.failed .tool-body'))[0].includes('exit code 1'), 'the failed call does not show its error');
          // The page is a Copilot CLI session's: its own Resume, and no Claude Code buttons.
          assert((await frame.getAttribute('[data-cmd="resume"]', 'title')).includes('GitHub Copilot CLI'), 'Resume is not for the GitHub Copilot CLI');
          for (const cmd of ['rename', 'openInClaudeCode']) assert(!(await has(frame, `[data-cmd="${cmd}"]`)), `the page offers ${cmd}`);
        } finally {
          await closeTab(ctx.page, COPILOT_TITLE);
        }
      });
    },
  },
  {
    name: 'other-tools-vscode-chat-transcript',
    prompt: 'E2E other tools chat transcript',
    async run(ctx) {
      await withEveryTool(ctx, async (side) => {
        await searchShows(side, 'source:chat otools', [VSCHAT]);
        const frame = await open(ctx, side, VSCHAT, VSCHAT_TITLE);
        try {
          await waitFor('the conversation to show', async () => (await frame.$$('.msg')).length >= 4);
          const users = await text(frame, '.msg.user .bubble');
          assert(users.join('|').includes('Explain the login flow in') && users.some((u) => u.includes('auth.ts')) && users.some((u) => u.includes('Thanks, that covers it')), `the prompts read ${JSON.stringify(users)}`);
          const replies = (await text(frame, '.msg.assistant .md, .msg.assistant .bubble')).join(' ');
          for (const want of ['The login flow starts in', `${VSCHAT_WORD} sends the person on.`, 'It ends at the router.', 'You are welcome.']) {
            assert(replies.includes(want), `the replies do not include "${want}": ${replies}`);
          }
          // The file the reply points at reads as code, in the middle of the sentence.
          assert((await text(frame, '.msg.assistant code')).includes('auth.ts'), 'the file reference is not shown as code');
          const tools = await text(frame, 'details.tool .tool-name');
          assert(tools.length === 1 && /readFile/.test(tools[0]), `the tool calls read ${tools.join(',')}`);
          assert((await text(frame, 'details.tool .tool-hint'))[0].includes('Read auth.ts'), 'the tool call does not show what it read');
          await frame.click('details.tool summary');
          await waitFor('the tool call to open', () => frame.$eval('details.tool', (d) => d.open));
          assert((await text(frame, 'details.tool .tool-body'))[0].includes('export function login() {}'), 'the tool call does not show its output');
          // Open in Chat is this tool's Resume.
          assert((await frame.textContent('[data-cmd="resume"] span')).trim() === 'Open in Chat', 'Resume is not worded Open in Chat');
          assert(/new chat/i.test(await frame.getAttribute('[data-cmd="continueInNewSession"]', 'title')), 'Continue is not a new chat');
          for (const cmd of ['rename', 'openInClaudeCode']) assert(!(await has(frame, `[data-cmd="${cmd}"]`)), `the page offers ${cmd}`);
        } finally {
          await closeTab(ctx.page, VSCHAT_TITLE);
        }
      });
    },
  },
  {
    name: 'other-tools-search',
    prompt: 'E2E other tools search',
    async run(ctx) {
      await withEveryTool(ctx, async (side) => {
        // A word only in a reply finds the conversation, and the card shows where it matched.
        await searchShows(side, COPILOT_WORD, [COPILOT]);
        const found = side.locator(`${cardSel(COPILOT)} .excerpt.transcript-match`);
        await found.waitFor({ timeout: 10_000 });
        assert((await found.locator('mark').textContent()).toLowerCase() === COPILOT_WORD, 'the matching word is not highlighted in the Copilot CLI card');
        await searchShows(side, VSCHAT_WORD, [VSCHAT]);
        const chatFound = side.locator(`${cardSel(VSCHAT)} .excerpt.transcript-match`);
        await chatFound.waitFor({ timeout: 10_000 });
        assert((await chatFound.locator('mark').textContent()).toLowerCase() === VSCHAT_WORD, 'the matching word is not highlighted in the VS Code Chat card');
        // A word in a prompt, the way both tools' prompts are searched, and the source: filter for each tool.
        await searchShows(side, '"bounce the visitor"', [COPILOT]);
        await searchShows(side, 'otools', [COPILOT, VSCHAT]);
        await searchShows(side, 'source:copilot otools', [COPILOT]);
        await searchShows(side, 'source:chat otools', [VSCHAT]);
        await searchShows(side, '-source:chat otools', [COPILOT]);
        // Searched from the transcript's side too: the word is marked in the open conversation.
        await searchShows(side, VSCHAT_WORD, [VSCHAT]);
        const frame = await open(ctx, side, VSCHAT, VSCHAT_TITLE);
        try {
          await waitFor('the match to be marked in the chat', async () => (await text(frame, 'mark.hit')).some((m) => m.toLowerCase() === VSCHAT_WORD), 15_000);
        } finally {
          await closeTab(ctx.page, VSCHAT_TITLE);
        }
      });
    },
  },
  {
    name: 'other-tools-copilot-resume',
    prompt: 'E2E other tools copilot resume',
    async run(ctx) {
      await withEveryTool(ctx, async (side) => {
        await searchShows(side, 'source:copilot otools', [COPILOT]);
        await cardMenu(ctx, side, COPILOT, 'Resume Session');
        // The terminal runs the Copilot command with this session's id and nothing that starts a new session.
        const call = await waitEvent_(ctx, COPILOT, 'terminal-resume');
        assert(JSON.stringify(call.argv) === JSON.stringify(['--resume', COPILOT]), `the terminal ran ${JSON.stringify(call.argv)}, not --resume ${COPILOT}`);
        assert(events(ctx.s, COPILOT).filter((e) => e.event === 'terminal-resume').length === 1, 'Resume ran the command more than once');
      });
    },
  },
  {
    name: 'other-tools-copilot-continue',
    prompt: 'E2E other tools copilot continue',
    async run(ctx) {
      await withEveryTool(ctx, async (side) => {
        await searchShows(side, 'source:copilot otools', [COPILOT]);
        const before = events(ctx.s).filter((e) => e.event === 'terminal-resume').length;
        await cardMenu(ctx, side, COPILOT, 'Continue in New Session');
        const call = await waitFor(
          'the terminal to start a new Copilot session',
          () => events(ctx.s).filter((e) => e.event === 'terminal-resume').slice(before).find((e) => e.argv.includes(`Continued: ${COPILOT_TITLE}`)),
          20_000,
        );
        // A new session (no --resume) named after this one, whose first prompt points at a handoff file.
        const shown = JSON.stringify(call.argv);
        assert(!call.argv.includes('--resume'), `Continue resumed the session instead of starting a new one: ${shown}`);
        const at = call.argv.indexOf('--name');
        assert(at >= 0 && call.argv[at + 1] === `Continued: ${COPILOT_TITLE}`, `the new session is not named after this one: ${shown}`);
        const file = call.argv.map((a) => /handoff in (\S+\.md):/.exec(a)?.[1]).find(Boolean);
        assert(file, `the prompt does not point at a handoff file: ${shown}`);
        const handoff = readFileSync(file, 'utf8');
        for (const want of [FIRST_PROMPT, SECOND_PROMPT]) assert(handoff.includes(want), `the handoff does not carry the prompt "${want}"`);
        assert(call.argv.includes('--add-dir'), 'the new session is not given access to the handoff folder');
      });
    },
  },
  {
    name: 'other-tools-vscode-chat-open',
    prompt: 'E2E other tools chat open',
    async run(ctx) {
      await withEveryTool(ctx, async (side) => {
        await searchShows(side, 'source:chat otools', [VSCHAT]);
        // The hover button: VS Code opens a chat only in the window of its own folder, and this window is not it, so the
        // extension says so and offers the folder and the transcript.
        const card = side.locator(cardSel(VSCHAT));
        await card.hover();
        await card.locator('[data-action="resume"]').click();
        const buttons = ctx.page.locator('.notification-toast .monaco-button');
        await waitFor('the notice that the chat belongs to another folder', async () => /belongs to .*otools-chat/s.test(await toastText(ctx)), 10_000);
        const labels = (await buttons.allTextContents()).map((t) => t.trim());
        assert(labels.includes('Open Folder in New Window') && labels.includes('Read Transcript'), `the notice offers ${labels.join(', ')}`);
        // Read Transcript opens the conversation.
        await ctx.page.locator('.notification-toast .monaco-button', { hasText: 'Read Transcript' }).first().click();
        const frame = await transcriptOf(ctx, VSCHAT, VSCHAT_TITLE);
        try {
          // The transcript's own Open in Chat does the same.
          await frame.click('[data-cmd="resume"]');
          await waitFor('the notice again, from the transcript', async () => /belongs to .*otools-chat/s.test(await toastText(ctx)), 10_000);
          await ctx.page.locator('.notification-toast .monaco-button', { hasText: 'Read Transcript' }).first().click();
          // No terminal was started for it: a chat has no command line.
          await sleep(1_000);
          assert(!events(ctx.s, VSCHAT).length, 'a terminal was started for a VS Code chat');
        } finally {
          await closeTab(ctx.page, VSCHAT_TITLE);
        }
      });
    },
  },
  {
    name: 'other-tools-chat-here-offered',
    prompt: 'E2E other tools chat here',
    async run(ctx) {
      await withEveryTool(ctx, async (side) => {
        await searchShows(side, 'otools', [COPILOT, VSCHAT]);
        const targets = async (frame) => {
          await frame.click('#composer-more');
          await frame.waitForSelector('#composer-menu:not([hidden])');
          const ids = await frame.$$eval('#composer-menu [data-target]', (els) => els.map((e) => e.dataset.target));
          const same = await frame.$eval('#composer-menu [data-mode="same"]', (e) => !e.disabled);
          const checked = await frame.$eval('#composer-menu [data-target][aria-checked="true"]', (e) => e.dataset.target);
          await frame.click('#composer-more');
          return { ids, same, checked };
        };
        // A Copilot CLI session offers Chat here, first and chosen, beside the tools it can be continued in.
        let frame = await open(ctx, side, COPILOT, COPILOT_TITLE);
        try {
          const cli = await targets(frame);
          assert(cli.ids.join() === 'here,copilot-cli,claude,claude-chat,vscode-chat', `a Copilot CLI session offers ${cli.ids.join()}`);
          assert(cli.checked === 'here' && cli.same, 'Chat here is not the default for a Copilot CLI session');
          assert(await has(frame, '#chat-bar'), 'the Copilot CLI transcript has no chat bar to show');
        } finally {
          await closeTab(ctx.page, COPILOT_TITLE);
        }
        // A VS Code Chat session does not: it can reopen in Chat, but cannot take a message from here.
        frame = await open(ctx, side, VSCHAT, VSCHAT_TITLE);
        try {
          const chat = await targets(frame);
          assert(!chat.ids.includes('here'), 'a VS Code Chat session offers Chat here');
          assert(chat.ids[0] === 'vscode-chat' && chat.checked === 'vscode-chat', `a VS Code Chat session offers ${chat.ids.join()}, starting with ${chat.checked}`);
          assert(!chat.same, 'a VS Code Chat session offers to send to the same session, which Chat cannot take');
          assert(!(await has(frame, '#chat-bar')), 'the VS Code Chat transcript has a chat bar');
        } finally {
          await closeTab(ctx.page, VSCHAT_TITLE);
        }
      });
    },
  },
];

function waitEvent_(ctx, id, name) {
  return waitFor(`the stub to record "${name}" for ${id}`, () => events(ctx.s, id).find((e) => e.event === name), 20_000);
}

export default { name: 'other-tools', seed, scenarios };
