// Sessions live in another Claude Code process: Claude Code's registry of running processes (<config>/sessions/<pid>.json),
// stale entries left by a crash or a reused pid, and the background subagents and shells a log has no end for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const live = require('../out/liveSessions');
const { renderLiveNotice } = live;

const registry = path.join(__dirname, 'fixtures', 'claude-live', 'sessions');
const log = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-code', 'background-tasks.jsonl'), 'utf8');
const SESSION = 'b7000000-1111-4222-8333-944455556666';
const BG_SESSION = 'c8000000-1111-4222-8333-944455556666';

/** A fake OS: `alive` pids run, and `starts` gives their start times (undefined: cannot be looked up). */
function probe(alive, starts, platform = 'win32') {
  const calls = [];
  return {
    calls,
    platform,
    isAlive: (pid) => alive.includes(pid),
    startTimes: starts && (async (pids) => (calls.push(pids), starts === 'unknown' ? undefined : new Map(Object.entries(starts).map(([k, v]) => [Number(k), v])))),
  };
}

test('registry files give the process, its session, where it runs and whether it is busy; others are skipped', async () => {
  const entries = await live.readRegistry(registry);
  const byPid = Object.fromEntries(entries.map((e) => [e.pid, e]));
  assert.deepEqual(Object.keys(byPid).map(Number).sort(), [41000, 41001, 41002, 41004], 'no session id, a cut-off file and a .key file are skipped');
  const p = byPid[41000];
  assert.equal(p.sessionId, SESSION);
  assert.equal(p.kind, 'interactive');
  assert.equal(p.entrypoint, 'cli');
  assert.equal(p.status, 'idle');
  assert.equal(p.agent, 'orchestrator');
  assert.equal(p.startedAt, 1795600000000);
  assert.equal(p.procStart, '134400000000000000');
  assert.equal(p.someFutureField, undefined, 'unknown fields are left out, not a crash');
  assert.equal(live.liveLabel(p), 'Live in a terminal · idle');
  assert.equal(byPid[41001].sessionId, BG_SESSION);
  assert.equal(live.liveLabel(byPid[41001]),'Live in the background (claude --bg) · working');
  assert.equal(live.liveLabel(byPid[41002]), 'Live in another Claude Code process · working');
  assert.deepEqual(await live.readRegistry(path.join(registry, 'missing')), [], 'no registry folder (an older Claude Code) is no live sessions');
  assert.equal(live.parseRegistryEntry('[1,2]'), undefined);
  assert.equal(live.parseRegistryEntry('{"pid":-4,"sessionId":"x"}'), undefined);
  assert.equal(live.registryDirFor(path.join('cfg', 'projects')), path.join('cfg', 'sessions'));
});

test('a dead pid, a reused pid and another system\'s pid are not live; a checked pid is not looked up again', async () => {
  const entries = await live.readRegistry(registry);
  // 41000 runs and is the process that wrote its file; 41001 runs, but its pid now belongs to a later process; 41002 has
  // no start time to check; 41004 is a Linux pid in a folder this Windows machine shares.
  const os1 = probe([41000, 41001, 41002, 41004], { 41000: '134400000000300000', 41001: '134409999999999999' });
  const cache = live.newStartCheckCache();
  const alive = await live.liveOnly(entries, os1, cache);
  assert.deepEqual(alive.map((e) => e.pid).sort(), [41000, 41002]);
  assert.deepEqual(os1.calls, [[41000, 41001]], 'only entries with a start time are looked up, together');
  assert.deepEqual([...cache.verified.keys()], [41000]);
  assert.deepEqual([...cache.rejected.keys()], [41001]);
  const again = await live.liveOnly(entries, os1, cache);
  assert.deepEqual(again.map((e) => e.pid).sort(), [41000, 41002], 'the reused pid stays rejected');
  assert.equal(os1.calls.length, 1, 'neither the verified nor the rejected pid is looked up again');

  // The process exited (its file left behind): dropped, and forgotten.
  const gone = await live.liveOnly(entries, probe([41002], {}), cache);
  assert.deepEqual(gone.map((e) => e.pid), [41002]);
  assert.equal(cache.verified.has(41000), false);
  assert.equal(cache.rejected.has(41001), false, 'a dead pid is forgotten, so a later process with it is looked up afresh');

  // Start times that cannot be looked up leave a running pid counted rather than hidden.
  const unknown = await live.liveOnly(entries, probe([41000, 41001], 'unknown'));
  assert.deepEqual(unknown.map((e) => e.pid).sort(), [41000, 41001]);
  // Where start times are not checked at all (not Windows), a running pid counts.
  const posix = await live.liveOnly(entries.map((e) => ({ ...e, pidDomain: undefined })), probe([41000, 41001], undefined, 'linux'));
  assert.deepEqual(posix.map((e) => e.pid).sort(), [41000, 41001]);
});

test('a failed start-time lookup is not retried on every refresh, and is retried after the backoff', async () => {
  const entries = await live.readRegistry(registry);
  const cache = live.newStartCheckCache();
  const failing = probe([41000, 41001], 'unknown');
  const t0 = 1_800_000_000_000;
  const first = await live.liveOnly(entries, failing, cache, t0);
  assert.deepEqual(first.map((e) => e.pid).sort(), [41000, 41001], 'unchecked entries count while the lookup fails');
  await live.liveOnly(entries, failing, cache, t0 + 10_000);
  assert.equal(failing.calls.length, 1, 'no second lookup inside the backoff');

  const throwing = { platform: 'win32', isAlive: () => true, calls: 0, startTimes: async () => (throwing.calls++, Promise.reject(new Error('spawn failed'))) };
  const c2 = live.newStartCheckCache();
  await live.liveOnly(entries, throwing, c2, t0);
  await live.liveOnly(entries, throwing, c2, t0 + 1000);
  assert.equal(throwing.calls, 1, 'a lookup that throws backs off too');

  const working = probe([41000, 41001], { 41000: '134400000000000000', 41001: '134409999999999999' });
  const later = await live.liveOnly(entries, working, cache, t0 + live.START_LOOKUP_BACKOFF_MS);
  assert.deepEqual(working.calls, [[41000, 41001]], 'looked up again once the backoff is over');
  assert.deepEqual(later.map((e) => e.pid), [41000]);
  assert.equal(cache.retryAt, undefined);
});

test('on this machine: a running pid is live and the pid of an exited process is not', async (t) => {
  const exited = spawnSync(process.execPath, ['-e', '0']).pid;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionsai-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'here', kind: 'interactive', status: 'idle' }));
  fs.writeFileSync(path.join(dir, `${exited}.json`), JSON.stringify({ pid: exited, sessionId: 'gone', kind: 'interactive', status: 'busy' }));
  if (process.platform === 'win32') {
    // This process's pid, but a start time that is not this process's: a pid reused after a crash.
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ pid: process.pid, sessionId: 'reused', procStart: '100000000000000000' }));
  }
  const sessions = new live.LiveSessions(() => dir);
  let changes = 0;
  sessions.onDidChange(() => changes++);
  await sessions.refresh();
  assert.equal(sessions.forSession('here').length, 1);
  assert.equal(sessions.forSession('gone').length, 0, 'an exited process is not live');
  assert.equal(sessions.forSession('reused').length, 0, 'a reused pid is not live');
  assert.equal(sessions.forSession('here', [process.pid]).length, 0, "this extension's own chat is not somewhere else");
  assert.equal(sessions.ownFor('here', [process.pid])?.pid, process.pid);
  assert.equal(changes, 1);
  await sessions.refresh();
  assert.equal(changes, 1, 'no change, no event');
  fs.rmSync(path.join(dir, `${process.pid}.json`));
  await sessions.refresh();
  assert.equal(sessions.forSession('here').length, 0);
  assert.equal(changes, 2);
});

test('the subagents and shells a log launched and has no end for', () => {
  const tasks = live.runningTasks(log);
  assert.deepEqual(
    tasks.map((t) => [t.kind, t.id, t.name, t.description, t.waiting]),
    [
      ['agent', 'a1000000000000001', 'reviewer', 'Review the pull request', undefined],
      ['agent', 'a3000000000000003', 'ext-worker', 'Build the feature', true],
      ['shell', 'b1shell01', undefined, 'Run the tests in watch mode', undefined],
    ],
    'finished (notification), handed back, failed and stopped ones are gone; a sidechain launch and a sync call never count',
  );
  assert.equal(tasks[0].since, Date.parse('2026-11-20T10:00:02.000Z'));
  // A shell with no description is named by the first line of its command.
  const bare = live.runningTasks(log.split('\n').filter((l) => !l.includes('b2shell02') || !l.includes('task-notification')).join('\n'));
  assert.equal(bare.find((t) => t.id === 'b2shell02')?.description, 'npm run build');
  assert.deepEqual(live.runningTasks(''), []);
  assert.deepEqual(live.runningTasks('garbage\n{"type":"user"}\n'), []);
});

test('only what was launched since the live process started runs: a restart ends the rest', () => {
  const tasks = live.runningTasks(log);
  const before = { pid: 1, sessionId: SESSION, startedAt: Date.parse('2026-11-20T09:00:00.000Z') };
  const after = { pid: 1, sessionId: SESSION, startedAt: Date.parse('2026-11-20T10:00:09.000Z') };
  assert.equal(live.tasksOf(tasks, before).length, 3);
  assert.deepEqual(live.tasksOf(tasks, after).map((t) => t.id), ['b1shell01']);
});

test('the warning names where the session is live and what still runs there', () => {
  const tasks = live.runningTasks(log);
  const p = { pid: 1, sessionId: SESSION, kind: 'interactive', entrypoint: 'cli', status: 'idle' };
  const text = live.liveWarning('Ship it', p, tasks, 'Chatting here as well');
  assert.match(text, /^"Ship it" is live in a terminal \(idle\), with 2 subagents and 1 background shell still running: /);
  assert.match(text, /reviewer "Review the pull request", ext-worker "Build the feature", background shell "Run the tests in watch mode"\./);
  assert.match(text, /It is idle at its prompt, but the work it started is not done\./);
  assert.match(text, /Chatting here as well would put a second Claude Code process on this session/);
  const busy = live.liveWarning('Ship it', { ...p, status: 'busy' }, [], 'Resuming it here as well');
  assert.equal(busy, '"Ship it" is live in a terminal (working). Resuming it here as well would put a second Claude Code process on this session, and the two fork its log. Let it finish there, or close it there first.');
});

test('the transcript notice: live elsewhere with what runs, only what this chat runs, or nothing', () => {
  const tasks = live.runningTasks(log);
  const p = { pid: 1, sessionId: SESSION, kind: 'interactive', entrypoint: 'cli', status: 'busy' };
  const html = renderLiveNotice([p, { ...p, pid: 2 }], undefined, tasks);
  assert.match(html, /Live in a terminal · working/);
  assert.match(html, /class="live-head busy"/);
  assert.match(html, /and 1 more process/);
  assert.match(html, /reviewer &quot;Review the pull request&quot;/);
  assert.match(html, /waiting on its own background work/);
  assert.match(html, /codicon-terminal/);
  assert.equal(renderLiveNotice([], undefined, tasks), '', 'no live process: nothing runs');
  assert.match(renderLiveNotice([], p, tasks), /Still running in this chat/);
  assert.equal(renderLiveNotice([], p, []), '', "this tab's own chat with nothing in the background says nothing");
  assert.doesNotMatch(renderLiveNotice([p], undefined, []), /live-tasks/);
});
