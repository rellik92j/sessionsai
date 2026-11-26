const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseTranscript } = require('../out/sessionParser');

// Two Claude Code processes resumed one session at once and both appended to its log. Process B closed A's open
// turn with a synthetic "No response requested." and asked its own question; A's answer to its own question was
// logged after that, parented (parentUuid) on it, with B's reply interleaved between A's records. Later in the log, a
// turn that was interrupted is closed with the same synthetic reply when resumed, with no other branch answering it.
const FIXTURE = path.join(__dirname, 'fixtures', 'claude-code', 'forked-session.jsonl');
const text = fs.readFileSync(FIXTURE, 'utf8');
const textOf = (e) => e.parts.map((p) => (p.kind === 'tool_use' ? `${p.name}: ${p.result?.text ?? ''}` : p.text)).join(' | ');

test('a forked log shows each answer under the question it answers, not merged, and not the placeholder', () => {
  const entries = parseTranscript(text);
  assert.deepEqual(
    entries.map((e) => [e.role, textOf(e), !!e.branch]),
    [
      ['user', 'What does the loader do?', false],
      ['assistant', 'It reads the config file.', false],
      ['user', 'Explain the whole config pipeline', false],
      ['assistant', 'Read: export function readConfig() {} | The pipeline reads, merges, then validates the config.', true],
      ['user', 'Which file holds the defaults?', false],
      ['assistant', 'The defaults are in defaults.ts.', false],
      // An interrupted turn resumed later: the synthetic reply is all that answered it, so it stays.
      ['user', 'Now run the config tests', false],
      ['assistant', 'No response requested.', false],
      ['user', 'Try the tests again', false],
      ['assistant', 'All config tests pass.', false],
    ],
  );
});

test('a forked reply\'s cost and time go to the prompt it answers', () => {
  const [, , pipeline, , defaults] = parseTranscript(text);
  assert.equal(pipeline.turn.requests, 2);
  assert.equal(pipeline.turn.outputTokens, 430);
  assert.equal(pipeline.turn.durationMs, 20000);
  assert.equal(defaults.turn.requests, 1);
  assert.equal(defaults.turn.outputTokens, 15);
});

test('a forked log read as it grows never merges the branches', () => {
  // The live transcript re-reads the file as each record lands; every prefix must keep the two answers apart.
  const lines = text.trimEnd().split('\n');
  for (let n = 1; n <= lines.length; n++) {
    const entries = parseTranscript(lines.slice(0, n).join('\n') + '\n');
    const defaults = entries.find((e) => e.role === 'assistant' && /defaults\.ts/.test(textOf(e)));
    if (defaults) {
      assert.doesNotMatch(textOf(defaults), /readConfig|pipeline/, `after ${n} records`);
    }
    const asked = entries.findIndex((e) => e.role === 'user' && /defaults\?/.test(textOf(e)));
    const branch = entries.findIndex((e) => e.branch);
    if (asked >= 0 && branch >= 0) {
      assert.ok(branch < asked, `the other branch's answer sits above the later question after ${n} records`);
    }
    // The other writer's placeholder shows under the pipeline question until the real answer lands, then goes.
    const pipeline = entries.findIndex((e) => e.role === 'user' && /pipeline$/.test(textOf(e)));
    if (pipeline >= 0 && pipeline + 1 < entries.length) {
      const under = entries[pipeline + 1];
      if (branch >= 0) {
        assert.equal(under, entries[branch], `only the real answer is under the question after ${n} records`);
      } else if (under.role === 'assistant') {
        assert.equal(textOf(under), 'No response requested.', `after ${n} records`);
      }
    }
  }
});

test('a log with one writer and no parent links reads as before', () => {
  // Records without uuid/parentUuid (older logs, hand-written tests) fall back to file order.
  const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const entries = parseTranscript(
    jsonl(
      { type: 'user', message: { role: 'user', content: 'one' } },
      { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
      { type: 'user', message: { role: 'user', content: 'two' } },
      { type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'b' }] } },
      { type: 'assistant', message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'c' }] } },
    ),
  );
  assert.deepEqual(entries.map((e) => [e.role, textOf(e), !!e.branch]), [
    ['user', 'one', false],
    ['assistant', 'a', false],
    ['user', 'two', false],
    ['assistant', 'b | c', false],
  ]);
});

test('a real reply reading "No response requested." stays when the other branch answers too', () => {
  // Hidden only when Claude Code wrote it itself ("model":"<synthetic>"), never on the words alone.
  const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const entries = parseTranscript(
    jsonl(
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'one' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: 'two' } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { id: 'm2', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'b' }] } },
      { type: 'assistant', uuid: 'a3', parentUuid: 'u1', message: { id: 'm3', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
    ),
  );
  assert.deepEqual(entries.map((e) => [e.role, textOf(e), !!e.branch]), [
    ['user', 'one', false],
    ['assistant', 'No response requested.', false],
    ['assistant', 'a', true],
    ['user', 'two', false],
    ['assistant', 'b', false],
  ]);
});

test('a rewound prompt parented on an earlier reply starts its own turn, with no branch marker', () => {
  // Esc Esc in the terminal: a new prompt parented on an earlier record. Its reply follows it as usual.
  const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const entries = parseTranscript(
    jsonl(
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'one' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: 'two' } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'b' }] } },
      { type: 'user', uuid: 'u3', parentUuid: 'a1', message: { role: 'user', content: 'two, again' } },
      { type: 'assistant', uuid: 'a3', parentUuid: 'u3', message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'c' }] } },
    ),
  );
  assert.deepEqual(entries.map((e) => [e.role, textOf(e), !!e.branch]), [
    ['user', 'one', false],
    ['assistant', 'a', false],
    ['user', 'two', false],
    ['assistant', 'b', false],
    ['user', 'two, again', false],
    ['assistant', 'c', false],
  ]);
});
