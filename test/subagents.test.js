// Subagent runs in the transcript: read from <sessionId>/subagents/, shown after the call that started them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseSession, parseTranscript, parseSubagentRun, parseAgentMessage } = require('../out/sessionParser');
const { readSubagentRuns } = require('../out/sessionStore');

const dir = path.join(__dirname, 'fixtures', 'claude-subagents', 'C--repo');
const ID = '5e1f0c2a-1111-4222-8333-944455556666';
const OTHER = '7a7a7a7a-1111-4222-8333-944455556666';
const logOf = (id) => path.join(dir, `${id}.jsonl`);
const read = (id) => fs.readFileSync(logOf(id), 'utf8');
const subagentLogs = (id) => {
  const sub = path.join(dir, id, 'subagents');
  return fs.readdirSync(sub).filter((n) => n.endsWith('.jsonl')).map((n) => fs.readFileSync(path.join(sub, n), 'utf8'));
};
const reply = (e) => e.parts.map((p) => p.text).join('\n');

test('a subagent log gives its prompt, its handback or last message as the reply, and who it answered', () => {
  const sub = path.join(dir, ID, 'subagents');
  const named = parseSubagentRun(
    fs.readFileSync(path.join(sub, 'agent-a1111111111111111.jsonl'), 'utf8'),
    fs.readFileSync(path.join(sub, 'agent-a1111111111111111.meta.json'), 'utf8'),
  );
  assert.equal(named.agentId, 'a1111111111111111');
  assert.equal(named.sessionId, ID);
  assert.equal(named.toolUseId, 'toolu_A');
  assert.equal(named.agentType, 'release-checker');
  assert.equal(named.isBuiltIn, false);
  assert.equal(named.prompt, 'Check that release 1.2.0 is ready to ship and report back.', 'the system reminder after it is not the prompt');
  assert.equal(named.reply, 'Release 1.2.0 is ready to ship.\n\n- Tests: 88 of 88 pass.');
  assert.equal(named.timestamp, '2026-11-20T10:01:55.000Z');

  // No meta file, a text-block prompt, a last message logged as two lines, and a corrupt line.
  const oneOff = parseSubagentRun(fs.readFileSync(path.join(sub, 'agent-a2222222222222222.jsonl'), 'utf8'));
  assert.equal(oneOff.toolUseId, undefined);
  assert.equal(oneOff.prompt, 'Draft release notes for 1.2.0 from the commits since 1.1.0.');
  assert.equal(oneOff.reply, '## Notes for 1.2.0\n\n- Faster search');

  assert.deepEqual(parseSubagentRun('', '{not json'), {});
  assert.doesNotThrow(() => parseSubagentRun('{"type":"assistant","message":{"content":"text, not blocks"}}\n[1,2]\nnull\n'));
});

test('subagent runs appear in order, each after the tool call that started it, and split the main reply', async () => {
  const runs = await readSubagentRuns(logOf(ID), ID);
  assert.equal(runs.length, 3, 'only this session\'s subagents folder is read');
  const t = parseTranscript(read(ID), { sessionId: ID, subagents: runs });
  assert.deepEqual(
    t.map((e) => e.role),
    ['user', 'assistant', 'subagent', 'assistant', 'subagent', 'subagent', 'assistant', 'peer'],
  );

  const [, first, checker, second, drafter, checkerReply, last, peer] = t;
  assert.equal(first.parts.at(-1).id, 'toolu_A', 'the named run follows its call');
  // The checker ran in the background: its launch shows who and what, and its reply comes where it arrived.
  assert.deepEqual(checker.subagent, {
    name: 'release-checker',
    description: 'Check release 1.2.0',
    prompt: 'Check that release 1.2.0 is ready to ship and report back.',
    toolUseId: 'toolu_A',
    agentId: 'a1111111111111111',
    background: true,
  });
  assert.deepEqual(checker.parts, [], 'the reply is not shown at the launch as well');
  assert.deepEqual(checkerReply.subagent, {
    name: 'release-checker',
    description: 'Check release 1.2.0',
    handback: true,
    toolUseId: 'toolu_A',
    agentId: 'a1111111111111111',
  });
  assert.equal(reply(checkerReply), 'Release 1.2.0 is ready to ship.\n\n- Tests: 88 of 88 pass.');
  assert.equal(checkerReply.timestamp, '2026-11-20T10:02:00.000Z');

  assert.equal(second.parts[0].text, 'While that runs, a one-off agent drafts the notes.');
  assert.equal(second.parts[1].id, 'toolu_B');
  assert.equal(drafter.subagent.name, undefined, 'a one-off agent has no name, so it shows as "Subagent"');
  assert.equal(drafter.subagent.description, 'Draft release notes', 'from the call when there is no meta file');
  assert.equal(drafter.subagent.toolUseId, 'toolu_B', 'matched by the agentId in its result');
  assert.equal(reply(drafter), '## Notes for 1.2.0\n\n- Faster search');

  assert.equal(last.parts[0].text, 'Both agents are done: the release is ready and the notes are drafted.');
  assert.ok(!JSON.stringify(t).includes('FOREIGN REPLY'), 'a run that answered another session is left out');
  assert.ok(!JSON.stringify(t).includes('inline sidechain'), 'inline sidechain records are still skipped');
  assert.deepEqual(peer.parts, [{ kind: 'text', text: 'Can you link the notes from the README?', from: 'Docs Lead' }], 'peer messages unchanged');
});

test("another session's subagent logs never show in this session's transcript", async () => {
  // Session 2's run was started by a call with the same id as one of session 1's (toolu_B).
  const others = await readSubagentRuns(logOf(OTHER), OTHER);
  assert.equal(others.length, 1);
  const t = parseTranscript(read(ID), { sessionId: ID, subagents: others });
  // What this session's own log says still shows: the background launch (from its call) and the reply it received.
  // Nothing comes from the other session's run.
  const shown = t.filter((e) => e.role === 'subagent');
  assert.deepEqual(shown.map((e) => e.subagent.toolUseId), ['toolu_A', 'toolu_A']);
  assert.ok(!JSON.stringify(t).includes('OTHER SESSION REPLY'));
  assert.ok(!JSON.stringify(shown).includes('Notes for 1.2.0'), 'the foreground run has no block without its log');

  // The foreign log sitting in this session's folder, with a meta file naming this session's call, on its own.
  const foreign = (await readSubagentRuns(logOf(ID), ID)).filter((r) => r.agentType === 'intruder');
  assert.equal(foreign.length, 1);
  const withForeign = parseTranscript(read(ID), { sessionId: ID, subagents: foreign }).filter((e) => e.role === 'subagent');
  assert.ok(!JSON.stringify(withForeign).includes('FOREIGN REPLY'));
  assert.ok(withForeign.every((e) => e.subagent.name !== 'intruder' && e.subagent.description !== "Not this session's"));

  // And session 2 shows its own run.
  const own = parseTranscript(read(OTHER), { sessionId: OTHER, subagents: others }).filter((e) => e.role === 'subagent');
  assert.equal(own.length, 1);
  assert.equal(reply(own[0]), 'OTHER SESSION REPLY: looks fine.');
});

test('a run whose call has no result logged goes right after the call', () => {
  const text = read(ID)
    .split('\n')
    .filter((l) => !l.includes('"tool_use_id":"toolu_A"'))
    .join('\n');
  const runs = [parseSubagentRun('{"type":"assistant","sessionId":"' + ID + '","message":{"id":"x","content":[{"type":"text","text":"interrupted run"}]}}', '{"toolUseId":"toolu_A","agentType":"release-checker","isBuiltIn":false}')];
  const t = parseTranscript(text, { sessionId: ID, subagents: runs });
  const i = t.findIndex((e) => e.role === 'subagent');
  assert.ok(t[i - 1].parts.some((p) => p.id === 'toolu_A'));
  assert.equal(reply(t[i]), 'interrupted run');
});

test('cost, request and token totals are the same with and without the subagent blocks', async () => {
  const text = read(ID);
  const runs = await readSubagentRuns(logOf(ID), ID);
  const turns = (t) => t.filter((e) => e.turn).map((e) => e.turn);
  const without = turns(parseTranscript(text));
  const withRuns = turns(parseTranscript(text, { sessionId: ID, subagents: runs }));
  assert.deepEqual(withRuns, without);
  assert.equal(without[0].requests, 3, 'the main thread\'s three requests, no subagent ones');

  // The session's totals still add the subagents in once, from the logs, whatever the transcript shows.
  const s = parseSession(text, logOf(ID), 'C--repo', ID, subagentLogs(ID));
  const bare = parseSession(text, logOf(ID), 'C--repo', ID);
  // msg_r1a, msg_r1b, msg_r2a and msg_r2b; not the stray log's msg_r3a, which answered another session.
  assert.equal(s.usage.requests, bare.usage.requests + 4);
  assert.ok(s.usage.subagentCost > 0);
  assert.equal(s.assistantCount, bare.assistantCount);
  assert.equal(s.promptCount, bare.promptCount);
});

test("a subagent log that answered another session adds nothing to this session's totals", () => {
  const text = read(ID);
  const sub = path.join(dir, ID, 'subagents');
  const log = (agent) => fs.readFileSync(path.join(sub, `agent-${agent}.jsonl`), 'utf8');
  const own = [log('a1111111111111111'), log('a2222222222222222')];
  const stray = log('a3333333333333333');
  assert.match(stray, /"sessionId":"7a7a7a7a-/, 'the stray log names session 2');

  // The stray log in this session's folder changes no cost, request or token total.
  const withStray = parseSession(text, logOf(ID), 'C--repo', ID, [...own, stray]);
  const ownOnly = parseSession(text, logOf(ID), 'C--repo', ID, own);
  assert.deepEqual(withStray.usage, ownOnly.usage);
  assert.equal(parseSession(text, logOf(ID), 'C--repo', ID, [stray]).usage.subagentCost, 0);
  // It still counts for the session it answered.
  const other = parseSession(read(OTHER), logOf(OTHER), 'C--repo', OTHER, [stray]);
  assert.equal(other.usage.requests, parseSession(read(OTHER), logOf(OTHER), 'C--repo', OTHER).usage.requests + 1);

  // Logs whose records name no session are counted, as before: the same three logs without their session ids.
  const unnamed = [...own, stray].map((l) => l.replace(/"sessionId":"[^"]*",/g, ''));
  assert.ok(unnamed.every((l) => !l.includes('"sessionId"')));
  const counted = parseSession(text, logOf(ID), 'C--repo', ID, unnamed);
  const bare = parseSession(text, logOf(ID), 'C--repo', ID);
  assert.equal(counted.usage.requests, bare.usage.requests + 5, 'msg_r1a, msg_r1b, msg_r2a, msg_r2b and msg_r3a');
  assert.ok(counted.usage.subagentCost > ownOnly.usage.subagentCost);
  assert.ok(counted.usage.tokens.output > ownOnly.usage.tokens.output);
});

test("a subagent's reply is searchable, but not one from another session", () => {
  const s = parseSession(read(ID), logOf(ID), 'C--repo', ID, subagentLogs(ID));
  assert.match(s.searchText, /88 of 88 pass/);
  assert.match(s.searchText, /Faster search/);
  assert.doesNotMatch(s.searchText, /FOREIGN REPLY/);
});

// Background runs, trimmed from a real Claude Code 2.1.332 session: replies arrive later as <agent-message> records.
const BG = '9b9b9b9b-1111-4222-8333-944455556666';

test("a background run's reply shows where it reached the main session, labelled with its agent", async () => {
  const runs = await readSubagentRuns(logOf(BG), BG);
  const t = parseTranscript(read(BG), { sessionId: BG, subagents: runs });
  const kind = (e) =>
    e.role !== 'subagent' ? e.role : `${e.subagent.handback ? 'reply' : 'launch'}:${e.subagent.name ?? 'Subagent'}`;
  assert.deepEqual(t.map(kind), [
    'user',
    'assistant',
    'launch:ext-worker',
    'assistant',
    'launch:Subagent',
    'assistant',
    'launch:reviewer',
    'assistant',
    'reply:ext-worker',
    'assistant',
    'reply:Subagent',
    'assistant',
    'reply:ext-worker',
    'reply:reviewer',
    'reply:Subagent',
    'assistant',
  ]);

  // Launches: name, description and prompt, no reply.
  const launches = t.filter((e) => e.subagent?.background);
  assert.equal(launches.length, 3);
  assert.ok(launches.every((e) => e.parts.length === 0 && !e.subagent.handback));
  assert.equal(launches[0].subagent.prompt, 'Your item is SA-1. Add a CI workflow that runs npm test.');
  assert.equal(launches[2].subagent.prompt, 'Review PR #47.', "the reviewer's log is missing, so its block comes from the call");
  assert.equal(launches[2].subagent.description, 'Review PR #47');

  const replies = t.filter((e) => e.subagent?.handback);
  // The worker handed back twice; each reply sits where it arrived.
  const worker = replies.filter((e) => e.subagent.toolUseId === 'toolu_W');
  assert.equal(worker.length, 2);
  assert.match(reply(worker[0]), /^\*\*SA-1 is done up to the merge\.\*\*[\s\S]*\n- New workflow `\.github\/workflows\/test\.yml`\.\n {2}- Runs `npm ci`/, 'the report as written, nesting kept');
  assert.equal(reply(worker[1]), 'Lint fixed in a second commit on PR #47; CI is green again.', 'read from the framed body when the record has no report text');
  assert.equal(worker[0].subagent.description, 'Build SA-1 CI workflow');

  // A one-off agent's reply delivered mid-turn (a queued command), and the reviewer whose log is missing.
  const [, oneOff, , reviewer, stranger] = replies;
  assert.equal(oneOff.subagent.name, undefined);
  assert.equal(oneOff.subagent.description, 'Check the changelog');
  assert.equal(reply(oneOff), 'The changelog has no entry for 0.4.7 yet.');
  assert.equal(reviewer.subagent.name, 'reviewer');
  assert.equal(reply(reviewer), 'Verdict on PR #47: approve. The workflow is read-only and cancels stale runs.');
  // An agent this session didn't launch: still shown, since it was sent here, as "Subagent" with no description.
  assert.deepEqual(stranger.subagent, { name: undefined, description: undefined, handback: true });
  assert.equal(reply(stranger), 'Hello from an agent of another session: the shared fixture moved.');

  const json = JSON.stringify(t);
  assert.ok(!json.includes('task-notification'), 'task notifications stay hidden');
  assert.ok(!json.includes('Subagent hand-back') && !json.includes('other Claude session'), 'the frame around a hand-back is not shown');
});

test('hand-backs show without any subagent logs, and a run that never handed back keeps its reply at the launch', async () => {
  const t = parseTranscript(read(BG), { sessionId: BG });
  const replies = t.filter((e) => e.subagent?.handback);
  assert.deepEqual(replies.map((e) => e.subagent.name), ['ext-worker', undefined, 'ext-worker', 'reviewer', undefined]);
  assert.ok(replies.every((e) => reply(e).length > 0));

  // Without its <agent-message> records (the session ended first), the worker's reply from its log shows at the launch.
  const text = read(BG)
    .split('\n')
    .filter((l) => !l.includes('agent-message from=\\"a5555555555555555'))
    .join('\n');
  const runs = await readSubagentRuns(logOf(BG), BG);
  const t2 = parseTranscript(text, { sessionId: BG, subagents: runs });
  const launch = t2.find((e) => e.subagent?.toolUseId === 'toolu_W');
  assert.equal(reply(launch), 'Lint fixed in a second commit on PR #47; CI is green again.');
  assert.equal(t2.filter((e) => e.subagent?.handback && e.subagent.toolUseId === 'toolu_W').length, 0);
});

test('a hand-back logged twice (as a record and as a queued command) shows once', () => {
  const lines = read(BG).split('\n');
  const queued = lines.find((l) => l.includes('"queued_command"'));
  const t = parseTranscript([...lines, queued].join('\n'), { sessionId: BG });
  assert.equal(t.filter((e) => e.subagent?.handback && reply(e).startsWith('The changelog')).length, 1);
});

test('parseAgentMessage reads both shapes and skips what it does not know', () => {
  assert.equal(parseAgentMessage({ type: 'user', message: { content: 'plain text' } }), undefined);
  assert.equal(parseAgentMessage({ type: 'attachment', attachment: { type: 'skill_listing', prompt: '<agent-message from="x">hi</agent-message>' } }), undefined);
  assert.equal(parseAgentMessage(null), undefined);
  assert.equal(parseAgentMessage({ type: 'user', message: { content: [{ type: 'text', text: '<agent-message from="x">hi</agent-message>' }] } }), undefined);
  assert.equal(parseAgentMessage({ type: 'user', message: { content: '<agent-message from="a1">\n</agent-message>' } }), undefined, 'empty');
  const m = parseAgentMessage({
    type: 'user',
    message: { content: '<agent-message from="a1">\n[Subagent hand-back] Frame. The report follows:\n  line one\n    nested\n</agent-message>' },
  });
  assert.deepEqual(m, { from: 'a1', name: undefined, text: 'line one\n  nested' });
  assert.equal(parseAgentMessage({ type: 'user', message: { content: '<agent-message from="a2">cut off mid-wri' } }).text, 'cut off mid-wri');
});

test('hand-backs leave cost, request and token totals unchanged, and are searchable', async () => {
  const text = read(BG);
  const runs = await readSubagentRuns(logOf(BG), BG);
  const withoutHandbacks = text
    .split('\n')
    .filter((l) => !l.includes('<agent-message'))
    .join('\n');
  const turns = (t) => t.filter((e) => e.turn).map((e) => e.turn);
  assert.deepEqual(turns(parseTranscript(text, { sessionId: BG, subagents: runs })), turns(parseTranscript(withoutHandbacks)));
  assert.equal(turns(parseTranscript(text))[0].requests, 7);

  const s = parseSession(text, logOf(BG), 'C--repo', BG, subagentLogs(BG));
  const bare = parseSession(withoutHandbacks, logOf(BG), 'C--repo', BG, subagentLogs(BG));
  assert.deepEqual(s.usage, bare.usage);
  assert.equal(s.promptCount, 1);
  assert.equal(s.peerMessageCount, 0, 'a hand-back is not a message from another session');
  assert.equal(s.assistantCount, bare.assistantCount);
  assert.equal(s.title, 'Build and review SA-1');
  for (const needle of ['Verdict on PR #47', 'shared fixture moved', 'no entry for 0.4.7', 'Whether to protect main']) {
    assert.ok(s.searchText.includes(needle), needle);
  }
  // Without the subagent logs, the hand-backs alone still make the replies searchable.
  assert.ok(parseSession(text, logOf(BG), 'C--repo', BG).searchText.includes('Verdict on PR #47'));
});

// A subagent's full run, opened from the transcript: its own log read as a transcript.
const runLog = (id, agent) => fs.readFileSync(path.join(dir, id, 'subagents', `agent-${agent}.jsonl`), 'utf8');

test("a subagent's own log reads as a full transcript: prompt, tool calls, text and reply in order", () => {
  assert.deepEqual(parseTranscript(runLog(ID, 'a1111111111111111')), [], 'without the option its sidechain records are skipped, as before');

  const t = parseTranscript(runLog(ID, 'a1111111111111111'), { sidechain: true });
  assert.deepEqual(t.map((e) => e.role), ['user', 'assistant']);
  assert.equal(t[0].parts[0].text, 'Check that release 1.2.0 is ready to ship and report back.', 'the system reminder after it is not shown');
  assert.equal(t[0].turn.requests, 2, 'the prompt carries what answering it cost');
  const [bash, handback] = t[1].parts;
  assert.equal(bash.kind, 'tool_use');
  assert.equal(bash.name, 'Bash');
  assert.deepEqual(bash.result, { text: '88 passing', isError: false });
  assert.deepEqual(handback, { kind: 'text', text: 'Release 1.2.0 is ready to ship.\n\n- Tests: 88 of 88 pass.' }, 'the SubagentHandback call is the reply');
  assert.ok(!JSON.stringify(t).includes('Delivered.'), "the hand-back call's own result is not shown");

  // No meta file, a message logged as two lines, and a corrupt line at the end.
  const drafter = parseTranscript(runLog(ID, 'a2222222222222222'), { sidechain: true });
  assert.deepEqual(drafter.map((e) => e.role), ['user', 'assistant']);
  assert.deepEqual(drafter[1].parts.map((p) => p.text), ['Looking at the commits.', '## Notes for 1.2.0', '- Faster search']);

  // A message the main session sent while it ran is a prompt of its own, between its two replies.
  const worker = parseTranscript(runLog(BG, 'a5555555555555555'), { sidechain: true });
  assert.deepEqual(worker.map((e) => e.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(worker[2].parts[0].text, /Fix the lint warning\.$/);
  assert.equal(worker[3].parts[0].text, 'Lint fixed in a second commit on PR #47; CI is green again.');
  // Outside a subagent's own log the same meta record stays hidden, and so the two replies read as one turn.
  const asMain = runLog(BG, 'a5555555555555555').replace(/"isSidechain":true/g, '"isSidechain":false');
  assert.deepEqual(parseTranscript(asMain).map((e) => e.role), ['user', 'assistant']);
});

test("a subagent's nested agents and unknown records never break its transcript", () => {
  const rec = (o) => JSON.stringify({ isSidechain: true, agentId: 'a9', sessionId: ID, timestamp: '2026-11-20T10:00:00.000Z', ...o });
  const log = [
    rec({ type: 'user', message: { role: 'user', content: 'Plan the work.' } }),
    rec({ type: 'brand-new-record', payload: { anything: 1 } }),
    rec({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_N', name: 'Agent', input: { subagent_type: 'planner', description: 'Nested plan', prompt: 'Go.', run_in_background: true } }] } }),
    rec({
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_N', type: 'tool_result', content: 'Async agent launched successfully.\nagentId: anested0000000000' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'anested0000000000' },
    }),
    rec({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'toolu_H', name: 'SubagentHandback', input: { message: 42 } }] } }),
    rec({ type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'Done.' }] } }),
    '{"cut off mid-wri',
  ].join('\n');
  let t;
  assert.doesNotThrow(() => (t = parseTranscript(log, { sidechain: true })));
  assert.deepEqual(t.map((e) => e.role), ['user', 'assistant', 'subagent', 'assistant']);
  assert.equal(t[2].subagent.name, 'planner');
  assert.equal(t[2].subagent.agentId, undefined, "a nested run's log is not read, so it offers nothing to open");
  assert.equal(t[3].parts.at(-1).text, 'Done.');
});

test('subagent runs know their log file and agent id, and are found by it only for their own session', async () => {
  const { findSubagentRun } = require('../out/sessionStore');
  const runs = await readSubagentRuns(logOf(ID), ID);
  for (const r of runs) {
    assert.equal(r.file, path.join(dir, ID, 'subagents', `agent-${r.agentId}.jsonl`));
  }
  assert.equal((await findSubagentRun(logOf(ID), ID, 'a1111111111111111')).agentType, 'release-checker');
  assert.equal(await findSubagentRun(logOf(ID), ID, 'a3333333333333333'), undefined, 'a run that answered another session');
  assert.equal(await findSubagentRun(logOf(ID), ID, 'a0000000000000000'), undefined, 'no such log');
  assert.equal(await findSubagentRun(logOf(BG), BG, 'a7777777777777777'), undefined, "the reviewer's log is missing");

  // Session details > Subagents: rows whose run's log was read carry its agent id; the reviewer's does not.
  const { collectInsights } = require('../out/insights');
  const bg = collectInsights(parseTranscript(read(BG), { sessionId: BG, subagents: await readSubagentRuns(logOf(BG), BG) }));
  assert.deepEqual(
    bg.subagents.map((a) => [a.description, a.agentId]),
    [
      ['Build SA-1 CI workflow', 'a5555555555555555'],
      ['Check the changelog', 'a6666666666666666'],
      ['Review PR #47', undefined],
    ],
  );
  const t = parseTranscript(read(BG), { sessionId: BG, subagents: await readSubagentRuns(logOf(BG), BG) });
  assert.ok(t.filter((e) => e.subagent?.toolUseId === 'toolu_R').every((e) => !e.subagent.agentId), 'no open control for the missing log');
});
