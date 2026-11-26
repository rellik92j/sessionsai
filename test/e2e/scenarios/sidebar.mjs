// The sidebar area: what README's "Browse every session in one place" and "Search everything you and Claude said"
// describe. The session list and its grouping, the Workspace and source filters, what a card shows, the search syntax,
// and which tab a click, a double-click or Keep open opens. See docs/dev/e2e.md for how to add a scenario.
//
// The sessions are synthetic, in real record shapes, and written by `seed` into the sandbox before VS Code starts:
// four Claude Code sessions in two projects, at different ages, and one Copilot CLI session. The scenarios find them by
// id and ignore every other card, so they hold whichever other areas run beside them. Each scenario puts back what it
// changed (grouping, filters, search box, tabs) so the next one, in this area or another, starts from the same place.

import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assert, frameWith, projectDirName, sidebar, transcript, waitFor } from '../harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

// ---------- the synthetic sessions ----------

const sid = (n) => `e2e51de0-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUTH = sid(1); // alpha-api, minutes ago: edits, a skill, a commit, a pull request, an agent, a cost, two prompts
const FLAKY = sid(2); // alpha-api, minutes ago: edits
const ORDERS = sid(3); // beta-web, three days ago: conversation only
const OLD = sid(4); // beta-web, forty days ago: conversation only
const COPILOT = sid(5); // beta-web, two days ago: a Copilot CLI session
const CLAUDE_SEEDS = [AUTH, FLAKY, ORDERS, OLD];
const ALL_SEEDS = [...CLAUDE_SEEDS, COPILOT];

const AGES = { [AUTH]: 10 * MIN, [FLAKY]: 20 * MIN, [ORDERS]: 3 * DAY, [OLD]: 40 * DAY, [COPILOT]: 2 * DAY };
// Taken once, when the module loads, so what the seeds wrote and what the scenarios expect agree.
const NOW = Date.now();
const timeOf = (id) => NOW - AGES[id];

/** The date group the sidebar puts a time in (format.ts's dateBucket, written out so a scenario does not borrow it). */
function bucketOf(time) {
  const d = new Date(NOW);
  d.setHours(0, 0, 0, 0);
  const today = d.getTime();
  if (time >= today) return 'Today';
  if (time >= today - DAY) return 'Yesterday';
  if (time >= today - 7 * DAY) return 'Previous 7 Days';
  if (time >= today - 30 * DAY) return 'Previous 30 Days';
  return 'Older';
}

const TITLES = {
  [AUTH]: 'Sidebar auth bug in the login redirect',
  [FLAKY]: 'Sidebar flaky tests in the redis cache',
  [ORDERS]: 'Sidebar postgres migration for the orders table',
  [OLD]: 'Sidebar redis session store',
  [COPILOT]: 'Sidebar copilot router fix',
};

/** A Claude Code log: `steps` are { user }, { assistant: [blocks], usage? } or { results: [[toolUseId, text]] }. */
function claudeLog(id, cwd, branch, steps, extra = []) {
  const common = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: id, version: '2.1.332', gitBranch: branch };
  const records = [...extra];
  let parent = null;
  let t = timeOf(id) - steps.length * 1000;
  steps.forEach((step, i) => {
    const uuid = `${id.slice(0, 8)}-0000-4000-8000-${String(100 + i).padStart(12, '0')}`;
    const timestamp = new Date((t += 1000)).toISOString();
    if (step.assistant) {
      records.push({
        parentUuid: parent,
        ...common,
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          id: `msg_${id.slice(-4)}_${i}`,
          type: 'message',
          role: 'assistant',
          content: step.assistant,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: step.usage ?? { input_tokens: 1, output_tokens: 1 },
        },
        uuid,
        timestamp,
      });
    } else {
      const content = step.results
        ? step.results.map(([toolUseId, text]) => ({ type: 'tool_result', tool_use_id: toolUseId, content: text }))
        : step.user;
      records.push({ parentUuid: parent, ...common, type: 'user', message: { role: 'user', content }, uuid, timestamp });
    }
    parent = uuid;
  });
  return records;
}

const text = (t) => ({ type: 'text', text: t });
const tool = (toolId, name, input) => ({ type: 'tool_use', id: toolId, name, input });

function writeClaude(s, id, cwd, records) {
  const dir = path.join(s.claudeConfig, 'projects', projectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  utimesSync(file, new Date(timeOf(id)), new Date(timeOf(id)));
}

/** Writes the seeded sessions into the sandbox. Run by the runner once, before VS Code starts. */
function seed(s) {
  const alpha = path.join(s.dir, 'work', 'alpha-api');
  const beta = path.join(s.dir, 'work', 'beta-web');

  writeClaude(
    s,
    AUTH,
    alpha,
    claudeLog(
      AUTH,
      alpha,
      'feat/login',
      [
        { user: TITLES[AUTH] },
        // 90 000 input and 10 000 output tokens of claude-sonnet-4-5 ($3 and $15 per million): $0.42.
        {
          assistant: [text('The race condition is in the token refresh.'), tool('toolu_a1', 'Edit', { file_path: path.join(alpha, 'src', 'auth.ts'), old_string: 'a', new_string: 'b' })],
          usage: { input_tokens: 90000, output_tokens: 10000 },
        },
        { results: [['toolu_a1', 'hunter2output edited the file']] },
        { assistant: [tool('toolu_a2', 'Skill', { skill: 'ship-change' })] },
        { results: [['toolu_a2', 'Launching skill']] },
        { assistant: [tool('toolu_a3', 'Bash', { command: 'git commit -m "Fix the redirect"', description: 'Commit' })] },
        { results: [['toolu_a3', '[feat/login abc1234] Fix the redirect']] },
        { user: 'Commit the fix when the tests pass' },
        { assistant: [text('Committed.')] },
      ],
      [
        { type: 'agent-setting', agentSetting: 'planner', sessionId: AUTH },
        { type: 'pr-link', sessionId: AUTH, prNumber: 7, prUrl: 'https://github.com/example/demo/pull/7', prRepository: 'example/demo', timestamp: new Date(timeOf(AUTH)).toISOString() },
      ],
    ),
  );

  writeClaude(
    s,
    FLAKY,
    alpha,
    claudeLog(FLAKY, alpha, 'main', [
      { user: TITLES[FLAKY] },
      { assistant: [text('Pinning the redis version removes the flaky run.'), tool('toolu_f1', 'Edit', { file_path: path.join(alpha, 'src', 'cache.ts'), old_string: 'a', new_string: 'b' })] },
      { results: [['toolu_f1', 'ok']] },
    ]),
  );

  writeClaude(s, ORDERS, beta, claudeLog(ORDERS, beta, 'main', [{ user: TITLES[ORDERS] }, { assistant: [text('The migration adds an index on the status column.')] }]));
  writeClaude(s, OLD, beta, claudeLog(OLD, beta, 'main', [{ user: TITLES[OLD] }, { assistant: [text('Give every key a TTL.')] }]));

  // A GitHub Copilot CLI session: session-state/<id>/workspace.yaml and events.jsonl.
  const dir = path.join(s.copilot, 'session-state', COPILOT);
  mkdirSync(dir, { recursive: true });
  const at = (ms) => new Date(timeOf(COPILOT) + ms).toISOString();
  writeFileSync(
    path.join(dir, 'workspace.yaml'),
    [`id: ${COPILOT}`, `cwd: ${beta}`, `branch: main`, `summary: "${TITLES[COPILOT]}"`, `created_at: ${at(-60_000)}`, `updated_at: ${at(0)}`, ''].join('\n'),
  );
  const events = [
    { type: 'session.start', data: { sessionId: COPILOT, version: 1, producer: 'copilot-agent', copilotVersion: '0.0.330', context: { cwd: beta, branch: 'main' } }, id: 'ev1', timestamp: at(-60_000) },
    { type: 'user.message', data: { content: 'Why does the router redirect twice?', attachments: [] }, id: 'ev2', timestamp: at(-50_000) },
    { type: 'assistant.message', data: { messageId: 'm1', content: 'The guard runs once per route.', toolRequests: [] }, id: 'ev3', timestamp: at(0) },
  ];
  writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  utimesSync(path.join(dir, 'events.jsonl'), new Date(timeOf(COPILOT)), new Date(timeOf(COPILOT)));
}

// ---------- steps ----------

const cardSel = (id) => `.card[data-id$=":${id}"]`;

/** The seeded sessions the sidebar lists, by id, sorted. Cards of every other session are ignored. */
const shownSeeds = async (frame) =>
  (await frame.$$eval('.card:not(.skeleton)', (els) => els.map((e) => e.dataset.id.split(':').pop()))).filter((id) => ALL_SEEDS.includes(id)).sort();

const names = (ids) => ids.map((id) => TITLES[id].replace('Sidebar ', '')).join(' | ') || 'none';

/** Waits until the list shows exactly `expected` of the seeded sessions, and keeps showing them (late results do not undo it). */
async function expectSeeds(frame, expected, what) {
  const want = [...expected].sort();
  const same = async () => {
    const got = await shownSeeds(frame);
    return got.length === want.length && got.every((id, i) => id === want[i]);
  };
  await waitFor(`${what} to show: ${names(want)} (showing: ${names(await shownSeeds(frame))})`, same, 10_000);
  await sleep(400);
  assert(await same(), `${what}: the list changed after it settled, now showing ${names(await shownSeeds(frame))}`);
}

/** Types a search and checks which seeded sessions it leaves. */
async function searchShows(frame, query, expected) {
  await frame.fill('#q', query);
  await expectSeeds(frame, expected, `searching ${query}`);
}

async function clearSearch(frame) {
  await frame.fill('#q', '');
  await frame.press('#q', 'Escape');
  await waitFor('the search box to be empty', async () => (await frame.$eval('#q', (el) => el.value)) === '');
}

const group = (frame, label) => frame.locator('.group').filter({ has: frame.locator('.group-label', { hasText: new RegExp(`^${label}$`) }) });
const isCollapsed = async (g) => /\bcollapsed\b/.test((await g.getAttribute('class')) ?? '');

/** Opens the group if it is collapsed; returns whether it was, so the scenario can put it back. */
async function openGroup(frame, label) {
  const g = group(frame, label);
  await g.waitFor({ timeout: 10_000 });
  if (!(await isCollapsed(g))) return false;
  await g.locator('.group-header').click();
  await waitFor(`the ${label} group to open`, async () => !(await isCollapsed(g)));
  return true;
}

async function closeGroup(frame, label) {
  const g = group(frame, label);
  await g.locator('.group-header').click();
  await waitFor(`the ${label} group to close`, () => isCollapsed(g));
}

/** Runs `fn` with the alpha-api and beta-web groups open (a closed group shows no cards), then puts them back. */
async function withOpenGroups(frame, fn) {
  const opened = [];
  for (const label of ['alpha-api', 'beta-web']) if (await openGroup(frame, label)) opened.push(label);
  try {
    return await fn();
  } finally {
    for (const label of opened) await closeGroup(frame, label).catch(() => undefined);
  }
}

const groupCardIds = (g) => g.locator('.card').evaluateAll((els) => els.map((e) => e.dataset.id.split(':').pop()));

/** Clicks a source chip and waits for its pressed state. */
async function chip(frame, source) {
  await frame.click(`#sources .chip[data-source="${source}"]`);
}
const chipPressed = async (frame, source) => (await frame.getAttribute(`#sources .chip[data-source="${source}"]`, 'aria-pressed')) === 'true';

/** Back to the window's starting sources: Claude Code only. */
async function claudeOnly(frame) {
  if (!(await chipPressed(frame, 'copilot-cli')) && !(await chipPressed(frame, '*'))) return; // already Claude only
  if (!(await chipPressed(frame, '*'))) await chip(frame, '*'); // from Copilot CLI alone, All first
  await chip(frame, 'claude'); // with everything on, one click picks just Claude
  await waitFor('the Claude chip to be the only one lit', async () => (await chipPressed(frame, 'claude')) && !(await chipPressed(frame, '*')));
}

const tabsWith = (page, text) => page.locator('.tabs-container .tab', { hasText: text });
const TAB_PREFIX = 'E2E sidebar tab';
const myTabs = (page) => tabsWith(page, TAB_PREFIX);

async function closeMyTabs(page) {
  for (let i = 0; i < 10 && (await myTabs(page).count()); i++) {
    const t = myTabs(page).first();
    await t.hover();
    await t.locator('.tab-actions .action-label').first().click();
    await sleep(200);
  }
  await waitFor('the transcript tabs to close', async () => (await myTabs(page).count()) === 0, 5_000);
}

/** Titles of the transcript tabs that are open, sorted. */
const openTitles = async (page) => (await myTabs(page).locator('.label-name').allTextContents()).sort();

async function expectTabs(page, titles, what) {
  const want = [...titles].sort();
  const same = async () => {
    const open = await openTitles(page);
    return open.length === want.length && open.every((t, i) => t === want[i]);
  };
  try {
    await waitFor(`${what}: the tabs to be ${want.join(', ') || 'none'}`, same, 10_000);
  } catch (err) {
    throw new Error(`${err.message}. Open: ${(await openTitles(page)).join(', ') || 'none'}`);
  }
}

const cardOf = (ctx, key) => ({ page: ctx.page, id: ctx.fixtures[key].id, title: ctx.fixtures[key].title });

// These look at the list as a whole, so they run with the projects open: a collapsed group shows no cards.
const NEEDS_OPEN_GROUPS = new Set([
  'sidebar-workspace-filter',
  'sidebar-source-chips',
  'sidebar-card-details',
  'sidebar-search-words',
  'sidebar-search-filters',
  'sidebar-search-help',
]);

const scenarios = [
    {
      name: 'sidebar-groups-by-project',
      prompt: 'E2E sidebar projects',
      async run(ctx) {
        const frame = await sidebar(ctx);
        assert((await frame.getAttribute('[data-group="project"]', 'aria-checked')) === 'true', 'the list is not grouped by project to start with');
        const alphaOpened = await openGroup(frame, 'alpha-api');
        const betaOpened = await openGroup(frame, 'beta-web');
        const alpha = group(frame, 'alpha-api');
        const beta = group(frame, 'beta-web');
        // Each project is a group with its own avatar (initials), its folder, a count and its sessions, newest first.
        assert((await alpha.locator('.avatar').textContent()).trim() === 'AA', 'alpha-api has no avatar with its initials');
        assert((await beta.locator('.avatar').textContent()).trim() === 'BW', 'beta-web has no avatar with its initials');
        assert((await alpha.locator('.group-path').textContent()).endsWith('alpha-api'), 'alpha-api does not show its folder');
        assert((await alpha.locator('.count').textContent()).trim() === '2', 'alpha-api does not count its 2 sessions');
        assert((await beta.locator('.count').textContent()).trim() === '2', 'beta-web does not count its 2 sessions (Claude Code only)');
        const inAlpha = await groupCardIds(alpha);
        const inBeta = await groupCardIds(beta);
        assert(inAlpha.join() === [AUTH, FLAKY].join(), `alpha-api lists ${inAlpha}, not its two sessions newest first`);
        assert(inBeta.join() === [ORDERS, OLD].join(), `beta-web lists ${inBeta}, not its two sessions newest first`);
        // The scenario's own session is in the sandbox's folder, a group of its own.
        assert((await groupCardIds(group(frame, 'demo'))).includes(ctx.id), 'the sandbox folder group does not hold its session');
        // A group header folds and unfolds its cards.
        await closeGroup(frame, 'beta-web');
        assert(!(await beta.locator('.card').first().isVisible()), 'a collapsed group still shows its cards');
        assert((await beta.locator('.group-header').getAttribute('aria-expanded')) === 'false', 'a collapsed group says it is expanded');
        await openGroup(frame, 'beta-web');
        assert((await beta.locator('.card').count()) === 2, 'an expanded group does not show its cards again');
        if (!betaOpened) await openGroup(frame, 'beta-web');
        else await closeGroup(frame, 'beta-web');
        if (alphaOpened) await closeGroup(frame, 'alpha-api');
      },
    },
    {
      name: 'sidebar-groups-by-date',
      prompt: 'E2E sidebar dates',
      async run(ctx) {
        const frame = await sidebar(ctx);
        try {
          await frame.click('[data-group="date"]');
          await waitFor('the list to be grouped by date', async () => (await frame.getAttribute('[data-group="date"]', 'aria-checked')) === 'true');
          const opened = [];
          for (const id of CLAUDE_SEEDS) {
            const label = bucketOf(timeOf(id));
            await group(frame, label).waitFor({ timeout: 10_000 });
            if (await openGroup(frame, label)) opened.push(label);
            const ids = await groupCardIds(group(frame, label));
            assert(ids.includes(id), `${TITLES[id]} is not under ${label} (that group lists ${ids.length} sessions)`);
          }
          // Date groups name the project on each card, as the group no longer does.
          assert((await frame.locator(`${cardSel(AUTH)} .tag.project`).textContent()).includes('alpha-api'), 'a card in a date group does not name its project');
          // The date groups are the ones the README lists, newest first.
          const labels = await frame.locator('.group .group-label').allTextContents();
          const order = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];
          const ranks = labels.map((l) => order.indexOf(l));
          assert(ranks.every((r) => r >= 0) && ranks.every((r, i) => i === 0 || r > ranks[i - 1]), `the date groups are ${labels.join(', ')}`);
          for (const label of opened) await closeGroup(frame, label);
        } finally {
          await frame.click('[data-group="project"]');
          await waitFor('the list to be grouped by project again', async () => (await frame.getAttribute('[data-group="project"]', 'aria-checked')) === 'true');
        }
      },
    },
    {
      name: 'sidebar-workspace-filter',
      prompt: 'E2E sidebar workspace',
      async run(ctx) {
        const frame = await sidebar(ctx);
        const alphaOpened = await openGroup(frame, 'alpha-api');
        assert((await frame.getAttribute('#ws', 'aria-pressed')) === 'false', 'the Workspace filter is on to start with');
        await expectSeeds(frame, [AUTH, FLAKY, ORDERS, OLD], 'the list before filtering');
        try {
          // The window has the sandbox's folder open: only its sessions stay.
          await frame.click('#ws');
          await waitFor('the Workspace filter to turn on', async () => (await frame.getAttribute('#ws', 'aria-pressed')) === 'true');
          await expectSeeds(frame, [], 'the Workspace filter');
          assert((await group(frame, 'alpha-api').count()) === 0 && (await group(frame, 'beta-web').count()) === 0, 'projects outside the open folder are still listed');
          assert((await frame.$(cardSel(ctx.id))) !== null, 'the session in the open folder is gone');
        } finally {
          await frame.click('#ws');
          await waitFor('the Workspace filter to turn off', async () => (await frame.getAttribute('#ws', 'aria-pressed')) === 'false');
        }
        await expectSeeds(frame, [AUTH, FLAKY, ORDERS, OLD], 'the list after the filter');
        if (alphaOpened) await closeGroup(frame, 'alpha-api');
      },
    },
    {
      name: 'sidebar-source-chips',
      prompt: 'E2E sidebar sources',
      async run(ctx) {
        const frame = await sidebar(ctx);
        await frame.waitForSelector('#sources:not([hidden])');
        // Two tools have sessions, so there is a chip for each, with its count, and All. The window starts on Claude Code.
        assert((await frame.locator('#sources .chip').count()) === 3, 'the source chips are not All, Claude and Copilot CLI');
        assert((await frame.locator('#sources .chip[data-source="copilot-cli"] .n').textContent()).trim() === '1', 'the Copilot CLI chip does not count its session');
        assert(await chipPressed(frame, 'claude'), 'the Claude chip is not lit on a window that starts on Claude Code');
        assert(!(await chipPressed(frame, 'copilot-cli')), 'the Copilot CLI chip is lit on a window that starts on Claude Code');
        await expectSeeds(frame, CLAUDE_SEEDS, 'the starting sources');
        try {
          // Adding the other source turns everything on, and All lights.
          await chip(frame, 'copilot-cli');
          await expectSeeds(frame, ALL_SEEDS, 'every source');
          assert(await chipPressed(frame, '*'), 'All is not lit with every source shown');
          const copilot = frame.locator(cardSel(COPILOT));
          await openGroup(frame, 'beta-web');
          assert((await copilot.locator('.tag.source').textContent()).includes('Copilot CLI'), 'the Copilot CLI card has no tag naming its tool');
          assert((await frame.locator(`${cardSel(AUTH)} .tag.source`).textContent()).includes('Claude'), 'the Claude Code card has no tag naming its tool');
          // With everything on, a click shows just that source.
          await chip(frame, 'copilot-cli');
          await expectSeeds(frame, [COPILOT], 'the Copilot CLI chip');
          await chip(frame, '*');
          await expectSeeds(frame, ALL_SEEDS, 'the All chip');
          await chip(frame, 'claude');
          await expectSeeds(frame, CLAUDE_SEEDS, 'the Claude chip');
        } finally {
          await claudeOnly(frame);
        }
      },
    },
    {
      name: 'sidebar-card-details',
      prompt: 'E2E sidebar card',
      async run(ctx) {
        const frame = await sidebar(ctx);
        await openGroup(frame, 'alpha-api');
        const card = frame.locator(cardSel(AUTH));
        const has = async (sel) => (await card.locator(sel).count()) > 0;
        assert((await card.locator('.title').textContent()).trim() === TITLES[AUTH], 'the card does not show its title');
        // The latest prompt shows under the title when it is not the title itself.
        assert((await card.locator('.excerpt').textContent()).includes('Commit the fix when the tests pass'), 'the card does not show the latest prompt');
        assert((await card.locator('.tag.agent').textContent()).trim() === 'planner', 'the card does not show the agent it ran as');
        assert((await card.locator('.tag.source').textContent()).includes('Claude'), 'the card does not show its tool');
        assert((await card.locator('.tag[title="Git branch"]').textContent()).trim() === 'feat/login', 'the card does not show its git branch');
        const prompts = card.locator('.tag[title$="prompts"]');
        assert((await prompts.textContent()).trim() === '2', 'the card does not count its 2 prompts');
        assert((await card.locator('.tag.pr').textContent()).trim() === '#7', 'the card does not show its pull request');
        assert((await card.locator('.tag[title^="Cost at Claude API prices"]').textContent()).trim() === '$0.42', 'the card does not show the cost, $0.42');
        assert(!(await has('.live')), 'a session ten minutes old is marked live');
        // A session with nothing worth knowing about shows none of these.
        const plain = frame.locator(cardSel(FLAKY));
        assert((await plain.locator('.tag.agent, .tag.pr, [title^="Cost at"]').count()) === 0, 'a plain session shows an agent, a pull request or a cost');
        assert((await plain.locator('.tag[title="Git branch"]').textContent()).trim() === 'main', 'the plain session does not show its branch');
        // The scenario's own session has a model without a price: no cost either.
        assert((await frame.locator(`${cardSel(ctx.id)} [title^="Cost at"]`).count()) === 0, 'a session with no priced usage shows a cost');
        // Hovering shows the quick actions.
        await card.hover();
        for (const a of ['resume', 'continueInNewSession', 'openTranscript', 'copyId']) {
          assert(await card.locator(`[data-action="${a}"]`).isVisible(), `hovering the card does not show its ${a} action`);
        }
      },
    },
    {
      name: 'sidebar-search-words',
      prompt: 'E2E sidebar search words',
      async run(ctx) {
        const frame = await sidebar(ctx);
        try {
          // Both words, anywhere in the card or the conversation, in any case.
          await searchShows(frame, 'auth bug', [AUTH]);
          await searchShows(frame, 'AUTH BUG', [AUTH]);
          // An exact phrase; it is in Claude's reply only, so the card shows where it matched.
          await searchShows(frame, '"race condition"', [AUTH]);
          const found = frame.locator(`${cardSel(AUTH)} .excerpt.transcript-match`);
          await found.waitFor({ timeout: 10_000 });
          assert((await found.textContent()).includes('race condition'), 'the card does not show the matching passage');
          assert((await found.locator('mark').textContent()).toLowerCase() === 'race condition', 'the phrase is not highlighted in the passage');
          await searchShows(frame, '"condition race"', []);
          // Leaving a word out.
          await searchShows(frame, '-flaky', [AUTH, ORDERS, OLD]);
          await searchShows(frame, '-"orders table" -flaky', [AUTH, OLD]);
          // Either word.
          await searchShows(frame, 'redis OR postgres', [FLAKY, ORDERS, OLD]);
          // The paths of files Claude's tools edited are searched; their output is not.
          await searchShows(frame, 'cache.ts', [FLAKY]);
          await searchShows(frame, 'hunter2output', []);
          await frame.waitForSelector('.empty h3');
          assert((await frame.textContent('.empty h3')).trim() === 'No matches', 'a search that finds nothing does not say so');
          // The summary counts what matched.
          await searchShows(frame, 'redis', [FLAKY, OLD]);
          assert(/^\d+ of \d+ sessions$/.test((await frame.textContent('#summary')).trim()), 'the summary does not count the matches');
        } finally {
          await clearSearch(frame);
        }
        await expectSeeds(frame, CLAUDE_SEEDS, 'the list after clearing the search');
      },
    },
    {
      name: 'sidebar-search-filters',
      prompt: 'E2E sidebar search filters',
      async run(ctx) {
        const frame = await sidebar(ctx);
        try {
          // source: needs the tool's sessions in the list, so switch the Copilot CLI chip on first.
          await chip(frame, 'copilot-cli');
          await expectSeeds(frame, ALL_SEEDS, 'every source');
          await searchShows(frame, 'source:copilot', [COPILOT]);
          await searchShows(frame, 'source:claude', CLAUDE_SEEDS);
          await searchShows(frame, '-source:copilot', CLAUDE_SEEDS);
          await clearSearch(frame);
          await claudeOnly(frame);
          // The filters on what a Claude Code session did.
          await searchShows(frame, 'file:auth.ts', [AUTH]);
          await searchShows(frame, 'file:src/auth', [AUTH]);
          await searchShows(frame, 'file:cache', [FLAKY]);
          await searchShows(frame, 'skill:ship', [AUTH]);
          await searchShows(frame, 'skill:deploy', []);
          await searchShows(frame, 'has:commits', [AUTH]);
          await searchShows(frame, 'has:pr', [AUTH]);
          await searchShows(frame, 'has:edits', [AUTH, FLAKY]);
          await searchShows(frame, '-has:edits', [ORDERS, OLD]);
          await searchShows(frame, '-has:pr', [FLAKY, ORDERS, OLD]);
          // They combine with words.
          await searchShows(frame, 'has:edits redis', [FLAKY]);
        } finally {
          await clearSearch(frame);
          await claudeOnly(frame);
        }
      },
    },
    {
      name: 'sidebar-search-help',
      prompt: 'E2E sidebar search help',
      async run(ctx) {
        const frame = await sidebar(ctx);
        try {
          // The ? button lists the filters; clicking one adds it to the search.
          assert(await frame.$eval('#search-help', (el) => el.hidden), 'the filter help is open to start with');
          await frame.click('#help-toggle');
          await waitFor('the filter help to open', async () => !(await frame.$eval('#search-help', (el) => el.hidden)));
          const inserts = await frame.$$eval('#search-help [data-insert]', (els) => els.map((e) => e.dataset.insert));
          for (const want of ['""', '-', 'OR', 'file:', 'skill:', 'has:commits', 'has:pr', 'has:edits']) {
            assert(inserts.includes(want), `the filter help does not offer ${want}`);
          }
          await frame.click('#search-help [data-insert="has:pr"]');
          assert((await frame.$eval('#q', (el) => el.value)) === 'has:pr ', 'clicking has:pr does not put it in the search box');
          await expectSeeds(frame, [AUTH], 'the has:pr filter from the help');
          await frame.click('#search-help [data-insert="file:"]');
          assert((await frame.$eval('#q', (el) => el.value)) === 'has:pr file:', 'a second filter does not follow the first');
          await frame.press('#q', 'Escape'); // clears the box; the help stays
          assert((await frame.$eval('#q', (el) => el.value)) === '', 'Escape does not clear the search box');
          await frame.press('#search-help [data-insert="OR"]', 'Escape');
          await waitFor('Escape to close the filter help', () => frame.$eval('#search-help', (el) => el.hidden));
          // The clear button.
          await frame.fill('#q', 'redis');
          await frame.click('#clear');
          assert((await frame.$eval('#q', (el) => el.value)) === '', 'the clear button does not empty the search box');
          // "/" jumps to the search box from anywhere in the sidebar.
          await frame.focus('#refresh');
          await frame.press('#refresh', '/');
          assert(await frame.evaluate(() => document.activeElement?.id === 'q'), '/ does not focus the search box');
        } finally {
          await clearSearch(frame);
          if (!(await frame.$eval('#search-help', (el) => el.hidden))) await frame.click('#help-toggle');
        }
      },
    },
    {
      name: 'sidebar-click-opens-preview-tab',
      prompt: 'E2E sidebar preview',
      async run(ctx) {
        const side = await sidebar(ctx);
        const [alpha, bravo] = [cardOf(ctx, 'alpha'), cardOf(ctx, 'bravo')];
        try {
          await side.click(cardSel(alpha.id));
          await expectTabs(ctx.page, [alpha.title], 'a click');
          // It is the shared preview tab: it offers Keep open, and the next click replaces it.
          await frameWith(ctx.page, `body[data-session*="${alpha.id}"] [data-cmd="keepOpen"]`, 'Keep open in the first transcript');
          await side.click(cardSel(bravo.id));
          await expectTabs(ctx.page, [bravo.title], 'a second click');
          await transcript(bravo);
        } finally {
          await closeMyTabs(ctx.page);
        }
      },
    },
    {
      name: 'sidebar-double-click-keeps-tab',
      prompt: 'E2E sidebar double-click',
      async run(ctx) {
        const side = await sidebar(ctx);
        const [alpha, bravo, charlie] = [cardOf(ctx, 'alpha'), cardOf(ctx, 'bravo'), cardOf(ctx, 'charlie')];
        try {
          await side.dblclick(cardSel(alpha.id));
          await expectTabs(ctx.page, [alpha.title], 'a double-click');
          // Its own tab: the next click opens a preview beside it, and the one after replaces that preview only.
          await side.click(cardSel(bravo.id));
          await expectTabs(ctx.page, [alpha.title, bravo.title], 'a click after a double-click');
          await side.click(cardSel(charlie.id));
          await expectTabs(ctx.page, [alpha.title, charlie.title], 'a second click after a double-click');
        } finally {
          await closeMyTabs(ctx.page);
        }
      },
    },
    {
      name: 'sidebar-keep-open-button',
      prompt: 'E2E sidebar keep open',
      async run(ctx) {
        const side = await sidebar(ctx);
        const [alpha, bravo, charlie] = [cardOf(ctx, 'alpha'), cardOf(ctx, 'bravo'), cardOf(ctx, 'charlie')];
        try {
          await side.click(cardSel(alpha.id));
          const frame = await frameWith(ctx.page, `body[data-session*="${alpha.id}"] [data-cmd="keepOpen"]`, 'Keep open in the first transcript');
          await frame.click('[data-cmd="keepOpen"]');
          // Kept: the preview tab is free again, so the next click opens another tab.
          await side.click(cardSel(bravo.id));
          await expectTabs(ctx.page, [alpha.title, bravo.title], 'a click after Keep open');
          await side.click(cardSel(charlie.id));
          await expectTabs(ctx.page, [alpha.title, charlie.title], 'a second click after Keep open');
        } finally {
          await closeMyTabs(ctx.page);
        }
      },
    },
];

export default {
  name: 'sidebar',
  seed,
  // Four plain sessions to open in tabs. Their titles share TAB_PREFIX, which is how the scenarios tell their tabs
  // from every other.
  sessions: ['alpha', 'bravo', 'charlie', 'delta'].map((w) => ({ key: w, prompt: `${TAB_PREFIX} ${w}` })),
  scenarios: scenarios.map((sc) =>
    NEEDS_OPEN_GROUPS.has(sc.name) ? { ...sc, run: async (ctx) => withOpenGroups(await sidebar(ctx), () => sc.run(ctx)) } : sc,
  ),
};

