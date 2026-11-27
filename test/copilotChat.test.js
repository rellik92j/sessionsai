// "Chat here" for GitHub Copilot CLI sessions: the command line, the JSON output handling, and one process per turn.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
  COPILOT_EXECUTABLE,
  CopilotChat,
  CopilotLive,
  copilotChatArgs,
  copilotModeArgs,
  isCopilotMode,
  unsafeCopilotSessionId,
} = require('../out/copilotChat');
const { resolveExecutable } = require('../out/claudeChat');
const { chatModes, chatStateMessage, renderLive, COPILOT_SPEAKER } = require('../out/chatView');

const fixture = (name) =>
  fs
    .readFileSync(path.join(__dirname, 'fixtures', 'copilot-stream', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
const parsed = (name) =>
  fixture(name).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });

// ---------- the command line ----------

test('each turn resumes the session by id, in JSON with streaming; the message goes on stdin, not in the arguments', () => {
  const id = 'c0c0c0c0-0000-4000-8000-000000000001';
  assert.deepEqual(copilotChatArgs(id, 'read'), [`--resume=${id}`, '--output-format', 'json', '--stream', 'on']);
  assert.deepEqual(copilotChatArgs(id, 'edits').slice(-1), ['--allow-tool=write']);
  assert.deepEqual(copilotChatArgs(id, 'all').slice(-1), ['--allow-all-tools']);
  assert.deepEqual(copilotModeArgs('read'), []);
  assert.ok(isCopilotMode('read') && isCopilotMode('edits') && isCopilotMode('all'));
  assert.ok(!isCopilotMode('ask') && !isCopilotMode('auto') && !isCopilotMode(undefined));
  // The picker offers the three, most restrictive first.
  assert.deepEqual(chatModes('copilot-cli').map((m) => m.id), ['read', 'edits', 'all']);
  assert.ok(chatModes('copilot-cli').every((m) => m.label && m.title && m.note));
  assert.deepEqual(chatModes().map((m) => m.id), ['ask', 'acceptEdits', 'plan', 'auto', 'deny']);
});

test('finding copilot: an executable without a shell, an npm .cmd shim through cmd.exe', () => {
  const files = new Set();
  const env = (platform, pathEnv) => ({ platform, pathEnv, home: 'C:\\Users\\u', isFile: (p) => files.has(p) });
  files.add(path.join('C:\\winget', 'copilot.exe'));
  assert.deepEqual(resolveExecutable('copilot', env('win32', 'C:\\npm;C:\\winget'), COPILOT_EXECUTABLE), { exe: path.join('C:\\winget', 'copilot.exe') });
  files.clear();
  files.add(path.join('C:\\npm', 'copilot.cmd'));
  assert.deepEqual(resolveExecutable('copilot', env('win32', 'C:\\npm'), COPILOT_EXECUTABLE), { exe: path.join('C:\\npm', 'copilot.cmd'), shell: true });
  files.add('D:\\tools\\copilot.cmd');
  assert.deepEqual(resolveExecutable('D:\\tools\\copilot.cmd', env('win32', ''), COPILOT_EXECUTABLE), { exe: 'D:\\tools\\copilot.cmd', shell: true });
  // A PowerShell shim cannot run through cmd.exe.
  files.add('D:\\tools\\copilot.ps1');
  assert.match(resolveExecutable('D:\\tools\\copilot.ps1', env('win32', ''), COPILOT_EXECUTABLE).error, /script shim.*claudeSessions\.copilotCommand/);
  assert.match(resolveExecutable('npx copilot', env('win32', ''), COPILOT_EXECUTABLE).error, /needs the GitHub Copilot CLI executable/);
  assert.match(resolveExecutable('copilot', env('win32', 'C:\\empty'), COPILOT_EXECUTABLE).error, /GitHub Copilot CLI was not found: no copilot\.exe on the PATH\./);
  files.add(path.join('/usr/local/bin', 'copilot'));
  assert.deepEqual(resolveExecutable('copilot', env('linux', '/usr/bin:/usr/local/bin'), COPILOT_EXECUTABLE), { exe: path.join('/usr/local/bin', 'copilot') });
});

// ---------- the JSON output ----------

test('a turn streams in: reasoning, a tool call as its input arrives, then the reply text delta by delta', () => {
  const live = new CopilotLive();
  live.addUser('Read notes.txt and tell me what it says.', false);
  const events = parsed('turn.jsonl');
  const at = (pred) => events.findIndex(pred);
  const upTo = (i) => events.slice(0, i + 1).forEach((e) => live.applyCopilot(e));

  // The user's message is taken: its piece gets the record's id, which the log gives it too.
  upTo(at((e) => e.type === 'user.message'));
  assert.equal(live.pieces[0].uuid, 'ev-0004');
  // Thinking shows while it streams; the tool call's input builds up.
  upTo(at((e) => e.id === 'ev-0010'));
  assert.ok(live.pieces.some((p) => p.kind === 'thinking' && p.streaming));
  const tool = live.pieces.find((p) => p.kind === 'tool');
  assert.equal(tool.name, 'view');
  assert.equal(tool.input, '{"path":"notes.txt"}');
  assert.equal(tool.status, 'running');
  // The finished message names the call and its hint; the result marks it done.
  upTo(at((e) => e.type === 'tool.execution_complete'));
  assert.equal(tool.hint, 'notes.txt');
  assert.equal(tool.uuid, 'ev-0012');
  assert.equal(tool.status, 'ok');
  assert.ok(live.pieces.every((p) => p.kind !== 'thinking' || !p.streaming));
  // The reply, part way.
  upTo(at((e) => e.id === 'ev-0020'));
  let text = live.pieces.find((p) => p.kind === 'text');
  assert.equal(text.text, 'It says: remember');
  assert.ok(text.streaming);
  const html = renderLive(live.pieces, true, [], COPILOT_SPEAKER);
  assert.match(html, /<strong>Copilot<\/strong>/);
  assert.match(html, /codicon-copilot/);
  assert.match(html, /It says: remember/);
  assert.doesNotMatch(html, /Claude/);
  // Finished, under the record's id; unknown records and the rest change nothing.
  upTo(events.length - 1);
  text = live.pieces.find((p) => p.kind === 'text');
  assert.equal(text.text, 'It says: remember the milk.');
  assert.equal(text.uuid, 'ev-0022');
  assert.ok(!text.streaming);
  assert.equal(live.pieces.filter((p) => p.kind === 'text').length, 1);
  assert.ok(!live.pieces.some((p) => p.kind === 'notice'));
});

test('pieces leave once the session log has their records (by id), and the rest at the next read after the turn', () => {
  const live = new CopilotLive();
  live.addUser('Read notes.txt and tell me what it says.', false);
  for (const e of parsed('turn.jsonl')) live.applyCopilot(e);
  live.endTurn();
  // The log holds the records under "id", as the stdout does.
  const log = fixture('turn.jsonl').filter((l) => /"id":"ev-00(04|12|13)"/.test(l)).join('\n');
  assert.ok(live.forget(log));
  // The reply is not in the log read yet; it was finished, so it stays until the log has it.
  assert.deepEqual(live.pieces.map((p) => p.kind), ['text']);
  assert.ok(live.forget(fixture('turn.jsonl').join('\n')));
  assert.deepEqual(live.pieces, []);
});

test('a call declined for want of approval is marked declined and says which mode lets it run; other failures are failures', () => {
  const live = new CopilotLive();
  live.mode = 'read';
  live.addUser('Create made.txt, then run echo done.', false);
  for (const e of parsed('denied.jsonl')) live.applyCopilot(e);
  const tools = live.pieces.filter((p) => p.kind === 'tool');
  assert.deepEqual(tools.map((t) => [t.name, t.status]), [['apply_patch', 'denied'], ['powershell', 'denied']]);
  assert.equal(tools[0].hint, '*** Add File: made.txt');
  assert.equal(tools[1].hint, 'Print done');
  // One note for the turn, naming each declined tool, which stays past the log read until the next message.
  let notes = live.pieces.filter((p) => p.kind === 'notice');
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /^Declined apply_patch and powershell: Copilot CLI cannot ask for approval here.*"Allow edits"/);
  assert.ok(notes[0].tone === 'info' && !notes[0].expire);
  const html = renderLive(live.pieces, false, [], COPILOT_SPEAKER);
  assert.match(html, /chat-tool denied/);
  assert.match(html, /I could not create the file/);
  live.endTurn();
  live.forget(fixture('denied.jsonl').join('\n'));
  assert.deepEqual(live.pieces.map((p) => p.kind), ['notice']);
  // The next message clears it; that turn's own denials get a new note, worded for its mode.
  live.addUser('Try again.', false);
  assert.ok(!live.pieces.some((p) => p.kind === 'notice'));
  live.mode = 'edits';
  live.markSent();
  live.applyCopilot({ type: 'tool.execution_start', data: { toolCallId: 'call_shell_2', toolName: 'powershell', arguments: { command: 'echo again' } }, id: 'y' });
  live.applyCopilot({ type: 'tool.execution_complete', data: { toolCallId: 'call_shell_2', success: false, error: { code: 'denied' } }, id: 'z' });
  notes = live.pieces.filter((p) => p.kind === 'notice');
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /^Declined powershell: .*"Allow all tools" lets it run/);
});

test('unknown records, missing fields and garbage are skipped without throwing', () => {
  const live = new CopilotLive();
  for (const v of [null, 1, 'x', [], {}, { type: 'assistant.message' }, { type: 'assistant.message', data: { toolRequests: [null, 1, {}] } }, { type: 'tool.execution_complete', data: {} }, { type: 'x.y', data: { a: 1 } }]) {
    assert.equal(live.applyCopilot(v), false);
  }
  assert.deepEqual(live.pieces, []);
});

// ---------- one process per turn, against a fake child process ----------

function fakeSpawner() {
  const spawns = [];
  const spawn = (exe, args, cwd, shell) => {
    const child = new EventEmitter();
    child.stdinText = '';
    child.stdinEnded = false;
    child.killed = false;
    child.pid = 4000 + spawns.length;
    child.stdin = Object.assign(new EventEmitter(), {
      write: (s) => (child.stdinText += s),
      end: () => (child.stdinEnded = true),
    });
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('exit', null, 'SIGTERM'));
    };
    child.say = (...lines) => {
      const text = lines.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
      const mid = Math.floor(text.length / 2);
      child.stdout.emit('data', Buffer.from(text.slice(0, mid)));
      child.stdout.emit('data', Buffer.from(text.slice(mid)));
    };
    child.exit = (code = 0) => child.emit('exit', code, null);
    spawns.push({ exe, args, cwd, shell, child });
    return child;
  };
  return { spawns, spawn };
}

function makeChat(overrides = {}) {
  const { spawns, spawn } = fakeSpawner();
  const unsent = [];
  const logs = [];
  const chat = new CopilotChat({
    sessionId: 'c0c0c0c0-0000-4000-8000-000000000001',
    mode: 'read',
    launch: () => ({ exe: 'C:\\bin\\copilot.exe', cwd: 'C:\\work\\demo' }),
    spawn,
    onChange: () => undefined,
    onUnsent: (t) => unsent.push(...t),
    log: (l) => logs.push(l),
    ...overrides,
  });
  return { chat, spawns, unsent, logs };
}

const tick = () => new Promise((r) => setImmediate(r));
const userRecord = (id) => ({ type: 'user.message', data: { content: 'x' }, id });

test('a message is one process: the text goes on stdin intact, quotes, newlines, %, $ and backticks included', async () => {
  const { chat, spawns } = makeChat();
  const text = 'He said "hi" & \'yo\'\nline 2: %PATH% $HOME `tick` ^caret | pipe';
  chat.send(text);
  assert.equal(spawns.length, 1);
  const { exe, args, cwd, shell, child } = spawns[0];
  assert.equal(exe, 'C:\\bin\\copilot.exe');
  assert.equal(cwd, 'C:\\work\\demo');
  assert.equal(shell, false);
  assert.ok(!args.includes(text) && !args.some((a) => a.includes('PATH')), 'the message is not on the command line');
  assert.equal(child.stdinText, text);
  assert.ok(child.stdinEnded, 'stdin closes after the message, so copilot takes it as the prompt');
  assert.ok(chat.status.busy && chat.status.running && chat.replying && chat.active);
  assert.equal(chat.pid, 4000);
  child.say(userRecord('u-1'), { type: 'assistant.message_delta', data: { messageId: 'm', deltaContent: 'Hello' }, id: 'd' });
  assert.equal(chat.live.pieces.find((p) => p.kind === 'text').text, 'Hello');
  child.exit(0);
  assert.ok(!chat.status.busy && !chat.status.running && !chat.active, 'between turns no process holds the session');
  assert.ok(chat.status.lastTurn && !chat.status.lastTurn.error && !chat.status.lastTurn.interrupted);
  assert.equal(chatStateMessage(chat.status, chat.mode).running, false);
});

test('consecutive messages continue the same session, one turn at a time; a mode change applies from the next turn', async () => {
  const { chat, spawns } = makeChat();
  chat.send('first');
  chat.send('second');
  assert.equal(spawns.length, 1, 'the second waits for the first turn');
  assert.equal(chat.status.queued, 1);
  assert.ok(chat.live.pieces.find((p) => p.kind === 'user' && p.text === 'second').queued);
  chat.setMode('all');
  assert.equal(chat.mode, 'all');
  chat.setMode('ask');
  assert.equal(chat.mode, 'all', 'a Claude Code mode is not a Copilot one');
  spawns[0].child.say(userRecord('u-1'));
  spawns[0].child.exit(0);
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].child.stdinText, 'second');
  assert.deepEqual(spawns.map((s) => s.args[0]), ['--resume=c0c0c0c0-0000-4000-8000-000000000001', '--resume=c0c0c0c0-0000-4000-8000-000000000001']);
  assert.ok(!spawns[0].args.includes('--allow-all-tools'));
  assert.ok(spawns[1].args.includes('--allow-all-tools'));
  assert.ok(!chat.live.pieces.some((p) => p.kind === 'user' && p.queued));
});

test('Stop kills the running turn, marks it stopped, and gives back what was waiting', async () => {
  const { chat, spawns, unsent } = makeChat();
  chat.send('long one');
  chat.send('later');
  spawns[0].child.say(userRecord('u-1'), { type: 'assistant.tool_call_delta', data: { toolCallId: 'c1', toolName: 'view', inputDelta: '{' }, id: 't' });
  chat.interrupt();
  assert.ok(spawns[0].child.killed);
  assert.deepEqual(unsent, ['later']);
  await tick();
  assert.equal(spawns.length, 1, 'nothing more starts');
  assert.ok(!chat.status.busy);
  assert.ok(chat.status.lastTurn.interrupted && !chat.status.lastTurn.error);
  assert.equal(chatStateMessage(chat.status, chat.mode).last, 'Last turn stopped');
  assert.equal(chat.live.pieces.find((p) => p.kind === 'tool').status, 'failed', 'a call cut off is no longer shown running');
  assert.ok(!chat.live.pieces.some((p) => p.kind === 'notice'), 'a stop is no error');
});

test('a turn that fails before the session took the message gives it back, with what copilot printed', () => {
  const { chat, spawns, unsent } = makeChat();
  chat.send('hello');
  chat.send('again');
  spawns[0].child.say("Error: No session, task, or name matched 'c0c0c0c0'.");
  spawns[0].child.exit(1);
  assert.deepEqual(unsent, ['hello', 'again']);
  assert.equal(spawns.length, 1);
  const note = chat.live.pieces.find((p) => p.kind === 'notice');
  assert.match(note.text, /GitHub Copilot CLI exited with code 1\. Error: No session/);
  assert.ok(chat.status.lastTurn.error);
  assert.ok(!chat.live.pieces.some((p) => p.kind === 'user'));
});

test('a turn that fails after the session took the message keeps it, and the next message still goes', () => {
  const { chat, spawns, unsent } = makeChat();
  chat.send('hello');
  chat.send('again');
  spawns[0].child.say(userRecord('u-1'));
  spawns[0].child.stderr.emit('data', 'rate limited\n');
  spawns[0].child.exit(2);
  assert.deepEqual(unsent, []);
  assert.match(chat.live.pieces.find((p) => p.kind === 'notice').text, /code 2\. rate limited/);
  assert.equal(spawns.length, 2);
});

test('a copilot that cannot start gives every message back', () => {
  const { chat, spawns, unsent } = makeChat({ launch: () => ({ error: 'GitHub Copilot CLI was not found.' }) });
  chat.send('hello');
  assert.equal(spawns.length, 0);
  assert.deepEqual(unsent, ['hello']);
  assert.match(chat.live.pieces.find((p) => p.kind === 'notice').text, /not found/);
  const thrown = makeChat({
    spawn: () => {
      throw new Error('spawn EINVAL');
    },
  });
  thrown.chat.send('hi');
  assert.deepEqual(thrown.unsent, ['hi']);
  assert.match(thrown.chat.live.pieces.find((p) => p.kind === 'notice').text, /Could not start GitHub Copilot CLI: spawn EINVAL/);
});

test('a session id a shell could act on is refused: nothing starts, the message goes back, and the tab says why', () => {
  for (const id of ['c0c0c0c0-0000-4000-8000-000000000001', 'abc_DEF.9-x', '1.0']) {
    assert.equal(unsafeCopilotSessionId(id), undefined, `${id} is accepted`);
  }
  for (const id of ['a&calc', 'a|more', 'a"b', 'a b', '%PATH%', 'a^b', 'a<b', 'a>b', 'a;b', 'a$(b)', 'a`b`', "a'b", 'a\nb', '', 'é']) {
    assert.match(unsafeCopilotSessionId(id), /characters a shell could run as a command/, `${JSON.stringify(id)} is refused`);
  }
  let launched = 0;
  const { chat, spawns, unsent } = makeChat({
    sessionId: 'e2e&calc',
    launch: () => {
      launched++;
      return { exe: 'C:\\npm\\copilot.cmd', shell: true };
    },
  });
  chat.send('hello');
  assert.equal(spawns.length, 0, 'no process starts');
  assert.equal(launched, 0, 'it is refused before copilot is even looked for');
  assert.deepEqual(unsent, ['hello']);
  const note = chat.live.pieces.find((p) => p.kind === 'notice');
  assert.equal(note.tone, 'error');
  assert.match(note.text, /^This GitHub Copilot CLI session's id, "e2e&calc", has characters a shell could run as a command/);
  assert.ok(!chat.status.busy && !chat.active);
});

test('ending the chat lets the running turn finish and starts no more; stopNow and dispose kill it', async () => {
  const { chat, spawns, unsent } = makeChat();
  chat.send('one');
  chat.send('two');
  const ended = chat.end();
  assert.deepEqual(unsent, ['two']);
  assert.ok(chat.status.finishing);
  assert.ok(!spawns[0].child.killed);
  let done = false;
  void ended.then(() => (done = true));
  await tick();
  assert.ok(!done, 'waits for the turn');
  spawns[0].child.exit(0);
  await ended;
  assert.equal(spawns.length, 1);
  chat.send('ignored after the end');
  assert.equal(spawns.length, 1);

  const b = makeChat();
  b.chat.send('one');
  await b.chat.stopNow();
  assert.ok(b.spawns[0].child.killed);

  const c = makeChat();
  c.chat.send('one');
  const closing = c.chat.dispose(10);
  await tick();
  assert.ok(!c.spawns[0].child.killed, 'a grace period first');
  await closing;
  assert.ok(c.spawns[0].child.killed);
  // Nothing running: resolves at once.
  await makeChat().chat.end();
});

test('a kill whose exit never comes does not hold up the end', async () => {
  const { chat, spawns } = makeChat();
  chat.send('one');
  spawns[0].child.kill = () => (spawns[0].child.killed = true);
  const started = Date.now();
  await chat.stopNow();
  assert.ok(Date.now() - started < 5000);
  assert.ok(!chat.status.running);
});

test('Copilot asks nothing here, so there is never a card to answer', () => {
  const { chat } = makeChat();
  assert.equal(chat.answer('req-1', true), false);
  assert.equal(chat.status.awaiting, undefined);
});
