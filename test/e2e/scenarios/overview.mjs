// The overview area: what README's "See what a session used and cost" and "See all your sessions at a glance" describe.
// The Overview tab (opening it, choosing projects and a range, its totals, the cost per day, the project and model
// tables and the session lists), and the cost, token, request, context and prompt-cache figures wherever they appear:
// the sidebar card, the top of a transcript, its top bar, its message box and its Session details panel.
// See docs/dev/e2e.md for how to add a scenario.
//
// The sessions are synthetic, in real Claude Code record shapes, and written by `seed` into the sandbox before VS Code
// starts, in two projects of their own (overview-north and overview-south) so the overview can be narrowed to exactly
// them whichever other areas run beside them. Every request has known token counts, and what the page should show is
// worked out below from src/prices.json, never written down from a screenshot: if a price changes, the expectations
// follow it.

import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, assert, frameWith, projectDirName, sidebar, transcript, waitFor } from '../harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const PRICES = JSON.parse(readFileSync(path.join(ROOT, 'src', 'prices.json'), 'utf8'));
const M = 1_000_000;

// ---------- the synthetic sessions ----------

const sid = (n) => `e2e0ae10-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUTH = sid(1); // north: two requests on two days; the context is nearly full and the 1-hour cache is warm; an agent
const CACHE = sid(2); // north: half full, the 5-minute cache has expired
const BILLING = sid(3); // south: nine days ago, an opus model
const LEGACY = sid(4); // south: forty days ago
const NOPRICE = sid(5); // south: a model with no known price
const ALL_IDS = [AUTH, CACHE, BILLING, LEGACY, NOPRICE];

// Taken once, when the module loads, so what the seeds wrote and what the scenarios expect agree.
const NOW = Date.now();
const noonDaysAgo = (n) => {
  const d = new Date(NOW);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
};

const NORTH = 'overview-north';
const SOUTH = 'overview-south';

/** One API request is { at, model, usage }; a turn is a prompt and the request that answers it. */
const SESSIONS = [
  {
    id: AUTH,
    project: NORTH,
    title: 'Overview auth service refactor',
    agent: 'planner',
    turns: [
      { prompt: 'Overview auth service refactor', at: noonDaysAgo(1), model: 'claude-sonnet-4-5', usage: { input_tokens: 50_000, output_tokens: 8_000 } },
      {
        prompt: 'Overview now tidy the token refresh',
        at: NOW - 10 * MIN,
        model: 'claude-sonnet-4-5',
        // 170 000 tokens in the window of 200 000: 85% full. The 10 000 cache writes are 1-hour ones.
        usage: {
          input_tokens: 20_000,
          cache_read_input_tokens: 140_000,
          cache_creation_input_tokens: 10_000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 },
          output_tokens: 4_000,
        },
      },
    ],
  },
  {
    id: CACHE,
    project: NORTH,
    title: 'Overview cache warmup job',
    turns: [
      {
        prompt: 'Overview cache warmup job',
        at: NOW - 2 * 60 * MIN,
        model: 'claude-haiku-4-5',
        // 104 000 tokens in the window of 200 000: 52% full. The 4 000 cache writes carry no breakdown: 5-minute ones.
        usage: { input_tokens: 100_000, cache_creation_input_tokens: 4_000, output_tokens: 3_000 },
      },
    ],
  },
  {
    id: BILLING,
    project: SOUTH,
    title: 'Overview billing export',
    turns: [{ prompt: 'Overview billing export', at: noonDaysAgo(9), model: 'claude-opus-5-5', usage: { input_tokens: 30_000, output_tokens: 10_000 } }],
  },
  {
    id: LEGACY,
    project: SOUTH,
    title: 'Overview legacy importer',
    turns: [{ prompt: 'Overview legacy importer', at: noonDaysAgo(40), model: 'claude-sonnet-4-5', usage: { input_tokens: 100_000, output_tokens: 10_000 } }],
  },
  {
    id: NOPRICE,
    project: SOUTH,
    title: 'Overview unpriced model check',
    turns: [{ prompt: 'Overview unpriced model check', at: NOW - 29 * MIN, model: 'claude-unpriced-9', usage: { input_tokens: 5_000, output_tokens: 1_000 } }],
  },
];
const byId = Object.fromEntries(SESSIONS.map((s) => [s.id, s]));

const REPLY_AFTER = 90_000; // a reply is logged this long after its prompt
const lastTime = (s) => Math.max(...s.turns.map((t) => t.at + REPLY_AFTER));

/** Writes the sessions into the sandbox. Run by the runner once, before VS Code starts. */
function seed(s) {
  const cwds = { [NORTH]: path.join(s.dir, 'work', NORTH), [SOUTH]: path.join(s.dir, 'work', SOUTH) };
  for (const session of SESSIONS) {
    const cwd = cwds[session.project];
    const dir = path.join(s.claudeConfig, 'projects', projectDirName(cwd));
    mkdirSync(dir, { recursive: true });
    const common = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: session.id, version: '2.1.332', gitBranch: 'main' };
    const records = session.agent ? [{ type: 'agent-setting', agentSetting: session.agent, sessionId: session.id }] : [];
    let parent = null;
    let n = 0;
    const uuid = () => `${session.id.slice(0, 8)}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    session.turns.forEach((turn, i) => {
      const u = uuid();
      records.push({ parentUuid: parent, ...common, type: 'user', message: { role: 'user', content: turn.prompt }, uuid: u, timestamp: new Date(turn.at).toISOString() });
      const a = uuid();
      records.push({
        parentUuid: u,
        ...common,
        type: 'assistant',
        message: {
          model: turn.model,
          id: `msg_${session.id.slice(-4)}_${i}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: `Done with step ${i + 1}.` }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: turn.usage,
        },
        uuid: a,
        timestamp: new Date(turn.at + REPLY_AFTER).toISOString(),
      });
      parent = a;
    });
    const file = path.join(dir, `${session.id}.jsonl`);
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    utimesSync(file, new Date(lastTime(session)), new Date(lastTime(session)));
  }
}

// ---------- what the figures should be, from the token counts and the prices ----------

/** "claude-sonnet-4-5-20250929" -> "sonnet-4-5": the price key, and what the overview calls a model. */
const modelKey = (model) => model.toLowerCase().replace(/^.*claude-/, '').replace(/-\d{8}$/, '');

/** Tokens and cost of one request by category. The synthetic models have no fast mode, long-context rates or US surcharge. */
function priced(turn) {
  const u = turn.usage;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const t = {
    input: u.input_tokens ?? 0,
    cacheWrite5m: (u.cache_creation_input_tokens ?? 0) - write1h,
    cacheWrite1h: write1h,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
  const p = PRICES[modelKey(turn.model)];
  const costs = Object.fromEntries(Object.keys(t).map((k) => [k, p ? (t[k] * p[k]) / M : 0]));
  return { tokens: t, costs, cost: Object.values(costs).reduce((a, b) => a + b, 0), priced: !!p, context: p?.context ?? 200_000 };
}

const dayKey = (time) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Everything one session adds up to. */
function totalsOf(session) {
  const reqs = session.turns.map(priced);
  const sum = (f) => reqs.reduce((n, r) => n + f(r), 0);
  const tokens = Object.fromEntries(['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'].map((k) => [k, sum((r) => r.tokens[k])]));
  const costs = Object.fromEntries(Object.keys(tokens).map((k) => [k, sum((r) => r.costs[k])]));
  const last = reqs[reqs.length - 1];
  // The window holds the input, the cache reads and the cache writes of the last request.
  const used = last.tokens.input + last.tokens.cacheRead + last.tokens.cacheWrite5m + last.tokens.cacheWrite1h;
  return {
    session,
    reqs,
    tokens,
    costs,
    cost: Object.values(costs).reduce((a, b) => a + b, 0),
    requests: reqs.length,
    used,
    limit: last.context,
  };
}

// ---------- what the overview should show for a range and a choice of projects ----------

const startOfDay = (time, back = 0) => {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d;
};
const keysBetween = (from, to) => {
  const [y, m, d] = from.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  const out = [];
  for (let k = dayKey(day.getTime()); k <= to; day.setDate(day.getDate() + 1), k = dayKey(day.getTime())) out.push(k);
  return out;
};

/** The days a session did anything: those of its requests, and that of its last message. */
const activeDaysOf = (session) => new Set([...session.turns.map((t) => dayKey(t.at + REPLY_AFTER)), dayKey(lastTime(session))]);

/** The overview of `range` over the sessions of `projects`, as the page should show it. */
function expectOverview(range, projects) {
  const sessions = SESSIONS.filter((s) => projects.includes(s.project));
  const to = dayKey(NOW);
  let from;
  if (range === 0) from = [...new Set(sessions.flatMap((s) => [...activeDaysOf(s)]))].sort()[0];
  else if (range === 'week') from = dayKey(startOfDay(NOW, (new Date(NOW).getDay() + 6) % 7).getTime());
  else if (range === 'month') from = dayKey(startOfDay(NOW, new Date(NOW).getDate() - 1).getTime());
  else from = dayKey(startOfDay(NOW, range - 1).getTime());
  const days = keysBetween(from, to);
  const buckets = days.map((day) => ({ day, cost: 0, sessions: new Set(), byModel: {} }));
  const at = Object.fromEntries(buckets.map((b) => [b.day, b]));
  const listed = [];
  const allDays = new Set();
  let prompts = 0;
  for (const session of sessions) {
    const mine = [...activeDaysOf(session)].filter((d) => d >= from && d <= to);
    if (!mine.length) continue;
    prompts += session.turns.length;
    let cost = 0;
    for (const d of mine) {
      allDays.add(d);
      at[d].sessions.add(session.id);
    }
    for (const turn of session.turns) {
      const day = dayKey(turn.at + REPLY_AFTER);
      const r = priced(turn);
      if (day < from || day > to || !(r.cost > 0)) continue;
      at[day].cost += r.cost;
      at[day].byModel[modelKey(turn.model)] = (at[day].byModel[modelKey(turn.model)] ?? 0) + r.cost;
      cost += r.cost;
    }
    listed.push({ session, cost, last: lastTime(session) });
  }
  const sum = (list, f) => list.reduce((n, x) => n + f(x), 0);
  const cost = sum(listed, (l) => l.cost);
  const projectRows = [...new Set(listed.map((l) => l.session.project))]
    .map((name) => {
      const mine = listed.filter((l) => l.session.project === name);
      return { name, sessions: mine.length, prompts: sum(mine, (l) => l.session.turns.length), cost: sum(mine, (l) => l.cost), last: Math.max(...mine.map((l) => l.last)) };
    })
    .sort((a, b) => b.cost - a.cost || b.last - a.last);
  const models = {};
  for (const b of buckets) for (const [m, c] of Object.entries(b.byModel)) models[m] = (models[m] ?? 0) + c;
  // Colors follow the all-time cost of every shown session, so a model keeps its color when the range changes.
  const allTime = {};
  for (const session of sessions) for (const turn of session.turns) allTime[modelKey(turn.model)] = (allTime[modelKey(turn.model)] ?? 0) + (priced(turn).cost > 0 ? priced(turn).cost : 0);
  return {
    from,
    to,
    buckets,
    sessions: listed.length,
    prompts,
    cost,
    activeDays: allDays.size,
    projects: projectRows,
    models: Object.entries(models)
      .map(([model, c]) => ({ model, cost: c }))
      .sort((a, b) => b.cost - a.cost),
    series: Object.keys(allTime)
      .filter((m) => allTime[m] > 0)
      .sort((a, b) => allTime[b] - allTime[a]),
    recent: [...listed].sort((a, b) => b.last - a.last),
    top: listed.filter((l) => l.cost > 0).sort((a, b) => b.cost - a.cost),
  };
}

// The overview's own number formats (media/overview.js), written out so a scenario does not borrow them.
const money = (usd) => (usd >= 10000 ? `$${(usd / 1000).toFixed(1)}k` : usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(usd >= 1000 ? 0 : 2)}`);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
// src/format.ts
const usd = (v) => (v > 0 && v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`);
const tokens = (n) => (n < 1000 ? String(n) : n < 1_000_000 ? `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${+(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`);

// ---------- steps ----------

const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const OVERVIEW_TAB = 'SessionsAI Overview';
const tabsWith = (page, text) => page.locator('.tabs-container .tab', { hasText: text });

async function closeTabs(page, text) {
  for (let i = 0; i < 10 && (await tabsWith(page, text).count()); i++) {
    const t = tabsWith(page, text).first();
    await t.hover();
    await t.locator('.tab-actions .action-label').first().click();
    await sleep(200);
  }
  await waitFor(`the ${text} tabs to close`, async () => (await tabsWith(page, text).count()) === 0, 5_000);
}

const overviewFrame = (ctx) => frameWith(ctx.page, '#project-btn', 'the overview');

/** Opens the overview from the dashboard button at the top of the sidebar. */
async function openOverview(ctx) {
  await sidebar(ctx);
  const button = ctx.page.locator('a.action-label[aria-label="Open Overview"]').first();
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  await button.click();
  return overviewFrame(ctx);
}

/** Shows only these projects: All projects first, then each one ticked in the Projects menu. */
async function showProjects(frame, names) {
  await frame.click('#project-btn');
  await frame.click('#project-menu [data-scope="all"]');
  await waitFor('All projects', async () => clean(await frame.textContent('#project-label')) === 'All projects');
  await frame.click('#project-btn');
  for (const name of names) {
    await frame.locator('#project-items label.menu-item', { hasText: name }).locator('input').check();
    await waitFor(`${name} to be ticked`, async () => (await frame.locator('#project-items label.menu-item', { hasText: name }).locator('input').isChecked()) === true);
  }
  await frame.press('#project-q', 'Escape');
  await waitFor('the menu to close', () => frame.$eval('#project-menu', (el) => el.hidden));
  await waitFor('the projects chosen', async () => clean(await frame.textContent('#project-label')) === (names.length === 1 ? names[0] : `${names.length} projects`));
}

async function chooseRange(frame, range) {
  await frame.click(`[data-range="${range}"]`);
  await waitFor(`the ${range} range to be on`, async () => (await frame.getAttribute(`[data-range="${range}"]`, 'aria-checked')) === 'true');
}

/** What the overview shows, once it is settled on `expected`'s totals. */
async function kpis(frame) {
  const rows = await frame.$$eval('.kpi', (els) => els.map((e) => [e.querySelector('.kpi-label').textContent, e.querySelector('.kpi-value').textContent, e.querySelector('.kpi-note').textContent]));
  // With another tool's sessions shown the label gains "Claude only": only Claude Code logs record usage.
  return Object.fromEntries(rows.map(([label, value, note]) => [clean(label).replace(/ Claude only$/, ''), { value: clean(value), note: clean(note) }]));
}

async function waitForTotals(frame, expected, what) {
  const want = `${expected.sessions}|${money(expected.cost)}`;
  const got = async () => {
    const k = await kpis(frame).catch(() => ({}));
    return `${k.Sessions?.value}|${k.Cost?.value}`;
  };
  try {
    await waitFor(`${what}: the totals ${want}`, async () => (await got()) === want, 10_000);
  } catch (err) {
    throw new Error(`${err.message}. Showing: ${await got()}`);
  }
}

/** The day of a bucket, as the overview words it in the window's own locale. */
const longDay = (frame, key) =>
  frame.evaluate((k) => {
    const [y, m, d] = k.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }, key);

const texts = (frame, selector) => frame.$$eval(selector, (els) => els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()));

// The sidebar's groups start closed when they are not the open folder's, and a closed group shows no cards.
const group = (frame, label) => frame.locator('.group').filter({ has: frame.locator('.group-label', { hasText: new RegExp(`^${label}$`) }) });
async function openGroup(frame, label) {
  const g = group(frame, label);
  await g.waitFor({ timeout: 10_000 });
  if (!/\bcollapsed\b/.test((await g.getAttribute('class')) ?? '')) return false;
  await g.locator('.group-header').click();
  await waitFor(`the ${label} group to open`, async () => !/\bcollapsed\b/.test((await g.getAttribute('class')) ?? ''));
  return true;
}
async function closeGroup(frame, label) {
  const g = group(frame, label);
  await g.locator('.group-header').click();
  await waitFor(`the ${label} group to close`, async () => /\bcollapsed\b/.test((await g.getAttribute('class')) ?? ''));
}

/** Runs `fn` with the two projects' groups open in the sidebar, then puts them back. */
async function withSidebarGroups(ctx, fn) {
  const frame = await sidebar(ctx);
  const opened = [];
  for (const label of [NORTH, SOUTH]) if (await openGroup(frame, label)) opened.push(label);
  try {
    return await fn(frame);
  } finally {
    for (const label of opened) await closeGroup(frame, label).catch(() => undefined);
  }
}

const card = (frame, id) => frame.locator(`.card[data-id$=":${id}"]`);

/** A session's own transcript, opened from the overview's list, as the context `transcript` and friends take. */
const asCtx = (ctx, id) => ({ page: ctx.page, id, title: byId[id].title });

const COST_OF = Object.fromEntries(ALL_IDS.map((id) => [id, totalsOf(byId[id])]));

// ---------- the scenarios ----------

const scenarios = [
  {
    name: 'overview-opens',
    prompt: 'E2E overview opens',
    async run(ctx) {
      try {
        // The dashboard button at the top of the sidebar opens it in an editor tab, on the current workspace.
        const frame = await openOverview(ctx);
        assert((await tabsWith(ctx.page, OVERVIEW_TAB).count()) === 1, 'the dashboard button does not open the overview tab');
        assert((await frame.textContent('h1')).trim() === 'Overview', 'the overview has no heading');
        assert(clean(await frame.textContent('#project-label')) === 'Current workspace', 'the overview does not start on the current workspace');
        const demo = await texts(frame, '.card:has(h2) tbody .name');
        assert(
          !demo.some((n) => n.includes(NORTH) || n.includes(SOUTH)),
          `the current workspace lists projects outside it: ${demo.join(', ')}`,
        );
        // The command does the same, and with the tab open it shows that tab instead of making another. To tell that it
        // ran, another tab is in front first. It is run from View > Command Palette: a key press here can be lost to
        // the webview that has focus, and the menu opens the same palette.
        const side = await sidebar(ctx);
        await side.dblclick(`.card[data-id$=":${ctx.id}"]`);
        await waitFor('the session tab to be in front', async () => (await ctx.page.locator('.tabs-container .tab.active', { hasText: ctx.title }).count()) === 1);
        // The tab is in front after the double-click's first click, which opens the preview tab. The double-click itself
        // lands later: it turns that tab into a tab of its own and brings it forward, which closes a menu or palette
        // opened in the meantime. Once it is done, the page is drawn again without Keep open.
        await waitFor('the double-click to give the session a tab of its own', async () => !(await (await transcript(ctx)).$('[data-cmd="keepOpen"]')));
        await ctx.page.locator('.menubar .menubar-menu-button', { hasText: 'View' }).first().click();
        await ctx.page.locator('.monaco-menu .action-item', { hasText: 'Command Palette' }).first().click();
        await ctx.page.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 10_000 });
        await ctx.page.keyboard.type('SessionsAI: Open Overview');
        await sleep(400);
        await ctx.page.keyboard.press('Enter');
        await waitFor('the overview tab to come to the front', async () => (await ctx.page.locator('.tabs-container .tab.active', { hasText: OVERVIEW_TAB }).count()) === 1);
        assert((await tabsWith(ctx.page, OVERVIEW_TAB).count()) === 1, 'Open Overview from the command palette opened a second tab');
        // The range buttons, and the Projects menu offering the current workspace and all projects.
        const ranges = await texts(frame, '[data-range]');
        assert(ranges.join('|') === 'Current week|Current month|7 days|30 days|90 days|All time', `the ranges are ${ranges}`);
        assert((await frame.getAttribute('[data-range="30"]', 'aria-checked')) === 'true', 'the overview does not start on 30 days');
        await frame.click('#project-btn');
        const scopes = await texts(frame, '#project-scopes .menu-item');
        assert(scopes.length === 2 && scopes[0].startsWith('Current workspace') && scopes[1] === 'All projects', `the scopes are ${scopes}`);
        await frame.press('#project-q', 'Escape');
      } finally {
        await ctx.page.keyboard.press('Escape').catch(() => undefined);
        await closeTabs(ctx.page, OVERVIEW_TAB);
        await closeTabs(ctx.page, ctx.title);
      }
    },
  },
  {
    name: 'overview-projects',
    prompt: 'E2E overview projects',
    async run(ctx) {
      try {
        const frame = await openOverview(ctx);
        // All projects, then the ones ticked.
        await frame.click('#project-btn');
        await frame.click('#project-menu [data-scope="all"]');
        await waitFor('All projects', async () => clean(await frame.textContent('#project-label')) === 'All projects');
        await frame.click('#project-btn');
        const offered = await texts(frame, '#project-items .menu-name');
        assert(offered.includes(NORTH) && offered.includes(SOUTH), `the menu offers ${offered}, not both projects`);
        // "Find a project" narrows the list.
        await frame.fill('#project-q', 'overview-so');
        await waitFor('the menu to narrow', async () => (await texts(frame, '#project-items .menu-name')).join() === SOUTH);
        await frame.fill('#project-q', 'zzz');
        await waitFor('the no-match message', async () => /No matching projects/.test(await frame.textContent('#project-items')));
        await frame.fill('#project-q', '');
        await frame.press('#project-q', 'Escape');
        await showProjects(frame, [NORTH, SOUTH]);
        assert((await texts(frame, '#selected .pill')).join('|') === `${NORTH}|${SOUTH}`, 'the picked projects are not shown as pills');
        await waitForTotals(frame, expectOverview(30, [NORTH, SOUTH]), 'both projects');
        const names = await texts(frame, 'section:has(h2) tbody .name .link');
        assert(names.sort().join('|') === `${NORTH}|${SOUTH}`, `the Projects table lists ${names}`);
        // Removing a pill drops its project.
        await frame.click(`#selected [aria-label="Remove ${SOUTH}"]`);
        await waitFor('one project left', async () => clean(await frame.textContent('#project-label')) === NORTH);
        await waitForTotals(frame, expectOverview(30, [NORTH]), 'north alone');
        // Clicking a project's name in the table shows just that one; clicking it again goes back to all of them.
        await frame.click('#project-btn');
        await frame.locator('#project-items label.menu-item', { hasText: SOUTH }).locator('input').check();
        await frame.press('#project-q', 'Escape');
        await waitForTotals(frame, expectOverview(30, [NORTH, SOUTH]), 'both again');
        await frame.click(`.link[data-only]:has-text("${SOUTH}")`);
        await waitFor('south alone', async () => clean(await frame.textContent('#project-label')) === SOUTH);
        await waitForTotals(frame, expectOverview(30, [SOUTH]), 'south alone');
        await frame.click(`.link[data-only]:has-text("${SOUTH}")`);
        await waitFor('all projects again', async () => clean(await frame.textContent('#project-label')) === 'All projects');
      } finally {
        await closeTabs(ctx.page, OVERVIEW_TAB);
      }
    },
  },
  {
    name: 'overview-totals-and-tables',
    prompt: 'E2E overview totals',
    async run(ctx) {
      try {
        const frame = await openOverview(ctx);
        await showProjects(frame, [NORTH, SOUTH]);
        const e = expectOverview(30, [NORTH, SOUTH]);
        await waitForTotals(frame, e, 'the 30 days');
        // The five totals, with their notes.
        const k = await kpis(frame);
        const same = (got, want, what) => assert(got === want, `${what}: the overview says "${got}", not "${want}"`);
        same(k.Cost.value, money(e.cost), 'Cost');
        same(k.Cost.note, `${money(e.cost / e.activeDays)} per active day`, 'the cost note');
        same(k.Sessions.value, String(e.sessions), 'Sessions');
        same(k.Sessions.note, `${money(e.cost / e.sessions)} each on average`, 'the sessions note');
        same(k.Prompts.value, String(e.prompts), 'Prompts');
        same(k.Prompts.note, `${(e.prompts / e.sessions).toFixed(1)} per session`, 'the prompts note');
        same(k.Projects.value, '2', 'Projects');
        same(k['Active days'].value, String(e.activeDays), 'Active days');
        same(k['Active days'].note, `of ${e.buckets.length}`, 'the active days note');
        // Projects: each one's sessions, prompts and cost, most expensive first.
        const rows = await frame.$$eval('section:has(h2) table:has(th.num) tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim())));
        const projectRows = rows.filter((r) => r.length === 5);
        assert(projectRows.length === e.projects.length, `the Projects table has ${projectRows.length} rows, not ${e.projects.length}`);
        e.projects.forEach((p, i) => {
          const [name, sessions, prompts, cost] = projectRows[i];
          assert(name === p.name, `Projects row ${i + 1} is ${name}, not ${p.name} (most expensive first)`);
          assert(sessions === String(p.sessions), `${p.name} has ${sessions} sessions, not ${p.sessions}`);
          assert(prompts === String(p.prompts), `${p.name} has ${prompts} prompts, not ${p.prompts}`);
          assert(cost === money(p.cost), `${p.name} cost ${cost}, not ${money(p.cost)}`);
        });
        // Models: cost and share, most expensive first; a model with no price is not in it.
        const modelRows = rows.filter((r) => r.length === 3);
        assert(modelRows.length === e.models.length, `the Models table has ${modelRows.length} rows, not ${e.models.length}`);
        e.models.forEach((m, i) => {
          const [name, cost, share] = modelRows[i];
          const pct = m.cost / e.cost < 0.005 ? '<1%' : `${Math.round((m.cost / e.cost) * 100)}%`;
          assert(name === m.model, `Models row ${i + 1} is ${name}, not ${m.model}`);
          assert(cost === money(m.cost), `${m.model} cost ${cost}, not ${money(m.cost)}`);
          assert(share === pct, `${m.model} share ${share}, not ${pct}`);
        });
        assert(!modelRows.some((r) => r[0].includes('unpriced')), 'a model with no price is listed in Models');
      } finally {
        await closeTabs(ctx.page, OVERVIEW_TAB);
      }
    },
  },
  {
    name: 'overview-cost-chart',
    prompt: 'E2E overview chart',
    async run(ctx) {
      try {
        const frame = await openOverview(ctx);
        await showProjects(frame, [NORTH, SOUTH]);
        const e = expectOverview(30, [NORTH, SOUTH]);
        await waitForTotals(frame, e, 'the 30 days');
        assert(clean(await frame.textContent('.chart-card h2')) === 'Cost per day', 'the chart is not titled Cost per day');
        // One bar per day, each saying its day, cost, sessions and the cost of each model, in the order of the legend.
        const slots = await frame.$$eval('.bar-slot', (els) => els.map((el) => el.getAttribute('aria-label')));
        assert(slots.length === e.buckets.length, `the chart has ${slots.length} bars, not ${e.buckets.length}`);
        for (let i = 0; i < e.buckets.length; i++) {
          const b = e.buckets[i];
          const parts = Object.entries(b.byModel)
            .sort((x, y) => e.series.indexOf(x[0]) - e.series.indexOf(y[0]))
            .map(([m, c]) => `; ${m} ${money(c)}`)
            .join('');
          const want = `${await longDay(frame, b.day)}: ${money(b.cost)}, ${plural(b.sessions.size, 'session')}${parts}`;
          assert(slots[i] === want, `bar ${i + 1} says "${slots[i]}", not "${want}"`);
        }
        assert((await frame.$$eval('.bar:not(.empty)', (els) => els.length)) === e.buckets.filter((b) => b.cost > 0).length, 'the bars with no cost are not empty');
        // The legend: each model with what it cost in the range, and the same under Color by Project.
        const legend = async () => texts(frame, '.legend .legend-item');
        assert(
          (await legend()).join('|') === e.series.filter((m) => e.models.some((x) => x.model === m)).map((m) => `${m}${money(e.models.find((x) => x.model === m).cost)}`).join('|'),
          `the legend is ${await legend()}`,
        );
        await frame.click('[data-color-by="project"]');
        await waitFor('the legend to name projects', async () => (await legend()).some((t) => t.startsWith(NORTH)));
        const byProject = Object.fromEntries((await legend()).map((t) => [t.replace(/\$.*$|<.*$/, ''), t.slice(t.search(/[$<]/))]));
        for (const p of e.projects) assert(byProject[p.name] === money(p.cost), `the legend gives ${p.name} ${byProject[p.name]}, not ${money(p.cost)}`);
        const projectBar = (await frame.$$eval('.bar-slot', (els) => els.map((el) => el.getAttribute('aria-label'))))[e.buckets.findIndex((b) => b.cost > 0)];
        assert(projectBar.includes(`; ${NORTH} `) || projectBar.includes(`; ${SOUTH} `), `a bar does not split by project: ${projectBar}`);
        await frame.click('[data-color-by="total"]');
        await waitFor('the legend to go', async () => (await frame.$$('.legend')).length === 0);
        assert(!(await frame.$$eval('.bar-slot', (els) => els.some((el) => el.getAttribute('aria-label').includes(';')))), 'plain bars still split their cost');
        await frame.click('[data-color-by="model"]');
        await waitFor('the model legend', async () => (await legend()).some((t) => t.startsWith('sonnet-4-5')));
        // Hovering a bar shows that day's breakdown.
        const i = e.buckets.findIndex((b) => b.cost > 0 && Object.keys(b.byModel).length);
        const b = e.buckets[i];
        await frame.hover(`.bar-slot[data-i="${i}"]`);
        await frame.waitForSelector('#tip:not([hidden])', { timeout: 5_000 });
        const tip = clean(await frame.textContent('#tip'));
        assert(tip.includes(await longDay(frame, b.day)), `the tooltip does not name its day: ${tip}`);
        assert(tip.includes(`Cost${money(b.cost)}`), `the tooltip does not give the cost ${money(b.cost)}: ${tip}`);
        assert(tip.includes(`Sessions${b.sessions.size}`), `the tooltip does not count ${b.sessions.size} sessions: ${tip}`);
        for (const [m, c] of Object.entries(b.byModel)) assert(tip.includes(`${m}${money(c)}`), `the tooltip does not split ${m} ${money(c)}: ${tip}`);
        await frame.hover('h1');
        await waitFor('the tooltip to go', () => frame.$eval('#tip', (el) => el.hidden));
      } finally {
        await closeTabs(ctx.page, OVERVIEW_TAB);
      }
    },
  },
  {
    name: 'overview-ranges',
    prompt: 'E2E overview ranges',
    async run(ctx) {
      try {
        const frame = await openOverview(ctx);
        await showProjects(frame, [NORTH, SOUTH]);
        // Each range covers the sessions active in it, and has one bar for each day: the billing export is nine days old,
        // the legacy importer forty.
        for (const range of [7, 30, 90, 0, 'week', 'month']) {
          const e = expectOverview(range, [NORTH, SOUTH]);
          await chooseRange(frame, range);
          await waitForTotals(frame, e, `the ${range} range`);
          // Two ranges can share their totals (90 days and all time here), so wait for the bars of this one.
          const barCount = () => frame.$$eval('.bar-slot', (els) => els.length);
          await waitFor(`the ${range} range to have ${e.buckets.length} bars (has ${await barCount()})`, async () => (await barCount()) === e.buckets.length, 10_000).catch((err) => {
            throw new Error(`the ${range} range does not have ${e.buckets.length} bars: ${err.message}`);
          });
          const k = await kpis(frame);
          assert(k.Prompts.value === String(e.prompts), `the ${range} range counts ${k.Prompts.value} prompts, not ${e.prompts}`);
          assert(k.Cost.value === money(e.cost), `the ${range} range costs ${k.Cost.value}, not ${money(e.cost)}`);
        }
        // Their reach, stated outright rather than only worked out: the old sessions are in all time and not before.
        await chooseRange(frame, 30);
        const at30 = expectOverview(30, [NORTH, SOUTH]);
        const at7 = expectOverview(7, [NORTH, SOUTH]);
        const all = expectOverview(0, [NORTH, SOUTH]);
        assert(at7.sessions === at30.sessions - 1 && all.sessions === at30.sessions + 1, 'the seeded sessions no longer fall on both sides of 7 and 30 days');
        assert(all.buckets.length >= 41, `all time has ${all.buckets.length} bars, fewer than the days back to the oldest session`);
        // The range is kept when the projects change.
        await chooseRange(frame, 7);
        await waitForTotals(frame, at7, '7 days');
        await frame.click(`.link[data-only]:has-text("${NORTH}")`);
        await waitForTotals(frame, expectOverview(7, [NORTH]), '7 days on north');
        assert((await frame.getAttribute('[data-range="7"]', 'aria-checked')) === 'true', 'choosing a project changed the range');
      } finally {
        await closeTabs(ctx.page, OVERVIEW_TAB);
      }
    },
  },
  {
    name: 'overview-sessions-list',
    prompt: 'E2E overview sessions',
    async run(ctx) {
      try {
        const frame = await openOverview(ctx);
        await showProjects(frame, [NORTH, SOUTH]);
        const e = expectOverview(30, [NORTH, SOUTH]);
        await waitForTotals(frame, e, 'the 30 days');
        const rows = () =>
          frame.$$eval('.session', (els) =>
            els.map((el) => ({
              title: el.querySelector('.session-title').textContent.trim(),
              tags: [...el.querySelectorAll('.session-meta .tag')].map((t) => (t.textContent || '').replace(/\s+/g, ' ').trim()),
              agent: el.querySelector('.tag.agent')?.textContent.trim() ?? '',
              cost: el.querySelector('.session-cost').textContent.trim(),
            })),
          );
        // Most recently active first, each with its project, agent, prompt count and cost in the range.
        const expectRows = (list) =>
          list.map((l) => ({ title: l.session.title, agent: l.session.agent ?? '', cost: money(l.cost), prompts: String(l.session.turns.length), project: l.session.project }));
        const check = async (list, what) => {
          const got = await rows();
          const want = expectRows(list);
          assert(got.length === want.length, `${what} lists ${got.map((r) => r.title).join(', ')}, not ${want.map((r) => r.title).join(', ')}`);
          want.forEach((w, i) => {
            const g = got[i];
            assert(g.title === w.title, `${what} row ${i + 1} is "${g.title}", not "${w.title}"`);
            assert(g.agent === w.agent, `"${w.title}" shows the agent "${g.agent}", not "${w.agent}"`);
            assert(g.cost === w.cost, `"${w.title}" costs ${g.cost}, not ${w.cost}`);
            assert(g.tags[0] === w.project, `"${w.title}" shows the project "${g.tags[0]}", not "${w.project}"`);
            assert(g.tags.includes(w.prompts), `"${w.title}" does not count ${w.prompts} prompts: ${g.tags}`);
          });
        };
        assert(clean(await frame.textContent('.card:has(.sessions) .card-head .muted')) === 'most recently active', 'the list does not start on the most recent');
        await check(e.recent, 'the recent list');
        assert(e.recent.some((l) => l.session.agent === 'planner') && e.recent.some((l) => !l.session.agent), 'the seeded sessions do not mix an agent and none');
        // Most expensive: cost in this range, and a session with no priced usage is left out.
        await frame.click('[data-sort="cost"]');
        await waitFor('the most expensive list', async () => /most expensive/.test(await frame.textContent('.card:has(.sessions) .card-head .muted')));
        await check(e.top, 'the most expensive list');
        assert(!(await rows()).some((r) => r.title === byId[NOPRICE].title), 'a session with no priced usage is in the most expensive list');
        await frame.click('[data-sort="recent"]');
        await waitFor('the recent list again', async () => (await rows()).length === e.recent.length);
        // Clicking a session reads its transcript.
        await frame.click(`.session:has-text("${byId[AUTH].title}")`);
        await waitFor('the transcript tab', async () => (await tabsWith(ctx.page, byId[AUTH].title).count()) > 0);
        await transcript(asCtx(ctx, AUTH));
      } finally {
        await closeTabs(ctx.page, byId[AUTH].title);
        await closeTabs(ctx.page, OVERVIEW_TAB);
      }
    },
  },
  {
    name: 'overview-card-figures',
    prompt: 'E2E overview card',
    async run(ctx) {
      await withSidebarGroups(ctx, async (frame) => {
        const auth = COST_OF[AUTH];
        // The cost, always; the context once it is more than half full, and yellow from 80%; the cache while it is warm.
        const a = card(frame, AUTH);
        await a.waitFor({ timeout: 10_000 });
        const costTag = (c) => c.locator('.tag[title^="Cost at Claude API prices"]');
        assert(clean(await costTag(a).textContent()) === usd(auth.cost), `the card does not show the cost ${usd(auth.cost)}`);
        const ctxTag = a.locator('.tag.ctx');
        const pct = Math.round((auth.used / auth.limit) * 100);
        assert(clean(await ctxTag.textContent()) === `${pct}%`, `the card does not show the context at ${pct}%`);
        assert(/\bwarn\b/.test(await ctxTag.getAttribute('class')), 'the card does not warn at 85% of the context');
        assert((await ctxTag.getAttribute('title')).includes(`${pct}% full at the last request`), 'the context badge does not explain itself');
        const cacheTag = a.locator('.tag.cache');
        assert(/^\d+m$/.test(clean(await cacheTag.textContent())), `the warm cache shows "${clean(await cacheTag.textContent())}", not minutes left`);
        const left = Number(clean(await cacheTag.textContent()).replace('m', ''));
        assert(left >= 40 && left <= 55, `a 1-hour cache last used about nine minutes ago has ${left} minutes left`);
        assert(clean(await a.locator('.tag.agent').textContent()) === 'planner', 'the card does not show its agent');
        // Half full is shown but not warned about, and an expired cache is not shown at all.
        const c = card(frame, CACHE);
        const cacheCost = COST_OF[CACHE];
        assert(clean(await costTag(c).textContent()) === usd(cacheCost.cost), `the card does not show the cost ${usd(cacheCost.cost)}`);
        const cpct = Math.round((cacheCost.used / cacheCost.limit) * 100);
        assert(clean(await c.locator('.tag.ctx').textContent()) === `${cpct}%`, `the card does not show the context at ${cpct}%`);
        assert(!/\bwarn\b/.test(await c.locator('.tag.ctx').getAttribute('class')), 'the card warns at 52% of the context');
        assert((await c.locator('.tag.cache').count()) === 0, 'the card shows a prompt cache that expired two hours ago');
        // A small context shows no badge, and a session with no priced usage shows no cost.
        const b = card(frame, BILLING);
        assert(clean(await costTag(b).textContent()) === usd(COST_OF[BILLING].cost), `the card does not show the cost ${usd(COST_OF[BILLING].cost)}`);
        assert((await b.locator('.tag.ctx, .tag.cache').count()) === 0, 'a small context or a cold cache is shown on the card');
        assert((await costTag(card(frame, NOPRICE)).count()) === 0, 'a session with no priced usage shows a cost');
      });
    },
  },
  {
    name: 'overview-transcript-figures',
    prompt: 'E2E overview transcript',
    async run(ctx) {
      try {
        const t = COST_OF[AUTH];
        await withSidebarGroups(ctx, async (frame) => {
          await frame.click(`.card[data-id$=":${AUTH}"]`);
        });
        const frame = await transcript(asCtx(ctx, AUTH));
        const tiles = async () =>
          Object.fromEntries(
            await frame.$$eval('.stats .stat', (els) =>
              els.map((el) => [
                el.querySelector('.stat-label').textContent.trim(),
                { value: (el.querySelector('.stat-value').textContent || '').replace(/\s+/g, ' ').trim(), sub: (el.querySelector('.stat-sub')?.textContent || '').replace(/\s+/g, ' ').trim(), warn: el.classList.contains('warn') },
              ]),
            ),
          );
        await waitFor('the cache tile to count down', async () => /left$/.test((await tiles())['Prompt cache']?.value ?? ''));
        const k = await tiles();
        const eq = (got, want, what) => assert(got === want, `${what}: "${got}", not "${want}"`);
        // Context: how full the window was at the last request, warned about from 80%.
        eq(k.Context.value, `${tokens(t.used)} / ${tokens(t.limit)}`, 'the Context tile');
        eq(k.Context.sub, `${Math.round((t.used / t.limit) * 100)}% full at the last request`, 'the Context note');
        assert(k.Context.warn, 'the Context tile does not warn at 85%');
        // Prompt cache: a countdown, and which cache it is.
        assert(/^\d+m left$/.test(k['Prompt cache'].value), `the cache tile says "${k['Prompt cache'].value}"`);
        eq(k['Prompt cache'].sub, 'Warm · 1-hour cache', 'the cache note');
        // Cost and requests, and the tokens in and out with the share read from the cache.
        eq(k['Cost at API prices'].value, usd(t.cost), 'the Cost tile');
        eq(k['Cost at API prices'].sub, `${t.requests} requests`, 'the requests');
        const input = t.tokens.input + t.tokens.cacheWrite5m + t.tokens.cacheWrite1h + t.tokens.cacheRead;
        eq(k.Tokens.value, `${tokens(input)} in · ${tokens(t.tokens.output)} out`, 'the Tokens tile');
        eq(k.Tokens.sub, `${Math.round((t.tokens.cacheRead / input) * 100)}% of input read from cache`, 'the Tokens note');
        // The cost breakdown, a row for each kind of token that was used, adding up to the cost.
        await frame.click('.cost-breakdown summary');
        const rows = await frame.$$eval('.cost-breakdown tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => (td.textContent || '').trim())));
        const labels = { input: 'Input', cacheWrite5m: 'Cache writes, 5 minutes', cacheWrite1h: 'Cache writes, 1 hour', cacheRead: 'Cache reads', output: 'Output' };
        const want = Object.keys(labels).filter((key) => t.tokens[key] > 0);
        assert(rows.length === want.length, `the breakdown has ${rows.map((r) => r[0])}, not ${want.map((key) => labels[key])}`);
        for (let i = 0; i < want.length; i++) {
          const key = want[i];
          const n = await frame.evaluate((v) => v.toLocaleString(), t.tokens[key]);
          assert(rows[i].join('|') === `${labels[key]}|${n}|${usd(t.costs[key])}`, `the breakdown row ${labels[key]} is ${rows[i].join(' | ')}, not ${n} tokens for ${usd(t.costs[key])}`);
        }
        eq(clean(await frame.textContent('.cost-breakdown tfoot')), `Total${usd(t.cost)}`, 'the breakdown total');
        // The top bar keeps the same figures while the tiles are out of view.
        const strip = clean(await frame.textContent('.strip-stats'));
        for (const part of [`${tokens(t.used)} / ${tokens(t.limit)} · ${Math.round((t.used / t.limit) * 100)}%`, usd(t.cost), `${tokens(input)} in · ${tokens(t.tokens.output)} out`]) {
          assert(strip.includes(part), `the top bar's figures lack "${part}": ${strip}`);
        }
        assert(/cache \d+m left/.test(strip), `the top bar does not count down the cache: ${strip}`);
        assert((await frame.$eval('.strip-stats [title="Context window at the last request"]', (el) => el.classList.contains('warn'))) === true, 'the top bar does not warn at 85% of the context');
        // The message box says why not to simply resume.
        await waitFor('the message box to explain the context', async () => /Context is 85% full\./.test(await frame.textContent('#composer-status')));
      } finally {
        await closeTabs(ctx.page, byId[AUTH].title);
      }
    },
  },
  {
    name: 'overview-transcript-cold-and-unpriced',
    prompt: 'E2E overview cold cache',
    async run(ctx) {
      try {
        await withSidebarGroups(ctx, async (frame) => {
          await frame.click(`.card[data-id$=":${CACHE}"]`);
        });
        const frame = await transcript(asCtx(ctx, CACHE));
        const t = COST_OF[CACHE];
        const tile = async (label) => frame.$$eval('.stats .stat', (els, l) => {
          const el = els.find((e) => e.querySelector('.stat-label').textContent.trim() === l);
          return el && { value: (el.querySelector('.stat-value').textContent || '').replace(/\s+/g, ' ').trim(), sub: (el.querySelector('.stat-sub')?.textContent || '').replace(/\s+/g, ' ').trim(), warn: el.classList.contains('warn') };
        }, label);
        await waitFor('the cache tile to say it expired', async () => (await tile('Prompt cache'))?.value === 'Expired');
        // Last used two hours and ninety seconds before the page was opened, with the 5-minute cache.
        const cache = await tile('Prompt cache');
        assert(/^\dh ago$/.test(cache.sub.split(' · ')[0]), `the expired cache says "${cache.sub}"`);
        assert(cache.sub.endsWith('5-minute cache'), `the cache note does not name the 5-minute cache: ${cache.sub}`);
        const context = await tile('Context');
        assert(context.value === `${tokens(t.used)} / ${tokens(t.limit)}` && !context.warn, `the Context tile says ${context.value}, warn ${context.warn}`);
        assert((await tile('Cost at API prices')).sub === '1 request', 'a single request is not worded in the singular');
        assert((await tile('Cost at API prices')).value === usd(t.cost), 'the cost is not shown');
        // Resuming would write the whole 104k context to the cache again: the message box says so.
        await waitFor('the message box to explain the expired cache', async () =>
          (await frame.textContent('#composer-status')).includes(`The prompt cache has expired, so resuming would pay to cache all ${Math.round(t.used / 1000)}k tokens again.`),
        );
        assert((await frame.$eval('.strip-stats .cache', (el) => el.textContent.trim())) === 'cache expired', 'the top bar does not say the cache expired');
      } finally {
        await closeTabs(ctx.page, byId[CACHE].title);
      }
    },
  },
  {
    name: 'overview-transcript-unpriced',
    prompt: 'E2E overview unpriced',
    async run(ctx) {
      try {
        await withSidebarGroups(ctx, async (frame) => {
          await frame.click(`.card[data-id$=":${NOPRICE}"]`);
        });
        const frame = await transcript(asCtx(ctx, NOPRICE));
        // The tokens are counted and nothing is costed, and the breakdown says why.
        await waitFor('the cost tile', async () => (await frame.$$('.stats .stat')).length >= 2);
        const text = clean(await frame.textContent('.stats'));
        assert(text.includes('$0.00'), `a model with no price is not costed at $0.00: ${text}`);
        assert(text.includes('5k in · 1k out'), `the unpriced tokens are not counted: ${text}`);
        await frame.click('.cost-breakdown summary');
        assert((await frame.textContent('.cost-breakdown .note')).includes(`No price is known for ${byId[NOPRICE].turns[0].model}`), 'the breakdown does not name the model with no price');
      } finally {
        await closeTabs(ctx.page, byId[NOPRICE].title);
      }
    },
  },
  {
    name: 'overview-session-details-costs',
    prompt: 'E2E overview details',
    async run(ctx) {
      try {
        await withSidebarGroups(ctx, async (frame) => {
          await frame.click(`.card[data-id$=":${AUTH}"]`);
        });
        const frame = await transcript(asCtx(ctx, AUTH));
        // Session details: the prompts, each with what answering it cost, and a bar that grows with the cost.
        if (!(await frame.$eval('body', (b) => b.classList.contains('side-open')))) await frame.click('#side-toggle');
        await waitFor('the details panel to open', () => frame.isVisible('#side-body'));
        const costs = await texts(frame, '.side-row.prompt .side-cost');
        const turns = byId[AUTH].turns.map((turn) => usd(priced(turn).cost));
        assert(costs.length === turns.length, `the details panel shows ${costs.length} prompt costs, not ${turns.length}`);
        turns.forEach((c, i) => assert(costs[i].startsWith(c), `prompt ${i + 1} costs ${costs[i]} in the details panel, not ${c}`));
        const titles = await frame.$$eval('.side-row.prompt .side-cost', (els) => els.map((e) => e.title));
        byId[AUTH].turns.forEach((turn, i) => {
          const u = turn.usage;
          const want = `1 request, ${tokens(u.output_tokens)} output tokens`;
          assert(titles[i].startsWith(want), `prompt ${i + 1}'s figures say "${titles[i]}", not "${want}..."`);
        });
        // The same figures sit beside each prompt in the conversation.
        const chips = await texts(frame, '.msg.user .turn-chip');
        turns.forEach((c, i) => assert(chips[i]?.startsWith(c), `prompt ${i + 1} shows ${chips[i]} beside it, not ${c}`));
        const bars = await frame.$$eval('.side-bar span', (els) => els.map((e) => Number(e.dataset.fill)));
        assert(bars.length === 2 && Math.max(...bars) === 1, `the cost bars are ${bars}`);
        assert(bars[0] > bars[1] === priced(byId[AUTH].turns[0]).cost > priced(byId[AUTH].turns[1]).cost, 'the cost bars do not follow the costs');
      } finally {
        await closeTabs(ctx.page, byId[AUTH].title);
      }
    },
  },
];

export default {
  name: 'overview',
  seed,
  scenarios,
};
