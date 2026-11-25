// Prompts the user typed while Claude was mid-turn: Claude Code logs them as `queued_command` attachments.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSession, parseTranscript, parseQueuedPrompt } = require('../out/sessionParser');

const FIXTURE = path.join(__dirname, 'fixtures', 'claude-code', 'queued-prompt.jsonl');
// Record shapes from a real 2.1.292 session; the words are synthetic.
const QUEUED = 'also tell the new session to read the handoff file if there is one';
const FIRST = 'Call out a handoff note when a session is continued';
const NEXT = 'write a handoff for this session so another agent can take over';

const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
const user = (content, ts, extra = {}) => ({ type: 'user', message: { role: 'user', content }, timestamp: ts, ...extra });
const asst = (id, content, ts) => ({
  type: 'assistant',
  message: { id, role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 1000, output_tokens: 100 } },
  timestamp: ts,
});
const queued = (prompt, ts, extra = {}) => ({
  type: 'attachment',
  attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' }, timestamp: ts, ...extra },
  timestamp: ts,
});
const turnsOf = (t) => t.filter((e) => e.turn).map((e) => e.turn);
const total = (turns) => turns.reduce((sum, t) => sum + t.cost, 0);

test('a prompt queued mid-turn, with no user record of its own, shows where it was logged (real 2.1.292 shape)', () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  // The fixture's queued prompt is logged only as an attachment; no user record repeats it.
  assert.ok(!text.split('\n').some((l) => l.includes('"type":"user"') && l.includes(QUEUED)));

  const t = parseTranscript(text);
  const prompts = t.filter((e) => e.role === 'user');
  assert.deepEqual(
    prompts.map((e) => e.parts[0].text),
    [FIRST, QUEUED, NEXT],
  );
  const at = t.findIndex((e) => e.queued);
  assert.equal(t[at].parts[0].text, QUEUED);
  assert.equal(t[at].timestamp, '2026-10-07T02:26:23.340Z');
  // Between the Bash call whose result it followed and the Read Claude made after taking it in.
  const before = t[at - 1];
  const after = t[at + 1];
  assert.equal(before.role, 'assistant');
  assert.ok(before.parts.some((p) => p.kind === 'tool_use' && p.id === 'toolu_01G1upcZQu2eFnQ2VEieqBjv' && p.result));
  assert.equal(after.role, 'assistant');
  assert.equal(after.parts[0].kind, 'tool_use');
  assert.equal(after.parts[0].name, 'Read');

  const s = parseSession(text, 'f', 'p', 'id');
  assert.equal(s.promptCount, 3);
  assert.equal(s.firstPrompt, FIRST);
  assert.equal(s.lastPrompt, NEXT);
  assert.equal(s.searchText.split(QUEUED).length - 1, 1, 'search holds it once');
});

test('a prompt queued mid-turn leaves turn costs as they were: the running turn keeps it', () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const without = text
    .split('\n')
    .filter((l) => !l.includes('"queued_command"'))
    .join('\n');
  const t = parseTranscript(text);
  assert.equal(t.find((e) => e.queued).turn, undefined, 'no cost of its own');
  assert.deepEqual(turnsOf(t), turnsOf(parseTranscript(without)));
  assert.equal(turnsOf(t).length, 2);
  const s = parseSession(text, 'f', 'p', 'id');
  assert.ok(Math.abs(total(turnsOf(t)) - s.usage.cost) < 1e-9, 'the turns add up to the session');
  assert.equal(s.usage.requests, parseSession(without, 'f', 'p', 'id').usage.requests);
});

test('a queued prompt that is also logged as a user record shows and counts once, and still starts its turn', () => {
  const text = jsonl(
    user('first', '2026-11-01T10:00:00.000Z'),
    asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], '2026-11-01T10:00:05.000Z'),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], '2026-11-01T10:00:06.000Z'),
    queued('also do this', '2026-11-01T10:00:04.000Z'),
    asst('m2', [{ type: 'text', text: 'Done with the first.' }], '2026-11-01T10:00:10.000Z'),
    user('also do this', '2026-11-01T10:01:00.000Z'),
    asst('m3', [{ type: 'text', text: 'Doing it.' }], '2026-11-01T10:01:30.000Z'),
  );
  const t = parseTranscript(text);
  assert.deepEqual(
    t.filter((e) => e.role === 'user').map((e) => e.parts[0].text),
    ['first', 'also do this'],
  );
  const q = t.find((e) => e.queued);
  assert.equal(q.timestamp, '2026-11-01T10:00:04.000Z', 'shown where it was queued');
  assert.equal(t[t.indexOf(q) + 1].parts[0].text, 'Done with the first.');
  // The record that repeats it opens the next turn: m1 and m2 stay with "first", m3 goes to the queued prompt.
  assert.equal(t[0].turn.requests, 2);
  assert.equal(q.turn.requests, 1);
  assert.equal(q.turn.durationMs, 30_000, 'timed from the record that opened the turn');
  const s = parseSession(text, 'f', 'p', 'id');
  assert.equal(s.promptCount, 2);
  assert.equal(s.searchText.split('also do this').length - 1, 1);
  assert.ok(Math.abs(total(turnsOf(t)) - s.usage.cost) < 1e-9);
});

test('the same words typed again later, after another prompt, are a new prompt', () => {
  const text = jsonl(
    user('go', '2026-11-01T10:00:00.000Z'),
    queued('continue', '2026-11-01T10:00:01.000Z'),
    asst('m1', [{ type: 'text', text: 'ok' }], '2026-11-01T10:00:02.000Z'),
    user('next', '2026-11-01T10:01:00.000Z'),
    user('continue', '2026-11-01T10:02:00.000Z'),
  );
  assert.deepEqual(
    parseTranscript(text).filter((e) => e.role === 'user').map((e) => e.parts[0].text),
    ['go', 'continue', 'next', 'continue'],
  );
  assert.equal(parseSession(text, 'f', 'p', 'id').promptCount, 4);
});

test('queued commands that are not typed prompts stay hidden and uncounted', () => {
  const notification = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>';
  const others = [
    // A background task finishing, with and without an origin (both seen in real logs).
    queued(notification, 't', { commandMode: 'task-notification', origin: { kind: 'task-notification', producer: 'session-task' } }),
    queued('mods loaded', 't', { commandMode: 'task-notification', origin: undefined }),
    // A message from another session, delivered mid-turn.
    queued('<cross-session-message from-name="Lead">\nhi\n</cross-session-message>', 't', { origin: { kind: 'peer', from: 'x' }, isMeta: true }),
    // Malformed or unknown shapes are skipped, not thrown on.
    queued(['not', 'a', 'string'], 't'),
    queued('   ', 't'),
    queued('<system-reminder>only a reminder</system-reminder>', 't'),
    { type: 'attachment', attachment: null },
    { type: 'attachment' },
  ];
  for (const r of others) {
    assert.equal(parseQueuedPrompt(r), undefined, JSON.stringify(r));
  }
  // A subagent's own queued prompt, logged in the main file as a sidechain record, is not the main session's.
  const side = { ...queued('subagent side', 't'), isSidechain: true };
  const text = jsonl(user('only prompt', 't0'), ...others, side, asst('m1', [{ type: 'text', text: 'reply' }], 't1'));
  assert.deepEqual(
    parseTranscript(text).filter((e) => e.role === 'user').map((e) => e.parts[0].text),
    ['only prompt'],
  );
  assert.equal(parseSession(text, 'f', 'p', 'id').promptCount, 1);
  // A queued prompt with no origin (older logs) and one with a reminder around it are still prompts.
  assert.equal(parseQueuedPrompt(queued('older', 't', { origin: undefined })), 'older');
  assert.equal(parseQueuedPrompt(queued('<system-reminder>r</system-reminder>\nwrapped', 't')), 'wrapped');
});
