// The keep-warm scheduler (src/keepWarm.ts), against a fake clock, a fake globalState and a fake claude process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
  KeepWarm,
  SHARED_KEY,
  RETRY_MS,
  PING_WRITE_TOKENS,
  marginFor,
  nextPingAt,
  cacheExpiry,
  pingText,
  estimateKeepWarm,
  sessionCacheState,
} = require('../out/keepWarm');
const { ONE_SHOT_ARGS, chatArgs } = require('../out/claudeChat');
const { UsageCollector, TTL_1H, TTL_5M } = require('../out/usage');

const MIN = 60_000;
const T0 = Date.parse('2026-11-25T10:00:00.000Z');

const pingEvents = fs
  .readFileSync(path.join(__dirname, 'fixtures', 'claude-stream', 'ping.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** Timers that fire only when the test moves the clock. */
function fakeClock(start = T0) {
  let now = start;
  let ids = 0;
  const timers = new Map();
  const next = () => [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
  return {
    now: () => now,
    setTimer: (f, ms) => {
      timers.set(++ids, { at: now + ms, f });
      return ids;
    },
    clearTimer: (h) => timers.delete(h),
    pending: () => timers.size,
    /** Moves the clock to `t`, firing every timer due on the way. */
    async to(t) {
      for (let n = next(); n && n[1].at <= t; n = next()) {
        timers.delete(n[0]);
        now = Math.max(now, n[1].at);
        n[1].f();
        await settle();
      }
      now = Math.max(now, t);
      await settle();
    },
    /** The computer sleeps: the clock jumps, then the one pending timer fires late, as on waking. */
    async sleep(ms) {
      now += ms;
      const n = next();
      if (n) {
        timers.delete(n[0]);
        n[1].f();
      }
      await settle();
    },
  };
}

/** Spawns fake claude processes that answer the ping with the fixture, unless `plan` says otherwise for that spawn. */
function fakeSpawner(plan = () => ({})) {
  const spawns = [];
  const spawn = (exe, args, cwd) => {
    const how = plan(spawns.length) ?? {};
    const child = new EventEmitter();
    child.written = [];
    child.ended = false;
    child.stdin = Object.assign(new EventEmitter(), {
      write: (s) => {
        child.written.push(s);
        const m = JSON.parse(s);
        if (m.type === 'user' && how.reply !== false) {
          setImmediate(() => child.say(...(how.events ?? pingEvents)));
        }
      },
      end: () => {
        child.ended = true;
        if (how.exitOnEnd !== false) setImmediate(() => child.emit('exit', 0, null));
      },
    });
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => setImmediate(() => child.emit('exit', null, 'SIGTERM'));
    child.say = (...events) => child.stdout.emit('data', Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'));
    child.users = () => child.written.map((l) => JSON.parse(l)).filter((m) => m.type === 'user').map((m) => m.message.content);
    child.controls = () => child.written.map((l) => JSON.parse(l)).filter((m) => m.type !== 'user');
    if (how.asyncError) setImmediate(() => child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
    spawns.push({ exe, args, cwd, child });
    return child;
  };
  return { spawns, spawn };
}

const withModel = (model) => pingEvents.map((e) => (e.type === 'system' && e.subtype === 'init' ? { ...e, model } : e));
const failedResult = pingEvents.map((e) =>
  e.type === 'result' ? { ...e, subtype: 'error_during_execution', is_error: true, errors: ['API Error: 529 overloaded'], model_usage_since_last_result: { m: { costUSD: 0.001 } } } : e,
);

function fakeShared() {
  const data = new Map();
  return { get: (k) => data.get(k), update: (k, v) => void data.set(k, JSON.parse(JSON.stringify(v))), data };
}

/** A kept-warm setup: the session's state is `st`, which a test changes as the log would. */
function setup(o = {}) {
  const clock = o.clock ?? fakeClock();
  const st = o.st ?? { lastRequest: T0 - 5 * MIN, ttlMs: TTL_1H, model: 'claude-haiku-test', contextTokens: 52_440, cacheRead: 52_000 };
  const sp = o.sp ?? fakeSpawner(o.plan);
  const shared = o.shared ?? fakeShared();
  const logs = [];
  const changes = [];
  const kw = new KeepWarm({
    windowId: o.windowId ?? 'win-A',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    state: () => (o.gone?.() ? undefined : st),
    launch: () => ({ exe: '/bin/claude', cwd: '/work/demo' }),
    spawn: sp.spawn,
    shared,
    log: (l) => logs.push(l),
    onChange: (id) => changes.push(id),
  });
  return { kw, clock, st, ...sp, shared, logs, changes };
}

// ---------- pure parts ----------

test('schedule: next ping at max(last request, last ping) + TTL - margin; expiry at the same base + TTL', () => {
  assert.equal(marginFor(TTL_1H), 10 * MIN);
  assert.equal(marginFor(TTL_5M), MIN);
  assert.equal(nextPingAt(T0, undefined, TTL_1H), T0 + 50 * MIN);
  assert.equal(nextPingAt(T0, T0 + 20 * MIN, TTL_1H), T0 + 70 * MIN);
  assert.equal(nextPingAt(T0 + 30 * MIN, T0 + 20 * MIN, TTL_1H), T0 + 80 * MIN, 'a later real turn pushes the ping back');
  assert.equal(nextPingAt(T0, undefined, TTL_5M), T0 + 4 * MIN);
  assert.equal(cacheExpiry(T0, T0 + 20 * MIN, TTL_1H), T0 + 80 * MIN);
  assert.equal(cacheExpiry(undefined, undefined, TTL_1H), undefined);
});

test("ping text differs on every ping, so each one diverges right after the conversation", () => {
  const a = pingText(1, T0);
  const b = pingText(2, T0 + 50 * MIN);
  const c = pingText(2, T0 + 51 * MIN);
  assert.notEqual(a, b);
  assert.notEqual(b, c, 'the time alone makes it differ');
  assert.match(a, /^Keep-alive ping 1 at 2026-11-25T10:00:00\.000Z\. Reply with only: ok$/);
});

test('estimates from prices.json: a ping, a warm and a cold resume, break-even, and pings over a duration', () => {
  // Opus 5.5, 200k, 1-hour TTL: read $0.20/M, 1h write $8/M, output $20/M.
  const e = estimateKeepWarm({ model: 'claude-opus-5-5', contextTokens: 200_000, ttlMs: TTL_1H, durationMs: 4 * 60 * MIN });
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  close(e.perPing, (200_000 * 0.2 + PING_WRITE_TOKENS * 8 + 5 * 20) / 1e6);
  close(e.warmResume, 0.04);
  close(e.coldResume, 1.6);
  close(e.coldResumeExtra, 1.56);
  close(e.breakEvenPings, 1.56 / e.perPing);
  assert.equal(e.intervalMs, 50 * MIN);
  assert.equal(e.pings, 4, 'at 50, 100, 150 and 200 minutes');
  close(e.total, 4 * e.perPing);
  // The cache was last refreshed 40 minutes ago: the first ping is 10 minutes away.
  assert.equal(estimateKeepWarm({ model: 'claude-opus-5-5', contextTokens: 200_000, ttlMs: TTL_1H, durationMs: 30 * MIN, sinceLastMs: 40 * MIN }).pings, 1);
  assert.equal(estimateKeepWarm({ model: 'claude-opus-5-5', contextTokens: 200_000, ttlMs: TTL_1H, durationMs: 30 * MIN }).pings, 0);
  // 5-minute TTL: a ping every 4 minutes, at the 5-minute write price.
  const short = estimateKeepWarm({ model: 'claude-opus-5-5', contextTokens: 200_000, ttlMs: TTL_5M, durationMs: 60 * MIN });
  assert.equal(short.intervalMs, 4 * MIN);
  assert.equal(short.pings, 15);
  close(short.coldResume, 1.0);
  // Haiku over 100k: the long-context rates (read $0.05/M, 1h write $1/M), as the SA-33 check's ping 2 measured.
  const haiku = estimateKeepWarm({ model: 'claude-haiku-5-5', contextTokens: 100_685, ttlMs: TTL_1H });
  close(haiku.perPing, (100_685 * 0.05 + PING_WRITE_TOKENS * 1 + 5 * 2.5) / 1e6);
  assert.ok(haiku.perPing > 0.0068 && haiku.perPing < 0.0071);
  assert.equal(haiku.pings, undefined);
  assert.equal(estimateKeepWarm({ model: 'claude-unknown-9', contextTokens: 1000, ttlMs: TTL_1H }), undefined);
});

test('sessionCacheState reads the parsed usage: last request, TTL, model, context and cache read', () => {
  const u = new UsageCollector();
  u.add(
    {
      timestamp: '2026-11-25T10:00:00.000Z',
      message: { id: 'm1', model: 'claude-haiku-5-5', usage: { input_tokens: 3, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 100 } } },
    },
    false,
  );
  // A subagent's later request on another model is not the main thread's cache.
  u.add({ timestamp: '2026-11-25T10:01:00.000Z', message: { id: 'm2', model: 'claude-opus-5-5', usage: { input_tokens: 9, output_tokens: 1 } } }, true);
  assert.deepEqual(sessionCacheState({ model: 'claude-opus-5-5', usage: u.summary() }), {
    lastRequest: T0,
    ttlMs: TTL_1H,
    model: 'claude-haiku-5-5',
    contextTokens: 1003,
    cacheRead: 900,
  });
  assert.deepEqual(sessionCacheState({}), { lastRequest: undefined, ttlMs: undefined, model: undefined, contextTokens: undefined, cacheRead: undefined });
});

// ---------- the scheduler ----------

test('pings on schedule through runOneShot: no-persist arguments, no --model, its own folder, varying text', async () => {
  const { kw, clock, spawns, shared, logs } = setup();
  assert.deepEqual(kw.start('sess-0001', { durationMs: 3 * 60 * MIN }), { ok: true });
  await settle();
  assert.equal(spawns.length, 0, 'not due yet');
  assert.ok(clock.pending() === 1);
  assert.equal(kw.get('sess-0001').nextPingAt, T0 + 45 * MIN);
  assert.equal(kw.get('sess-0001').expiresAt, T0 + 55 * MIN);

  await clock.to(T0 + 45 * MIN - 1);
  assert.equal(spawns.length, 0);
  await clock.to(T0 + 45 * MIN);
  assert.equal(spawns.length, 1);
  const { args, cwd, child } = spawns[0];
  assert.equal(cwd, '/work/demo');
  assert.deepEqual(args, [...chatArgs('sess-0001', 'deny'), ...ONE_SHOT_ARGS]);
  assert.ok(!args.includes('--model'));
  assert.deepEqual(child.users(), [pingText(1, T0 + 45 * MIN)]);
  assert.equal(child.ended, true);

  const k = kw.get('sess-0001');
  assert.equal(k.pings.length, 1);
  assert.deepEqual(k.pings[0], {
    n: 1,
    at: T0 + 45 * MIN,
    ok: true,
    cost: 0.0058,
    cacheRead: 51_969,
    cacheWrite: 469,
    model: 'claude-haiku-test',
    permissionMode: 'dontAsk',
  });
  assert.ok(Math.abs(k.spent - 0.0058) < 1e-12);
  assert.equal(k.lastPing, T0 + 45 * MIN);
  assert.equal(k.expiresAt, T0 + 105 * MIN, 'the timer shows the last ping + TTL, not the log');
  assert.equal(k.nextPingAt, T0 + 95 * MIN);
  assert.deepEqual(shared.data.get(SHARED_KEY), { 'sess-0001': { window: 'win-A', at: T0 + 45 * MIN } });
  assert.ok(logs.some((l) => /ping 1 init: model claude-haiku-test, permissionMode dontAsk/.test(l)), 'init.permissionMode is logged');

  await clock.to(T0 + 95 * MIN);
  assert.equal(spawns.length, 2);
  assert.deepEqual(spawns[1].child.users(), [pingText(2, T0 + 95 * MIN)]);
  assert.notEqual(spawns[1].child.users()[0], spawns[0].child.users()[0]);
});

test('pingNow refreshes at once, then at 50 and 100 minutes from that ping (the SA-72 check), and still yields to a writer', async () => {
  const { kw, clock, spawns } = setup();
  kw.start('s', { pingNow: true, durationMs: 105 * MIN });
  await settle();
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].child.users(), [pingText(1, T0)]);
  await clock.to(T0 + 50 * MIN);
  assert.equal(spawns.length, 2);
  await clock.to(T0 + 100 * MIN);
  assert.equal(spawns.length, 3);
  await clock.to(T0 + 106 * MIN);
  assert.equal(kw.get('s').stopped.reason, 'duration');
  assert.deepEqual(
    kw.get('s').pings.map((p) => p.at),
    [T0, T0 + 50 * MIN, T0 + 100 * MIN],
  );

  const busy = setup();
  busy.st.busy = 'it is open in a terminal';
  busy.kw.start('s', { pingNow: true });
  await settle();
  assert.equal(busy.spawns.length, 0);
  assert.equal(busy.kw.get('s').lastSkip.why, 'it is open in a terminal');
  busy.st.busy = undefined;
  await busy.clock.to(T0 + RETRY_MS);
  assert.equal(busy.spawns.length, 1, 'the asked-for refresh goes once the writer is gone');
});

test('a real turn elsewhere pushes the next ping back; the 5-minute TTL pings a minute before expiry', async () => {
  const { kw, clock, spawns, st } = setup();
  kw.start('s');
  await clock.to(T0 + 45 * MIN);
  assert.equal(spawns.length, 1);
  st.lastRequest = T0 + 60 * MIN; // the user typed a turn in a terminal
  await clock.to(T0 + 100 * MIN);
  assert.equal(spawns.length, 1, 'not at 95: the real turn refreshed the cache');
  await clock.to(T0 + 110 * MIN);
  assert.equal(spawns.length, 2);

  const five = setup({ st: { lastRequest: T0, ttlMs: TTL_5M, model: 'claude-haiku-test', contextTokens: 1000 } });
  five.kw.start('s');
  await five.clock.to(T0 + 4 * MIN - 1);
  assert.equal(five.spawns.length, 0);
  await five.clock.to(T0 + 4 * MIN);
  assert.equal(five.spawns.length, 1);
  await five.clock.to(T0 + 8 * MIN);
  assert.equal(five.spawns.length, 2);
});

test('skips a ping while another writer has the session, then pings once it is free', async () => {
  const { kw, clock, spawns, st, logs } = setup();
  kw.start('s');
  st.busy = 'it is open in a terminal';
  await clock.to(T0 + 45 * MIN);
  assert.equal(spawns.length, 0);
  assert.deepEqual(kw.get('s').lastSkip, { at: T0 + 45 * MIN, why: 'it is open in a terminal' });
  assert.ok(logs.some((l) => /skipped a refresh: it is open in a terminal/.test(l)));
  st.busy = undefined;
  st.logWrittenAt = T0 + 45 * MIN + 25_000; // a record lands just before the re-check
  await clock.to(T0 + 45 * MIN + RETRY_MS);
  assert.equal(spawns.length, 0, 'the log was written 5s ago');
  assert.match(kw.get('s').lastSkip.why, /its log was written 5s ago/);
  await clock.to(T0 + 45 * MIN + 2 * RETRY_MS);
  assert.equal(spawns.length, 1);

  // A writer that never lets go: the cache expires, and keep-warm says why.
  const b = setup();
  b.kw.start('s');
  b.st.busy = 'the in-view chat is replying';
  await b.clock.to(T0 + 56 * MIN);
  assert.equal(b.spawns.length, 0);
  const k = b.kw.get('s');
  assert.equal(k.active, false);
  assert.equal(k.stopped.reason, 'expired');
  assert.match(k.stopped.message, /skipped because the in-view chat is replying/);

  // The busy writer's own turn lands: the schedule moves from the new last request, nothing stops.
  const c = setup();
  c.kw.start('s');
  c.st.busy = 'it is open in a terminal';
  await c.clock.to(T0 + 46 * MIN);
  c.st.lastRequest = T0 + 46 * MIN;
  c.st.busy = undefined;
  await c.clock.to(T0 + 95 * MIN);
  assert.equal(c.spawns.length, 0);
  assert.equal(c.kw.get('s').active, true);
  await c.clock.to(T0 + 96 * MIN);
  assert.equal(c.spawns.length, 1);
});

test('a failed ping is retried once after 30s; a second failure stops it', async () => {
  const { kw, clock, spawns } = setup({ plan: (i) => (i === 0 ? { events: failedResult } : {}) });
  kw.start('s');
  await clock.to(T0 + 45 * MIN);
  assert.equal(spawns.length, 1);
  let k = kw.get('s');
  assert.equal(k.active, true);
  assert.equal(k.pings[0].ok, false);
  assert.equal(k.pings[0].error, 'API Error: 529 overloaded');
  assert.ok(Math.abs(k.spent - 0.001) < 1e-12, 'a failed ping still counts what it cost');
  await clock.to(T0 + 45 * MIN + RETRY_MS - 1);
  assert.equal(spawns.length, 1);
  await clock.to(T0 + 45 * MIN + RETRY_MS);
  assert.equal(spawns.length, 2);
  k = kw.get('s');
  assert.equal(k.pings[1].ok, true);
  assert.equal(k.lastPing, T0 + 45 * MIN + RETRY_MS);

  const twice = setup({ plan: () => ({ events: failedResult }) });
  twice.kw.start('s');
  await twice.clock.to(T0 + 46 * MIN);
  assert.equal(twice.spawns.length, 2);
  assert.equal(twice.kw.get('s').stopped.reason, 'failed');
  assert.match(twice.kw.get('s').stopped.message, /failed twice \(API Error: 529 overloaded\)/);
  assert.equal(twice.clock.pending(), 0);
});

test('a ping whose CLI fails after spawn (async error) counts as failed and is retried', async () => {
  const { kw, clock, spawns } = setup({ plan: (i) => (i === 0 ? { asyncError: true, reply: false } : {}) });
  kw.start('s');
  await clock.to(T0 + 45 * MIN);
  assert.equal(spawns.length, 1);
  const k = kw.get('s');
  assert.equal(k.pings[0].ok, false);
  assert.match(k.pings[0].error, /ENOENT|not found|could not/i);
  assert.equal(k.active, true);
  await clock.to(T0 + 45 * MIN + RETRY_MS);
  assert.equal(spawns.length, 2);
  assert.equal(kw.get('s').pings[1].ok, true);
});

test('a ping is recorded only once its process has exited (exitOnEnd: false)', async () => {
  const { kw, clock, spawns } = setup({ plan: () => ({ exitOnEnd: false }) });
  kw.start('s');
  await clock.to(T0 + 45 * MIN);
  assert.equal(spawns.length, 1);
  const { child } = spawns[0];
  assert.equal(child.ended, true, 'the result came and stdin was closed');
  assert.equal(kw.get('s').pings.length, 0, 'but the process has not exited yet');
  assert.equal(kw.get('s').lastPing, undefined);
  child.emit('exit', 0, null);
  await settle();
  assert.equal(kw.get('s').pings.length, 1);
  assert.equal(kw.get('s').pings[0].ok, true);
});

test('after a sleep past the expiry it stops instead of pinging; an expired cache is never pinged', async () => {
  const { kw, clock, spawns } = setup();
  kw.start('s');
  await clock.to(T0 + 45 * MIN);
  assert.equal(spawns.length, 1);
  await clock.sleep(3 * 60 * MIN);
  assert.equal(spawns.length, 1);
  const k = kw.get('s');
  assert.equal(k.stopped.reason, 'slept');
  assert.match(k.stopped.message, /expired while the computer was asleep/);
  assert.equal(k.expiresAt, T0 + 105 * MIN);
  assert.equal(clock.pending(), 0);

  // A start on a cache that has expired, or with no cache state at all, is refused.
  const cold = setup({ st: { lastRequest: T0 - 61 * MIN, ttlMs: TTL_1H, model: 'claude-haiku-test' } });
  assert.match(cold.kw.start('s').error, /already expired/);
  const none = setup({ st: { model: 'claude-haiku-test' } });
  assert.match(none.kw.start('s').error, /does not say when/);
  assert.equal(cold.spawns.length + none.spawns.length, 0);
});

test('stops at the spend cap, at the chosen duration, on Stop, when the window closes, and when the session goes', async () => {
  // Each fixture ping costs $0.0058; with a $0.01 cap the second would pass it.
  const cap = setup();
  cap.kw.start('s', { spendCapUsd: 0.01 });
  await cap.clock.to(T0 + 45 * MIN);
  assert.equal(cap.spawns.length, 1);
  await cap.clock.to(T0 + 95 * MIN);
  assert.equal(cap.spawns.length, 1);
  assert.equal(cap.kw.get('s').stopped.reason, 'spendCap');
  assert.match(cap.kw.get('s').stopped.message, /would pass the \$0\.01 spend cap/);

  // The default cap is $1.00.
  const dflt = setup();
  dflt.kw.start('s');
  assert.equal(dflt.kw.get('s').spendCapUsd, 1);

  // A 30-minute run ends before the first ping is due.
  const dur = setup();
  dur.kw.start('s', { durationMs: 30 * MIN });
  await dur.clock.to(T0 + 31 * MIN);
  assert.equal(dur.spawns.length, 0);
  assert.equal(dur.kw.get('s').stopped.reason, 'duration');
  assert.equal(dur.kw.get('s').stopped.at, T0 + 30 * MIN);

  const user = setup();
  user.kw.start('s');
  user.kw.stop('s');
  assert.equal(user.kw.get('s').stopped.reason, 'user');
  assert.deepEqual(user.kw.active(), []);
  assert.equal(user.clock.pending(), 0);
  await user.clock.to(T0 + 120 * MIN);
  assert.equal(user.spawns.length, 0);

  const win = setup();
  win.kw.start('a');
  win.kw.start('b');
  assert.equal(win.kw.active().length, 2);
  win.kw.dispose();
  assert.deepEqual([win.kw.get('a').stopped.reason, win.kw.get('b').stopped.reason], ['window', 'window']);
  assert.equal(win.clock.pending(), 0);

  let gone = false;
  const g = setup({ gone: () => gone });
  g.kw.start('s');
  gone = true;
  await g.clock.to(T0 + 2 * MIN);
  assert.equal(g.kw.get('s').stopped.reason, 'gone');
});

test('Stop during a ping: the ping finishes and counts, nothing more is scheduled, the claim is taken back', async () => {
  const { kw, clock, spawns, shared } = setup({ plan: () => ({ reply: false }) });
  kw.start('s');
  await clock.to(T0 + 45 * MIN);
  assert.equal(spawns.length, 1);
  assert.equal(shared.data.get(SHARED_KEY).s.pinging, true);
  kw.stop('s');
  assert.equal(shared.data.get(SHARED_KEY).s, undefined);
  spawns[0].child.say(...pingEvents);
  await settle();
  const k = kw.get('s');
  assert.equal(k.pings.length, 1);
  assert.equal(k.stopped.reason, 'user');
  assert.equal(clock.pending(), 0);
  // It did refresh the cache, so the expiry moves and other windows see the ping.
  assert.equal(k.expiresAt, T0 + 105 * MIN);
  assert.deepEqual(shared.data.get(SHARED_KEY).s, { window: 'win-A', at: T0 + 45 * MIN });
});

test("stops without retrying when init reports a model other than the log's", async () => {
  const { kw, clock, spawns } = setup({ plan: () => ({ events: withModel('claude-opus-test') }) });
  kw.start('s');
  await clock.to(T0 + 47 * MIN);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].child.controls().map((c) => c.request?.subtype), ['interrupt']);
  const k = kw.get('s');
  assert.equal(k.stopped.reason, 'model');
  assert.match(k.stopped.message, /run on claude-opus-test, not the session's claude-haiku-test/);
  assert.equal(k.pings[0].model, 'claude-opus-test');
});

test('two windows share one session: only one pings, the other counts that ping as its own', async () => {
  const clock = fakeClock();
  const shared = fakeShared();
  const st = { lastRequest: T0 - 5 * MIN, ttlMs: TTL_1H, model: 'claude-haiku-test', contextTokens: 52_440 };
  const a = setup({ clock, shared, st, windowId: 'win-A' });
  const b = setup({ clock, shared, st, windowId: 'win-B' });
  a.kw.start('s');
  b.kw.start('s');
  await clock.to(T0 + 45 * MIN);
  assert.equal(a.spawns.length + b.spawns.length, 1);
  const [pinger, other] = a.spawns.length ? [a, b] : [b, a];
  assert.equal(other.kw.get('s').lastPing, T0 + 45 * MIN);
  assert.equal(other.kw.get('s').expiresAt, T0 + 105 * MIN);
  assert.equal(other.kw.get('s').spent, 0);
  await clock.to(T0 + 95 * MIN);
  assert.equal(a.spawns.length + b.spawns.length, 2);
  assert.ok(pinger.spawns.length >= 1);

  // A window that is mid-ping makes the other wait rather than ping as well.
  const clock2 = fakeClock();
  const shared2 = fakeShared();
  const c = setup({ clock: clock2, shared: shared2, st: { ...st }, windowId: 'win-C', plan: () => ({ reply: false }) });
  c.kw.start('s');
  await clock2.to(T0 + 45 * MIN);
  assert.equal(c.spawns.length, 1);
  const d = setup({ clock: clock2, shared: shared2, st: { ...st }, windowId: 'win-D' });
  d.kw.start('s');
  await settle();
  assert.equal(d.spawns.length, 0);
  assert.equal(d.kw.get('s').lastSkip.why, 'another window is refreshing it');
  // C's ping lands: D counts it as its own and does not ping.
  c.spawns[0].child.say(...pingEvents);
  await settle();
  await clock2.to(T0 + 45 * MIN + RETRY_MS);
  assert.equal(d.spawns.length, 0);
  assert.equal(d.kw.get('s').lastPing, T0 + 45 * MIN);
});

test("after a kept-warm session's next real turn, reports whether it read the context from the cache", async () => {
  const { kw, clock, st, changes } = setup();
  kw.start('s');
  await clock.to(T0 + 45 * MIN);
  st.lastRequest = T0 + 80 * MIN;
  st.cacheRead = 52_100;
  st.contextTokens = 53_000;
  kw.observe('s');
  assert.deepEqual(kw.get('s').nextTurn, { at: T0 + 80 * MIN, cacheRead: 52_100, expected: 52_440, warm: true });
  assert.ok(changes.length > 0);

  // After keep-warm has stopped, the user comes back to a cold cache.
  const late = setup();
  late.kw.start('s', { durationMs: 10 * MIN });
  await late.clock.to(T0 + 11 * MIN);
  assert.equal(late.kw.get('s').active, false);
  late.st.lastRequest = T0 + 120 * MIN;
  late.st.cacheRead = 16_000;
  late.kw.observe('s');
  assert.equal(late.kw.get('s').nextTurn.warm, false);
  assert.equal(late.kw.get('s').nextTurn.cacheRead, 16_000);
});
