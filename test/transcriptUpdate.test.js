// The diff that decides what an open transcript tab redraws when its log grows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { diffBlocks, logSignature } = require('../out/transcriptUpdate');
const { parseTranscript } = require('../out/sessionParser');

test('nothing changed: no patch', () => {
  assert.equal(diffBlocks(['a', 'b'], ['a', 'b']), undefined);
  assert.equal(diffBlocks([], []), undefined);
});

test('appended blocks are sent, and counted as added', () => {
  assert.deepEqual(diffBlocks(['a', 'b'], ['a', 'b', 'c', 'd']), {
    blocks: [
      { index: 2, html: 'c' },
      { index: 3, html: 'd' },
    ],
    length: 4,
    added: 2,
  });
});

test('a changed earlier block is resent in place, before the new ones', () => {
  assert.deepEqual(diffBlocks(['a', 'b'], ['a', 'B', 'c']), {
    blocks: [
      { index: 1, html: 'B' },
      { index: 2, html: 'c' },
    ],
    length: 3,
    added: 1,
  });
});

test('a log that got shorter (rewritten) trims the page', () => {
  assert.deepEqual(diffBlocks(['a', 'b', 'c'], ['a']), { blocks: [], length: 1, added: 0 });
  assert.deepEqual(diffBlocks(['a', 'b', 'c'], ['x', 'b']), { blocks: [{ index: 0, html: 'x' }], length: 2, added: 0 });
});

test('the signature changes with size or time, and is empty for a missing log', () => {
  assert.equal(logSignature(undefined), '');
  assert.notEqual(logSignature({ size: 10, mtimeMs: 1 }), logSignature({ size: 11, mtimeMs: 1 }));
  assert.notEqual(logSignature({ size: 10, mtimeMs: 1 }), logSignature({ size: 10, mtimeMs: 2 }));
});

test('a growing log: earlier entries keep their place, so blocks line up by index', () => {
  // Rendering needs VS Code, so this checks what the diff relies on: each entry of the shorter log is, at the same
  // index, the start of an entry in the longer one. The last can grow: a tool result lands on its tool call, and the
  // reply that follows joins the same entry.
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-code', 'live-session.jsonl'), 'utf8').trimEnd().split('\n');
  const before = parseTranscript(lines.slice(0, 5).join('\n'));
  const after = parseTranscript(lines.join('\n'));
  assert.ok(after.length > before.length);
  const label = (p) => p.kind + (p.kind === 'text' ? p.text : p.kind === 'tool_use' ? p.name : '');
  before.forEach((e, i) => {
    assert.equal(after[i].role, e.role);
    assert.deepEqual(after[i].parts.slice(0, e.parts.length).map(label), e.parts.map(label), `entry ${i}`);
  });
  const toolBefore = before.flatMap((e) => e.parts).find((p) => p.kind === 'tool_use' && p.name === 'Edit');
  const toolAfter = after.flatMap((e) => e.parts).find((p) => p.kind === 'tool_use' && p.name === 'Edit');
  assert.equal(toolBefore.result, undefined, 'no result yet');
  assert.ok(toolAfter.result && !toolAfter.result.isError, 'the result landed on the earlier entry');

  const stringify = (entries) => entries.map((e) => JSON.stringify(e));
  const patch = diffBlocks(stringify(before), stringify(after));
  assert.equal(patch.length, after.length);
  assert.equal(patch.added, after.length - before.length);
  assert.ok(patch.blocks.some((b) => b.index < before.length), 'the entry holding the Edit changed');
});
