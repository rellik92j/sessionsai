// Subagent runs in the transcript: read from <sessionId>/subagents/, shown after the call that started them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseSession, parseTranscript, parseSubagentRun } = require('../out/sessionParser');
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
    ['user', 'assistant', 'subagent', 'assistant', 'subagent', 'assistant', 'peer'],
  );

  const [, first, checker, second, drafter, last, peer] = t;
  assert.equal(first.parts.at(-1).id, 'toolu_A', 'the named run follows its call');
  assert.deepEqual(checker.subagent, {
    name: 'release-checker',
    description: 'Check release 1.2.0',
    prompt: 'Check that release 1.2.0 is ready to ship and report back.',
    toolUseId: 'toolu_A',
  });
  assert.equal(reply(checker), 'Release 1.2.0 is ready to ship.\n\n- Tests: 88 of 88 pass.');

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
  assert.equal(t.filter((e) => e.role === 'subagent').length, 0);
  assert.ok(!JSON.stringify(t).includes('OTHER SESSION REPLY'));

  // The foreign log sitting in this session's folder, with a meta file naming this session's call, on its own.
  const foreign = (await readSubagentRuns(logOf(ID), ID)).filter((r) => r.agentType === 'intruder');
  assert.equal(foreign.length, 1);
  assert.equal(parseTranscript(read(ID), { sessionId: ID, subagents: foreign }).filter((e) => e.role === 'subagent').length, 0);

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
  // msg_r1a, msg_r1b, msg_r2a, msg_r2b and the stray log's msg_r3a: counted as before this change.
  assert.equal(s.usage.requests, bare.usage.requests + 5);
  assert.ok(s.usage.subagentCost > 0);
  assert.equal(s.assistantCount, bare.assistantCount);
  assert.equal(s.promptCount, bare.promptCount);
});

test("a subagent's reply is searchable, but not one from another session", () => {
  const s = parseSession(read(ID), logOf(ID), 'C--repo', ID, subagentLogs(ID));
  assert.match(s.searchText, /88 of 88 pass/);
  assert.match(s.searchText, /Faster search/);
  assert.doesNotMatch(s.searchText, /FOREIGN REPLY/);
});
