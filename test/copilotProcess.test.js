// Stopping a Copilot CLI chat turn: the turn and every command it started go, on every platform.
//
// The unit tests run everywhere. The process tests start a stand-in "copilot" (Node) that starts a long-running
// "command" (Node again) of its own, then stop the turn and check that neither is left. The POSIX ones run on the
// Linux and macOS runners of the process-tree CI job; the Windows one runs in the test job. Every process they signal
// is one they started.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const { GROUP_KILL_GRACE_MS, killTurnTree, turnSpawnOptions } = require('../out/copilotProcess');

const isWindows = process.platform === 'win32';

// ---------- spawn options ----------

test('on macOS and Linux a turn starts detached, in a process group of its own', () => {
  const base = { cwd: '/w', shell: false, windowsHide: true, stdio: 'pipe' };
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(turnSpawnOptions(base, platform), { ...base, detached: true });
  }
  assert.equal(base.detached, undefined, 'the options passed in are not changed');
});

test('on Windows a turn starts exactly as before: not detached, which would open a console', () => {
  const base = { cwd: 'C:\\w', shell: true, windowsHide: true, stdio: 'pipe' };
  assert.equal(turnSpawnOptions(base, 'win32'), base);
});

// ---------- killTurnTree with fakes ----------

function fakeChild(pid = 4242) {
  const kills = [];
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill: (signal) => kills.push(signal ?? 'default'),
    kills,
  };
}

function fakeDeps(platform, { groupError } = {}) {
  const calls = { execFile: [], group: [], timers: [] };
  return {
    calls,
    deps: {
      platform,
      graceMs: 50,
      execFile: (file, args, options, callback) => calls.execFile.push({ file, args, options, callback }),
      killGroup: (pgid, signal) => {
        calls.group.push([pgid, signal]);
        if (groupError) {
          throw Object.assign(new Error(groupError), { code: groupError });
        }
      },
      setTimeout: (f, ms) => calls.timers.push({ f, ms }),
    },
  };
}

test('Windows: Stop runs taskkill /pid <pid> /T /F and never signals a group', () => {
  const child = fakeChild(1234);
  const { calls, deps } = fakeDeps('win32');
  killTurnTree(child, deps);
  assert.equal(calls.execFile.length, 1);
  assert.equal(calls.execFile[0].file, 'taskkill');
  assert.deepEqual(calls.execFile[0].args, ['/pid', '1234', '/T', '/F']);
  assert.deepEqual(calls.execFile[0].options, { windowsHide: true });
  assert.deepEqual(calls.group, []);
  calls.execFile[0].callback(null);
  assert.deepEqual(child.kills, [], 'taskkill worked, so nothing else');
});

test('Windows: when taskkill fails, the turn process itself is killed', () => {
  const child = fakeChild(1234);
  const { calls, deps } = fakeDeps('win32');
  killTurnTree(child, deps);
  calls.execFile[0].callback(new Error('taskkill failed'));
  assert.deepEqual(child.kills, ['default']);
});

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: Stop sends SIGTERM to the turn's group, then SIGKILL if copilot is still running after the grace`, () => {
    const child = fakeChild(777);
    const { calls, deps } = fakeDeps(platform);
    killTurnTree(child, deps);
    assert.deepEqual(calls.group, [[777, 'SIGTERM']]);
    assert.deepEqual(calls.execFile, []);
    assert.equal(calls.timers.length, 1);
    assert.equal(calls.timers[0].ms, 50);
    calls.timers[0].f();
    assert.deepEqual(calls.group, [[777, 'SIGTERM'], [777, 'SIGKILL']]);
    assert.deepEqual(child.kills, []);
  });
}

test('POSIX: no SIGKILL once copilot has exited, since its group id may then belong to someone else', () => {
  for (const exited of [{ exitCode: 0 }, { signalCode: 'SIGTERM' }]) {
    const child = { ...fakeChild(777), ...exited };
    const { calls, deps } = fakeDeps('linux');
    killTurnTree(child, deps);
    calls.timers[0].f();
    assert.deepEqual(calls.group, [[777, 'SIGTERM']]);
  }
});

test('POSIX: a group that is already gone is left alone', () => {
  const child = fakeChild(777);
  const { calls, deps } = fakeDeps('linux', { groupError: 'ESRCH' });
  killTurnTree(child, deps);
  assert.deepEqual(calls.timers, []);
  assert.deepEqual(child.kills, []);
});

test('POSIX: when the group cannot be signalled, copilot itself is', () => {
  const child = fakeChild(777);
  const { calls, deps } = fakeDeps('linux', { groupError: 'EPERM' });
  killTurnTree(child, deps);
  assert.deepEqual(child.kills, ['SIGTERM']);
  calls.timers[0].f();
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
});

test('a turn that never got a pid is killed directly, on every platform', () => {
  for (const platform of ['win32', 'linux']) {
    const child = { ...fakeChild(), pid: undefined };
    const { calls, deps } = fakeDeps(platform);
    killTurnTree(child, deps);
    assert.deepEqual(child.kills, ['default']);
    assert.deepEqual(calls.execFile, []);
    assert.deepEqual(calls.group, []);
  }
});

test('the default grace before SIGKILL is a few seconds', () => {
  assert.ok(GROUP_KILL_GRACE_MS >= 1000 && GROUP_KILL_GRACE_MS <= 10_000);
});

// ---------- real processes ----------

// The stand-in turn: starts a long-running command, prints its pid, then waits. With "ignore-term" it shrugs off
// SIGTERM, as a busy or stuck copilot might; its command does not.
const TURN = `
const { spawn } = require('child_process');
if (process.argv[1] === 'ignore-term') process.on('SIGTERM', () => {});
const command = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
process.stdout.write(command.pid + '\\n');
setInterval(() => {}, 1000);
`;

/** Starts the stand-in turn the way the extension starts copilot; resolves once the command it runs has started. */
function startTurn(mode = 'plain') {
  const child = spawn(process.execPath, ['-e', TURN, mode], turnSpawnOptions({ shell: false, windowsHide: true, stdio: 'pipe' }));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const commandPid = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const line = out.split('\n')[0];
      if (out.includes('\n')) {
        resolve(Number(line));
      }
    });
    child.on('exit', () => reject(new Error('the stand-in turn exited before starting its command')));
  });
  return { child, exited, commandPid };
}

/** Whether a process is still running. A zombie (dead, not yet reaped by its new parent) counts as gone. */
function alive(pid) {
  if (isWindows) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const stat = (r.stdout || '').trim();
  return stat !== '' && !stat.startsWith('Z');
}

async function gone(pid, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

function within(promise, ms, what) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms).unref())]);
}

/** Leaves nothing behind whatever the test did: only the two processes this test started. */
function cleanUp(child, commandPid) {
  for (const pid of [commandPid, child.pid]) {
    if (pid && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
}

test('POSIX: Stop during a running command leaves neither copilot nor the command behind', { skip: isWindows && 'macOS and Linux only' }, async () => {
  const { child, exited, commandPid } = startTurn();
  let pid;
  try {
    pid = await within(commandPid, 10_000, 'starting the command');
    assert.ok(alive(pid), 'the command is running before Stop');
    killTurnTree(child);
    const { signal } = await within(exited, 5000, 'copilot exiting');
    assert.equal(signal, 'SIGTERM');
    assert.ok(await gone(pid), 'the command copilot started is gone too');
  } finally {
    cleanUp(child, pid);
  }
});

test('POSIX: a copilot that ignores SIGTERM is killed with its command after the grace', { skip: isWindows && 'macOS and Linux only' }, async () => {
  const { child, exited, commandPid } = startTurn('ignore-term');
  let pid;
  try {
    pid = await within(commandPid, 10_000, 'starting the command');
    killTurnTree(child, { graceMs: 300 });
    assert.ok(await gone(pid), 'the command goes on SIGTERM');
    const { signal } = await within(exited, 5000, 'copilot exiting');
    assert.equal(signal, 'SIGKILL');
  } finally {
    cleanUp(child, pid);
  }
});

test('POSIX: what this fixes: signalling copilot alone would have left its command running', { skip: isWindows && 'macOS and Linux only' }, async () => {
  const { child, exited, commandPid } = startTurn();
  let pid;
  try {
    pid = await within(commandPid, 10_000, 'starting the command');
    child.kill();
    await within(exited, 5000, 'copilot exiting');
    assert.ok(!(await gone(pid, 500)), 'the command outlives copilot');
  } finally {
    cleanUp(child, pid);
  }
});

test('Windows: Stop during a running command leaves neither copilot nor the command behind', { skip: !isWindows && 'Windows only' }, async () => {
  const { child, exited, commandPid } = startTurn();
  let pid;
  try {
    pid = await within(commandPid, 10_000, 'starting the command');
    assert.ok(alive(pid), 'the command is running before Stop');
    killTurnTree(child);
    await within(exited, 10_000, 'copilot exiting');
    assert.ok(await gone(pid, 10_000), 'the command copilot started is gone too');
  } finally {
    cleanUp(child, pid);
  }
});
