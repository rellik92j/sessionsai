// Subagent hand-backs: matched only when the message opens with <agent-message>, and each delivery shown once
// however Claude Code logged it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSession, parseTranscript, parseAgentMessage, HandbackDeliveries } = require('../out/sessionParser');

// Record shapes from real 2.1.332 sessions (and an older one without the clean report text); ids and words are synthetic.
const FIXTURE = path.join(__dirname, 'fixtures', 'claude-code', 'handback-edge-cases.jsonl');
const read = () => fs.readFileSync(FIXTURE, 'utf8');
const reply = (e) => e.parts.map((p) => p.text).join('\n');
const QUOTING = 'The parser now stops at a closing tag on its own line.\nA report may quote it, like this:\n</agent-message>\nand the rest still shows.';

test('a hand-back is shown once per delivery, and a record that only mentions the tag is not one', () => {
  const t = parseTranscript(read());
  const replies = t.filter((e) => e.subagent?.handback);
  assert.deepEqual(
    replies.map((e) => reply(e)),
    [QUOTING, 'Lint is clean on the branch.', 'The README has no section on hand-backs yet.'],
  );
  assert.deepEqual(t.map((e) => e.role), ['user', 'assistant', 'subagent', 'subagent', 'subagent', 'assistant']);
  assert.ok(!JSON.stringify(t).includes('aSKILL'), 'the skill body that mentions the tag is not a reply');
  assert.ok(!JSON.stringify(t).includes('Base directory'), 'and is not shown at all');
});

test('a session counts each hand-back once in its search text, and the skill body is not one', () => {
  const s = parseSession(read(), FIXTURE, 'C--repo', 'c4c4c4c4-1111-4222-8333-944455556666');
  assert.equal(s.searchText.split('Lint is clean on the branch.').length - 1, 1);
  assert.equal(s.searchText.split('no section on hand-backs').length - 1, 1);
  assert.ok(s.searchText.includes('and the rest still shows.'), 'the quoted closing tag does not cut the report short');
  assert.ok(!s.searchText.includes('its report'), 'the skill body is not searchable as a reply');
  assert.equal(s.promptCount, 1);
  assert.equal(s.peerMessageCount, 0);
});

test('parseAgentMessage matches only a message that opens with the tag', () => {
  const user = (content) => ({ type: 'user', isMeta: true, message: { role: 'user', content } });
  assert.equal(parseAgentMessage(user('A reply arrives as <agent-message from="a1">\n  text\n</agent-message> later.')), undefined);
  assert.equal(parseAgentMessage(user('Notes first.\n<agent-message from="a1">\nhi\n</agent-message>')), undefined);
  assert.equal(parseAgentMessage(user('Another Claude session sent a message:\nthen <agent-message from="a1">\nhi\n</agent-message>')), undefined);
  assert.equal(parseAgentMessage(user('Another Claude session sent a message:\n<agent-message from="a1">\nhi\n</agent-message>')).text, 'hi');
  assert.equal(parseAgentMessage(user('Another Claude session sent a message:\r\n<agent-message from="a1">\r\nhi\r\n</agent-message>\r\n')).text, 'hi');
  // Written on a single line, the closing tag at the end still closes it.
  assert.equal(parseAgentMessage(user('<agent-message from="a1">hi</agent-message>')).text, 'hi');
  // A framed report that quotes the closing tag keeps everything up to the tag at column zero.
  const framed = `<agent-message from="a1">\n[Subagent hand-back] Frame. The report follows:\n  one\n  </agent-message>\n  two\n</agent-message>\n\nAfter.`;
  assert.equal(parseAgentMessage(user(framed)).text, 'one\n</agent-message>\ntwo');
});

test('HandbackDeliveries pairs logs with and without a tool-use id, and keeps distinct deliveries apart', () => {
  const msg = (text, toolUseId) => ({ from: 'a1', text, key: toolUseId ?? `a1\n${text}`, ...(toolUseId ? { toolUseId } : {}) });
  const d = new HandbackDeliveries();
  assert.equal(d.isRepeat(msg('Done.', 't1')), false);
  assert.equal(d.isRepeat(msg('Done.')), true, 'the framed log of t1');
  assert.equal(d.isRepeat(msg('Done.', 't1')), true, 't1 again');
  assert.equal(d.isRepeat(msg('Done.', 't2')), false, 'a second delivery with the same words');
  assert.equal(d.isRepeat(msg('Done. \r\n')), true, 'line endings and trailing spaces do not make it new');

  const e = new HandbackDeliveries();
  assert.equal(e.isRepeat(msg('Ready.')), false);
  assert.equal(e.isRepeat(msg('Ready.')), true, 'two logs without an id are one delivery');
  assert.equal(e.isRepeat(msg('Ready.', 't3')), true, 'the id arrives with a later log');
  assert.equal(e.isRepeat(msg('Ready.', 't4')), false, 'another delivery of the same words');
  assert.equal(e.isRepeat({ from: 'a2', text: 'Ready.', key: 'a2\nReady.' }), false, 'another sender');
});
