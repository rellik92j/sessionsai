// The transcript area: reading a session as a chat. Tool rows, the tool-call switch and jump to latest, the pills and
// cards for mid-turn prompts, other sessions' messages and subagent runs, opening from a search, the details panel,
// what each prompt cost, and a log that grows while its tab is open. See docs/dev/e2e.md for how to add a scenario.
//
// Each scenario's session is a log built here from real Claude Code record shapes and synthetic text (`log`, and `files`
// for a subagent's own log), written before VS Code starts. The ones that watch a log grow append to it through the
// `Log` that built it.

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { assert, frameWith, logPath, openTranscript, sidebar, transcript, waitFor } from '../harness.mjs';

// ---------- building logs ----------

const FILLER_PARAGRAPHS = 60;

/** Paragraphs of filler, so a message is tall enough to scroll. */
const filler = (n = FILLER_PARAGRAPHS) => Array.from({ length: n }, (_, i) => `Filler paragraph ${i + 1} of this reply, only there to make the page tall.`).join('\n\n');

/** One synthetic Claude Code log, built record by record; `sec` is seconds after the session's start. */
class Log {
  constructor({ id, cwd }) {
    this.id = id;
    this.cwd = cwd;
    this.start = Date.now() - 30 * 3600 * 1000;
    this.lines = [];
    this.n = 0;
    this.last = null;
    this.msgs = 0;
    this.tools = 0;
  }

  uuid() {
    return `${this.id.slice(0, 8)}-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
  }

  /** The common fields every record carries, chained to the one before it unless `parent` says otherwise. */
  base(sec, parent) {
    const uuid = this.uuid();
    const rec = {
      parentUuid: parent === undefined ? this.last : parent,
      isSidechain: false,
      uuid,
      timestamp: new Date(this.start + sec * 1000).toISOString(),
      userType: 'external',
      entrypoint: 'cli',
      cwd: this.cwd,
      sessionId: this.id,
      version: '2.1.332',
      gitBranch: 'main',
    };
    return rec;
  }

  push(rec) {
    this.lines.push(JSON.stringify(rec));
    this.last = rec.uuid;
    return rec;
  }

  user(sec, text, extra = {}) {
    return this.push({ ...this.base(sec), type: 'user', message: { role: 'user', content: text }, ...extra });
  }

  /** An assistant record. `content` is an array of parts; `out` is the request's output tokens, which set its cost. */
  assistant(sec, content, { out = 100, parent, model = 'claude-opus-5-5' } = {}) {
    const message = {
      id: `msg_e2e_${++this.msgs}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    return this.push({ ...this.base(sec, parent), type: 'assistant', message });
  }

  text(sec, text, opts) {
    return this.assistant(sec, [{ type: 'text', text }], opts);
  }

  /** A tool call: returns its id, to answer with `result`. */
  tool(sec, name, input, opts) {
    const id = `toolu_e2e_${++this.tools}`;
    this.assistant(sec, [{ type: 'tool_use', id, name, input }], opts);
    return id;
  }

  result(sec, toolId, content, { isError = false, extra = {} } = {}) {
    return this.push({
      ...this.base(sec),
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: toolId, type: 'tool_result', content, is_error: isError }] },
      ...extra,
    });
  }

  /** An attachment record, as Claude Code logs a prompt typed mid-turn. */
  attachment(sec, attachment) {
    return this.push({ ...this.base(sec), type: 'attachment', attachment: { ...attachment, timestamp: new Date(this.start + sec * 1000).toISOString() } });
  }

  text_() {
    return this.lines.join('\n') + '\n';
  }

  /** Records added to the log file of a running session; returns once they are written. */
  flush(s, from) {
    appendFileSync(logPath(s, this.id), this.lines.slice(from).join('\n') + '\n');
  }
}

/** Logs by session id, so a scenario that appends carries on from the log it started with. */
const logs = new Map();
const logOf = (info, build) => {
  const log = new Log(info);
  build(log);
  logs.set(info.id, log);
  return log.text_();
};

// ---------- reading what is on the page ----------

const page = (ctx) => transcript(ctx);
const text = async (ctx, selector) => (await page(ctx)).$$eval(selector, (els) => els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()));
const count = async (ctx, selector) => (await page(ctx)).$$eval(selector, (els) => els.length);
/** Distance from the bottom of the page, and whether the element is in the window. */
const fromBottom = async (ctx) => (await page(ctx)).evaluate(() => document.documentElement.scrollHeight - (window.scrollY + window.innerHeight));
const inView = async (ctx, selector, nth = 0) =>
  (await page(ctx)).$$eval(selector, (els, i) => {
    const r = els[i]?.getBoundingClientRect();
    return !!r && r.bottom > 0 && r.top < window.innerHeight;
  }, nth);

// ---------- tool rows ----------

/** A session with an edit, a command that worked and one that failed. */
function toolsLog(cwd, log, prompt) {
  log.user(0, prompt);
  log.text(5, 'Looking at the config.');
  const edit = log.tool(10, 'Edit', { file_path: path.join(cwd, 'src', 'app.ts'), old_string: 'const mode = "slow";', new_string: 'const mode = "fast";' });
  log.result(12, edit, 'The file src/app.ts has been updated.');
  const test = log.tool(20, 'Bash', { command: 'npm test', description: 'Run the tests' });
  log.result(25, test, '12 passing\nall checks done');
  const lint = log.tool(30, 'Bash', { command: 'npm run lint', description: 'Lint the sources' });
  log.result(35, lint, 'lint failed: unexpected token on line 3', { isError: true });
  log.text(40, 'Two of the three steps worked.');
}

const TOOLS_PROMPT = 'E2E transcript tool rows';
const HIDE_PROMPT = 'E2E transcript hide tool calls';

// ---------- search ----------

const NEEDLE = 'zephyrquartz';
const SEARCH_PROMPT = 'E2E transcript opened from a search';

function searchLog(log) {
  log.user(0, SEARCH_PROMPT);
  log.text(5, `The ${NEEDLE} loader runs first.\n\n${filler(40)}`);
  const lookup = log.tool(10, 'Bash', { command: `grep -r ${NEEDLE} src` });
  log.result(12, lookup, `src/loader.ts: ${NEEDLE}`);
  log.user(20, `Where is ${NEEDLE} configured?`);
  log.text(25, `It is configured in ${NEEDLE}.json, next to the loader.\n\n${filler(40)}`);
  log.user(40, 'Thanks, that covers it.');
  log.text(45, 'Glad to help.');
}

// ---------- special messages ----------

const MID_TURN = 'Also check the docs when you are done.';
const SPECIAL_PROMPT = 'E2E transcript special messages';
const RUN_PROMPT = 'E2E transcript subagent run';
const AGENT = 'a1e2e2e2e2e2e2e2e';

function specialLog(log) {
  log.user(0, SPECIAL_PROMPT);
  const run = log.tool(5, 'Bash', { command: 'npm run build' });
  // Typed while Claude was working: logged as a queued command, folded into the running turn.
  log.attachment(8, { type: 'queued_command', prompt: MID_TURN, commandMode: 'prompt', origin: { kind: 'human' }, source_uuid: log.uuid(), delivery_id: log.uuid() });
  log.result(10, run, 'built in 2s');
  log.text(15, 'The build finished.');
  // Another session's message, between turns.
  log.push({
    ...log.base(60),
    type: 'user',
    isMeta: true,
    message: { role: 'user', content: '<cross-session-message from-name="Docs Lead">Can you link the notes from the README?</cross-session-message>' },
  });
}

function runLog(log) {
  log.user(0, RUN_PROMPT);
  log.text(5, 'A subagent checks the release first.');
  const call = log.tool(10, 'Agent', { subagent_type: 'release-checker', description: 'Check the release', prompt: 'Check that the release is ready to ship and report back.' });
  log.result(60, call, [{ type: 'text', text: 'The release is ready.' }, { type: 'text', text: `agentId: ${AGENT} (use SendMessage with to: '${AGENT}' to continue this agent)` }], {
    extra: { toolUseResult: { status: 'completed', agentId: AGENT, agentType: 'release-checker' } },
  });
  log.text(65, 'The checker is done.');
}

/** The subagent's own log, beside the session's, in the layout Claude Code writes. */
function runFiles({ id, cwd }) {
  const side = (n, rec) => JSON.stringify({ isSidechain: true, agentId: AGENT, sessionId: id, cwd, uuid: `${AGENT}-${n}`, timestamp: new Date(Date.now() - 29 * 3600 * 1000 + n * 1000).toISOString(), ...rec });
  const lines = [
    side(1, { type: 'user', message: { role: 'user', content: 'Check that the release is ready to ship and report back.' } }),
    side(2, {
      type: 'assistant',
      message: { id: 'msg_e2e_run1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Checked every item on the release list.' }], usage: { input_tokens: 500, output_tokens: 40 } },
    }),
  ];
  const meta = { agentType: 'release-checker', description: 'Check the release', toolUseId: 'toolu_e2e_1', spawnDepth: 1, finished: true };
  return {
    [`${id}/subagents/agent-${AGENT}.jsonl`]: lines.join('\n') + '\n',
    [`${id}/subagents/agent-${AGENT}.meta.json`]: JSON.stringify(meta),
  };
}

// ---------- details panel ----------

const DETAILS_PROMPT = 'E2E transcript details panel';

function detailsLog(log) {
  log.user(0, DETAILS_PROMPT);
  const edit = log.tool(5, 'Edit', { file_path: path.join(log.cwd, 'src', 'app.ts'), old_string: 'a', new_string: 'b' });
  log.result(6, edit, 'Edited.');
  const write = log.tool(10, 'Write', { file_path: path.join(log.cwd, 'notes', 'plan.md'), content: '# Plan' });
  log.result(11, write, 'Created.');
  const todos = log.tool(15, 'TodoWrite', { todos: [{ content: 'Write the tests', status: 'completed', activeForm: 'Writing the tests' }, { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' }] });
  log.result(16, todos, 'Todos updated.');
  const skill = log.tool(20, 'Skill', { skill: 'start-change' });
  log.result(21, skill, 'Launching skill.');
  const web = log.tool(25, 'WebFetch', { url: 'https://example.com/docs', prompt: 'Summarise' });
  log.result(26, web, 'A page.');
  log.text(30, `First prompt done.\n\n${filler(20)}`);
  log.user(60, 'Second prompt: add caching.');
  log.text(65, `Caching added.\n\n${filler(20)}`);
  log.user(90, 'Third prompt: write it up.');
  log.text(95, `Written up.\n\n${filler(20)}`);
}

// ---------- cost ----------

const COST_PROMPT = 'E2E transcript per-prompt cost';

/** Cost is (1000 input x $4 + output x $20) per million tokens; the first prompt runs 2 minutes, the second 45 seconds. */
function costLog(log) {
  log.user(0, COST_PROMPT);
  log.text(120, 'The first answer.', { out: 5000 });
  log.user(200, 'A second, bigger question.');
  log.text(245, 'The second answer.', { out: 20000 });
}

// ---------- live updates ----------

const LIVE_PROMPT = 'E2E transcript live update';
const BRANCH_PROMPT = 'E2E transcript other branch';

function liveLog(log) {
  log.user(0, LIVE_PROMPT);
  const run = log.tool(5, 'Bash', { command: 'npm test' });
  log.result(8, run, 'all passing');
  log.text(10, `The first answer.\n\n${filler()}`);
}

function branchLog(log) {
  log.user(0, BRANCH_PROMPT);
  log.text(5, 'The first answer.');
  log.user(20, 'The second question.');
  log.text(25, 'The second answer.');
}

// ---------- scenarios ----------

export default {
  name: 'transcript',
  scenarios: [
    {
      name: 'transcript-tool-rows',
      prompt: TOOLS_PROMPT,
      log: (info) => logOf(info, (log) => toolsLog(info.cwd, log, TOOLS_PROMPT)),
      async run(ctx) {
        await openTranscript(ctx);
        const [head] = await text(ctx, '.tool-group-head');
        assert(/3 tool calls/.test(head) && /1 failed/.test(head), `the tool group should say 3 tool calls, 1 failed; it says "${head}"`);
        assert((await count(ctx, 'details.tool')) === 3, 'three tool rows');
        assert((await count(ctx, 'details.tool[open]')) === 0, 'tool rows start closed');
        assert((await count(ctx, 'details.tool .status.ok')) === 2 && (await count(ctx, 'details.tool .status.error')) === 1, 'two rows show a check and one shows the failure mark');
        const row = async (i) => (await page(ctx)).locator('details.tool').nth(i);
        const open = async (i) => {
          await (await row(i)).locator('summary').click();
          await waitFor(`tool row ${i + 1} to open`, async () => (await row(i)).evaluate((el) => el.open));
          return (await row(i)).locator('.tool-body').innerText();
        };
        // An edit shows what it replaced and what it put there.
        const edit = await open(0);
        assert(/slow/.test(edit) && /fast/.test(edit), `the edit's body should show its change; it shows "${edit}"`);
        const diff = await (await row(0)).locator('.diff').innerText();
        assert(/const mode = "slow"/.test(diff) && /const mode = "fast"/.test(diff), 'the edit shows as a diff');
        assert((await (await row(0)).locator('.diff pre.del').count()) === 1 && (await (await row(0)).locator('.diff pre.add').count()) === 1, 'the diff has a removed and an added side');
        // A command shows its input and its output.
        const ok = await open(1);
        assert(/npm test/.test(ok) && /12 passing/.test(ok), `the command's body should show input and output; it shows "${ok}"`);
        // A failed one shows its error.
        const bad = await open(2);
        assert(/lint failed/.test(bad), `the failed command's body should show its error; it shows "${bad}"`);
        assert((await (await row(2)).locator('pre.error').count()) === 1, 'the error output is marked as an error');
        // Clicking again closes it.
        await (await row(1)).locator('summary').click();
        await waitFor('tool row 2 to close', async () => !(await (await row(1)).evaluate((el) => el.open)));
      },
    },
    {
      name: 'transcript-hide-tool-calls',
      prompt: HIDE_PROMPT,
      log: (info) => logOf(info, (log) => toolsLog(info.cwd, log, HIDE_PROMPT)),
      async run(ctx) {
        await openTranscript(ctx);
        const frame = await page(ctx);
        assert(await frame.isVisible('.tool-group'), 'tool calls show to begin with');
        assert((await text(ctx, '[data-tool-label]'))[0] === 'Show 3 tool calls', 'the switch counts the tool calls');
        try {
          await frame.click('.hero .switch');
          await waitFor('the tool calls to hide', async () => !(await (await page(ctx)).isVisible('.tool-group')));
          const states = await (await page(ctx)).$$eval('[data-tools-toggle]', (els) => els.map((e) => e.checked));
          assert(states.length >= 2 && states.every((c) => !c), 'the hero switch and the top bar switch both turn off');
          assert(await (await page(ctx)).isVisible('.msg.assistant .md'), 'the replies stay when the tool calls hide');
        } finally {
          // The choice is kept in the tab, so put it back for the scenarios after this one.
          const again = await page(ctx);
          if (await again.$eval('body', (b) => b.classList.contains('hide-tools'))) await again.click('.hero .switch');
        }
        await waitFor('the tool calls to show again', async () => (await page(ctx)).isVisible('.tool-group'));
      },
    },
    {
      name: 'transcript-jump-to-latest',
      prompt: 'E2E transcript jump to latest',
      log: (info) => logOf(info, (log) => {
        log.user(0, 'E2E transcript jump to latest');
        log.text(5, `A long answer.\n\n${filler()}\n\nThe very last line.`);
      }),
      async run(ctx) {
        await openTranscript(ctx);
        // A transcript opens at the latest message, like a chat.
        await waitFor('the page to open at its bottom', async () => (await fromBottom(ctx)) <= 80);
        assert(!(await (await page(ctx)).$eval('#jump', (b) => b.classList.contains('visible'))), 'no jump button while at the bottom');
        await (await page(ctx)).evaluate(() => window.scrollTo(0, 0));
        await waitFor('the jump button to show once scrolled up', async () => (await page(ctx)).$eval('#jump', (b) => b.classList.contains('visible')));
        await (await page(ctx)).click('#jump');
        await waitFor('the page to be back at its bottom', async () => (await fromBottom(ctx)) <= 80);
        await waitFor('the jump button to go', async () => !(await (await page(ctx)).$eval('#jump', (b) => b.classList.contains('visible'))));
      },
    },
    {
      name: 'transcript-mid-turn-and-session-messages',
      prompt: SPECIAL_PROMPT,
      log: (info) => logOf(info, specialLog),
      async run(ctx) {
        await openTranscript(ctx);
        // A prompt typed while Claude worked shows with the "sent mid-turn" pill.
        const user = await text(ctx, '.msg.user');
        const mid = user.find((t) => t.includes(MID_TURN));
        assert(mid, `the mid-turn prompt should show; the prompts are ${JSON.stringify(user)}`);
        assert(/sent mid-turn/.test(mid), `the mid-turn prompt should carry the "sent mid-turn" pill: "${mid}"`);
        const first = user.find((t) => t.includes(SPECIAL_PROMPT));
        assert(first && !/sent mid-turn/.test(first), 'the typed first prompt has no mid-turn pill');
        // Another session's message is a card of its own, with its sender.
        const peer = (await text(ctx, '.msg.peer'))[0];
        assert(peer, 'a session message card shows');
        assert(/Docs Lead/.test(peer) && /session message/.test(peer) && /link the notes from the README/.test(peer), `the card should name its sender and carry the text: "${peer}"`);
        assert((await count(ctx, '.msg.peer .avatar')) === 1, 'the card has the sender avatar');
      },
    },
    {
      name: 'transcript-subagent-run',
      prompt: RUN_PROMPT,
      log: (info) => logOf(info, runLog),
      files: runFiles,
      async run(ctx) {
        await openTranscript(ctx);
        const card = (await text(ctx, '.msg.subagent'))[0];
        assert(card && /Check the release/.test(card), `the subagent's block should show in the session: "${card}"`);
        assert((await text(ctx, '.msg.subagent .subagent-open'))[0] === 'Open run', 'the block has an Open run button');
        await (await page(ctx)).click('.msg.subagent .subagent-open');
        // The run opens as a transcript of its own log, with no message box.
        const run = await frameWith(ctx.page, 'body.subagent-run', 'the subagent run');
        assert(/Checked every item on the release list/.test(await run.innerText('.conversation')), "the run shows the subagent's own log");
        assert(!(await run.$('#composer')), 'a run has no message box to send to');
        assert((await run.textContent('.topbar-actions [data-cmd="openParent"]')).includes('Back to session'), 'the run has a Back to session button');
        await run.click('.topbar [data-cmd="openParent"]');
        // Back at the session itself.
        const back = await transcript(ctx);
        assert(await back.$('#composer'), 'Back to session shows the session with its message box');
        assert(/A subagent checks the release first/.test(await back.innerText('.conversation')), 'the session is back');
      },
    },
    {
      name: 'transcript-search-highlights',
      prompt: SEARCH_PROMPT,
      log: (info) => logOf(info, searchLog),
      async run(ctx) {
        const side = await sidebar(ctx);
        try {
          await side.fill('#q', NEEDLE);
          // Only this session's transcript has the word; the other cards drop out once the results are in.
          await waitFor('the search to narrow the sessions to this one', async () => {
            const ids = await (await sidebar(ctx)).$$eval('.card', (cs) => cs.map((c) => c.dataset.id));
            return ids.length === 1 && ids[0].endsWith(`:${ctx.id}`);
          });
          await (await sidebar(ctx)).click(`.card[data-id$=":${ctx.id}"]`);
          await frameWith(ctx.page, `body[data-session*="${ctx.id}"][data-highlight]`, 'the transcript opened from the search');
          await waitFor('the matches to be marked', async () => (await count(ctx, 'mark.hit')) === 3);
          const marked = await text(ctx, 'mark.hit');
          assert(marked.every((m) => m.toLowerCase() === NEEDLE), `every match is the searched word: ${JSON.stringify(marked)}`);
          assert((await text(ctx, '.findbar .find-count'))[0] === '1 of 3', 'the find bar starts at the first match');
          assert((await count(ctx, 'mark.hit.current')) === 1 && (await (await page(ctx)).$eval('mark.hit', (m) => m.classList.contains('current'))), 'the first match is the current one');
          assert(await inView(ctx, 'mark.hit', 0), 'the page opens at the first match');
          assert(!(await inView(ctx, 'mark.hit', 2)), 'the last match is further down, out of view');
          assert((await count(ctx, 'details.tool mark.hit')) === 0, 'a match inside a tool call is not marked');
          // F3 and Shift+F3 move between matches.
          const which = async () => (await text(ctx, '.findbar .find-count'))[0];
          const press = async (key) => (await page(ctx)).press('body', key);
          await press('F3');
          await waitFor('F3 to move to the second match', async () => (await which()) === '2 of 3');
          assert(await inView(ctx, 'mark.hit', 1), 'the second match is scrolled into view');
          assert(await (await page(ctx)).$$eval('mark.hit', (ms) => ms[1].classList.contains('current') && !ms[0].classList.contains('current')), 'the current mark moves');
          await press('F3');
          await waitFor('F3 to move to the third match', async () => (await which()) === '3 of 3');
          await press('F3');
          await waitFor('F3 to wrap to the first match', async () => (await which()) === '1 of 3');
          await press('Shift+F3');
          await waitFor('Shift+F3 to wrap back to the last match', async () => (await which()) === '3 of 3');
          // Escape clears the marks.
          await press('Escape');
          await waitFor('Escape to clear the highlights', async () => (await count(ctx, 'mark.hit')) === 0 && (await count(ctx, '.findbar')) === 0);
        } finally {
          await (await sidebar(ctx)).fill('#q', '').catch(() => undefined);
        }
      },
    },
    {
      name: 'transcript-details-panel',
      prompt: DETAILS_PROMPT,
      log: (info) => logOf(info, detailsLog),
      async run(ctx) {
        await openTranscript(ctx);
        // The panel is docked and open in a wide tab and closed in a narrow one: open it either way.
        if (!(await (await page(ctx)).$eval('body', (b) => b.classList.contains('side-open')))) await (await page(ctx)).click('#side-toggle');
        await waitFor('the details panel to open', async () => (await page(ctx)).isVisible('#side-body'));
        const section = (id) => `details[data-section="${id}"]`;
        const sectionText = async (id) => (await text(ctx, `${section(id)} .side-row`));
        const countOf = async (id) => (await text(ctx, `${section(id)} summary .side-count`))[0];
        assert((await countOf('changed')) === '2', 'two files changed');
        const files = await sectionText('changed');
        assert(files.some((f) => /app\.ts/.test(f)) && files.some((f) => /plan\.md/.test(f) && /New/.test(f)), `the changed files should list app.ts and the new plan.md: ${JSON.stringify(files)}`);
        assert(/1 of 2 done/.test((await text(ctx, `${section('todos')} summary`))[0]), 'the to-dos count what is done');
        assert((await sectionText('todos')).some((t) => /Write the tests/.test(t)), 'the to-dos are listed');
        assert((await sectionText('skills')).some((t) => /start-change/.test(t)), 'the skill used is listed');
        assert((await countOf('prompts')) === '3', 'three prompts');
        // A section folds closed and open again.
        const folded = async () => (await page(ctx)).$eval(section('changed'), (d) => d.open);
        assert(await folded(), 'the changed-files section starts open');
        await (await page(ctx)).click(`${section('changed')} summary`);
        await waitFor('the section to fold', async () => !(await folded()));
        await (await page(ctx)).click(`${section('changed')} summary`);
        await waitFor('the section to open again', folded);
        // Web starts folded; opening it shows the page that was fetched.
        assert(!(await (await page(ctx)).$eval(section('web'), (d) => d.open)), 'the web section starts folded');
        await (await page(ctx)).click(`${section('web')} summary`);
        await waitFor('the web section to open', async () => (await sectionText('web')).some((t) => /example\.com\/docs/.test(t)));
        await (await page(ctx)).click(`${section('web')} summary`);
        // Clicking a prompt jumps to it.
        assert(!(await inView(ctx, '#msg-0')), 'the first prompt is out of view while the page sits at its end');
        await (await page(ctx)).click(`${section('prompts')} .side-row.prompt >> nth=0`);
        await waitFor('the page to scroll to the first prompt', async () => inView(ctx, '#msg-0'));
        assert(await (await page(ctx)).$eval('#msg-0', (m) => m.classList.contains('flash')), 'the prompt jumped to is flashed');
      },
    },
    {
      name: 'transcript-prompt-cost',
      prompt: COST_PROMPT,
      log: (info) => logOf(info, costLog),
      async run(ctx) {
        await openTranscript(ctx);
        // 1000 input and 5000 output tokens at $4 and $20 per million: $0.10, in 2 minutes. Then $0.40 in 45 seconds.
        await waitFor('the cost beside each prompt', async () => (await count(ctx, '.msg.user .turn-chip')) === 2);
        assert(JSON.stringify(await text(ctx, '.msg.user .turn-chip')) === JSON.stringify(['$0.10 · 2m', '$0.40 · 45s']), `the prompts' chips: ${JSON.stringify(await text(ctx, '.msg.user .turn-chip'))}`);
        // The details panel has the same figures, beside each prompt.
        if (!(await (await page(ctx)).$eval('body', (b) => b.classList.contains('side-open')))) await (await page(ctx)).click('#side-toggle');
        await waitFor('the details panel to open', async () => (await page(ctx)).isVisible('#side-body'));
        const side = await text(ctx, '.side-row.prompt .side-cost');
        assert(JSON.stringify(side) === JSON.stringify(['$0.10 · 2m', '$0.40 · 45s']), `the details panel's costs: ${JSON.stringify(side)}`);
      },
    },
    {
      name: 'transcript-live-update',
      prompt: LIVE_PROMPT,
      log: (info) => logOf(info, liveLog),
      async run(ctx) {
        await openTranscript(ctx);
        const log = logs.get(ctx.id);
        await waitFor('the page to open at its bottom', async () => (await fromBottom(ctx)) <= 80);
        // Read from the top, with something on the page that a rebuild would lose.
        await (await page(ctx)).evaluate(() => {
          window.scrollTo(0, 0);
          window.__e2eKept = true;
        });
        await waitFor('the page to scroll to its top', async () => (await (await page(ctx)).evaluate(() => window.scrollY)) < 5);
        // The log grows while the reader is up there.
        const from = log.lines.length;
        log.user(100, 'A follow-up question.');
        log.text(105, 'The follow-up answer arrives.');
        log.flush(ctx.s, from);
        await waitFor('the new messages to appear in the open tab', async () => (await text(ctx, '.conversation')).join(' ').includes('The follow-up answer arrives.'), 20_000);
        const frame = await page(ctx);
        assert(await frame.evaluate(() => window.__e2eKept === true), 'the tab was updated in place, not rebuilt');
        assert((await frame.evaluate(() => window.scrollY)) < 5, 'the reader stays where they were');
        await waitFor('the new-messages dot', async () => (await page(ctx)).$eval('#jump', (b) => b.classList.contains('has-new') && b.classList.contains('visible')));
        assert((await (await page(ctx)).$eval('#jump', (b) => b.title)) === 'New messages below', 'the jump button says there are new messages');
        // Going to the latest message clears it.
        await (await page(ctx)).click('#jump');
        await waitFor('the page to reach its bottom', async () => (await fromBottom(ctx)) <= 80);
        await waitFor('the dot to clear', async () => !(await (await page(ctx)).$eval('#jump', (b) => b.classList.contains('has-new'))));
        // At the bottom the page follows along.
        const more = log.lines.length;
        log.text(110, 'One more answer, read as it lands.');
        log.flush(ctx.s, more);
        await waitFor('the next message to appear', async () => (await text(ctx, '.conversation')).join(' ').includes('One more answer, read as it lands.'), 20_000);
        await waitFor('the page to follow the new message', async () => (await fromBottom(ctx)) <= 80);
        assert(!(await (await page(ctx)).$eval('#jump', (b) => b.classList.contains('has-new'))), 'no dot while following along');
        assert(await (await page(ctx)).evaluate(() => window.__e2eKept === true), 'still the same page');
      },
    },
    {
      name: 'transcript-other-branch',
      prompt: BRANCH_PROMPT,
      log: (info) => logOf(info, branchLog),
      async run(ctx) {
        await openTranscript(ctx);
        const log = logs.get(ctx.id);
        assert(!(await text(ctx, '.msg .pill')).some((t) => /other branch/.test(t)), 'no other-branch pill in a log with one line of conversation');
        await (await page(ctx)).evaluate(() => (window.__e2eKept = true));
        // A second Claude Code process answers the first question after the second one was asked: its record is
        // parented on the first answer, not on the second prompt.
        const firstAnswer = log.lines.map((l) => JSON.parse(l)).find((r) => r.type === 'assistant');
        const from = log.lines.length;
        log.text(60, 'A late answer from the other process.', { parent: firstAnswer.uuid });
        log.flush(ctx.s, from);
        await waitFor('the late answer to show', async () => (await text(ctx, '.conversation')).join(' ').includes('A late answer from the other process.'), 20_000);
        const pills = await text(ctx, '.msg.assistant .pill');
        assert(pills.some((t) => /other branch/.test(t)), `the late answer should carry the "other branch" pill: ${JSON.stringify(pills)}`);
        assert((await count(ctx, '.msg.assistant .pill')) === 1, 'only the late answer has the pill');
        // It sits under the question it answers, not at the end.
        const all = (await text(ctx, '.conversation')).join(' ');
        assert(all.indexOf('The first answer.') < all.indexOf('A late answer') && all.indexOf('A late answer') < all.indexOf('The second question.'), 'the late answer sits between the first answer and the second question');
        assert(await (await page(ctx)).evaluate(() => window.__e2eKept === true), 'the tab was updated in place');
      },
    },
  ],
};
