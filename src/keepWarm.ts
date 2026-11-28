// Keeps a Claude Code session's prompt cache from expiring: a short no-persist ping process per refresh, on a schedule
// worked out from the wall clock, with a spend cap (docs/dev/keep-alive.md sections 4, 6, 7 and 9).
// No VS Code imports here, so it can be unit-tested with a fake clock and a fake spawner.

import { ChatOptions, OneShotResult, RECENT_WRITE_MS, runOneShot, Spawner } from './claudeChat';
import { modelKey, ratesFor, TTL_5M, UsageSummary } from './usage';

/** Per session, unless the caller passes its own (the `claudeSessions.keepWarm.spendCapUsd` setting). */
export const DEFAULT_SPEND_CAP_USD = 1;

/** A failed ping is tried once more after this long, if the cache still has time left. */
export const RETRY_MS = 30_000;

/**
 * The longest a timer is set for. Each tick works out the schedule again from the wall clock, so a timer that did not
 * count the time the computer slept, or a log that changed meanwhile, is caught within this.
 */
export const TICK_MAX_MS = 60_000;

/** A tick this much later than it was set for means the computer slept (or the host stalled) in between. */
export const LATE_MS = 2 * 60_000;

/** A ping started with less than this left before the expiry might reach the API after it: the cache counts as gone. */
export const MIN_LEFT_MS = 15_000;

/** A ping with no `result` by then is stopped, and counts as failed. */
export const PING_TIMEOUT_MS = 2 * 60_000;

/**
 * What each ping writes to the cache: the `-p` mode's own tail plus the ping message, past the end of the
 * conversation (keep-alive doc section 8, measured at 1,924). Every ping writes it, because each ping's text differs
 * (see pingText).
 */
export const PING_WRITE_TOKENS = 1_924;

/** A ping's reply, "ok", is a few output tokens. */
export const PING_OUTPUT_TOKENS = 5;

/** The cache read of a real turn after keep-warm counts as warm when it covers this share of the context before it. */
export const WARM_READ_SHARE = 0.9;

/** The `globalState` key where windows record their pings, so two windows do not both ping one session. */
export const SHARED_KEY = 'keepWarm.pings';

/** Shared records older than this are dropped: their cache has expired whatever the TTL. */
const SHARED_KEEP_MS = 2 * 60 * 60_000;

/** How long before the expiry to ping: 10 minutes on the 1-hour TTL, 60 seconds on the 5-minute one (doc section 6). */
export function marginFor(ttlMs: number): number {
  return ttlMs > TTL_5M ? 10 * 60_000 : 60_000;
}

/** When the cache was last refreshed: the later of the log's last request and the last ping. */
export function lastWarmed(lastRequest: number | undefined, lastPing: number | undefined): number | undefined {
  if (lastRequest === undefined) {
    return lastPing;
  }
  return lastPing === undefined ? lastRequest : Math.max(lastRequest, lastPing);
}

/** When the next ping is due: `max(last logged request, last ping) + TTL - margin`. */
export function nextPingAt(lastRequest: number | undefined, lastPing: number | undefined, ttlMs: number): number | undefined {
  const base = lastWarmed(lastRequest, lastPing);
  return base === undefined ? undefined : base + ttlMs - marginFor(ttlMs);
}

/** When the cache expires if nothing refreshes it again: `max(last logged request, last ping) + TTL`. */
export function cacheExpiry(lastRequest: number | undefined, lastPing: number | undefined, ttlMs: number): number | undefined {
  const base = lastWarmed(lastRequest, lastPing);
  return base === undefined ? undefined : base + ttlMs;
}

/**
 * The text of ping `n`, sent at `at`. It differs on every ping on purpose (keep-alive doc section 8): an identical
 * text would hit the previous ping's own entry, which ends about 1.9k tokens past the conversation, and it is unproven
 * that such a hit also refreshes the terminal's shorter entry. A text that differs makes the request diverge right
 * after the conversation, so each ping falls back to the terminal's entry and refreshes it, for PING_WRITE_TOKENS
 * written each time.
 */
export function pingText(n: number, at: number): string {
  return `Keep-alive ping ${n} at ${new Date(at).toISOString()}. Reply with only: ok`;
}

// ---------- estimates ----------

export interface KeepWarmEstimate {
  /** One ping: the context read from the cache, PING_WRITE_TOKENS written, a few output tokens. USD. */
  perPing: number;
  /** The context read from the cache on the next real turn, when it is still warm. */
  warmResume: number;
  /** The context written to the cache again on the next real turn, once it has expired. */
  coldResume: number;
  /** What expiry costs the next turn: coldResume - warmResume. */
  coldResumeExtra: number;
  /** How many pings cost as much as that extra. */
  breakEvenPings: number;
  /** Time between pings. */
  intervalMs: number;
  /** Pings over `durationMs`, and what they cost, when a duration was given. */
  pings?: number;
  total?: number;
}

/**
 * Cost estimates from `src/prices.json` for keeping a session of `contextTokens` on `model` warm (doc section 4).
 * `sinceLastMs` is how long ago the cache was last refreshed, so the first ping comes sooner. Undefined for an unpriced
 * model.
 */
export function estimateKeepWarm(o: { model: string; contextTokens: number; ttlMs: number; durationMs?: number; sinceLastMs?: number }): KeepWarmEstimate | undefined {
  const ctx = Math.max(0, o.contextTokens);
  const r = ratesFor(o.model, ctx + PING_WRITE_TOKENS);
  if (!r) {
    return undefined;
  }
  const write = o.ttlMs > TTL_5M ? r.cacheWrite1h : r.cacheWrite5m;
  const perPing = (ctx * r.cacheRead + PING_WRITE_TOKENS * write + PING_OUTPUT_TOKENS * r.output) / 1e6;
  const warmResume = (ctx * r.cacheRead) / 1e6;
  const coldResume = (ctx * write) / 1e6;
  const coldResumeExtra = coldResume - warmResume;
  const intervalMs = o.ttlMs - marginFor(o.ttlMs);
  const est: KeepWarmEstimate = {
    perPing,
    warmResume,
    coldResume,
    coldResumeExtra,
    breakEvenPings: perPing > 0 ? coldResumeExtra / perPing : Infinity,
    intervalMs,
  };
  if (o.durationMs !== undefined) {
    const first = Math.max(0, intervalMs - Math.max(0, o.sinceLastMs ?? 0));
    const pings = o.durationMs < first ? 0 : Math.floor((o.durationMs - first) / intervalMs) + 1;
    est.pings = pings;
    est.total = pings * perPing;
  }
  return est;
}

// ---------- the scheduler ----------

/** What the scheduler needs to know about a session at each tick, read fresh every time. */
export interface SessionCacheState {
  /** Time of the log's last main-thread API request. */
  lastRequest?: number;
  /** The cache's lifetime, from the log's last cache write (usage.ts). */
  ttlMs?: number;
  /** The model of the log's last main-thread request: a ping on any other would miss the cache. */
  model?: string;
  /** Context of that request, and how much of it was read from the cache. */
  contextTokens?: number;
  cacheRead?: number;
  /** When the log file was last written. */
  logWrittenAt?: number;
  /** Why the session has another writer right now ("the in-view chat is replying", "it is open in a terminal"). */
  busy?: string;
}

/** The parts of a parsed session (SessionInfo) the scheduler reads; the caller adds the log's mtime and `busy`. */
export function sessionCacheState(info: { model?: string; usage?: UsageSummary }): SessionCacheState {
  const u = info.usage;
  return {
    lastRequest: u?.cache?.lastRequest,
    ttlMs: u?.cache?.ttlMs,
    model: u?.lastModel ?? info.model,
    contextTokens: u?.context?.tokens,
    cacheRead: u?.lastCacheRead,
  };
}

/** `globalState`, or a fake. */
export interface SharedState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

/** One window's last ping of a session, as other windows see it. */
export interface SharedPing {
  window: string;
  /** When the ping started. */
  at: number;
  /** The ping is running now. */
  pinging?: boolean;
}

export interface KeepWarmDeps {
  /** This window, to tell its records from other windows'. */
  windowId: string;
  now(): number;
  setTimer(f: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The session's state now; undefined when it is gone. */
  state(sessionId: string): SessionCacheState | undefined;
  /** Where its ping process starts: claude.exe and the session's own folder. */
  launch(sessionId: string): ReturnType<ChatOptions['launch']>;
  spawn: Spawner;
  shared: SharedState;
  log(line: string): void;
  /** Something about this session's keep-warm changed: a ping, a skip, a stop, a next-turn report. */
  onChange?(sessionId: string): void;
}

export type StopReason = 'duration' | 'spendCap' | 'expired' | 'slept' | 'failed' | 'model' | 'user' | 'window' | 'gone';

export interface PingRecord {
  n: number;
  at: number;
  ok: boolean;
  /** This ping's cost from turnCost(), when the result carried it. */
  cost?: number;
  /** Summed over the ping's API requests. */
  cacheRead: number;
  cacheWrite: number;
  /** What `init` reported. */
  model?: string;
  permissionMode?: string;
  error?: string;
}

/** How the first real turn after keep-warm started went: did it read the context from the cache? */
export interface NextTurnReport {
  at: number;
  cacheRead: number;
  /** The context before that turn: what should have been in the cache. */
  expected: number;
  warm: boolean;
}

/** One session's keep-warm, as the UI shows it. */
export interface KeptWarm {
  sessionId: string;
  active: boolean;
  startedAt: number;
  /** When it stops by itself; undefined for "until I stop". */
  until?: number;
  spendCapUsd: number;
  /** What this window's pings have cost, failed ones included. */
  spent: number;
  pings: PingRecord[];
  ttlMs: number;
  /** When the cache expires if nothing refreshes it (the timer shows this, not the log's last request + TTL). */
  expiresAt?: number;
  /** When the next ping is due (it may still be skipped). */
  nextPingAt?: number;
  /** The last ping, this window's or another's. */
  lastPing?: number;
  /** The last skipped ping and why. */
  lastSkip?: { at: number; why: string };
  stopped?: { reason: StopReason; message: string; at: number };
  nextTurn?: NextTurnReport;
}

interface Entry extends KeptWarm {
  timer?: unknown;
  /** When the current timer was meant to fire, to spot a sleep. */
  timerFor?: number;
  pinging: boolean;
  retried: boolean;
  /** The log's last request when keep-warm started, to spot the next real turn. */
  baseline?: number;
  /** The context at the last tick, for the next-turn report. */
  context?: number;
  /** The first refresh goes now rather than at the schedule's time (StartOptions.pingNow). */
  pingNow?: boolean;
}

export interface StartOptions {
  /** Undefined: until stopped. */
  durationMs?: number;
  spendCapUsd?: number;
  /**
   * Refresh once straight away, then on the schedule from that ping. Every other rule still holds: a writer still
   * skips it, and the spend cap still counts it. SA-72's timed check uses it to ping at about 0, 50 and 100 minutes.
   */
  pingNow?: boolean;
}

/** "$1.00", "$0.01", "$0.0058": two decimals, or up to four for a few tenths of a cent. */
const usd = (v: number): string => {
  const four = v.toFixed(4);
  return `$${v < 0.1 && !four.endsWith('00') ? four.replace(/0$/, '') : v.toFixed(2)}`;
};

const STOP_MESSAGES: Record<Exclude<StopReason, 'failed' | 'model' | 'expired'>, string> = {
  duration: 'Stopped keeping the cache warm: the chosen time is up.',
  spendCap: 'Stopped keeping the cache warm: the next refresh would pass the spend cap.',
  slept: 'The cache expired while the computer was asleep, so keep-warm stopped. A refresh cannot bring an expired cache back.',
  user: 'Stopped keeping the cache warm.',
  window: 'Stopped keeping the cache warm: the window closed.',
  gone: 'Stopped keeping the cache warm: the session is no longer there.',
};

/**
 * Keeps sessions' prompt caches warm. Each kept-warm session has one timer; every tick reads the session's state again
 * and works out from the wall clock whether to stop, wait, skip or ping. A ping is one no-persist `-p` process through
 * runOneShot, in the session's own folder, with no `--model`.
 */
export class KeepWarm {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: KeepWarmDeps) {}

  /**
   * Starts keeping a session warm. Refused (with the reason) when its cache state is unknown or the cache has already
   * expired: a ping then pays the full write, and cannot recreate a terminal's entry.
   */
  start(sessionId: string, opts: StartOptions = {}): { ok: true } | { ok: false; error: string } {
    const s = this.deps.state(sessionId);
    const now = this.deps.now();
    // A ping another window is running now has not refreshed anything yet; tick() waits for it instead.
    const shared = this.sharedPing(sessionId);
    const lastPing = shared && !shared.pinging ? shared.at : undefined;
    if (!s || s.ttlMs === undefined || lastWarmed(s.lastRequest, lastPing) === undefined) {
      return { ok: false, error: "This session's log does not say when its prompt cache was last used." };
    }
    const expiry = cacheExpiry(s.lastRequest, lastPing, s.ttlMs)!;
    if (now >= expiry - MIN_LEFT_MS) {
      return { ok: false, error: 'The prompt cache has already expired. A refresh cannot bring it back; the next turn writes it again.' };
    }
    const old = this.entries.get(sessionId);
    if (old?.timer !== undefined) {
      this.deps.clearTimer(old.timer);
    }
    const e: Entry = {
      sessionId,
      active: true,
      startedAt: now,
      until: opts.durationMs === undefined ? undefined : now + opts.durationMs,
      spendCapUsd: opts.spendCapUsd ?? DEFAULT_SPEND_CAP_USD,
      spent: 0,
      pings: [],
      ttlMs: s.ttlMs,
      lastPing,
      pinging: false,
      retried: false,
      baseline: s.lastRequest,
      context: s.contextTokens,
      pingNow: opts.pingNow,
    };
    this.entries.set(sessionId, e);
    this.deps.log(`keep-warm ${sessionId}: started${e.until ? ` until ${new Date(e.until).toISOString()}` : ' until stopped'}, cap ${usd(e.spendCapUsd)}`);
    void this.tick(sessionId);
    return { ok: true };
  }

  /** The user's stop. */
  stop(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (e?.active) {
      this.halt(e, 'user');
    }
  }

  /** The window is closing: stop everything, and take back any claim another window would wait on. */
  dispose(): void {
    for (const e of this.entries.values()) {
      if (e.active) {
        this.halt(e, 'window');
      }
    }
  }

  /** The session's keep-warm, running or stopped (with its reason), if it was ever started in this window. */
  get(sessionId: string): KeptWarm | undefined {
    const e = this.entries.get(sessionId);
    return e && this.snapshot(e);
  }

  /** Every session kept warm now. */
  active(): KeptWarm[] {
    return [...this.entries.values()].filter((e) => e.active).map((e) => this.snapshot(e));
  }

  /**
   * The session's log changed: if a real turn has come since keep-warm started, report whether it read the context
   * from the cache. Works after keep-warm has stopped as well, until the report is made.
   */
  observe(sessionId: string): void {
    const e = this.entries.get(sessionId);
    const s = e && this.deps.state(sessionId);
    if (e && s) {
      this.checkNextTurn(e, s);
    }
  }

  // ---------- inside ----------

  private snapshot(e: Entry): KeptWarm {
    const s = e.active ? this.deps.state(e.sessionId) : undefined;
    const ttl = s?.ttlMs ?? e.ttlMs;
    return {
      sessionId: e.sessionId,
      active: e.active,
      startedAt: e.startedAt,
      until: e.until,
      spendCapUsd: e.spendCapUsd,
      spent: e.spent,
      pings: e.pings.map((p) => ({ ...p })),
      ttlMs: ttl,
      expiresAt: e.active ? cacheExpiry(s?.lastRequest, e.lastPing, ttl) : e.expiresAt,
      nextPingAt: e.active ? nextPingAt(s?.lastRequest, e.lastPing, ttl) : undefined,
      lastPing: e.lastPing,
      lastSkip: e.lastSkip,
      stopped: e.stopped,
      nextTurn: e.nextTurn,
    };
  }

  private changed(e: Entry): void {
    this.deps.onChange?.(e.sessionId);
  }

  private halt(e: Entry, reason: StopReason, message?: string): void {
    const now = this.deps.now();
    if (e.timer !== undefined) {
      this.deps.clearTimer(e.timer);
      e.timer = undefined;
    }
    const s = this.deps.state(e.sessionId);
    e.expiresAt = cacheExpiry(s?.lastRequest, e.lastPing, s?.ttlMs ?? e.ttlMs);
    e.active = false;
    e.stopped = { reason, message: message ?? STOP_MESSAGES[reason as keyof typeof STOP_MESSAGES] ?? 'Stopped keeping the cache warm.', at: now };
    if (e.pinging) {
      // Take back this window's claim, so another window does not wait on a ping nobody will finish recording.
      void this.writeShared(e.sessionId, undefined, true);
    }
    this.deps.log(`keep-warm ${e.sessionId}: stopped (${reason}): ${e.stopped.message} Spent ${usd(e.spent)} on ${e.pings.length} ping(s).`);
    this.changed(e);
  }

  private schedule(e: Entry, at: number): void {
    if (e.timer !== undefined) {
      this.deps.clearTimer(e.timer);
    }
    const now = this.deps.now();
    const fire = Math.min(at, now + TICK_MAX_MS);
    e.timerFor = fire;
    e.timer = this.deps.setTimer(() => {
      e.timer = undefined;
      void this.tick(e.sessionId);
    }, Math.max(0, fire - now));
  }

  private sharedAll(): Record<string, SharedPing> {
    const all = this.deps.shared.get<Record<string, SharedPing>>(SHARED_KEY);
    return all && typeof all === 'object' ? all : {};
  }

  private sharedPing(sessionId: string): SharedPing | undefined {
    const r = this.sharedAll()[sessionId];
    return r && typeof r.at === 'number' && typeof r.window === 'string' ? r : undefined;
  }

  /** Records this window's ping (or, with `undefined`, removes this window's claim), dropping records long expired. */
  private async writeShared(sessionId: string, rec: SharedPing | undefined, onlyIfMine = false): Promise<void> {
    const now = this.deps.now();
    const all = { ...this.sharedAll() };
    for (const [id, r] of Object.entries(all)) {
      if (!r || typeof r.at !== 'number' || now - r.at > SHARED_KEEP_MS) {
        delete all[id];
      }
    }
    if (rec) {
      all[sessionId] = rec;
    } else if (!onlyIfMine || all[sessionId]?.window === this.deps.windowId) {
      delete all[sessionId];
    }
    await this.deps.shared.update(SHARED_KEY, all);
  }

  private checkNextTurn(e: Entry, s: SessionCacheState): void {
    if (e.nextTurn || s.lastRequest === undefined || e.baseline === undefined || s.lastRequest <= e.baseline) {
      if (!e.nextTurn && s.contextTokens !== undefined) {
        e.context = s.contextTokens;
      }
      return;
    }
    const expected = e.context ?? 0;
    const cacheRead = s.cacheRead ?? 0;
    e.nextTurn = { at: s.lastRequest, cacheRead, expected, warm: expected > 0 && cacheRead >= WARM_READ_SHARE * expected };
    this.deps.log(`keep-warm ${e.sessionId}: the next turn read ${cacheRead} of ${expected} tokens from the cache (${e.nextTurn.warm ? 'warm' : 'not warm'})`);
    this.changed(e);
  }

  private async tick(sessionId: string): Promise<void> {
    const e = this.entries.get(sessionId);
    if (!e?.active || e.pinging) {
      return;
    }
    const now = this.deps.now();
    const late = e.timerFor !== undefined && now - e.timerFor > LATE_MS;
    e.timerFor = undefined;
    const s = this.deps.state(sessionId);
    if (!s) {
      return this.halt(e, 'gone');
    }
    this.checkNextTurn(e, s);
    if (s.ttlMs !== undefined) {
      e.ttlMs = s.ttlMs;
    }
    // Another window's later ping counts as this one's.
    const other = this.sharedPing(sessionId);
    if (other && other.window !== this.deps.windowId && !other.pinging && other.at > (e.lastPing ?? -Infinity)) {
      e.lastPing = other.at;
    }
    const expiry = cacheExpiry(s.lastRequest, e.lastPing, e.ttlMs)!;
    if (e.until !== undefined && now >= e.until) {
      return this.halt(e, 'duration');
    }
    if (now >= expiry - MIN_LEFT_MS) {
      if (late) {
        return this.halt(e, 'slept');
      }
      const why = e.lastSkip && now - e.lastSkip.at < e.ttlMs ? ` The refresh was skipped because ${e.lastSkip.why}.` : '';
      return this.halt(e, 'expired', `The cache expired before it could be refreshed, so keep-warm stopped.${why}`);
    }
    const due = e.pingNow ? now : nextPingAt(s.lastRequest, e.lastPing, e.ttlMs)!;
    if (now < due) {
      // A failed refresh that the schedule has moved past (pingNow's, or one a real turn made moot) is not retried.
      e.retried = false;
      this.schedule(e, e.until === undefined ? due : Math.min(due, e.until));
      return;
    }
    // Due (or a retry): skip while something else writes the session; its turn refreshes the cache by itself.
    const busy =
      s.busy ??
      (s.logWrittenAt !== undefined && now - s.logWrittenAt < RECENT_WRITE_MS ? `its log was written ${Math.max(1, Math.round((now - s.logWrittenAt) / 1000))}s ago` : undefined) ??
      (other && other.window !== this.deps.windowId && other.pinging && now - other.at < PING_TIMEOUT_MS ? 'another window is refreshing it' : undefined);
    if (busy) {
      e.lastSkip = { at: now, why: busy };
      this.deps.log(`keep-warm ${sessionId}: skipped a refresh: ${busy}`);
      this.changed(e);
      this.schedule(e, now + RETRY_MS);
      return;
    }
    const cost = e.pings.filter((p) => p.ok && p.cost !== undefined).pop()?.cost;
    const estimate =
      cost ?? (s.model && s.contextTokens !== undefined ? estimateKeepWarm({ model: s.model, contextTokens: s.contextTokens, ttlMs: e.ttlMs })?.perPing : undefined) ?? 0;
    if (e.spent + estimate > e.spendCapUsd) {
      return this.halt(e, 'spendCap', `Stopped keeping the cache warm: the next refresh (about ${usd(estimate)}) would pass the ${usd(e.spendCapUsd)} spend cap. Spent ${usd(e.spent)}.`);
    }
    await this.ping(e, s, now);
  }

  private async ping(e: Entry, s: SessionCacheState, now: number): Promise<void> {
    const n = e.pings.length + 1;
    const record: PingRecord = { n, at: now, ok: false, cacheRead: 0, cacheWrite: 0 };
    let wrongModel = false;
    e.pinging = true;
    e.pingNow = false;
    await this.writeShared(e.sessionId, { window: this.deps.windowId, at: now, pinging: true });
    this.deps.log(`keep-warm ${e.sessionId}: ping ${n}`);
    const r: OneShotResult = await runOneShot({
      sessionId: e.sessionId,
      launch: () => this.deps.launch(e.sessionId),
      spawn: this.deps.spawn,
      log: this.deps.log,
      text: pingText(n, now),
      timeoutMs: PING_TIMEOUT_MS,
      checkInit: (init) => {
        record.model = init.model;
        record.permissionMode = init.permissionMode;
        // Confirms that ONE_SHOT_ARGS' --permission-mode wins over chatArgs' own (PR #108 review).
        this.deps.log(`keep-warm ${e.sessionId}: ping ${n} init: model ${init.model ?? '?'}, permissionMode ${init.permissionMode ?? '?'}`);
        if (s.model && init.model && modelKey(init.model) !== modelKey(s.model)) {
          wrongModel = true;
          return `The refresh would run on ${init.model}, not the session's ${s.model}, and miss its cache.`;
        }
        return undefined;
      },
    });
    e.pinging = false;
    const turn = r.turn;
    record.ok = r.ok;
    record.cost = turn?.cost;
    record.model = record.model ?? turn?.model ?? (r.ok ? undefined : r.model);
    for (const q of turn?.requests ?? []) {
      record.cacheRead += q.cacheRead;
      record.cacheWrite += q.cacheWrite;
    }
    if (!r.ok) {
      record.error = r.error;
    }
    e.pings.push(record);
    e.spent += turn?.cost ?? 0;
    const end = this.deps.now();
    this.deps.log(
      `keep-warm ${e.sessionId}: ping ${n} ${r.ok ? 'ok' : `failed: ${r.error}`}; cache read ${record.cacheRead}, write ${record.cacheWrite}, cost ${record.cost === undefined ? '?' : usd(record.cost)}, spent ${usd(e.spent)}`,
    );
    if (r.ok) {
      // Recorded even when keep-warm was stopped while it ran: the cache was refreshed all the same.
      e.lastPing = now;
      await this.writeShared(e.sessionId, { window: this.deps.windowId, at: now });
    }
    if (!e.active) {
      // Stopped while the ping ran; halt() has already said so.
      const st = this.deps.state(e.sessionId);
      e.expiresAt = cacheExpiry(st?.lastRequest ?? s.lastRequest, e.lastPing, e.ttlMs);
      this.changed(e);
      return;
    }
    if (r.ok) {
      e.retried = false;
      this.changed(e);
      if (e.spent >= e.spendCapUsd) {
        return this.halt(e, 'spendCap', `Stopped keeping the cache warm: it reached the ${usd(e.spendCapUsd)} spend cap.`);
      }
      return this.tick(e.sessionId);
    }
    // Put back what was there before this window's claim: the last ping this window or another made.
    await this.writeShared(e.sessionId, e.lastPing === undefined ? undefined : { window: this.deps.windowId, at: e.lastPing }, true);
    this.changed(e);
    if (wrongModel) {
      return this.halt(e, 'model', `Stopped keeping the cache warm: ${r.error}`);
    }
    const expiry = cacheExpiry(this.deps.state(e.sessionId)?.lastRequest ?? s.lastRequest, e.lastPing, e.ttlMs)!;
    if (e.retried || end + RETRY_MS >= expiry - MIN_LEFT_MS) {
      return this.halt(e, 'failed', `Stopped keeping the cache warm: the refresh failed${e.retried ? ' twice' : ''} (${r.error}).`);
    }
    e.retried = true;
    this.schedule(e, end + RETRY_MS);
  }
}
