// Messages from other Claude sessions that arrived while Claude was mid-turn: Claude Code logs them as
// `queued_command` attachments with `origin.kind: "peer"`, not as the meta user records read before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSession, parseTranscript, parsePeerRecord, parseQueuedPrompt } = require('../out/sessionParser');

const FIXTURE = path.join(__dirname, 'fixtures', 'claude-code', 'queued-peer-message.jsonl');
// Record shapes from a real 2.1.292 agent-team session; ids, paths and words are synthetic.
const LEAD = 'Project Lead — split the parser work';
const QUEUED = 'The user approved the plan, so start on the parser scope now, on branch parsers-split. Message me with the branch name when you have pushed.';
const LATER = 'Thanks. Hold off on the Copilot reader until I confirm the field names.';
const PROMPT = 'Read the parser module and list what each reader handles';

const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
const user = (content, ts, extra = {}) => ({ type: 'user', message: { role: 'user', content }, timestamp: ts, ...extra });
const asst = (id, content, ts) => ({
  type: 'assistant',
  message: { id, role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 1000, output_tokens: 100 } },
  timestamp: ts,
});
const csm = (name, body) => `<cross-session-message from="uds:x" from-name="${name}" from-mode="prompting">\n${body}\n</cross-session-message>`;
const origin = (body, msgId, extra = {}) => ({ kind: 'peer', from: 'uds:x', ...(msgId ? { msg_id: msgId } : {}), name: 'Lead', fromMode: 'prompting', body, ...extra });
const queuedPeer = (body, ts, msgId, extra = {}) => ({
  type: 'attachment',
  attachment: { type: 'queued_command', prompt: csm('Lead', body), commandMode: 'prompt', origin: origin(body, msgId), timestamp: ts, isMeta: true, ...extra },
  timestamp: ts,
});
const metaPeer = (body, ts, msgId) => user(`Another Claude session sent a message:\n${csm('Lead', body)}\n\nThis came from another Claude session.`, ts, { isMeta: true, origin: origin(body, msgId) });
const turnsOf = (t) => t.filter((e) => e.turn).map((e) => e.turn);
const withoutQueued = (text) =>
  text
    .split('\n')
    .filter((l) => !l.includes('"queued_command"'))
    .join('\n');

test('a peer message that arrived mid-turn shows where it was logged, with its sender (real 2.1.292 shape)', () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  // The fixture's mid-turn message is logged only as an attachment; no user record repeats it.
  assert.ok(!text.split('\n').some((l) => l.includes('"type":"user"') && l.includes(QUEUED)));

  const t = parseTranscript(text);
  const peers = t.filter((e) => e.role === 'peer');
  assert.deepEqual(
    peers.map((e) => e.parts),
    [[{ kind: 'text', text: QUEUED, from: LEAD }], [{ kind: 'text', text: LATER, from: LEAD }]],
  );
  const at = t.indexOf(peers[0]);
  assert.equal(t[at].timestamp, '2026-10-07T01:10:14.630Z');
  // Between the Bash call whose result it followed and the branch Claude made after reading it.
  assert.ok(t[at - 1].parts.some((p) => p.kind === 'tool_use' && p.id === 'toolu_01AAAAAAAAAAAAAAAAAAAAAA' && p.result));
  assert.ok(t[at + 1].parts.some((p) => p.kind === 'tool_use' && p.id === 'toolu_01BBBBBBBBBBBBBBBBBBBBBB'));
  assert.deepEqual(
    t.filter((e) => e.role === 'user').map((e) => e.parts[0].text),
    [PROMPT],
    'not shown as a prompt',
  );

  const s = parseSession(text, 'f', 'p', 'id');
  assert.equal(s.peerMessageCount, 2);
  assert.deepEqual(s.firstPeerMessage, { from: LEAD, text: QUEUED });
  assert.equal(s.searchText.split(QUEUED).length - 1, 1, 'search holds it once');
  assert.equal(s.searchText.split(LATER).length - 1, 1);
  assert.equal(s.promptCount, 1);
});

test('a peer message that arrived mid-turn leaves turn costs and prompt counts as they were', () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const without = withoutQueued(text);
  const t = parseTranscript(text);
  assert.equal(t.find((e) => e.role === 'peer').turn, undefined, 'no cost of its own');
  assert.deepEqual(turnsOf(t), turnsOf(parseTranscript(without)));
  assert.equal(turnsOf(t).length, 1);
  const s = parseSession(text, 'f', 'p', 'id');
  const w = parseSession(without, 'f', 'p', 'id');
  assert.equal(s.promptCount, w.promptCount);
  assert.equal(s.firstPrompt, w.firstPrompt);
  assert.equal(s.lastPrompt, w.lastPrompt);
  assert.deepEqual(s.usage, w.usage);
  assert.equal(s.peerMessageCount, w.peerMessageCount + 1);
});

test('an agent-team session whose only peer message arrived mid-turn now gets "<name> — <topic>" as its title', () => {
  // The title depends on peerMessageCount > 0, so counting mid-turn messages changes it for such sessions.
  const text = fs
    .readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => !(l.includes('"type":"user"') && l.includes(LATER)))
    .join('\n');
  assert.equal(parseSession(text, 'f', 'p', 'id').title, `Parser Worker — ${PROMPT}`);
  assert.equal(parseSession(withoutQueued(text), 'f', 'p', 'id').title, 'Parser Worker');
});

test('a peer message logged both as a queued command and as a user record shows and counts once', () => {
  for (const order of ['queued first', 'record first']) {
    const pair = [queuedPeer('look at the README', '2026-11-01T10:00:04.000Z', 'm-1'), metaPeer('look at the README', '2026-11-01T10:00:20.000Z', 'm-1')];
    if (order === 'record first') {
      pair.reverse();
    }
    const text = jsonl(
      user('first', '2026-11-01T10:00:00.000Z'),
      asst('a1', [{ type: 'text', text: 'working' }], '2026-11-01T10:00:02.000Z'),
      ...pair,
      asst('a2', [{ type: 'text', text: 'done' }], '2026-11-01T10:00:30.000Z'),
    );
    const t = parseTranscript(text);
    const peers = t.filter((e) => e.role === 'peer');
    assert.equal(peers.length, 1, order);
    assert.equal(peers[0].timestamp, pair[0].timestamp, `${order}: shown at the first delivery`);
    const s = parseSession(text, 'f', 'p', 'id');
    assert.equal(s.peerMessageCount, 1, order);
    assert.equal(s.searchText.split('look at the README').length - 1, 1, order);
    assert.equal(s.promptCount, 1, order);
  }
  // Without message ids, the sender and words identify the delivery.
  const text = jsonl(user('first', 't0'), queuedPeer('same words', 't1'), metaPeer('same words', 't2'));
  assert.equal(parseTranscript(text).filter((e) => e.role === 'peer').length, 1);
  assert.equal(parseSession(text, 'f', 'p', 'id').peerMessageCount, 1);
  // Two messages with the same words but their own ids are two messages.
  const twice = jsonl(user('first', 't0'), queuedPeer('ok', 't1', 'm-1'), metaPeer('ok', 't2', 'm-2'));
  assert.equal(parseTranscript(twice).filter((e) => e.role === 'peer').length, 2);
  assert.equal(parseSession(twice, 'f', 'p', 'id').peerMessageCount, 2);
});

test('queued commands that are not peer messages are not read as one, and bad shapes are skipped', () => {
  const notPeers = [
    // A typed prompt, with and without an origin, even one quoting a peer message.
    { type: 'attachment', attachment: { type: 'queued_command', prompt: 'continue', commandMode: 'prompt', origin: { kind: 'human' } } },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: 'continue', commandMode: 'prompt' } },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: csm('Lead', 'quoted'), commandMode: 'prompt', origin: { kind: 'human' } } },
    // A task notification.
    { type: 'attachment', attachment: { type: 'queued_command', prompt: csm('Lead', 'x'), commandMode: 'task-notification', origin: { kind: 'task-notification' } } },
    // Malformed shapes.
    queuedPeer('x', 't', 'm', { prompt: ['not', 'a', 'string'] }),
    queuedPeer('x', 't', 'm', { prompt: 'no tag here' }),
    { type: 'attachment', attachment: null },
    { type: 'attachment' },
    { type: 'attachment', attachment: { type: 'other', prompt: csm('Lead', 'x'), origin: { kind: 'peer' } } },
  ];
  for (const r of notPeers) {
    assert.equal(parsePeerRecord(r), undefined, JSON.stringify(r));
  }
  // A peer message is never a prompt either.
  assert.equal(parseQueuedPrompt(queuedPeer('hi', 't', 'm')), undefined);
  // No from-name: the origin's name, then a placeholder.
  const unnamed = queuedPeer('hi', 't', 'm', { prompt: '<cross-session-message from="uds:x">\nhi\n</cross-session-message>' });
  assert.equal(parsePeerRecord(unnamed).from, 'Lead');
  unnamed.attachment.origin = undefined;
  assert.deepEqual(parsePeerRecord(unnamed), { from: 'another session', text: 'hi', key: 'another session\nhi' });

  // A subagent's own mid-turn message, logged in the main file as a sidechain record, is not the main session's.
  const side = { ...queuedPeer('to the subagent', 't', 'm-side'), isSidechain: true };
  const text = jsonl(user('only prompt', 't0'), ...notPeers, side, asst('m1', [{ type: 'text', text: 'reply' }], 't1'));
  const t = parseTranscript(text);
  assert.deepEqual(t.filter((e) => e.role === 'peer'), []);
  const s = parseSession(text, 'f', 'p', 'id');
  assert.equal(s.peerMessageCount, 0);
  assert.equal(s.promptCount, 4, 'the typed prompts still count: the record, the two queued "continue"s and the quote');
});
