// "Chat here": the stream-json events of a resumed Claude Code session, the automatic deny, and the process lifecycle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
  chatArgs,
  ClaudeChat,
  DENY_MESSAGE,
  denyLine,
  LiveChat,
  resolveClaudeExecutable,
  resultError,
  turnCost,
  userLine,
} = require('../out/claudeChat');
const { renderLive, chatStateMessage } = require('../out/chatView');

const fixture = fs
  .readFileSync(path.join(__dirname, 'fixtures', 'claude-stream', 'turn.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

test('the chat process is resumed in stream-json mode with an explicit permission mode and stdio prompts', () => {
  const args = chatArgs('sess-0001', 'acceptEdits');
  assert.deepEqual(args.slice(0, 3), ['-p', '--resume', 'sess-0001']);
  for (const flag of ['--include-partial-messages', '--verbose', '--replay-user-messages']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(!args.includes('--permission-prompts'), 'never --permission-prompts none: it poisons the session');
  assert.deepEqual(JSON.parse(userLine('Say "ok"\nplease')), {
    type: 'user',
    message: { role: 'user', content: 'Say "ok"\nplease' },
    parent_tool_use_id: null,
    session_id: '',
  });
});

test('a turn streams in, a tool request is denied with the neutral message, and the result ends it', () => {
  const live = new LiveChat();
  live.addUser('Write hello.txt, then tell me what you did.', false);
  const replies = [];
  let end;
  let init;
  const texts = [];
  for (const ev of fixture) {
    const r = live.apply(ev);
    if (r.reply) replies.push(JSON.parse(r.reply));
    if (r.turnEnd) end = r.turnEnd;
    if (r.init) init = r.init;
    const t = live.pieces.find((p) => p.kind === 'text');
    if (t) texts.push(t.text);
  }
  assert.deepEqual(init, { permissionMode: 'default', model: 'claude-haiku-test' });
  // Text grew delta by delta before the finished block replaced it.
  assert.ok(texts.includes("I'll create "));
  assert.ok(texts.includes("I'll create the file."));

  // The can_use_tool request got the deny; an unknown control request got an error reply, so nothing hangs.
  assert.deepEqual(replies[0], {
    type: 'control_response',
    response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'deny', message: DENY_MESSAGE } },
  });
  assert.equal(replies[1].response.subtype, 'error');
  assert.equal(replies[1].response.request_id, 'req-2');
  assert.equal(replies.length, 2);
  assert.doesNotMatch(DENY_MESSAGE, /rest of (this|the) session/i, 'never says approvals are gone for good');

  const kinds = live.pieces.map((p) => p.kind + (p.uuid ? `:${p.uuid}` : ''));
  assert.deepEqual(kinds, ['user:u-user-1', 'text:u-asst-1', 'tool:u-asst-2', 'notice', 'thinking:u-asst-3', 'text:u-asst-4']);
  const tool = live.pieces.find((p) => p.kind === 'tool');
  assert.equal(tool.name, 'Write');
  assert.equal(tool.status, 'denied');
  assert.equal(tool.hint, '/work/demo/hello.txt');
  assert.match(live.pieces.find((p) => p.kind === 'notice').text, /^Declined Write/);
  assert.ok(!live.pieces.some((p) => p.text === "A subagent's own reply."), "a subagent's stream is not this session's");
  assert.ok(live.pieces.every((p) => !p.streaming));

  // Per-turn cost from model_usage_since_last_result, never the session total.
  assert.ok(Math.abs(end.cost - 0.015) < 1e-12, 'not total_cost_usd (4.25)');
  assert.deepEqual({ ...end, cost: undefined }, { isError: false, error: undefined, cost: undefined, durationMs: 2800, interrupted: false });

  // The log catches up: what it records (by uuid) leaves, and so do the turn's notes.
  assert.equal(live.forget('{"uuid":"u-user-1"}\n{"uuid":"u-asst-1"}\n'), true);
  assert.deepEqual(live.pieces.map((p) => p.uuid ?? p.kind), ['u-asst-2', 'u-asst-3', 'u-asst-4']);
  live.forget('{"uuid":"u-asst-2"}{"uuid":"u-asst-3"}{"uuid":"u-asst-4"}');
  assert.deepEqual(live.pieces, []);
  assert.equal(live.forget(''), false);
});

test('per-turn cost, and what a failed turn says', () => {
  assert.equal(turnCost({ total_cost_usd: 9, model_usage_since_last_result: { a: { costUSD: 0.5 }, b: { costUSD: 0.25 } } }), 0.75);
  assert.equal(turnCost({ total_cost_usd: 9 }), undefined);
  assert.equal(turnCost({ model_usage_since_last_result: { a: { costUSD: 'x' } } }), undefined);
  assert.equal(resultError({ errors: ['No conversation found with session ID: x'], result: '' }), 'No conversation found with session ID: x');
  assert.equal(resultError({ result: 'API Error: 404' }), 'API Error: 404');
  assert.equal(resultError({ subtype: 'error_max_turns' }), 'The turn failed (error_max_turns).');

  const live = new LiveChat();
  live.addUser('hi', false);
  const r = live.apply({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'API Error: 404 model not found' });
  assert.equal(r.turnEnd.isError, true);
  const notice = live.pieces.find((p) => p.kind === 'notice');
  assert.equal(notice.tone, 'error');
  assert.equal(notice.text, 'API Error: 404 model not found');
  // An error stays through log reads, until the next message.
  live.forget('');
  assert.ok(live.pieces.some((p) => p.kind === 'notice'));
  live.addUser('again', false);
  assert.ok(!live.pieces.some((p) => p.kind === 'notice'));

  // An interrupt ends the turn without an error, in the doc's shape and in the one Claude Code 2.1.332 sends, whose
  // `errors` holds a diagnostic rather than a message for the user.
  const stopped = new LiveChat().apply({ type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: null });
  assert.equal(stopped.turnEnd.interrupted, true);
  assert.equal(stopped.turnEnd.isError, false);
  const interrupted = fs
    .readFileSync(path.join(__dirname, 'fixtures', 'claude-stream', 'interrupted.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const asked of [false, true]) {
    const live = new LiveChat();
    live.addUser('Count to 100', false);
    live.interrupting = asked;
    const ends = interrupted.map((ev) => live.apply(ev).turnEnd).filter(Boolean);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].interrupted, true, `Stop pressed: ${asked}`);
    assert.equal(ends[0].isError, false);
    assert.ok(!live.pieces.some((p) => p.kind === 'notice'), 'no error shown for a stop');
    assert.equal(live.interrupting, false, 'reset for the next turn');
  }
});

test('ExitPlanMode in plan mode is declined the same way, with a note about the plan', () => {
  const live = new LiveChat();
  const r = live.apply({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'Step 1' }, tool_use_id: 'toolu_P' } });
  assert.equal(r.reply, denyLine('p1'));
  assert.match(live.pieces[0].text, /^Declined the plan/);
});

test('unknown events and shapes are skipped, never thrown on', () => {
  const live = new LiveChat();
  for (const ev of [null, 1, 'x', [], {}, { type: 'assistant' }, { type: 'assistant', message: { content: 'text' } }, { type: 'user', message: {} }, { type: 'stream_event' }, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'orphan' } } }, { type: 'control_request', request: {} }, { type: 'result' }]) {
    assert.doesNotThrow(() => live.apply(ev));
  }
});

test('claude.exe is found on the PATH or in ~/.local/bin, and a .cmd shim is refused', () => {
  const files = new Set();
  const env = (platform, pathEnv) => ({ platform, pathEnv, home: platform === 'win32' ? 'C:\\Users\\u' : '/home/u', isFile: (p) => files.has(p) });
  // Windows: the .exe on the PATH.
  files.add(path.join('C:\\tools', 'claude.exe'));
  assert.deepEqual(resolveClaudeExecutable('claude', env('win32', 'C:\\nothing;C:\\tools')), { exe: path.join('C:\\tools', 'claude.exe') });
  files.clear();
  // Only an npm shim: refused, never run through cmd.exe.
  files.add(path.join('C:\\npm', 'claude.cmd'));
  const shim = resolveClaudeExecutable('claude', env('win32', 'C:\\npm'));
  assert.match(shim.error, /script shim/);
  // The native installer's folder, even when the extension host's PATH lacks it.
  files.add(path.join('C:\\Users\\u', '.local', 'bin', 'claude.exe'));
  assert.deepEqual(resolveClaudeExecutable('claude', env('win32', 'C:\\npm')), { exe: path.join('C:\\Users\\u', '.local', 'bin', 'claude.exe') });
  files.clear();
  // A configured path is used as it is, unless it is a shim.
  files.add('D:\\bin\\claude.exe');
  files.add('D:\\bin\\claude.cmd');
  assert.deepEqual(resolveClaudeExecutable('D:\\bin\\claude.exe', env('win32', '')), { exe: 'D:\\bin\\claude.exe' });
  assert.match(resolveClaudeExecutable('D:\\bin\\claude.cmd', env('win32', '')).error, /script shim/);
  // A command line, or a path that is not there, is not the executable.
  assert.match(resolveClaudeExecutable('npx claude', env('win32', '')).error, /needs the Claude Code executable/);
  assert.match(resolveClaudeExecutable('D:\\missing\\claude.exe', env('win32', '')).error, /needs the Claude Code executable/);
  assert.match(resolveClaudeExecutable('claude', env('win32', 'C:\\empty')).error, /Claude Code was not found: no claude\.exe/);
  // Elsewhere: the plain name on the PATH.
  files.add(path.join('/usr/local/bin', 'claude'));
  assert.deepEqual(resolveClaudeExecutable('claude', env('linux', '/usr/bin:/usr/local/bin')), { exe: path.join('/usr/local/bin', 'claude') });
});

// ---------- the process lifecycle, against a fake child process ----------

function fakeSpawner() {
  const spawns = [];
  const spawn = (exe, args, cwd) => {
    const child = new EventEmitter();
    child.written = [];
    child.ended = false;
    child.killed = false;
    child.stdin = Object.assign(new EventEmitter(), {
      write: (s) => child.written.push(s),
      end: () => {
        child.ended = true;
        if (child.exitOnEnd !== false) setImmediate(() => child.emit('exit', 0, null));
      },
    });
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('exit', null, 'SIGTERM'));
    };
    /** Writes events to stdout, split across chunks the way a pipe may. */
    child.say = (...events) => {
      const text = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
      const mid = Math.floor(text.length / 2);
      child.stdout.emit('data', Buffer.from(text.slice(0, mid)));
      child.stdout.emit('data', Buffer.from(text.slice(mid)));
    };
    child.users = () => child.written.map((l) => JSON.parse(l)).filter((m) => m.type === 'user').map((m) => m.message.content);
    child.controls = () => child.written.map((l) => JSON.parse(l)).filter((m) => m.type !== 'user');
    spawns.push({ exe, args, cwd, child });
    return child;
  };
  return { spawns, spawn };
}

function makeChat(overrides = {}) {
  const { spawns, spawn } = fakeSpawner();
  const unsent = [];
  const logs = [];
  let changes = 0;
  const chat = new ClaudeChat({
    sessionId: 'sess-0001',
    mode: 'default',
    launch: () => ({ exe: '/bin/claude', cwd: '/work/demo' }),
    spawn,
    onChange: () => changes++,
    onUnsent: (t) => unsent.push(...t),
    log: (l) => logs.push(l),
    ...overrides,
  });
  return { chat, spawns, unsent, logs, changes: () => changes };
}

const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', model_usage_since_last_result: { m: { costUSD: 0.01 } }, duration_ms: 1000, ...extra });
const tick = () => new Promise((r) => setImmediate(r));

test('one process takes several turns; a message typed during a turn waits for its result', async () => {
  const { chat, spawns } = makeChat();
  chat.send('first');
  await tick();
  assert.equal(spawns.length, 1);
  const { child, exe, args, cwd } = spawns[0];
  assert.equal(exe, '/bin/claude');
  assert.equal(cwd, '/work/demo');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.deepEqual(child.users(), ['first']);
  assert.equal(chat.status.busy, true);

  chat.send('second');
  chat.send('third');
  await tick();
  assert.deepEqual(child.users(), ['first'], 'queued, not written while a turn runs');
  assert.equal(chat.status.queued, 2);
  assert.deepEqual(chat.live.pieces.filter((p) => p.kind === 'user').map((p) => !!p.queued), [false, true, true]);

  child.say(result());
  await tick();
  assert.deepEqual(child.users(), ['first', 'second']);
  child.say(result());
  await tick();
  child.say('not json at all', result());
  await tick();
  assert.deepEqual(child.users(), ['first', 'second', 'third']);
  assert.equal(spawns.length, 1, 'the same process for every turn');
  assert.equal(chat.status.busy, false);
  assert.equal(chat.status.running, true);
  assert.deepEqual(chat.status.lastTurn, { cost: 0.01, durationMs: 1000, error: undefined, interrupted: undefined });
  assert.equal(chatStateMessage(chat.status, 'default').last, 'Last turn $0.01 · 1.0s');
});

test('a can_use_tool request is answered with the deny on stdin', async () => {
  const { chat, spawns } = makeChat();
  chat.send('write it');
  await tick();
  const { child } = spawns[0];
  child.say({ type: 'control_request', request_id: 'r-9', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'mkdir out' }, tool_use_id: 'toolu_B' } });
  assert.deepEqual(child.controls(), [JSON.parse(denyLine('r-9'))]);
  assert.equal(chat.status.busy, true, 'the turn carries on');

  // A request that names a subagent's tool call is still answered, though the subagent's own stream is skipped.
  child.say({ type: 'control_request', parent_tool_use_id: 'toolu_Task', request_id: 'r-10', request: { subtype: 'can_use_tool', tool_name: 'Edit', input: {}, tool_use_id: 'toolu_E' } });
  assert.deepEqual(child.controls().at(-1), JSON.parse(denyLine('r-10')));
  child.say({ type: 'control_request', parent_tool_use_id: 'toolu_Task', request_id: 'r-11', request: { subtype: 'mcp_message' } });
  assert.equal(child.controls().at(-1).response.subtype, 'error', 'an unknown request from a subagent gets an error reply');
});

test('Stop sends the interrupt control request and never kills; waiting messages come back', async () => {
  const { chat, spawns, unsent } = makeChat();
  chat.send('long job');
  chat.send('after it');
  await tick();
  const { child } = spawns[0];
  chat.interrupt();
  assert.deepEqual(child.controls().map((c) => c.request.subtype), ['interrupt']);
  assert.equal(child.killed, false);
  assert.equal(child.ended, false);
  assert.deepEqual(unsent, ['after it']);
  assert.ok(!chat.live.pieces.some((p) => p.kind === 'user' && p.queued));
  child.say({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }, result({ subtype: 'error_during_execution', is_error: true, stop_reason: null }));
  await tick();
  assert.equal(chat.status.busy, false);
  assert.equal(chat.status.lastTurn.interrupted, true);
  // The message box can send again, to the same process.
  chat.send('next');
  await tick();
  assert.deepEqual(child.users(), ['long job', 'next']);
  assert.equal(spawns.length, 1);
});

test('a new permission mode restarts the process between turns, never during one', async () => {
  const { chat, spawns } = makeChat();
  chat.send('one');
  await tick();
  const first = spawns[0].child;
  chat.setMode('plan');
  assert.equal(first.ended, false, 'busy: waits for the turn');
  chat.send('two');
  await tick();
  first.say(result());
  await tick();
  await tick();
  assert.equal(first.ended, true);
  assert.equal(spawns.length, 2);
  const { args, child } = spawns[1];
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.deepEqual(child.users(), ['two'], 'the queued message goes to the new process');

  // Idle: the process closes at once, and the next message starts one in the new mode.
  child.say(result());
  await tick();
  chat.setMode('acceptEdits');
  await tick();
  assert.equal(child.ended, true);
  assert.equal(chat.status.running, false);
  chat.send('three');
  await tick();
  assert.equal(spawns.length, 3);
  assert.equal(spawns[2].args[spawns[2].args.indexOf('--permission-mode') + 1], 'acceptEdits');
});

test('ending the chat during a turn lets the reply finish: no interrupt, stdin closes after its result, waiting messages come back', async () => {
  const { chat, spawns, unsent } = makeChat();
  chat.send('long job');
  chat.send('queued behind it');
  await tick();
  const { child } = spawns[0];
  let exited = false;
  const done = chat.end().then(() => (exited = true));
  assert.deepEqual(child.controls(), [], 'no interrupt line');
  assert.equal(child.ended, false, 'stdin stays open while the turn runs');
  assert.deepEqual(unsent, ['queued behind it']);
  assert.equal(chat.status.busy, true);
  assert.equal(chat.status.finishing, true);
  assert.equal(chat.replying, true);
  assert.equal(chatStateMessage(chat.status, 'default').finishing, true);

  // The finishing turn still has its tool requests answered.
  child.say({ type: 'control_request', request_id: 'r-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 'toolu_1' } });
  assert.deepEqual(child.controls(), [JSON.parse(denyLine('r-1'))]);
  await tick();
  assert.equal(exited, false);

  child.say(result());
  await done;
  assert.equal(child.ended, true);
  assert.equal(child.killed, false);
  assert.equal(chat.status.lastTurn.interrupted, undefined, 'the reply finished');
  assert.deepEqual(child.users(), ['long job'], 'the waiting message was never sent');
  assert.equal(chat.active, false);
  chat.send('after');
  assert.equal(spawns.length, 1, 'an ended chat starts nothing');

  // No time limit on the finishing turn, but a process that has not exited some time after its result is killed.
  const b = makeChat();
  b.chat.send('long job');
  await tick();
  const bChild = b.spawns[0].child;
  bChild.exitOnEnd = false;
  const bDone = b.chat.end(20);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(bChild.killed, false, 'not killed while the turn runs');
  bChild.say(result());
  await bDone;
  assert.equal(bChild.ended, true);
  assert.equal(bChild.killed, true);
});

test('stop now interrupts a reply that is finishing after the chat ended', async () => {
  const { chat, spawns } = makeChat();
  chat.send('long job');
  await tick();
  const { child } = spawns[0];
  const done = chat.end();
  assert.equal(child.ended, false);
  void chat.stopNow();
  void chat.stopNow();
  assert.deepEqual(child.controls().map((c) => c.request.subtype), ['interrupt'], 'one interrupt line');
  assert.equal(child.ended, true);
  await done;
  assert.equal(chat.status.running, false);

  // Stop in the chat bar works on a finishing chat too: the interrupt, then stdin closes after the result.
  const b = makeChat();
  b.chat.send('long job');
  await tick();
  const bChild = b.spawns[0].child;
  const bDone = b.chat.end();
  b.chat.interrupt();
  assert.deepEqual(bChild.controls().map((c) => c.request.subtype), ['interrupt']);
  assert.equal(bChild.ended, false);
  bChild.say(result({ subtype: 'error_during_execution', is_error: true, stop_reason: null }));
  await bDone;
  assert.equal(bChild.ended, true);
  assert.equal(b.chat.status.lastTurn.interrupted, true);
});

test('window close: a running turn gets a grace period, then the interrupt; a process that will not exit is killed', async () => {
  // Finishes within the grace period: no interrupt.
  const a = makeChat();
  a.chat.send('quick');
  await tick();
  const aChild = a.spawns[0].child;
  const aDone = a.chat.dispose(200, 1000);
  await tick();
  aChild.say(result());
  await aDone;
  assert.deepEqual(aChild.controls(), []);
  assert.equal(aChild.killed, false);

  const { chat, spawns } = makeChat();
  chat.send('hi');
  await tick();
  const { child } = spawns[0];
  child.exitOnEnd = false;
  const done = chat.dispose(40, 30);
  assert.deepEqual(child.controls(), [], 'not interrupted straight away');
  assert.equal(child.ended, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(child.controls().map((c) => c.request.subtype), ['interrupt'], 'interrupted after the grace period');
  assert.equal(child.ended, true);
  await done;
  assert.equal(child.killed, true, 'killed when it would not exit');
  assert.equal(chat.status.running, false);
  assert.equal(chat.active, false);

  // An idle process that exits on its own is not killed.
  const b = makeChat();
  b.chat.send('hi');
  await tick();
  b.spawns[0].child.say(result());
  await b.chat.dispose(1000);
  assert.equal(b.spawns[0].child.ended, true);
  assert.equal(b.spawns[0].child.killed, false);
  b.chat.send('after');
  assert.equal(b.spawns.length, 1, 'a disposed chat starts nothing');

  // A kill whose exit is never reported: whoever waits (window close) is let go after a short wait.
  const c = makeChat();
  c.chat.send('hi');
  await tick();
  const stuck = c.spawns[0].child;
  stuck.exitOnEnd = false;
  stuck.kill = () => (stuck.killed = true);
  const started = Date.now();
  await c.chat.dispose(10, 10);
  assert.equal(stuck.killed, true);
  assert.ok(Date.now() - started < 5000);
  assert.ok(c.logs.some((l) => /No exit reported after the kill/.test(l)));
});

test('errors show in the tab: CLI not found, a spawn failure, a crash', async () => {
  const missing = makeChat({ launch: () => ({ error: 'Claude Code was not found.' }) });
  missing.chat.send('hello');
  await tick();
  assert.equal(missing.spawns.length, 0);
  assert.deepEqual(missing.unsent, ['hello'], 'the message goes back to the box');
  assert.deepEqual(missing.chat.live.pieces.map((p) => [p.kind, p.text]), [['notice', 'Claude Code was not found.']]);
  assert.equal(missing.chat.status.busy, false);

  const throws = makeChat({
    spawn: () => {
      throw new Error('spawn EINVAL');
    },
  });
  throws.chat.send('hello');
  await tick();
  assert.match(throws.chat.live.pieces[0].text, /Could not start Claude Code: spawn EINVAL/);
  assert.deepEqual(throws.unsent, ['hello']);

  // ENOENT arrives as an error event after spawn() returned.
  const enoent = makeChat();
  enoent.chat.send('hello');
  await tick();
  enoent.spawns[0].child.emit('error', new Error('spawn claude ENOENT'));
  assert.match(enoent.chat.live.pieces.find((p) => p.kind === 'notice').text, /ENOENT/);
  assert.deepEqual(enoent.unsent, ['hello']);

  // A crash mid-turn: its exit code and stderr, logged and shown; the next message starts a new process.
  const crash = makeChat();
  crash.chat.send('hello');
  await tick();
  const { child } = crash.spawns[0];
  child.stderr.emit('data', Buffer.from('fatal: something broke\n'));
  child.emit('exit', 1, null);
  const notice = crash.chat.live.pieces.find((p) => p.kind === 'notice');
  assert.equal(notice.tone, 'error');
  assert.match(notice.text, /stopped in the middle of the turn \(exit code 1\)\. fatal: something broke/);
  assert.ok(crash.logs.some((l) => l.includes('stderr: fatal: something broke')));
  assert.equal(crash.chat.status.busy, false);
  assert.equal(crash.chat.status.running, false);
  crash.chat.send('again');
  await tick();
  assert.equal(crash.spawns.length, 2);
});

test('the pending part shows the message at once, a typing indicator, and the reply as it streams', () => {
  const live = new LiveChat();
  live.addUser('Hi **there**', false);
  live.addUser('and then', true);
  let html = renderLive(live.pieces, true);
  assert.match(html, /<strong>there<\/strong>/);
  assert.match(html, /queued/);
  assert.match(html, /chat-typing/);
  live.apply(fixture[3]);
  live.apply(fixture[4]);
  live.apply(fixture[5]);
  html = renderLive(live.pieces, true);
  assert.match(html, /<p>I'll create<\/p>/);
  assert.doesNotMatch(html, /chat-typing/);
  live.apply(fixture[15]);
  html = renderLive(live.pieces, false);
  assert.match(html, /Declined Write/);
  assert.equal(renderLive([], false), '');
});
