# Keeping a session's prompt cache warm

Proposal for SA-29: let the user keep a Claude Code session's prompt cache from expiring for a set time, so that
resuming it later reads the conversation from the cache instead of writing all of it again. The scheduler is built
(`src/keepWarm.ts`, SA-35), but nothing in the extension starts it yet; the rest of the build is split into the
follow-up items listed in section 9.

**Tested against:** Claude Code `2.1.332`, the native `claude.exe` on Windows 11, Node 24, on 2026-11-25. Every run
used throwaway sessions in a scratch folder, the `haiku` model (`claude-haiku-5-5`), and `--setting-sources project`.
The driver is [`scripts/trial-keep-warm.mjs`](../../scripts/trial-keep-warm.mjs). It sends turns through the
extension's own `ClaudeChat` (`src/claudeChat.ts`, the SA-25 chat process) and prints each API request's cache
numbers. The whole trial cost about $0.06 at API prices (section 10).

Record shapes below are real, with synthetic text. Ids and paths are placeholders, and `…` marks fields left out.

## 1. Summary

- **It works, and it can be done without touching the session.** A turn sent with
  `claude -p --resume <id> --no-session-persistence` reads the session's whole conversation from the cache, which
  refreshes the cache's TTL, and writes **nothing** to the session's `.jsonl` or anywhere else under `~/.claude`.
  On a 52k-token session it read 51,969 tokens from the cache and wrote 469, for $0.0006.
- **This account's sessions use the 1-hour cache.** Every cache write in the trial was `ephemeral_1h`. On the 1-hour
  TTL a ping is needed only every ~50 minutes, and keeping a session warm costs less than one cold resume for well
  over a day. On the 5-minute TTL, which other accounts get, a ping is needed every 3.5 minutes and keeping warm
  stops paying for itself after under half an hour (Haiku) to about 1 h 15 min (Opus, Sonnet) (section 4). An hour-long run
confirmed it: a session pinged once at 32 minutes was read whole from the cache at 64 minutes, while one left alone
had to write 73k tokens again (section 5).
- **The ping must not change the request's prefix.** The model, tool set and settings sources must match the session.
  `--disallowedTools Bash` turned a full cache hit into a full miss. `--permission-mode`, `--effort` and
  `--max-turns` did not affect the cache.
- **Recommendation: build it**, as a short-lived no-persist ping process per refresh, driven by `ClaudeChat`, with a
  duration, a spend cap and a status-bar indicator.
- **It also keeps an interactive terminal's cache warm, if it starts in time.** Checked by hand (section 8): a
  terminal resume 66 minutes after its last request read 99% of its context from the cache when a ping had landed
  inside the hour, and 29% when none had. A ping reads the terminal's entry and refreshes its lifetime, but cannot
  recreate one that has already expired, so the first ping must come before the entry does.

## 2. Mechanisms tried

The cache key is the exact request prefix: tools, then the system prompt, then the messages, on one model. A
request whose prefix matches a cached entry reads it, and a read refreshes the entry's TTL. So a "ping" is any
request that repeats the session's prefix and adds as little as possible after it.

Claude Code has no flag or command that refreshes the cache without making a request. Calling the API directly
would mean rebuilding Claude Code's exact request (system prompt snapshot, tool definitions, beta headers, auth that is
often a subscription login rather than an API key), which is fragile and not something the extension should own.
Every option below is therefore a real, minimal turn. The numbers are from `scripts/trial-keep-warm.mjs` runs; the
session (call it S) held about 52k tokens of context after reading a synthetic 135 KB text file.

| Mechanism | Cache read | Cache write | What the session's log got |
|---|---|---|---|
| New process, `--resume <id>`, ping turn | 49,283 | 846 | 13 more lines: the ping, its reply, and bookkeeping records |
| Second ping in the same process | 50,129 | 1,840 | 13 more lines |
| **New process, `--resume <id> --no-session-persistence`** | **51,969** | **469** | **nothing** (line count and file unchanged) |
| New process, `--resume <id> --fork-session` | 52,438 | 0 | nothing, but a **new 63-line session file** appears beside it |
| No-persist ping with `--permission-mode acceptEdits` | 52,438 | 0 | nothing |
| No-persist ping with `--disallowedTools Bash` | **0** | **46,911** | nothing |

A ping's usage, as the `assistant` event carries it:

```json
{"type":"assistant","message":{"id":"msg_…","model":"claude-haiku-5-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":2,"cache_read_input_tokens":51969,"cache_creation_input_tokens":469,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":469},"output_tokens":4,"…":"…"}},"session_id":"<session-id>","…":"…"}
```

What the table shows:

- **A ping refreshes the same entry.** Every variant that kept the tool set read the whole conversation (about 52k of
  52k) from the cache. The small write is the ping turn itself plus a few system reminders the CLI adds per process.
  A ping with the same text as the previous one, against an unchanged log, wrote **0** tokens: the whole request was
  already cached.
- **`--fork-session` and `--no-session-persistence` warm the original session's cache.** The cache is keyed on
  content, not on the session id, so a forked copy's request matches the original's prefix. Forking leaves a new
  session file that the sidebar would list, so no-persist is strictly better.
- **Changing the tool set is a full miss.** Tools come first in the prefix, so removing one tool invalidates
  everything after it. The same applies to MCP servers and settings: a ping must load the same settings sources as the
  user's real sessions. The trial used `--setting-sources project` throughout so that all its runs matched one
  another; the extension must **not** pass it, or its pings would warm a prefix the user's terminal never sends.
- **The system prompt is stable across processes.** Claude Code records the system prompt on a conversation's first
  request and resends that snapshot on every resume (`--system-prompt-snapshot`, on by default), so the cwd, date or
  git status changing between processes does not break the prefix.
- **The model comes from the session.** A resume without `--model` ran on the session's model (`haiku`), while a new
  session with the same flags got the account default (`claude-opus-5-5`). A ping should not pass `--model`, and
  should check that `system`/`init` reports the model of the log's last main-thread request.
- **`--effort low` and `--effort max` both hit the cache** (on haiku). Effort need not match.
- **`--max-budget-usd` cannot cap a ping.** With a cap of $0.001 the ping still ran and the result was a normal
  success. The cap is checked after a request, against more than this one process's spend, so it is a backstop at
  best. The extension has to count spend itself.
- One quirk: a session's second request rewrites about 4.5k tokens even when nothing changed (seen both on the
  first resume after a new session and on the second turn of a new session in one process). After that, requests read
  the whole prefix. It does not affect pinging.

## 3. What a ping leaves behind

**A persisted ping (plain `--resume`) pollutes the session.** Each one appended 13 records to the `.jsonl`: two
`queue-operation`s, the `user` ping, three `attachment` records (system reminders such as "the following tools just
became available"), `api-request-blob`, `api-request`, `data-flow-records`, the `assistant` reply, and then
`last-prompt`, `mode`, `session-owner`, `atis-latch` and `cost-state`. Consequences:

- The transcript shows each ping as a user/assistant exchange, and the sidebar's excerpt (from `last-prompt`) becomes
  the ping text.
- The model sees every ping in the conversation from then on, and they add to the context.
- The ping is a write to the log, so it forks the log if the session is also open elsewhere (SA-24 doc section 8).

Hiding persisted pings in the transcript view would be possible (a fixed ping text, matched in the parser), but the
model would still see them. **No-persist avoids all of this.** A no-persist ping left the session's `.jsonl`
byte-for-byte unchanged (same line count, same modification time), created no other session file, and did not add to
`~/.claude/history.jsonl`. The `cost-state` record is not updated either, so a session's logged total does not include
its pings; the extension keeps that count itself (section 6).

**The extension's cache timer will not see a no-persist ping.** The transcript's "Prompt cache" tile, its top-bar
timer and the sidebar's cache tag all compute the expiry from the log's last request (`usage.ts`, `cache.lastRequest +
ttlMs`). While a session is kept warm, the extension must use its own last ping time instead, or the timer will say
"expired" while the cache is warm.

## 4. What it costs, and when it pays

With context size N tokens, cache-read price r and cache-write price w (per token, for the session's TTL):

- **A ping** costs about N × r, plus a few hundred tokens written (zero when the ping repeats the previous one on an
  unchanged log) and a few output tokens.
- **A cold resume** costs N × w for the first request instead of N × r, so the extra is N × (w − r).
- **Break-even:** keeping warm costs less than one cold resume for (w − r) / r pings. The ratio depends only on the
  model's price list, so the UI can show both figures from `src/prices.json` and the context size it already
  computes.

Measured, on haiku: a no-persist ping on the 52k session cost **$0.00053 to $0.00066**. A cold resume of that session
would cost 52k × ($0.20 − $0.01)/M = **$0.0099** extra. The hour-long check in section 5 measured a cold resume
directly: $0.0147 on an 89k session, against $0.0006 for a warm one.

**The built ping writes about 1.9k tokens every time.** Its text differs on every ping (section 8's open point), so
each one reads the conversation from the terminal's own cache entry and writes the `-p` tail and its message again:
1,924 tokens in SA-33, `PING_WRITE_TOKENS` in `src/keepWarm.ts`. That adds 1,924 × w to each ping: $0.0154 on Opus
5.5 at the 1-hour write price, $0.0019 on Haiku 5.5 above 100k, whatever the context size. `estimateKeepWarm()`
counts it.

Computed from `src/prices.json` by `estimateKeepWarm()`, with a ping every 50 minutes on the 1-hour TTL and every 3.5
minutes on the 5-minute TTL (section 6), each writing 1,924 tokens:

| Model | Context | Ping (1 h TTL) | Ping (5 min TTL) | Cold resume extra (1 h TTL) | Cold resume extra (5 min TTL) |
|---|---|---|---|---|---|
| Opus 5.5 | 50k | $0.026 | $0.020 | $0.39 | $0.24 |
| Opus 5.5 | 200k | $0.056 | $0.050 | $1.56 | $0.96 |
| Opus 5.5 | 500k | $0.116 | $0.110 | $3.90 | $2.40 |
| Sonnet 5.5 | 200k | $0.028 | $0.025 | $0.78 | $0.48 |
| Haiku 5.5 | 50k | $0.0009 | $0.0007 | $0.0095 | $0.0057 |

| Model | Context | Break-even, 1 h TTL | Break-even, 5 min TTL |
|---|---|---|---|
| Opus 5.5 | 50k | 15 pings, about **12.5 hours** | 12 pings, about **43 min** |
| Opus 5.5, Sonnet 5.5 | 200k | 28 pings, about **23 hours** | 19 pings, about **1 h 8 min** |
| Opus 5.5 | 500k | 34 pings, about **28 hours** | 22 pings, about **1 h 17 min** |
| Haiku 5.5 | 50k | 11 pings, about **9 hours** | 8 pings, about **27 min** |

Before the fixed write, a ping cost N × r alone, and break-even was a flat (w − r) / r pings: 39 on Opus and Sonnet
and 19 on Haiku at the 1-hour TTL. The write matters most on small sessions, where it is a large share of the ping.

So on the 1-hour TTL, keeping a session warm through lunch or overnight is clearly cheaper than a cold resume, as
long as the user does come back to it. On the 5-minute TTL it pays for gaps up to one or two hours, and the UI should
say when a chosen duration costs more than the resume it saves. For subscription users these are API-equivalent
figures, as everywhere else in the extension: usage against the plan, not money.

## 5. Measured over an hour

To check that a no-persist ping really keeps a cache alive past its TTL, two sessions were left alone after their last
request: S (52k tokens) got one no-persist ping 32 minutes in, and C (89k tokens, a second synthetic file, its own
folder) got none. Both were then resumed with a real question about an hour after their last request, past the
1-hour TTL.

| Session | Last request before | Ping | Real turn at | Cache read | Cache write | Turn cost |
|---|---|---|---|---|---|---|
| S, kept warm | 0 min | at 32 min: read 52,438, wrote 0, $0.00053 | 64 min | **51,969** | 477 | **$0.00062** |
| C, left alone | 0 min | none | 63 min | 16,310 | **72,843** | **$0.01473** |

Both answered correctly from the conversation ("lantern", "copper"). S's real turn read its whole context, more than
an hour after its last real request, because the ping at 32 minutes had refreshed the 1-hour entry. C's cache had
expired: only the first 16k tokens (the tool definitions and the start of the system prompt, which every session in
this setup shares and other runs kept warm) were read, and the rest was written again at the 1-hour write price. On
these numbers, one $0.0005 ping saved about $0.014 on C's size, and $0.009 on S's.

The ping also confirmed the log is untouched: S's `.jsonl` kept 89 lines and the same modification time across it,
then grew by 11 lines with the real turn.

## 6. Timing, failures and sleep

- **Interval.** Ping when the cache has a margin left: at TTL − 10 minutes on the 1-hour TTL (every 50 minutes), and
  at TTL − 90 seconds on the 5-minute TTL (every 3.5 minutes). The TTL comes from the log's last cache write, as
  `usage.ts` already works out. A ping takes 1 to 2 seconds, including process start.
- **Too close to the expiry.** A ping is not started with under a minute left (`MIN_LEFT_MS`): claude.exe's start-up
  (MCP servers, Windows) could take its request past the expiry, and a late ping pays the full write. The 5-minute
  margin is 90 seconds rather than 60 for this reason, plus the 4-second claim below; it leaves no room for a retry or
  a skipped ping on that TTL, so those stop as expired. SA-72's run measures the real spawn-to-request time.
- **Schedule from the wall clock.** Each tick computes the next ping from `max(last logged request, last ping)` and
  `Date.now()`, rather than counting `setTimeout`s, so drift does not add up and a real turn in a terminal (which
  refreshes the cache by itself) pushes the next ping back.
- **A failed ping** (non-zero exit, `is_error` result, model mismatch at `init`) is retried once after 30 seconds if
  the cache still has time left. If the expiry passes, keep-warm stops and says why.
- **Sleep.** Timers do not run while the machine sleeps. On the first tick after waking, if the expiry has already
  passed, stop and tell the user ("the cache expired while the computer was asleep") instead of pinging: a ping
  then pays the full cache write, which is exactly the cost keep-warm exists to avoid, and the user may not come back.
- **Stop** when the chosen duration ends, when the spend cap is reached, when the user stops it, and when the window
  closes. Keep-warm lives in the extension host, so it ends with the window; it should not be restored on the next
  start, because the cache may already have expired.
- **One process per ping, not a long-lived one.** A fresh `--resume` reads the current log each time, so if the user
  has added turns elsewhere in the meantime, the ping warms the new prefix. A long-lived no-persist process would
  keep pinging the conversation as it was when it started.
- **Two VS Code windows** could both keep one session warm. They compute the same due time from the same log, and
  `globalState` reaches the other window late, so a claim read back at once would show each window only its own. So
  a window that is due writes a claim (its window id and the claim time) into the session's record in `globalState`,
  waits 2 seconds, reads the claims again, and does that once more: an earlier claim from another window, by claim
  time and then window id, makes it back off and count that window's ping as its own. A claim that another window's
  write has overwritten is written again after the first wait, so after the second both windows see both claims.
  Each ping therefore starts 4 seconds after it is due. The record also keeps the last ping (window and time), which
  every window reads.

## 7. Conflicts with other writers

A no-persist ping writes nothing to the log, so it cannot fork it the way two chat processes do (SA-24 doc section
8, SA-28). Two cases still need care:

- **A turn is running elsewhere** (a terminal, the in-view chat, the Claude Code chat panel). The running turn
  refreshes the cache itself, and a ping started meanwhile would resume a half-written log. Skip the ping when the
  log was written in the last few seconds (the same `RECENT_WRITE_MS` check the chat uses), when the in-view chat is
  busy, or when a terminal for the session is open; then reschedule from the log's new last request.
- **The in-view chat's own process** (SA-25) must not be used for pings: it persists its turns, so every ping would
  land in the log and the transcript. The warmer always starts its own no-persist process.

Not tested: a ping resuming a log in the middle of another process's turn. The CLI closes a half-written turn with a
synthetic "No response requested." record in memory (SA-24 doc section 8); with no-persist that record should not be
written, but the skip above means it should not come up.

## 8. Does a `-p` ping warm an interactive terminal's cache? Yes, if it comes in time

Everything above was measured between `-p` processes. The user's next real turn is often in an interactive terminal
(the sidebar's Resume), which the trial could not drive without a TTY. If the interactive CLI sent a different tool
set from `-p`, a ping would warm a prefix the terminal never reads. It was checked by hand, on Claude Code 2.1.332 and
Haiku, with two scratch sessions of about 100k tokens: **warm**, which gets pings, and **control**, which does not.
[`scripts/prepare-keep-warm-check.mjs`](../../scripts/prepare-keep-warm-check.mjs) sets up the folder and a `README.txt`
with every command, and [`scripts/show-session-cache.mjs`](../../scripts/show-session-cache.mjs) prints each API
request's cache read and write from a session's `.jsonl`.

**Result.** Times are local; "age" is the time since the session's last terminal request. Context is cache read plus
cache write plus 2 uncached tokens.

| Request | Age | Cache read | Cache write | Cost |
|---|---|---|---|---|
| Ping 1 (warm), after the terminal's entry had expired | about 2 h | 0 | 102,498 | $0.1025 |
| Ping 2 (warm), after warm's terminal resume at 13:25:54 | not recorded | 100,685 | 1,924 | $0.0070 |
| Pings 3 and 4 (warm) | not recorded | 102,609 | 0 | $0.0051 each |
| Ping 5 (warm), 14:15 to 14:25 | under 1 h | 102,609 | 0 | $0.0051 |
| Terminal resume, warm, 14:32:14 | 66 min | 100,685 of 101,357 (99%) | 670 | |
| Terminal resume, control, 14:32:46, never pinged | 66 min | 29,124 of 100,124 (29%) | 70,998 | |

- **The ping's prefix matches the terminal's through the whole conversation.** Ping 2 read 100,685 tokens, which is
  all of the terminal's last request (context 100,687, of which 2 were uncached). The interactive CLI and `-p` send
  the same system prompt and tools. The ping adds about 1.9k tokens after the conversation, the `-p` mode's own tail
  plus the ping message, and that is all it writes (ping 2's 1,924). This is also the gap between ping 1's 102,498
  and the terminal's 100,624.
- **Terminal Resume benefits.** At 66 minutes, past the 1-hour lifetime of the terminal's own write, warm read 99% of
  its context from the cache for a $0.006 turn. Control, never pinged, read only the 29,124-token prefix that every
  session shares (system prompt and tools) and wrote 70,998 again. Rough cost on Haiku: a cold resume of a 100k
  session about $0.07, a warm one about $0.006, each ping $0.005 to $0.007.
- **Nothing was written to the session.** The log held at 135 lines across ping 1, 153 across pings 2 to 4 and 166
  across ping 5. (It went from 153 to 166 between pings 4 and 5 with no API request, probably from opening and closing
  the interactive CLI.)

**Why the first try missed.** The check as first written pinged more than an hour after the terminal's last request,
so that only the ping could have warmed anything. By then the terminal's entry had expired. Ping 1 wrote a new entry,
but one that ends past the 1.9k `-p` tail, and the terminal's next request diverges from it before that point, so
the terminal read only the shared 29k prefix, the same as control (warm 31,878, control 29,124). A ping can refresh
an entry that is alive. It cannot recreate one that has expired. Hence: **the first ping has to come before the
terminal's entry expires**, which is what the ~50-minute schedule in section 9 already does. The check's step 3 now
says to ping 15 to 50 minutes after the last terminal request and to resume more than an hour after it.

**Open point, for SA-35.** After the first ping, identical pings (3 to 5) read 102,609 tokens, which is the ping's own
longer entry, not the terminal's 100,685. A read of the ping's entry may or may not also refresh the terminal's
shorter one; the check cannot tell, because ping 2, which read the terminal's entry directly, may itself have been
inside the hour. If a later ping does not refresh it, a schedule that outlasts the hour loses the terminal's entry.
Two ways out: vary the ping text so each ping falls back to the terminal's breakpoint, or measure it with a timed test
(pings at 0, 50 and 100 minutes, a terminal resume at about 110). The scheduler (SA-35) must settle this before it
relies on repeated pings.

**Decided in SA-35 (user, in chat): vary the text, and measure it as well.** Each ping says
`Keep-alive ping <n> at <ISO time>. Reply with only: ok` (`pingText()` in `src/keepWarm.ts`), so the request diverges
from every earlier ping's right after the conversation, and its read should fall back to, and refresh, the terminal's
own entry. The cost is the ~1.9k tail written on every ping (section 4). The timed check is SA-72, run by hand:
`node scripts/prepare-keep-warm-check.mjs --check sa72` writes its folder and README, and
[`scripts/keep-session-warm.mjs`](../../scripts/keep-session-warm.mjs) sends its pings through the built module
(`out/keepWarm.js`), not the trial script. Its result goes here when it is in.

The build should also report this live: after a kept-warm session's next real turn, compare its cache read with the
context size and say "Kept warm: the next turn read 198k of 200k tokens from the cache", or that it did not.

## 9. Recommendation and UI

**Build it**, with no-persist pings. It is cheap to run, invisible in the session, and on the 1-hour TTL it pays for
itself after a handful of pings. Proposed shape:

**The ping.** Spawn through `ClaudeChat` with the chat's command line plus `--no-session-persistence --max-turns 1
--permission-mode dontAsk`, send a text that differs on every ping (`Keep-alive ping <n> at <time>. Reply with only:
ok`, section 8), wait for the `result`, then `end()`. `dontAsk` denies any tool call without asking, and `--max-turns 1` stops a tool loop; neither changed the
cache. The process runs in the session's project folder, with the user's own settings sources and no `--model`. Abort
(`stopNow()`) if `init` reports a model other than the log's last main-thread model. Cost per ping comes from
`turnCost()` (`model_usage_since_last_result`), and its cache read and write from the `assistant` event's `usage`.
`runOneShot()` in `src/claudeChat.ts` (SA-34) does all of this on `ClaudeChat`'s own process code: it appends
`ONE_SHOT_ARGS` to `chatArgs` (the `extraArgs` option), declines every permission request at once without a card
(`declineAll`), stops the run when its `checkInit` refuses the `init` model or its timeout passes, and resolves after
the process has exited with the turn's cost, model and per-request usage (`TurnReport`, from the `onTurnEnd` option).
The trial script still rewrites arguments through its spawner.

**The scheduler** is `KeepWarm` in `src/keepWarm.ts` (SA-35), with no VS Code imports, so `test/keepWarm.test.js`
drives it with a fake clock, a fake `globalState` and a fake `claude`. Each tick reads the session again and decides
from the wall clock: stop (the chosen duration, the spend cap, an expiry, a sleep past the expiry), wait, skip (the
log written in the last `RECENT_WRITE_MS`, or the caller's `busy` reason: the in-view chat replying, a terminal
open, another window's claim), or claim and ping. A failed ping is retried once after 30 seconds. Claims and pings
are recorded in `globalState` under `keepWarm.pings` (section 6), and another window's ping counts as this window's
own. Each ping's cost, cache
read and write, `init` model and `init.permissionMode` are kept and logged: the last one shows whether the appended
`--permission-mode dontAsk` wins over the one `chatArgs` gives (PR #108 review). The real CLI's answer is not
recorded yet; SA-72's README asks for it. `get()` gives the effective expiry (`max(last request, last ping) + TTL`) for the timers,
`estimateKeepWarm()` the per-ping and cold-resume costs, and `observe()` reports whether the next real turn read its
context from the cache. It refuses to start on a cache that has already expired. The spend cap is a start option
(default $1.00); the `claudeSessions.keepWarm.spendCapUsd` setting that feeds it comes with the UI (SA-36).

**Entry points.**

| Where | What |
|---|---|
| Transcript: the "Prompt cache" tile and the top-bar cache timer | Click opens a menu: **Keep warm for 30 min / 1 hour / 4 hours / until I stop**, each with its estimate ("about 5 refreshes, $0.20; a cold resume would cost $1.56"). While kept warm, the tile reads "Kept warm until 14:30, $0.08 so far" with a Stop button, and the timer counts down from the last ping. |
| Transcript: the ⌄ menu next to "Continue in new session" | A **Keep prompt cache warm…** entry, for users who look for actions there rather than on the tile. |
| Sidebar right-click on a Claude Code session | **Keep Prompt Cache Warm…** (`sessionSource == 'claude'`), and **Stop Keeping Warm** when it is kept warm (a new `sessionKeptWarm` context key). The row's cache tag shows that it is kept warm. |
| Command palette | **SessionsAI: Keep Session's Prompt Cache Warm…** (picks a recent Claude Code session) and **SessionsAI: Stop Keeping Sessions Warm**. |
| Status bar | Shown only while at least one session is kept warm: "2 kept warm, $0.06". Click lists them with their end time, spend and a Stop action each, and a Stop All. |

**Settings.** `claudeSessions.keepWarm.defaultDuration` (`30m`, `1h`, `4h`, `untilStopped`; default `1h`) for a
one-click start, and `claudeSessions.keepWarm.spendCapUsd` (per session, default `1.00`), after which keep-warm stops
and says so.

**Only for sessions whose cache can be read.** Offer it only while the cache is still warm (a cold session's first
ping would pay the full write, the same as resuming) and only for Claude Code sessions. The same holds for a terminal:
a ping reads the terminal's entry and keeps it alive, but cannot bring back one that has expired, so the first ping
must come before expiry (about 50 minutes after the last request on the 1-hour TTL). Section 8 has the open question
on whether repeated identical pings keep refreshing the terminal's own entry.

**Copilot CLI and VS Code Chat: not applicable.** Neither exposes per-token cache pricing or a cache TTL to the user:
Copilot bills per premium request, and any prompt caching happens on the service's side, out of view. A ping would
spend a premium request for no saving the user can see, and VS Code Chat has no process the extension could drive.
The entry points above should be hidden for those sources.

**Build tasks**, filed in the agent vault, in order:

1. **SA-33** (done): confirmed by hand that a no-persist ping warms the cache for an interactive terminal resume,
   provided the first ping comes before the terminal's entry expires (section 8).
2. **SA-34** (done): let `ClaudeChat` run a one-shot turn with extra arguments, auto-denying tool requests and handing
   back the `init` model and per-request usage.
3. **SA-35**: the scheduler: pings, wall-clock schedule, skip on another writer, retry, sleep, spend cap, cross-window
   coordination, effective expiry and cost estimates, all unit-tested with a fake clock.
4. **SA-72**: the timed check by hand that repeated pings keep a terminal's entry alive past two hours (section 8).
5. **SA-36**: the transcript's tile, timer and ⌄ menu entry, and the spend-cap setting.
6. **SA-71**: the sidebar, command palette and status bar, and the default-duration setting.

## 10. Trial spend

All at API prices on `claude-haiku-5-5`, from each turn's `model_usage_since_last_result`: building the two test
sessions $0.026, the pings and mechanism variants $0.015 (the `--disallowedTools` miss alone $0.009), the
effort/mode/turn-limit checks about $0.003, and the hour-long check $0.016 (most of it C's cold resume). Total about
**$0.06**. Two
further runs were killed as soon as `system`/`init` arrived, to read which model a resume picks without paying for a
turn; if the CLI had already sent its request, the one on Opus could have cost up to about $0.20.
