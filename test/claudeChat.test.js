// "Chat here": the stream-json events of a resumed Claude Code session, the automatic deny, and the process lifecycle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
  chatArgs,
  ClaudeChat,
  allowLine,
  DENY_MESSAGE,
  denyLine,
  ENDED_DENY_MESSAGE,
  LiveChat,
  PLAN_DENY_MESSAGE,
  pickerMode,
  sessionGrants,
  STOP_DENY_MESSAGE,
  USER_DENY_MESSAGE,
  resolveClaudeExecutable,
  resultError,
  turnCost,
  userLine,
} = require('../out/claudeChat');
const { renderLive, chatStateMessage, permissionDetail } = require('../out/chatView');

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
  // "Ask me" and decline-prompts both run Claude Code in its default mode; only the chat's answer differs.
  for (const mode of ['ask', 'deny']) {
    const a = chatArgs('sess-0001', mode);
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'default', mode);
  }
  assert.deepEqual(JSON.parse(userLine('Say "ok"\nplease')), {
    type: 'user',
    message: { role: 'user', content: 'Say "ok"\nplease' },
    parent_tool_use_id: null,
    session_id: '',
  });
});

test('a turn streams in, a tool request is denied with the neutral message (decline-prompts mode), and the result ends it', () => {
  const live = new LiveChat();
  live.decline = DENY_MESSAGE;
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

test('in the decline-prompts mode, ExitPlanMode is declined the same way, with a note about the plan', () => {
  const live = new LiveChat();
  live.decline = DENY_MESSAGE;
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
    mode: 'ask',
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

test('in the decline-prompts mode, a can_use_tool request is answered with the deny on stdin', async () => {
  const { chat, spawns } = makeChat({ mode: 'deny' });
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

  // The finishing turn still has its tool requests answered: nobody is left to answer a card, so they are denied.
  child.say({ type: 'control_request', request_id: 'r-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 'toolu_1' } });
  assert.deepEqual(child.controls(), [JSON.parse(denyLine('r-1', ENDED_DENY_MESSAGE))]);
  assert.ok(!chat.live.pieces.some((p) => p.kind === 'permission'), 'no card for a chat that has ended');
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
  assert.match(html, /Claude wants to use <strong>Write<\/strong>/, 'a card, by default');
  assert.equal(renderLive([], false), '');
});

test('messages waiting for an ended chat show after its finishing reply, marked as waiting (SA-32)', () => {
  const live = new LiveChat();
  live.addUser('Finish this', false);
  live.markSent();
  let html = renderLive(live.pieces, true, ['Next **one**', 'and another']);
  const typing = html.indexOf('chat-typing');
  const first = html.indexOf('Next <strong>one</strong>');
  assert.ok(html.indexOf('Finish this') < typing && typing < first, 'the reply in progress, then the waiting messages');
  assert.ok(first < html.indexOf('and another'), 'in the order sent');
  assert.equal(html.match(/waits for the previous reply to finish/g).length, 2);
  assert.equal(html.match(/chat-pending waiting/g).length, 2);
  assert.doesNotMatch(html, /queued/);
  // Once the ended chat has gone, only the waiting messages are left.
  html = renderLive([], false, ['Next one']);
  assert.match(html, /waits for the previous reply to finish/);
  assert.doesNotMatch(html, /chat-typing/);
  assert.doesNotMatch(renderLive(live.pieces, true), /waits for the previous reply/);
  assert.equal(chatStateMessage(undefined, 'ask', 2).waiting, 2);
  assert.equal(chatStateMessage(undefined, 'ask').waiting, 0);
});

// ---------- permission cards (SA-26) ----------

const readStream = (name) =>
  fs
    .readFileSync(path.join(__dirname, 'fixtures', 'claude-stream', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test('"Ask me": each request shows a card, answered in order; Allow and Deny reply on stdin and the turn carries on', () => {
  const events = readStream('permissions.jsonl');
  const live = new LiveChat();
  live.addUser('Make the out folder and fix the typo in notes.txt.', false);
  const firstResult = events.findIndex((e) => e.type === 'user' && Array.isArray(e.message.content) && e.message.content[0]?.type === 'tool_result');
  const replies = [];
  for (const ev of events.slice(0, firstResult)) {
    const r = live.apply(ev);
    if (r.reply) replies.push(r.reply);
  }
  assert.deepEqual(replies, [], 'nothing is answered until the user does');
  const cards = live.pendingPermissions();
  assert.deepEqual(cards.map((c) => [c.requestId, c.toolName, c.toolUseId]), [
    ['req-b1', 'Bash', 'toolu_B1'],
    ['req-e1', 'Edit', 'toolu_E1'],
  ]);
  assert.equal(cards[0].description, 'Create directory out');
  assert.equal(cards[1].blockedPath, '/work/demo/notes.txt');

  // Only the oldest card has buttons; the next one waits.
  let html = renderLive(live.pieces, true);
  assert.equal((html.match(/data-perm="allow"/g) ?? []).length, 1);
  assert.match(html, /data-perm="allow" data-request="req-b1"/);
  assert.match(html, /Claude wants to use <strong>Bash<\/strong>/);
  assert.match(html, /mkdir out/);
  assert.match(html, /Waiting: answer the request above first/);
  assert.doesNotMatch(html, /chat-typing/, 'a card, not the typing dots');

  // Out of order, or twice: ignored.
  assert.equal(live.answer('req-e1', true), undefined);
  assert.equal(live.answer('nope', true), undefined);
  const allow = live.answer('req-b1', true);
  assert.equal(allow, allowLine('req-b1', { command: 'mkdir out', description: 'Create directory out' }));
  assert.deepEqual(JSON.parse(allow).response, {
    subtype: 'success',
    request_id: 'req-b1',
    response: { behavior: 'allow', updatedInput: { command: 'mkdir out', description: 'Create directory out' } },
  });
  assert.equal(live.answer('req-b1', false), undefined, 'already answered');
  html = renderLive(live.pieces, true);
  assert.match(html, /data-perm="deny" data-request="req-e1"/);
  assert.match(html, /perm-outcome allowed/);

  const deny = JSON.parse(live.answer('req-e1', false));
  assert.deepEqual(deny.response, { subtype: 'success', request_id: 'req-e1', response: { behavior: 'deny', message: USER_DENY_MESSAGE } });
  assert.doesNotMatch(USER_DENY_MESSAGE, /rest of (this|the) session|do not retry/i, 'never says approvals are gone for good');
  assert.deepEqual(live.pendingPermissions(), []);

  // The rest of the turn: the allowed call ran, the denied one failed with the message Claude carries on from.
  let end;
  for (const ev of events.slice(firstResult)) {
    const r = live.apply(ev);
    assert.equal(r.reply, undefined);
    if (r.turnEnd) end = r.turnEnd;
  }
  assert.equal(end.isError, false);
  const tools = live.pieces.filter((p) => p.kind === 'tool');
  assert.deepEqual(tools.map((t) => [t.name, t.status]), [
    ['Bash', 'ok'],
    ['Edit', 'denied'],
  ]);
  // Both outcomes stay visible until the log has the turn, which then shows the tool output and the denial.
  html = renderLive(live.pieces, false);
  assert.match(html, /perm-outcome allowed[\s\S]*Allowed/);
  assert.match(html, /perm-outcome denied[\s\S]*Denied/);
  live.forget(['p-user-1', 'p-asst-1', 'p-asst-2', 'p-asst-3'].map((u) => `{"uuid":"${u}"}`).join('\n'));
  assert.deepEqual(live.pieces, []);
});

test('plan mode: ExitPlanMode shows the plan with Approve plan and Keep planning', () => {
  const events = readStream('plan.jsonl');
  for (const approve of [true, false]) {
    const live = new LiveChat();
    live.addUser('Plan a greeting module.', false);
    for (const ev of events) {
      assert.equal(live.apply(ev).reply, undefined);
    }
    const html = renderLive(live.pieces, true);
    assert.match(html, /Claude has a plan/);
    assert.match(html, /<strong>greeting<\/strong>/, 'the plan is rendered as markdown');
    assert.match(html, /Approve plan/);
    assert.match(html, /Keep planning/);
    const reply = JSON.parse(live.answer('req-plan', approve));
    assert.deepEqual(
      reply.response.response,
      approve ? { behavior: 'allow', updatedInput: { plan: '## Plan\n\n1. Add a **greeting** module.\n2. Test it.' } } : { behavior: 'deny', message: PLAN_DENY_MESSAGE },
    );
    assert.match(renderLive(live.pieces, true), approve ? /Plan approved/ : /Plan not approved/);
  }
});

test('"Allow for this session" sends the suggestions scoped to the process, never to a settings file', () => {
  // Real shapes from Claude Code 2.1.332 (doc section 6a): a Bash rule offered for localSettings, and a Write outside
  // the working folder offering Accept edits and the folder.
  assert.deepEqual(
    sessionGrants([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git tag *' }], behavior: 'allow', destination: 'localSettings' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { type: 'addDirectories', directories: ['/work/notes'], destination: 'userSettings' },
      { type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'projectSettings' },
    ]),
    [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git tag *' }], behavior: 'allow', destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { type: 'addDirectories', directories: ['/work/notes'], destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'session' },
    ],
  );
  // What it does not know or would not grant is left out; a bad entry is skipped, not a crash.
  assert.deepEqual(
    sessionGrants([
      { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm *' }], behavior: 'deny', destination: 'session' },
      { type: 'addRules', rules: [{ ruleContent: 'x' }, 7], behavior: 'allow', destination: 'session' },
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      { type: 'setMode', mode: 'plan', destination: 'session' },
      { type: 'addDirectories', directories: [], destination: 'session' },
      null,
      'addRules',
    ]),
    [],
  );
  assert.deepEqual(sessionGrants(undefined), []);
  assert.deepEqual(sessionGrants({ type: 'setMode' }), []);

  const events = readStream('session-permissions.jsonl');
  const live = new LiveChat();
  live.addUser('Tag this commit v1, then write a note in /work/notes.', false);
  const at = (id) => events.findIndex((e) => e.type === 'control_request' && e.request_id === id);
  for (const ev of events.slice(0, at('req-g1') + 1)) {
    assert.equal(live.apply(ev).reply, undefined);
  }
  let html = renderLive(live.pieces, true);
  assert.match(html, /data-perm="allow" data-request="req-g1"[\s\S]*data-perm="session" data-request="req-g1"[\s\S]*data-perm="deny" data-request="req-g1"/, 'Allow, then for this session, then Deny');
  assert.match(html, /Allow for this session/);
  assert.match(html, /For this session: allows Bash\(git tag \*\) without asking\./);
  assert.match(html, /Nothing is written to settings files/, 'the button says it writes no settings file');

  const g1 = JSON.parse(live.answer('req-g1', true, true));
  assert.deepEqual(g1.response.response, {
    behavior: 'allow',
    updatedInput: { command: 'git tag v1', description: 'Create git tag v1' },
    updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git tag *' }], behavior: 'allow', destination: 'session' }],
  });
  assert.match(renderLive(live.pieces, true), /perm-outcome allowed[\s\S]*Allowed for this session: allows Bash\(git tag \*\) without asking/);

  for (const ev of events.slice(at('req-g1') + 1, at('req-w1') + 1)) {
    assert.equal(live.apply(ev).reply, undefined);
  }
  html = renderLive(live.pieces, true);
  assert.match(html, /For this session: switches the permission mode to Accept edits; lets Claude use \/work\/notes\./);
  const w1 = live.answerLine('req-w1', true, true);
  assert.equal(w1.cliMode, 'acceptEdits', 'the process leaves default mode');
  assert.deepEqual(JSON.parse(w1.line).response.response.updatedPermissions, [
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addDirectories', directories: ['/work/notes'], destination: 'session' },
  ]);

  // The second turn asks nothing: the grants hold for the process, and its init reports the new mode.
  let init;
  for (const ev of events.slice(at('req-w1') + 1)) {
    const r = live.apply(ev);
    assert.equal(r.reply, undefined);
    if (r.init) init = r.init;
  }
  assert.equal(init.permissionMode, 'acceptEdits');
  assert.deepEqual(live.pendingPermissions(), []);
  assert.deepEqual(
    live.pieces.filter((p) => p.kind === 'tool').map((t) => t.status),
    ['ok', 'ok', 'ok', 'ok'],
  );

  // Plain Allow on a card with grants sends none; a card without grants has no third button.
  const once = new LiveChat();
  once.apply(events[at('req-g1')]);
  assert.deepEqual(JSON.parse(once.answer('req-g1', true)).response.response, { behavior: 'allow', updatedInput: { command: 'git tag v1', description: 'Create git tag v1' } });
  assert.doesNotMatch(renderLive(once.pieces, false), /for this session/i);
  const bare = new LiveChat();
  bare.apply({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, permission_suggestions: [{ type: 'replaceRules' }] } });
  assert.doesNotMatch(renderLive(bare.pieces, true), /data-perm="session"/);
  // Asked for the session anyway (a stale page): allowed once, with nothing to grant.
  assert.equal(JSON.parse(bare.answer('r', true, true)).response.response.updatedPermissions, undefined);
});

test('the picker follows the mode Claude Code switches to: a session grant, an approved plan, or what init reports', async () => {
  // "Allow for this session" with Accept edits: the picker says so at once, and the process is not restarted for it.
  const a = makeChat();
  a.chat.send('Write a note.');
  await tick();
  const aChild = a.spawns[0].child;
  const events = readStream('session-permissions.jsonl');
  aChild.say(events.find((e) => e.request_id === 'req-w1'));
  assert.equal(a.chat.status.mode, 'ask');
  assert.equal(a.chat.answer('req-w1', true, true), true);
  assert.equal(a.chat.status.mode, 'acceptEdits');
  assert.equal(chatStateMessage(a.chat.status, 'ask').mode, 'acceptEdits', 'the page is told the new mode');
  a.chat.setMode('acceptEdits');
  aChild.say(result());
  await tick();
  await tick();
  assert.equal(aChild.ended, false, 'already in acceptEdits: no restart');
  // Picking "Ask me" again does restart it: the session grants go with the process.
  a.chat.setMode('ask');
  await tick();
  assert.equal(aChild.ended, true);

  // An approved plan: Claude Code leaves plan mode for default (doc section 6a), so the picker says "Ask me".
  const b = makeChat({ mode: 'plan' });
  b.chat.send('Plan a greeting module.');
  await tick();
  const bChild = b.spawns[0].child;
  bChild.say(...readStream('plan.jsonl'));
  assert.equal(b.chat.status.mode, 'plan');
  b.chat.answer('req-plan', true);
  assert.equal(b.chat.status.mode, 'ask');
  bChild.say(result());
  await tick();
  b.chat.send('Go on.');
  await tick();
  bChild.say({ type: 'system', subtype: 'init', session_id: 'sess-0003', permissionMode: 'default' });
  assert.equal(b.chat.status.mode, 'ask');
  assert.equal(bChild.ended, false, 'no restart: the process is already in default');
  assert.equal(b.spawns.length, 1);

  // A plan not approved stays in plan mode.
  const c = makeChat({ mode: 'plan' });
  c.chat.send('Plan it.');
  await tick();
  c.spawns[0].child.say(...readStream('plan.jsonl'));
  c.chat.answer('req-plan', false);
  assert.equal(c.chat.status.mode, 'plan');

  // init is the CLI's word on it, whatever changed it; a mode the picker has no entry for leaves the picker alone.
  const d = makeChat();
  d.chat.send('hi');
  await tick();
  const dChild = d.spawns[0].child;
  dChild.say({ type: 'system', subtype: 'init', session_id: 's', permissionMode: 'default' });
  assert.equal(d.chat.status.mode, 'ask');
  dChild.say({ type: 'system', subtype: 'init', session_id: 's', permissionMode: 'auto' });
  assert.equal(d.chat.status.mode, 'auto');
  dChild.say({ type: 'system', subtype: 'init', session_id: 's', permissionMode: 'dontAsk' });
  assert.equal(d.chat.status.mode, 'auto');
  assert.ok(d.logs.some((l) => /now in dontAsk mode/.test(l)));

  // Decline-prompts runs as default too: an init saying default keeps it.
  const e = makeChat({ mode: 'deny' });
  e.chat.send('hi');
  await tick();
  e.spawns[0].child.say({ type: 'system', subtype: 'init', session_id: 's', permissionMode: 'default' });
  assert.equal(e.chat.status.mode, 'deny');

  // A mode the user picked during the turn wins over one the CLI switched to: it restarts into it after the turn.
  const f = makeChat();
  f.chat.send('Write a note.');
  await tick();
  const fChild = f.spawns[0].child;
  fChild.say(events.find((ev) => ev.request_id === 'req-w1'));
  f.chat.setMode('plan');
  f.chat.answer('req-w1', true, true);
  assert.equal(f.chat.status.mode, 'plan');
  fChild.say(result());
  await tick();
  await tick();
  assert.equal(fChild.ended, true, 'restarted into the mode the user picked');

  assert.equal(pickerMode('acceptEdits', 'ask'), 'acceptEdits');
  assert.equal(pickerMode('default', 'deny'), 'deny');
  assert.equal(pickerMode('default', 'plan'), 'ask');
  assert.equal(pickerMode('bypassPermissions', 'ask'), undefined);
});

test('a card never hangs the turn: Stop, ending the chat, switching to decline, or the process exiting resolves it', async () => {
  const ask = (child, id, tool = 'Bash') =>
    child.say({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input: { command: `echo ${id}` }, tool_use_id: `toolu_${id}` } });

  // Stop: every open card is denied, in order, before the interrupt.
  const a = makeChat();
  a.chat.send('two calls');
  await tick();
  const aChild = a.spawns[0].child;
  ask(aChild, 'r1');
  ask(aChild, 'r2');
  assert.equal(a.chat.status.awaiting, 2);
  assert.equal(chatStateMessage(a.chat.status, 'ask').awaiting, 2);
  assert.deepEqual(aChild.controls(), []);
  a.chat.interrupt();
  assert.deepEqual(
    aChild.controls().map((c) => c.response?.request_id ?? c.request.subtype),
    ['r1', 'r2', 'interrupt'],
  );
  assert.ok(aChild.controls().slice(0, 2).every((c) => c.response.response.behavior === 'deny' && c.response.response.message === STOP_DENY_MESSAGE));
  assert.equal(a.chat.status.awaiting, undefined);
  assert.match(renderLive(a.chat.live.pieces, true), /Denied\. Stopped before it was answered/);
  assert.equal(a.chat.answer('r1', true), false, 'too late to answer');

  // The tab closes (end): open cards are denied, the reply finishes, then the process exits.
  const b = makeChat();
  b.chat.send('one call');
  await tick();
  const bChild = b.spawns[0].child;
  ask(bChild, 'r1', 'Write');
  const done = b.chat.end();
  assert.deepEqual(bChild.controls(), [JSON.parse(denyLine('r1', ENDED_DENY_MESSAGE))]);
  assert.equal(bChild.ended, false, 'the reply still finishes');
  bChild.say(result());
  await done;
  assert.equal(bChild.ended, true);

  // Window close (dispose) mid-card: denied at once, then the usual grace and interrupt.
  const c = makeChat();
  c.chat.send('one call');
  await tick();
  const cChild = c.spawns[0].child;
  ask(cChild, 'r1');
  const cDone = c.chat.dispose(20, 1000);
  assert.deepEqual(cChild.controls()[0], JSON.parse(denyLine('r1', ENDED_DENY_MESSAGE)));
  await cDone;
  assert.equal(cChild.ended, true);

  // Switching to decline-prompts denies an open card and changes no process; back to "Ask me" asks again.
  const d = makeChat();
  d.chat.send('one call');
  await tick();
  const dChild = d.spawns[0].child;
  ask(dChild, 'r1');
  d.chat.setMode('deny');
  assert.deepEqual(dChild.controls(), [JSON.parse(denyLine('r1', DENY_MESSAGE))]);
  ask(dChild, 'r2');
  assert.deepEqual(dChild.controls().at(-1), JSON.parse(denyLine('r2', DENY_MESSAGE)));
  d.chat.setMode('ask');
  ask(dChild, 'r3');
  assert.equal(dChild.controls().length, 2, 'asks the user again');
  assert.equal(d.chat.answer('r3', true), true);
  assert.equal(dChild.controls().at(-1).response.response.behavior, 'allow');
  dChild.say(result());
  await tick();
  await tick();
  assert.equal(dChild.ended, false, 'same --permission-mode: no restart');
  assert.equal(d.spawns.length, 1);

  // The process exits with a card open: it is closed, says why, and nothing is written.
  const e = makeChat();
  e.chat.send('one call');
  await tick();
  const eChild = e.spawns[0].child;
  ask(eChild, 'r1');
  eChild.emit('exit', 1, null);
  assert.equal(e.chat.status.awaiting, undefined);
  assert.equal(e.chat.status.busy, false);
  assert.deepEqual(eChild.controls(), []);
  assert.match(renderLive(e.chat.live.pieces, false), /Denied\. Claude Code exited before it was answered/);
});

test('a card shows what the call does: the command, the file and its content or diff, or the input', () => {
  assert.match(permissionDetail('Bash', { command: 'rm -rf <out>' }), /<pre class="perm-pre">rm -rf &lt;out&gt;<\/pre>/);
  const write = permissionDetail('Write', { file_path: '/work/a.txt', content: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') });
  assert.match(write, /\/work\/a\.txt/);
  assert.match(write, /Writes 30 lines/);
  assert.match(write, /line 12\n… 18 more lines/);
  const edit = permissionDetail('Edit', { file_path: '/work/b.txt', old_string: 'helo', new_string: 'hello\nworld' });
  assert.match(edit, /−1 \+2 lines/);
  assert.match(edit, /- helo\n\+ hello\n\+ world/);
  assert.match(permissionDetail('MultiEdit', { file_path: '/work/c.txt', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }), /2 edits/);
  assert.match(permissionDetail('WebFetch', { url: 'https://example.com/x' }), /https:\/\/example\.com\/x/);
  assert.match(permissionDetail('mcp__thing__do', { target: 'x', count: 2 }), /&quot;target&quot;: &quot;x&quot;/);
  assert.equal(permissionDetail('Mystery', {}), '');
  assert.doesNotThrow(() => permissionDetail('Edit', { file_path: 3, old_string: null }));
});
