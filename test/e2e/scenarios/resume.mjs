// The resume area: what README's "Pick up where you left off" and "Reply from the transcript" describe, plus New Claude
// Code Session. Resume Session, Continue in New Session (with or without a tool, model, effort and agent), the message
// box's Send menu, and New Claude Code Session, each through the entry points that reach it. See docs/dev/e2e.md.
//
// Nothing here runs a real claude. The terminal they open runs the harness's terminal stub, which records its arguments
// and the folder it started in as a `terminal-resume` event; the Claude Code chat is the stand-in extension, which
// records `claude-code-open`. A scenario reads those, so it checks what the CLI would have been given, not just that a
// terminal appeared. The sessions are the harness's default two-record ones (a prompt and "Ready when you are."), one
// per scenario, and `seed` adds two synthetic agents for the pickers' agent step.
//
// Entry points that do not exist: package.json hides Resume Session and the Continue commands from the command
// palette (`when: false`), so the palette reaches this area only through New Claude Code Session and Search Sessions
// (whose rows have a Resume button). Those are the palette scenarios below.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assert, click, events, openTranscript, sidebar, sidebarMenu, transcript, waitFor } from '../harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the synthetic agents the pickers list ----------

/** Writes a project agent (in the sandbox's work folder) and a user agent (in CLAUDE_CONFIG_DIR) the agent step lists. */
function seed(s) {
  const agent = (dir, name, description) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\nYou are a synthetic agent for the end-to-end tests.\n`);
  };
  agent(path.join(s.work, '.claude', 'agents'), 'e2e-reviewer', 'Reviews the demo folder (a synthetic project agent).');
  agent(path.join(s.claudeConfig, 'agents'), 'e2e-planner', 'Plans work (a synthetic user agent).');
}

// ---------- steps ----------

/** The position in the events file now, so a scenario sees only what its own action recorded. */
function mark(ctx) {
  const all = events(ctx.s);
  return all.length ? all[all.length - 1].i + 1 : 0;
}

/** The terminal stub's record of the run an action started (the arguments one by one, and the folder). */
function terminalSince(ctx, since, timeout = 20_000) {
  return waitFor('the terminal stub to be run', () => events(ctx.s).find((e) => e.event === 'terminal-resume' && e.i >= since), timeout);
}

/** The Claude Code chat stand-in's record of being asked to open. */
function chatSince(ctx, since, timeout = 20_000) {
  return waitFor('the Claude Code chat to be asked to open', () => events(ctx.s).find((e) => e.event === 'claude-code-open' && e.i >= since), timeout);
}

/** Nothing was opened (no terminal, no Claude Code chat) since `since`: waits long enough for one to have shown up. */
async function nothingOpened(ctx, since, what) {
  await sleep(2_000);
  const opened = events(ctx.s).filter((e) => (e.event === 'terminal-resume' || e.event === 'claude-code-open') && e.i >= since);
  assert(!opened.length, `${what} opened something anyway: ${JSON.stringify(opened)}`);
}

const realFolder = (p) => {
  const r = realpathSync.native(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** The terminal started in the sandbox's work folder, which is the folder every synthetic session was started in. */
function assertInWorkFolder(ctx, ev) {
  assert(realFolder(ev.cwd) === realFolder(ctx.s.work), `the terminal started in ${ev.cwd}, not in ${ctx.s.work}`);
}

/** What a Continue puts after its option flags: `--name "Continued: <title>"` and the handoff as one argument. */
function assertHandoff(ctx, handoff) {
  assert(typeof handoff === 'string' && handoff.startsWith("I'm continuing work from an earlier Claude Code session"), `not a handoff: ${String(handoff).slice(0, 120)}`);
  assert(handoff.includes(`"${ctx.title}"`), 'the handoff does not name the session');
  assert(handoff.includes('Ready when you are.'), "the handoff does not carry the session's last reply");
}

function assertContinued(ctx, ev, flags) {
  const { argv } = ev;
  assert(JSON.stringify(argv.slice(0, flags.length)) === JSON.stringify(flags), `expected the arguments to start with ${JSON.stringify(flags)}, got ${JSON.stringify(argv.slice(0, flags.length + 2))}`);
  assert(argv.length === flags.length + 3, `expected ${flags.length + 3} arguments, got ${argv.length}: ${JSON.stringify(argv.map((a) => a.slice(0, 40)))}`);
  assert(argv[flags.length] === '--name' && argv[flags.length + 1] === `Continued: ${ctx.title}`, `the session is not named "Continued: ${ctx.title}": ${JSON.stringify(argv.slice(flags.length, flags.length + 2))}`);
  assertHandoff(ctx, argv[flags.length + 2]);
  assertInWorkFolder(ctx, ev);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The quick picks and input boxes the pickers are drawn in, in the workbench page.

const widget = (ctx) => ctx.page.locator('.quick-input-widget');

/**
 * Waits for the picker (`kind` 'list') or input box (`kind` 'input') whose title contains `title`. The two look alike
 * while one replaces the other, so an input box is told by its list being hidden.
 */
async function atStep(ctx, title, kind) {
  await waitFor(
    `the ${kind === 'input' ? 'input box' : 'picker'} "${title}"`,
    async () => {
      const w = widget(ctx);
      if (!(await w.isVisible()) || !((await w.locator('.quick-input-title').first().innerText()) || '').includes(title)) return false;
      const list = await w.locator('.quick-input-list').isVisible();
      return kind === 'input' ? !list : kind === 'list' ? list : true;
    },
    15_000,
    200,
  );
}

/** The labels of the rows the open picker lists. */
async function rowLabels(ctx) {
  return (await ctx.page.locator('.quick-input-list .monaco-list-row .label-name').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
}

const exact = (label) => new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);

/** In the picker titled `title`, clicks the row whose label is exactly `label`. */
async function choose(ctx, title, label) {
  await atStep(ctx, title, 'list');
  const row = ctx.page
    .locator('.quick-input-list .monaco-list-row')
    .filter({ has: ctx.page.locator('.label-name', { hasText: exact(label) }) })
    .first();
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  await row.click();
}

/** In the input box titled `title`, types `text` and presses Enter. */
async function typeIn(ctx, title, text) {
  await atStep(ctx, title, 'input');
  await widget(ctx).locator('.quick-input-box input').fill(text);
  await ctx.page.keyboard.press('Enter');
}

/** Cancels the open picker or input box with Escape and waits for it to close. */
async function cancelStep(ctx) {
  await ctx.page.keyboard.press('Escape');
  await waitFor('the picker to close', async () => !(await widget(ctx).isVisible()), 10_000, 150);
}

/** Opens the command palette, types the command's title (without a trailing …) and clicks the row with its exact title. */
async function palette(ctx, title) {
  await ctx.page.keyboard.press('F1');
  await widget(ctx).waitFor({ state: 'visible', timeout: 10_000 });
  await ctx.page.keyboard.type(title.replace(/…$/, ''));
  // The first row is not always the command (Search Sessions… ranks below Search Sessions for This File).
  const row = ctx.page.locator('.quick-input-list .monaco-list-row').filter({ has: ctx.page.locator('.label-name', { hasText: exact(title) }) }).first();
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  await row.click();
}

/**
 * Hovers the session's card and clicks one of its quick-action buttons, which show only while the card is hovered. With
 * a long list the sidebar can redraw between the hover and the click, so the pair is retried.
 */
async function cardButton(ctx, action) {
  const card = `.card[data-id$=":${ctx.id}"]`;
  await waitFor(
    `the ${action} button on the card of ${ctx.title}`,
    async () => {
      const side = await sidebar(ctx);
      // Centred, because a card scrolled to the very top of a long list sits under the sticky group header.
      await side.$eval(card, (el) => el.scrollIntoView({ block: 'center' }));
      await side.hover(card, { timeout: 3_000 });
      await side.click(`${card} [data-action="${action}"]`, { timeout: 3_000 });
      return true;
    },
    25_000,
    300,
  );
}

/** The sidebar's + (New Claude Code Session…) in its title bar. */
async function sidebarPlus(ctx) {
  await sidebar(ctx);
  await ctx.page.locator('.part.sidebar .action-label[aria-label^="New Claude Code Session"]').first().click();
}

/** The session's transcript tab. A terminal the session was resumed in has a tab with the title in it too, so not that. */
const transcriptTab = (ctx) => ctx.page.locator('.tabs-container .tab', { hasText: ctx.title }).filter({ hasNotText: 'Claude Code' });

/** Changes one user setting in the sandbox's settings.json (VS Code picks it up from disk). */
async function setSetting(ctx, key, value) {
  const file = path.join(ctx.s.userData, 'User', 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  settings[key] = value;
  writeFileSync(file, JSON.stringify(settings, null, 2));
  await sleep(1_500);
}

/** Types `text` in the message box and picks a route in its ⌄ menu: a target, and optionally "same" or "handoff". */
async function routeTo(frame, text, target, mode) {
  await frame.fill('#composer-input', text);
  await menuItem(frame, `[data-target="${target}"]`);
  if (mode) await menuItem(frame, `[data-mode="${mode}"]`);
}

/**
 * Clicks an item of the message box's ⌄ menu, opening the menu first when it is closed. Choosing a target or a mode
 * redraws the menu, and the page then closes it (the clicked button is no longer in it), so each item needs this.
 */
async function menuItem(frame, selector) {
  if (await frame.$eval('#composer-menu', (m) => m.hidden)) await frame.click('#composer-more');
  await frame.click(`#composer-menu ${selector}`);
}

/** A modest check that the picker offered what the user is promised. */
function assertRows(rows, wanted, what) {
  for (const w of wanted) assert(rows.some((r) => exact(w).test(r)), `${what} lacks "${w}": ${JSON.stringify(rows)}`);
}

const CONTINUE_TITLE = 'Continue in New Session';
const NEW_TITLE = 'New Claude Code Session';

/** Steps through a Continue's pickers for a Claude Code CLI session: tool, model, effort, agent. */
async function continuePickers(ctx, { model, effort, agent }) {
  await choose(ctx, `${CONTINUE_TITLE}: tool`, 'Claude Code CLI');
  await choose(ctx, `${CONTINUE_TITLE} (1/3): model`, model);
  await choose(ctx, `${CONTINUE_TITLE} (2/3): effort`, effort);
  await choose(ctx, `${CONTINUE_TITLE} (3/3): agent`, agent);
}

export default {
  name: 'resume',
  seed,
  scenarios: [
    // ---------- Resume Session ----------
    {
      name: 'resume-sidebar-menu',
      prompt: 'E2E resume from the sidebar menu',
      async run(ctx) {
        const since = mark(ctx);
        await sidebarMenu(ctx, 'Resume Session');
        const ev = await terminalSince(ctx, since);
        assert(same(ev.argv, ['--resume', ctx.id]), `the terminal ran ${JSON.stringify(ev.argv)}`);
        assertInWorkFolder(ctx, ev);
      },
    },
    {
      name: 'resume-sidebar-card-button',
      prompt: 'E2E resume from the card button',
      async run(ctx) {
        const since = mark(ctx);
        await cardButton(ctx, 'resume');
        const ev = await terminalSince(ctx, since);
        assert(same(ev.argv, ['--resume', ctx.id]), `the terminal ran ${JSON.stringify(ev.argv)}`);
        assertInWorkFolder(ctx, ev);
      },
    },
    {
      name: 'resume-sidebar-ctrl-enter',
      prompt: 'E2E resume with Ctrl+Enter',
      async run(ctx) {
        const side = await sidebar(ctx);
        const since = mark(ctx);
        await side.focus(`.card[data-id$=":${ctx.id}"]`);
        await ctx.page.keyboard.press('Control+Enter');
        const ev = await terminalSince(ctx, since);
        assert(same(ev.argv, ['--resume', ctx.id]), `the terminal ran ${JSON.stringify(ev.argv)}`);
        assertInWorkFolder(ctx, ev);
      },
    },
    {
      name: 'resume-topbar',
      prompt: 'E2E resume from the transcript top bar',
      async run(ctx) {
        await openTranscript(ctx);
        const since = mark(ctx);
        await click(ctx, '[data-cmd="resume"]');
        const ev = await terminalSince(ctx, since);
        assert(same(ev.argv, ['--resume', ctx.id]), `the terminal ran ${JSON.stringify(ev.argv)}`);
        assertInWorkFolder(ctx, ev);
        // closeTranscriptOnResume is off in the sandbox, so the tab is still there.
        assert((await transcriptTab(ctx).count()) > 0, 'the transcript tab closed although closeTranscriptOnResume is off');
      },
    },
    {
      name: 'resume-search-quick-pick',
      prompt: 'E2E resume from the search picker',
      async run(ctx) {
        const since = mark(ctx);
        await palette(ctx, 'SessionsAI: Search Sessions…');
        await waitFor('the session search picker', async () => ((await widget(ctx).locator('.quick-input-box input').getAttribute('placeholder')) || '').startsWith('Search sessions and transcripts'), 10_000, 150);
        await ctx.page.keyboard.type(ctx.title);
        const row = ctx.page.locator('.quick-input-list .monaco-list-row').filter({ has: ctx.page.locator('.label-name', { hasText: exact(ctx.title) }) }).first();
        await row.waitFor({ state: 'visible', timeout: 10_000 });
        await row.hover();
        await row.locator('.action-label').first().click();
        const ev = await terminalSince(ctx, since);
        assert(same(ev.argv, ['--resume', ctx.id]), `the terminal ran ${JSON.stringify(ev.argv)}`);
      },
    },
    {
      name: 'resume-closes-transcript-setting',
      prompt: 'E2E resume closes the transcript',
      async run(ctx) {
        await openTranscript(ctx);
        assert((await transcriptTab(ctx).count()) > 0, 'the transcript did not open in a tab');
        await setSetting(ctx, 'claudeSessions.closeTranscriptOnResume', true);
        try {
          const since = mark(ctx);
          await click(ctx, '[data-cmd="resume"]');
          await terminalSince(ctx, since);
          await waitFor('the transcript tab to close', async () => (await transcriptTab(ctx).count()) === 0, 10_000);
        } finally {
          await setSetting(ctx, 'claudeSessions.closeTranscriptOnResume', false);
        }
      },
    },

    // ---------- Continue in New Session ----------
    {
      name: 'continue-sidebar-menu',
      prompt: 'E2E continue from the sidebar menu',
      async run(ctx) {
        const since = mark(ctx);
        await sidebarMenu(ctx, 'Continue in New Session');
        assertContinued(ctx, await terminalSince(ctx, since), []);
      },
    },
    {
      name: 'continue-card-button',
      prompt: 'E2E continue from the card button',
      async run(ctx) {
        const since = mark(ctx);
        await cardButton(ctx, 'continueInNewSession');
        assertContinued(ctx, await terminalSince(ctx, since), []);
      },
    },
    {
      name: 'continue-topbar',
      prompt: 'E2E continue from the transcript top bar',
      async run(ctx) {
        await openTranscript(ctx);
        const since = mark(ctx);
        await click(ctx, '[data-cmd="continueInNewSession"]');
        assertContinued(ctx, await terminalSince(ctx, since), []);
      },
    },

    // ---------- Continue in New Session with Tool or Model… ----------
    {
      name: 'continue-with-model-sidebar-menu',
      prompt: 'E2E continue with a model from the sidebar menu',
      async run(ctx) {
        const since = mark(ctx);
        await sidebarMenu(ctx, 'Continue in New Session with Tool or Model');
        await atStep(ctx, `${CONTINUE_TITLE}: tool`);
        assertRows(await rowLabels(ctx), ['Claude Code CLI', 'Claude Code Chat', 'GitHub Copilot CLI', 'VS Code Chat'], 'the tool picker');
        await choose(ctx, `${CONTINUE_TITLE}: tool`, 'Claude Code CLI');
        await atStep(ctx, `${CONTINUE_TITLE} (1/3): model`);
        assertRows(await rowLabels(ctx), ['Default', 'Opus', 'Sonnet', 'Haiku', 'Fable', 'claude-stand-in', 'Other model…'], 'the model picker');
        await choose(ctx, `${CONTINUE_TITLE} (1/3): model`, 'Opus');
        await atStep(ctx, `${CONTINUE_TITLE} (2/3): effort`);
        assertRows(await rowLabels(ctx), ['Default', 'low', 'medium', 'high', 'xhigh', 'max'], 'the effort picker');
        await choose(ctx, `${CONTINUE_TITLE} (2/3): effort`, 'high');
        await atStep(ctx, `${CONTINUE_TITLE} (3/3): agent`);
        assertRows(await rowLabels(ctx), ['Default (no agent)', 'e2e-reviewer', 'e2e-planner', 'Enter an agent name…'], 'the agent picker');
        await choose(ctx, `${CONTINUE_TITLE} (3/3): agent`, 'e2e-reviewer');
        assertContinued(ctx, await terminalSince(ctx, since), ['--model', 'opus', '--effort', 'high', '--agent', 'e2e-reviewer']);
      },
    },
    {
      name: 'continue-with-model-topbar-chevron',
      prompt: 'E2E continue with a typed model and agent from the top bar',
      async run(ctx) {
        await openTranscript(ctx);
        const since = mark(ctx);
        await click(ctx, '[data-cmd="continueInNewSessionWithModel"]');
        await choose(ctx, `${CONTINUE_TITLE}: tool`, 'Claude Code CLI');
        await choose(ctx, `${CONTINUE_TITLE} (1/3): model`, 'Other model…');
        await typeIn(ctx, CONTINUE_TITLE, 'claude-e2e-model');
        await choose(ctx, `${CONTINUE_TITLE} (2/3): effort`, 'Default');
        await choose(ctx, `${CONTINUE_TITLE} (3/3): agent`, 'Enter an agent name…');
        // An empty name goes back to the list, rather than starting without an agent.
        await typeIn(ctx, `${CONTINUE_TITLE} (3/3): agent`, '');
        await choose(ctx, `${CONTINUE_TITLE} (3/3): agent`, 'Enter an agent name…');
        await typeIn(ctx, `${CONTINUE_TITLE} (3/3): agent`, 'typed-agent');
        // The effort was left on Default, so there is no --effort.
        assertContinued(ctx, await terminalSince(ctx, since), ['--model', 'claude-e2e-model', '--agent', 'typed-agent']);
      },
    },
    {
      name: 'continue-with-model-defaults',
      prompt: 'E2E continue with every default',
      async run(ctx) {
        const since = mark(ctx);
        await sidebarMenu(ctx, 'Continue in New Session with Tool or Model');
        await continuePickers(ctx, { model: 'Default', effort: 'Default', agent: 'Default (no agent)' });
        // Defaults leave the options out, so the CLI uses whatever the user's own settings say.
        assertContinued(ctx, await terminalSince(ctx, since), []);
      },
    },
    {
      name: 'continue-with-model-cancel',
      prompt: 'E2E cancel a continue at every step',
      async run(ctx) {
        const since = mark(ctx);
        const menu = () => sidebarMenu(ctx, 'Continue in New Session with Tool or Model');
        await menu();
        await atStep(ctx, `${CONTINUE_TITLE}: tool`);
        await cancelStep(ctx);
        await menu();
        await choose(ctx, `${CONTINUE_TITLE}: tool`, 'Claude Code CLI');
        await atStep(ctx, `${CONTINUE_TITLE} (1/3): model`);
        await cancelStep(ctx);
        await menu();
        await choose(ctx, `${CONTINUE_TITLE}: tool`, 'Claude Code CLI');
        await choose(ctx, `${CONTINUE_TITLE} (1/3): model`, 'Sonnet');
        await atStep(ctx, `${CONTINUE_TITLE} (2/3): effort`);
        await cancelStep(ctx);
        await menu();
        await choose(ctx, `${CONTINUE_TITLE}: tool`, 'Claude Code CLI');
        await choose(ctx, `${CONTINUE_TITLE} (1/3): model`, 'Sonnet');
        await choose(ctx, `${CONTINUE_TITLE} (2/3): effort`, 'low');
        await atStep(ctx, `${CONTINUE_TITLE} (3/3): agent`);
        await cancelStep(ctx);
        await menu();
        await choose(ctx, `${CONTINUE_TITLE}: tool`, 'Claude Code CLI');
        await choose(ctx, `${CONTINUE_TITLE} (1/3): model`, 'Other model…');
        await atStep(ctx, CONTINUE_TITLE, 'input');
        await cancelStep(ctx);
        await nothingOpened(ctx, since, 'a cancelled Continue');
      },
    },
    {
      name: 'continue-with-model-other-tools',
      prompt: 'E2E continue in another tool',
      async run(ctx) {
        // The Claude Code chat takes the handoff in its input box and has no model, effort or agent step.
        let since = mark(ctx);
        await sidebarMenu(ctx, 'Continue in New Session with Tool or Model');
        await choose(ctx, `${CONTINUE_TITLE}: tool`, 'Claude Code Chat');
        const opened = await chatSince(ctx, since);
        assert(opened.session === null, `the chat was told to open session ${opened.session}, not a new one`);
        assertHandoff(ctx, opened.prompt);
        await sleep(500);
        assert(!(await widget(ctx).isVisible()), 'a picker is still open after choosing the chat');
        // GitHub Copilot CLI: model and effort (two steps, no agent), then a handoff file its prompt points at.
        since = mark(ctx);
        await sidebarMenu(ctx, 'Continue in New Session with Tool or Model');
        await choose(ctx, `${CONTINUE_TITLE}: tool`, 'GitHub Copilot CLI');
        await atStep(ctx, `${CONTINUE_TITLE} (1/2): model`);
        const models = await rowLabels(ctx);
        assert(!models.includes('Opus'), `Copilot CLI's model picker offers Claude aliases: ${JSON.stringify(models)}`);
        await choose(ctx, `${CONTINUE_TITLE} (1/2): model`, 'Other model…');
        await typeIn(ctx, CONTINUE_TITLE, 'gpt-e2e');
        await choose(ctx, `${CONTINUE_TITLE} (2/2): effort`, 'high');
        const ev = await terminalSince(ctx, since);
        const { argv } = ev;
        assert(argv[argv.indexOf('--model') + 1] === 'gpt-e2e', `no --model gpt-e2e: ${JSON.stringify(argv)}`);
        assert(argv[argv.indexOf('--reasoning-effort') + 1] === 'high', `no --reasoning-effort high: ${JSON.stringify(argv)}`);
        assert(argv.includes('--add-dir') && argv.includes('--name') && argv.includes('-i'), `missing --add-dir, --name or -i: ${JSON.stringify(argv)}`);
        assert(argv[argv.indexOf('--name') + 1] === `Continued: ${ctx.title}`, `the session is not named Continued: ${JSON.stringify(argv)}`);
        const file = /Read the handoff in (.+\.md): it describes/.exec(argv[argv.indexOf('-i') + 1])?.[1];
        assert(file, `the prompt does not point at a handoff file: ${argv[argv.indexOf('-i') + 1]}`);
        assertHandoff(ctx, readFileSync(file, 'utf8'));
        assertInWorkFolder(ctx, ev);
      },
    },

    // ---------- the transcript's Send menu ----------
    {
      name: 'send-to-cli-resumes-session',
      prompt: 'E2E send to the CLI in the same session',
      async run(ctx) {
        const frame = await openTranscript(ctx);
        const text = 'Carry on with the next step.';
        const since = mark(ctx);
        await routeTo(frame, text, 'claude');
        await frame.click('#composer-send');
        const ev = await terminalSince(ctx, since);
        assert(same(ev.argv, ['--resume', ctx.id, text]), `the terminal ran ${JSON.stringify(ev.argv)}`);
        assertInWorkFolder(ctx, ev);
        await waitFor('the message box to empty', async () => (await (await transcript(ctx)).inputValue('#composer-input')) === '', 10_000);
      },
    },
    {
      name: 'send-to-cli-with-handoff',
      prompt: 'E2E send to the CLI in a new session',
      async run(ctx) {
        const frame = await openTranscript(ctx);
        const text = 'Start over from where this left off, and add tests.';
        const since = mark(ctx);
        await routeTo(frame, text, 'claude', 'handoff');
        await frame.press('#composer-input', 'Enter');
        const ev = await terminalSince(ctx, since);
        assertContinued(ctx, ev, []);
        // The message is the request at the end of the handoff.
        assert(ev.argv[2].trimEnd().endsWith(text), `the handoff does not end with the message: ...${ev.argv[2].slice(-120)}`);
      },
    },
    {
      name: 'send-with-model-and-effort',
      prompt: 'E2E send with a model and effort',
      async run(ctx) {
        const frame = await openTranscript(ctx);
        const text = 'Use a smaller model for this.';
        const since = mark(ctx);
        await routeTo(frame, text, 'claude');
        await menuItem(frame, '[data-pick-model]');
        // Resuming the same session: two steps, and no agent (Claude Code ignores --agent on --resume).
        await choose(ctx, 'Send (1/2): model', 'Haiku');
        await choose(ctx, 'Send (2/2): effort', 'max');
        const ev = await terminalSince(ctx, since);
        assert(same(ev.argv, ['--resume', ctx.id, '--model', 'haiku', '--effort', 'max', text]), `the terminal ran ${JSON.stringify(ev.argv)}`);
      },
    },
    {
      name: 'send-with-model-effort-and-agent',
      prompt: 'E2E send a handoff with a model, effort and agent',
      async run(ctx) {
        const frame = await openTranscript(ctx);
        const text = 'Review what changed.';
        const since = mark(ctx);
        await routeTo(frame, text, 'claude', 'handoff');
        await menuItem(frame, '[data-pick-model]');
        // A new session also asks for an agent.
        await choose(ctx, 'Send (1/3): model', 'Sonnet');
        await choose(ctx, 'Send (2/3): effort', 'low');
        await choose(ctx, 'Send (3/3): agent', 'e2e-planner');
        const ev = await terminalSince(ctx, since);
        assertContinued(ctx, ev, ['--model', 'sonnet', '--effort', 'low', '--agent', 'e2e-planner']);
        assert(ev.argv[ev.argv.length - 1].trimEnd().endsWith(text), 'the handoff does not end with the message');
      },
    },
    {
      name: 'send-with-model-cancel',
      prompt: 'E2E cancel a send with a model',
      async run(ctx) {
        const frame = await openTranscript(ctx);
        const text = 'Never mind this one.';
        const since = mark(ctx);
        await routeTo(frame, text, 'claude');
        await menuItem(frame, '[data-pick-model]');
        await atStep(ctx, 'Send (1/2): model');
        await cancelStep(ctx);
        await menuItem(frame, '[data-pick-model]');
        await choose(ctx, 'Send (1/2): model', 'Opus');
        await atStep(ctx, 'Send (2/2): effort');
        await cancelStep(ctx);
        await nothingOpened(ctx, since, 'a cancelled Send');
        // Cancelled, so the message is still in the box to send again.
        const kept = await (await transcript(ctx)).inputValue('#composer-input');
        assert(kept === text, `the message box holds "${kept}"`);
      },
    },
    {
      name: 'send-to-claude-code-chat',
      prompt: 'E2E send to the Claude Code chat',
      async run(ctx) {
        const frame = await openTranscript(ctx);
        // Into this session: the chat opens it, with the message in its input box.
        let text = 'Pick this up in the chat.';
        let since = mark(ctx);
        await routeTo(frame, text, 'claude-chat');
        await frame.click('#composer-send');
        let opened = await chatSince(ctx, since);
        assert(opened.session === ctx.id && opened.prompt === text, `the chat was asked for ${JSON.stringify(opened)}`);
        await waitFor('the message box to empty', async () => (await (await transcript(ctx)).inputValue('#composer-input')) === '', 10_000);
        // As a handoff: a new chat, with the handoff ending in the message.
        text = 'And a fresh chat for the follow-up.';
        since = mark(ctx);
        await routeTo(await transcript(ctx), text, 'claude-chat', 'handoff');
        await (await transcript(ctx)).click('#composer-send');
        opened = await chatSince(ctx, since);
        assert(opened.session === null, `the chat was told to open session ${opened.session}`);
        assertHandoff(ctx, opened.prompt);
        assert(opened.prompt.trimEnd().endsWith(text), 'the handoff does not end with the message');
        await waitFor('the message box to empty', async () => (await (await transcript(ctx)).inputValue('#composer-input')) === '', 10_000);
        // Leave the box pointing at the CLI, which is the default again, so later transcripts start where they did.
        text = 'Back to the terminal.';
        since = mark(ctx);
        // The handoff mode chosen above sticks while the target can resume, so ask for this session explicitly.
        await routeTo(await transcript(ctx), text, 'claude', 'same');
        await (await transcript(ctx)).click('#composer-send');
        const ev = await terminalSince(ctx, since);
        assert(same(ev.argv, ['--resume', ctx.id, text]), `the terminal ran ${JSON.stringify(ev.argv)}`);
      },
    },

    // ---------- New Claude Code Session… ----------
    {
      name: 'new-session-palette',
      prompt: 'E2E new session from the palette',
      async run(ctx) {
        const since = mark(ctx);
        await palette(ctx, 'SessionsAI: New Claude Code Session…');
        await atStep(ctx, `${NEW_TITLE}: folder`);
        assertRows(await rowLabels(ctx), ['demo', 'Choose a folder…'], 'the folder picker');
        await choose(ctx, `${NEW_TITLE}: folder`, 'demo');
        await atStep(ctx, `${NEW_TITLE} (1/3): model`);
        assertRows(await rowLabels(ctx), ['Default', 'Opus', 'Sonnet', 'Haiku', 'Fable', 'Other model…'], 'the model picker');
        assert(!(await rowLabels(ctx)).includes('claude-stand-in'), 'a blank session was offered a session model');
        await choose(ctx, `${NEW_TITLE} (1/3): model`, 'Sonnet');
        await choose(ctx, `${NEW_TITLE} (2/3): effort`, 'medium');
        await atStep(ctx, `${NEW_TITLE} (3/3): agent`);
        assertRows(await rowLabels(ctx), ['Default (no agent)', 'e2e-reviewer', 'e2e-planner', 'Enter an agent name…'], 'the agent picker');
        await choose(ctx, `${NEW_TITLE} (3/3): agent`, 'e2e-planner');
        const ev = await terminalSince(ctx, since);
        // A blank session: the options and nothing else, so no prompt and no name.
        assert(same(ev.argv, ['--model', 'sonnet', '--effort', 'medium', '--agent', 'e2e-planner']), `the terminal ran ${JSON.stringify(ev.argv)}`);
        assertInWorkFolder(ctx, ev);
      },
    },
    {
      name: 'new-session-sidebar-plus',
      prompt: 'E2E new session from the sidebar plus',
      async run(ctx) {
        const since = mark(ctx);
        await sidebarPlus(ctx);
        await choose(ctx, `${NEW_TITLE}: folder`, 'demo');
        await choose(ctx, `${NEW_TITLE} (1/3): model`, 'Default');
        await choose(ctx, `${NEW_TITLE} (2/3): effort`, 'Default');
        await choose(ctx, `${NEW_TITLE} (3/3): agent`, 'Default (no agent)');
        const ev = await terminalSince(ctx, since);
        // Every default leaves its flag out, so the CLI starts exactly as `claude` would by hand.
        assert(same(ev.argv, []), `the terminal ran ${JSON.stringify(ev.argv)}`);
        assertInWorkFolder(ctx, ev);
      },
    },
    {
      name: 'new-session-cancel',
      prompt: 'E2E cancel a new session at every step',
      async run(ctx) {
        const since = mark(ctx);
        await sidebarPlus(ctx);
        await atStep(ctx, `${NEW_TITLE}: folder`);
        await cancelStep(ctx);
        await sidebarPlus(ctx);
        await choose(ctx, `${NEW_TITLE}: folder`, 'demo');
        await atStep(ctx, `${NEW_TITLE} (1/3): model`);
        await cancelStep(ctx);
        await sidebarPlus(ctx);
        await choose(ctx, `${NEW_TITLE}: folder`, 'demo');
        await choose(ctx, `${NEW_TITLE} (1/3): model`, 'Opus');
        await atStep(ctx, `${NEW_TITLE} (2/3): effort`);
        await cancelStep(ctx);
        await sidebarPlus(ctx);
        await choose(ctx, `${NEW_TITLE}: folder`, 'demo');
        await choose(ctx, `${NEW_TITLE} (1/3): model`, 'Opus');
        await choose(ctx, `${NEW_TITLE} (2/3): effort`, 'high');
        await atStep(ctx, `${NEW_TITLE} (3/3): agent`);
        await cancelStep(ctx);
        await nothingOpened(ctx, since, 'a cancelled New Claude Code Session');
      },
    },
  ],
};
