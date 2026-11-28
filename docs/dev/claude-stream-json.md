# Claude Code's stream-json mode for a resumed multi-turn chat

Finding for SA-24, which decides how the in-view chat (SA-22, SA-25) is built. Nothing here ships in the extension.

**Tested against:** Claude Code `2.1.332`, the native `claude.exe` on Windows 11, Node 24, on 2026-11-25. Every run
used a throwaway folder and throwaway sessions, the `haiku` model, and `--setting-sources project` so the user's own
settings (a `defaultMode`, hooks) did not colour the results. The driver is
[`scripts/trial-claude-stream.mjs`](../../scripts/trial-claude-stream.mjs); the usage is in its header comment.

The examples below are real record shapes, cut down to the fields that matter, with synthetic text. Ids, paths and
token counts are placeholders. `…` marks fields left out.

The base command for everything below:

```
claude -p --resume <session-id> --input-format stream-json --output-format stream-json
       --include-partial-messages --verbose [--permission-prompt-tool stdio] [--permission-mode <mode>]
```

`-p` and `--verbose` are both required for stream-json output. Leave out `--resume` and the CLI starts a new session.

## 1. A user turn on stdin, and several turns per process

One JSON object per line:

```json
{"type":"user","message":{"role":"user","content":"Read notes.txt and tell me its second word."},"parent_tool_use_id":null,"session_id":""}
```

`session_id` can be empty; the process already knows its session. `content` should also accept an array of content
blocks (`[{"type":"text","text":"…"}]`), as the API does, but only the string form was tested.

**One process takes many turns.** Write the next user line after the previous turn's `result` and the process carries
on in the same session, with the conversation context intact. The process stays alive until stdin is closed. After
the last `result`, close stdin and it exits with code 0 in under half a second.

**Typing while Claude works is fine.** A second user line written while a turn is running is queued, not dropped and
not an error. It runs as its own turn after the first, with its own `result` (`result_index` 0, then 1). Closing
stdin straight after writing it still lets the queued turn run. The first turn's `result` said `queued_turn_count: 0`
even though a turn was waiting, so do not rely on that field to know whether more is coming.

`--replay-user-messages` echoes each user line back on stdout with `"isReplay":true` and the `uuid` the CLI gave it
in the session log. The echo comes late, just before the first assistant message, so show the user's bubble
immediately rather than waiting for it.

```json
{"type":"user","message":{"role":"user","content":"Say ok."},"session_id":"<session-id>","parent_tool_use_id":null,"uuid":"<uuid>","timestamp":"…","isReplay":true}
```

## 2. The stdout events

Every stdout line is one JSON object with a `type`. Every type below except `control_response` carries
`session_id`. A turn looks like this (stream events in brackets):

```
system/init → system/status → [message_start → content_block_start → content_block_delta… → ]
assistant → [content_block_stop → message_delta → message_stop] → rate_limit_event → result
```

Tool calls add a `user` event with the `tool_result` and then a second API round inside the same turn.

**`system`/`init` comes at the start of every turn**, not once per process. It reports `model`, `permissionMode`,
`tools`, `claude_code_version`, `cwd`, and more.

```json
{"type":"system","subtype":"init","session_id":"<session-id>","model":"claude-haiku-…","permissionMode":"default","tools":["Bash","Edit","Read","…"],"claude_code_version":"2.1.332","cwd":"…", "…":"…"}
```

**Partial text chunk:** a `stream_event` wrapping the API's raw event. Text arrives as `text_delta`, tool input as
`input_json_delta`, and thinking as `thinking_delta` (with `thinking` empty and only an `estimated_tokens` count;
the CLI also sends `system`/`thinking_tokens` events alongside).

```json
{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The second word in "}},"session_id":"<session-id>","parent_tool_use_id":null,"uuid":"<uuid>","api_message_id":"msg_…"}
```

**Finished assistant message:** an `assistant` event. There is **one per content block**, not one per API message,
so a reply with thinking and then text arrives as two `assistant` events with the same `message.id`. Group by
`message.id`. Each one arrives just before that block's `content_block_stop`.

```json
{"type":"assistant","message":{"id":"msg_…","role":"assistant","model":"claude-haiku-…","content":[{"type":"text","text":"The second word is beta."}],"usage":{"…":"…"}},"parent_tool_use_id":null,"session_id":"<session-id>","uuid":"<uuid>","timestamp":"…"}
```

**Tool call:** an `assistant` event whose content block is `tool_use` (preceded by a `content_block_start` stream
event carrying the tool name, so the UI can show the call before its input has streamed).

```json
{"type":"assistant","message":{"id":"msg_…","content":[{"type":"tool_use","id":"toolu_…","name":"Read","input":{"file_path":"<cwd>/notes.txt"}}],"…":"…"},"session_id":"<session-id>","uuid":"<uuid>"}
```

**Tool result:** a `user` event with a `tool_result` block. `tool_use_result` holds the tool's structured result, and
`tool_result_meta` says how the call was allowed (`"source":"config"` for a rule or mode, `"user_temporary"` for a
host allow, `"user_reject"` for a host deny).

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_…","content":"1\talpha beta gamma\n"}]},"session_id":"<session-id>","uuid":"<uuid>","tool_use_result":{"type":"text","file":{"…":"…"}},"tool_result_meta":[{"id":"toolu_…","permission_decision":{"decision":"accept","source":"config","reason_type":"mode"}}]}
```

**The `uuid` on `assistant` and `user` events is the `uuid` of the matching record in the session's `.jsonl`.** The
live stream and the log file can be de-duplicated by it.

**End of turn, with cost and usage:** a `result` event, always the last line of a turn.

```json
{"type":"result","subtype":"success","is_error":false,"num_turns":2,"stop_reason":"end_turn","terminal_reason":"completed","result":"The second word is beta.","session_id":"<session-id>","duration_ms":2800,"total_cost_usd":0.0157,"usage":{"input_tokens":4,"output_tokens":222,"cache_read_input_tokens":40407,"cache_creation_input_tokens":7146,"…":"…"},"model_usage_since_last_result":{"claude-haiku-…":{"inputTokens":2,"outputTokens":17,"costUSD":0.00056,"…":"…"}},"modelUsage":{"…":"…"},"permission_denials":[],"queued_turn_count":0,"result_index":0}
```

Watch the cost fields:

- `total_cost_usd` and `modelUsage` are **running totals for the whole session**, carried over from earlier processes
  (the CLI keeps them in a `cost-state` record in the log). They are not this turn's cost.
- `model_usage_since_last_result` is **this turn's** cost and tokens, per model. Use this for a per-turn figure.
- `usage` is this turn's tokens summed over its API calls. `num_turns` counts API round trips, not user turns.

**Errors.** There is no separate error event. A failed turn still ends with a `result`, with `is_error: true`:

| What went wrong | `result` | Also on stdout / stderr | Exit |
|---|---|---|---|
| Turn interrupted | `subtype:"error_during_execution"`, `stop_reason:null` | a `user` text event `[Request interrupted by user]` | process stays up |
| API error (unknown model, here) | `subtype:"success"`, `is_error:true`, `terminal_reason:"api_error"`, `api_error_status:404` | a synthetic `assistant` message (`"model":"<synthetic>"`) with the error text; a line on stderr | 1, after stdin closes |
| Unknown `--resume` id | `subtype:"error_during_execution"`, `num_turns:0`, `errors:["No conversation found with session ID: …"]` | the same text on stderr | 1, immediately |

So read `is_error`, not `subtype`. Stderr carries human-readable diagnostics and should be logged, not parsed.

An interrupted turn's `result` also carries `terminal_reason: "aborted_streaming"` and an `errors` entry that is a
diagnostic (`"[ede_diagnostic] result_type=user …"`), not a message for the user (seen while building SA-25). The chat
treats a turn it asked to interrupt, or one whose `terminal_reason` starts with `aborted`, as stopped rather than
failed. After an error result, closing stdin makes the process exit with code 1.

Other events seen and safe to ignore for a chat view: `system`/`status` (`"status":"requesting"`),
`rate_limit_event`, `system`/`thinking_tokens`. Anything unknown should be skipped.

## 3. Resuming keeps the session id and the file

`--resume <id>` (without `--fork-session`) keeps the same `session_id` on every event and **appends to the same
`~/.claude/projects/<project-dir>/<id>.jsonl`**. No new file appears. The project folder is derived from the process's
working directory, so the chat must spawn the CLI with `cwd` set to the session's original project folder.

The appended records are ordinary log records, parented on the previous leaf through `parentUuid`. The CLI also writes
record types the transcript does not need (`queue-operation`, `api-request`, `api-request-blob`, `data-flow-records`,
`tools-used`, `derived-from`, `session-owner`, `mode`, `atis-latch`, `last-prompt`, `cost-state`). The extension's
current parser reads the resulting file without errors and shows the turns, so SA-22's live transcript can keep
watching the same file it already reads.

`--fork-session` exists for the opposite case (a new id and file). It was not tested.

## 4. Interrupting a turn

| Method | What happened | Process afterwards | Log afterwards |
|---|---|---|---|
| **Control request** on stdin | Stopped within ~30 ms | **Stays up and takes the next turn** | Partial `assistant` text, then a user record `[Request interrupted by user]`, the same as Esc in the terminal |
| `child.kill('SIGINT')` (Windows) | Process killed outright: exit `signal=SIGINT`, no `result` | Gone | The user prompt and nothing after it. On the next resume the CLI adds a synthetic `"No response requested."` assistant record |
| Closing stdin | **Does not interrupt.** The running turn (and anything queued) finishes, then the process exits 0 | Exits after the turn | Normal |
| `child.kill()` | Same as SIGINT on Windows | Gone | Same as SIGINT |

The control request, and its reply:

```json
{"type":"control_request","request_id":"<any id you choose>","request":{"subtype":"interrupt"}}
```

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<the same id>","response":{"still_queued":[]}}}
```

Then the turn closes with the interrupted `result` from the table in section 2. The next user line starts a new turn
in the same process, and Claude knows the previous one was interrupted.

On Windows, signals are not real signals: Node's `kill` calls `TerminateProcess`, so only the control request gives a
clean stop.

## 5. `--permission-prompts none`

Anything that would have prompted is denied at once, and the turn carries on. The stream gets a `system`
`permission_denied` event, then the tool result is an error the model sees:

```json
{"type":"system","subtype":"permission_denied","tool_name":"Write","tool_use_id":"toolu_…","decision_reason_type":"asyncAgent","decision_reason":"no approval surface in this session; permission request denied automatically","message":"Permission for this tool use was denied. It requires approval, and this session has no approval surface … do not retry it: this action, and anything else that requires approval, will be denied the same way for the rest of this session. …","session_id":"<session-id>"}
```

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_…","is_error":true,"content":"Permission for this tool use was denied. It requires approval, and this session has no approval surface …"}]},"session_id":"<session-id>","…":"…"}
```

The `result` lists it in `permission_denials` (`tool_name`, `tool_use_id`, `tool_input`). The model reports the
denial in its reply and does not retry.

**This message poisons the session.** It tells the model that approvals "will be denied the same way for the rest of
this session", and it stays in the transcript. In the next process on the same session, asked for the same Write, the
model did not call the tool at all and answered that it had been denied earlier. It only tried again when the prompt
said plainly that approvals now work. A chat that switches between `none`
and `host` on one session will hit this.

## 6. `--permission-prompts host`: it works, with `--permission-prompt-tool stdio`

`--permission-prompts host` is the default, but **on its own it does not send anything to stdout**: with no
`--permission-prompt-tool` the tool is denied (`system`/`permission_denied` with the plain message "Claude requested
permissions to write to …, but you haven't granted it yet."). Add **`--permission-prompt-tool stdio`** and the CLI
asks on stdout and waits for the reply on stdin. No `initialize` handshake was needed.

The request:

```json
{"type":"control_request","request_id":"<request-id>","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"mkdir out","description":"Create directory out"},"description":"Create directory out","tool_use_id":"toolu_…","blocked_path":"…","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"mkdir out *"}],"behavior":"allow","destination":"localSettings"},{"type":"addDirectories","directories":["…"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}
```

Allow (the tool runs with `updatedInput`, which may be the input unchanged or an edited copy):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<request-id>","response":{"behavior":"allow","updatedInput":{"command":"mkdir out","description":"Create directory out"}}}}
```

Deny (the tool result is an error whose text is exactly `message`, and the model carries on):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<request-id>","response":{"behavior":"deny","message":"The user declined."}}}
```

Both were tested and worked: an allowed Write created the file and the result's `tool_result_meta` said
`"source":"user_temporary"`; a denied Write left no file, the model quoted the deny message back, and the `result`
listed one denial. A denial by the host emits no `system`/`permission_denied` event; the error tool result and
`permission_denials` are the record of it.

The process blocks on the request until it is answered, so the extension must answer every `can_use_tool` (or
interrupt the turn) or the chat hangs. `permission_suggestions` are the "always allow" options the terminal offers.
Replying with them is section 6a.

**So the permission-card task can go ahead.**

## 6a. Allowing with `updatedPermissions`

Finding for SA-37, tested on 2026-11-27 against the same `2.1.332` with the same driver (`--permissions allow
--suggest <types> [--suggest-dest <destination>]`), each run in a fresh throwaway folder and session, `haiku`, and
`--setting-sources project` or `project,local`.

An allow reply can carry the request's `permission_suggestions`, as they came or with another `destination`:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<request-id>","response":{"behavior":"allow","updatedInput":{"command":"git tag first-tag","description":"…"},"updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"git tag *"}],"behavior":"allow","destination":"session"}]}}}
```

**What each request offered:**

| Request | `permission_suggestions` |
|---|---|
| Bash `git tag first-tag` in the working folder | `addRules` `Bash(git tag *)`, `destination: "localSettings"` |
| Write a new file in the working folder | `setMode` `acceptEdits`, `destination: "session"` |
| Write a new file in another folder | `setMode` `acceptEdits` and `addDirectories` (that folder), both `"session"` |
| Read a file in another folder | `addRules` `Read(//c/<that folder>/**)`, `"session"` (no `addDirectories`); the request also had `decision_reason_type: "workingDir"` |
| `ExitPlanMode` | none: no `permission_suggestions` key at all, but a `requires_user_interaction` key |

**What each did:**

| Sent | Later request of the same kind, same process | Settings files |
|---|---|---|
| `setMode acceptEdits`, `session` | Not asked: the next turn's `system`/`init` said `permissionMode: "acceptEdits"`, and the Write ran with `tool_result_meta` `source: "config"`, `reason_type: "mode"` | none |
| `addRules`, `localSettings` (as offered) | With `--setting-sources project,local`: not asked (`source: "config"`, `reason_type: "subcommandResults"`). With `--setting-sources project`: **asked again**, since local settings are not read | **Wrote `<cwd>/.claude/settings.local.json`** (folder and file created) with `{"permissions":{"allow":["Bash(git tag *)"]}}`, either way |
| `addRules` with `destination` changed to `session` | Not asked (`source: "config"`) | none |
| `addDirectories`, `session` | The next Write in that folder no longer offered `addDirectories` (only `setMode`), so the folder now counts as a working folder; the Write still asked, as one in the working folder does in `default` mode | none |

So all three types are honoured, `destination: "session"` works for every one of them (including the `addRules` that
was offered as `localSettings`), and only `localSettings` writes a file: the project's own
`.claude/settings.local.json`, which outlives the chat and every other Claude Code run in that folder.

**"Session" means this process.** A new process resuming the same session (`--resume`) asked again for the rule
granted with `session` before, and one started with `--permission-mode default` after a `setMode acceptEdits` reported
`default` and asked again for a Write. Nothing about these grants goes into the session's log.

**Approving a plan leaves plan mode for `default`.** With `--permission-mode plan`, the `ExitPlanMode` request was
allowed with its input unchanged (no `updatedPermissions`). The model then started on the plan in the same turn, and
its Write asked as it would in `default` (offering `setMode acceptEdits`). The next turn's `init` said
`permissionMode: "default"`. So once a plan is approved, the process is no longer in plan mode, and a picker that
still says Plan is wrong.

**What the chat does with this (SA-37):** a card whose request offers suggestions has a third button, **Allow for
this session**. It sends every `addRules` (allow), `addDirectories` and `setMode` suggestion with `destination`
rewritten to `"session"`, so nothing is ever written to a settings file, and the card says what it grants. Unknown
types (and `setMode` to a mode the picker does not know) are left out. The grants last as long as the chat's process:
until the tab closes, End chat, or a change of permission mode restarts it. The picker follows the CLI's mode: at
once when a `setMode` grant or a plan approval is sent, and from every `init` after that. That mode is the process's,
not the tab's: when the process ends (End chat, a restart, an exit), the picker goes back to the mode the user last
picked, and the next process starts in it. This holds for an approved plan too, so a tab set to Plan plans again in
its next process. A plan is approved once, for one plan, and going back to the more restrictive mode the user chose
never grants something they did not pick.

## 7. How `--permission-mode` combines with the above

Each mode was run on a fresh session with `--permission-prompt-tool stdio` and a host that denies everything, asking
for one Write of a new file and one Bash `mkdir` in the working folder. "prompt" means a `can_use_tool` request
reached the host.

| `--permission-mode` | `init` reports | Write a new file | Bash `mkdir` | Notes |
|---|---|---|---|---|
| (none) / `manual` | `default` | prompt | prompt | `manual` is reported as `default`; they behaved the same |
| `acceptEdits` | `acceptEdits` | allowed, no prompt | allowed, no prompt | File-system commands inside the working folder count as edits |
| `auto` | `auto` | allowed, no prompt | allowed, no prompt | The CLI's own classifier decides; nothing reached the host |
| `dontAsk` | `dontAsk` | denied, no prompt | denied, no prompt | `system`/`permission_denied` with `"decision_reason_type":"mode"`; the host never hears |
| `plan` | `plan` | — | — | The model only plans: read-only Bash (`echo`) ran, the plan went to a file under `~/.claude/plans/`, and the one prompt was `can_use_tool` for **`ExitPlanMode`**, with the plan text in `input.plan` |

Read-only commands (`echo`) ran without a prompt in every mode.

Put together: the mode decides first, and only what the mode leaves undecided becomes a prompt. `--permission-prompts`
then decides where that prompt goes: to the host (`host` plus `--permission-prompt-tool stdio`) or straight to a
denial (`none`). `dontAsk` behaves much like `none` but says "don't ask mode" to the model instead of "no approval
surface". A plan-mode chat needs a card for `ExitPlanMode` (approve the plan or not), which is a different card from a
tool permission.

Without `--setting-sources project` the user's own `defaultMode` applies (on the test machine, `auto`), so the
extension should pass `--permission-mode` explicitly rather than inherit it.

## 8. Windows: `.cmd` shims and a session open twice

**Spawn `claude.exe` directly.** The native installer puts `claude.exe` on the PATH (`~/.local/bin`), and spawning it
with no shell works; `spawn('claude', …)` finds it on the PATH by itself, because Node's PATH search on Windows tries
`.exe` (but never `.cmd`). An npm-style `claude.cmd` shim cannot be spawned without a shell: Node 24 throws `EINVAL`
synchronously from `spawn()` (the CVE-2024-27980 fix), so wrap the call in `try`. Running the shim through
`cmd.exe /d /s /c` (what `shell: true` does) works, but has two real problems:

- **cmd rewrites the arguments.** An `--append-system-prompt` containing `50%OS%50` reached Claude as
  `50Windows_NT50`. Quoting kept `&` safe, but `%VAR%` is expanded inside quotes. User text sent over stdin is not
  affected; any user text put on the command line is.
- **Killing it orphans Claude.** `child.kill()` killed `cmd.exe` and the `exit` event fired, but `claude.exe` kept
  running and finished the turn, still writing to the pipe and the log. Only a control-request interrupt (or killing
  the process tree) stops it.

So: resolve `claude.exe` (the configured path, then PATH lookup for `claude.exe`), spawn it without a shell, keep
user text on stdin, and if only a `.cmd` can be found, either resolve the `.exe` or `node … cli.js` it points at, or
refuse with a clear message.

**The same session open twice.** Two stream-json processes resumed the same session at once (one mid-turn, the other
asking a short question). Neither was refused, both kept the same session id, and **both appended to the same
`.jsonl`**. The second process read the first one's half-written turn, closed it with a synthetic
`"No response requested."` assistant record, and continued from there; the first process then wrote its answer
parented on the record before that. The file now holds two branches of the conversation interleaved, and the
extension's parser, reading it in file order, merged the two answers into one assistant entry.

An interactive terminal session was not driven in this trial, because it needs a real TTY. It writes the same log
through the same code path, so expect the same behaviour: no lock, no warning, interleaved branches. The CLI's
`--bg --resume` help text mentions starting a copy "when the session is already running", so some detection exists for
background sessions, but plain `-p --resume` did not use it.

## 9. Recommendation for the chat task (SA-25)

1. **One long-lived process per open chat**, spawned on the first message, kept for the life of the transcript view,
   with stdin closed when the view closes. Spawn `claude.exe` with `shell: false`, `cwd` set to the session's project
   folder, and:
   `-p --resume <id> --input-format stream-json --output-format stream-json --include-partial-messages --verbose
   --permission-prompt-tool stdio --permission-mode <explicit>`.
2. **Render live from stdout, keep the file as the record.** Stream `text_delta`s into a pending bubble, replace it
   with the `assistant` blocks as they land (grouped by `message.id`), and end the turn on `result`. Skip unknown
   event types. When the file watcher re-reads the `.jsonl`, de-duplicate by `uuid`.
3. **Cost per turn from `model_usage_since_last_result`**, not `total_cost_usd`.
4. **Stop button = control request `interrupt`.** Never kill the process for a stop; keep `kill()` for disposal only.
5. **Permission cards** answer `can_use_tool` with allow/deny, and a separate card for `ExitPlanMode`. Every request
   must be answered or the turn hangs, so closing the view while a card is open should deny it or interrupt.
   Use `--permission-prompts none` only for a "never ask" setting, and warn that it poisons the session (section 5).
6. **Let the user type during a turn**; the CLI queues it. Show the bubble optimistically.
7. **Guard against a second writer.** Before spawning, warn when the session's file was written in the last
   few seconds or a terminal for it is open, since two writers fork the log (section 8).
8. **Errors come in `result`.** Show `result.result` or `errors[]` when `is_error` is true, and log stderr.

## 10. Remote Control from a stream-json process

Finding for SA-76, tested on 2026-11-28 against the same `2.1.332`. Every run used a fresh throwaway folder, `haiku`,
`--setting-sources project` and `--permission-prompt-tool stdio`, through a small driver that redacted every URL and id
before printing, so no link was ever shown or opened. Remote Control was turned off at the end of every run, and the
last run on the one resumed throwaway session left its `bridge-session` record cleared. No real session was used.

**Short answer: yes.** The `/rc` slash command is refused in `-p` mode, but a `remote_control` control request on
stdin turns Remote Control on and off for the running process, on a new or a `--resume`d session, before the first turn
or between turns.

### What does not work

| Tried | Result |
|---|---|
| `/remote-control` (or `/rc`) sent as a user turn | Refused locally, no API call. A synthetic `assistant` message `"/remote-control isn't available in this environment."` with `"local_command_outcome":{"kind":"unavailable_headless"}`, then a `result` with that text and `num_turns: 0`. The log gets two `system`/`local_command` records |
| `--remote-control` on the command line with `-p` | Ignored silently. The help says it starts an *interactive* session; no `bridge_state` event appeared |
| `--settings '{"remoteControlAtStartup":true}'` with `-p` | Ignored silently, as above |
| `system`/`init` `slash_commands` | Lists no `remote-control` command in `-p` mode |

### The control request

```json
{"type":"control_request","request_id":"rc-1","request":{"subtype":"remote_control","enabled":true}}
```

The CLI's own SDK client sends the same request, with optional `name`, `reattach_session_id`, `keep_session_on_exit`
and `work_secret` fields (read from the CLI's bundled code; only `enabled` was tested). The stream, in order:

```json
{"type":"system","subtype":"bridge_state","state":"ready","uuid":"<uuid>","session_id":"<session-id>"}
{"type":"system","subtype":"background_tasks_changed","tasks":[],"uuid":"<uuid>","session_id":"<session-id>"}
{"type":"control_response","response":{"subtype":"success","request_id":"rc-1","response":{"session_url":"<redacted-url>","connect_url":"<redacted-url>","environment_id":"","bridge_epoch":1,"bridge_session_id":"cse_<id>"}}}
{"type":"system","subtype":"bridge_state","state":"connected","bridge_epoch":1,"uuid":"<uuid>","session_id":"<session-id>"}
```

So the process prints **two links, in the control response** (not as text): `session_url`, the claude.ai page for this
session, and `connect_url`. There is no pairing code. The reply came within about a second. `bridge_state` `connected`
can arrive after the `control_response`, and in one run it arrived after the next request had already been sent.

Turning it off:

```json
{"type":"control_request","request_id":"rc-2","request":{"subtype":"remote_control","enabled":false}}
```

```json
{"type":"control_response","response":{"subtype":"success","request_id":"rc-2"}}
```

No `bridge_state` event follows the off reply. Sending `enabled: false` when it is already off also answers `success`.

While it was on, a turn's stream also carried a `system`/`post_turn_summary` event (`status_category`, `status_detail`,
`needs_action`), which did not appear in turns without Remote Control. It is safe to skip.

### What it leaves in the session log

Enabling appends a record the transcript does not need, and disabling appends the same record with an empty id:

```json
{"type":"bridge-session","sessionId":"<session-id>","bridgeSessionId":"cse_<id>","lastSequenceNum":0,"ownerAccountUuid":"<uuid>","ownerOrganizationUuid":"<uuid>"}
{"type":"bridge-session","sessionId":"<session-id>","bridgeSessionId":"","lastSequenceNum":0}
```

A `data-flow-records` record also listed `RemoteControlLinked` and `RemoteControlInput` entries. The extension's parser
read the resulting file without errors and showed the same turns as before. The `bridge-session` record has no `uuid`
or `message`, so it is skipped like the other bookkeeping records in section 3.

### Process lifetime

- **Closing stdin with Remote Control on** let the process exit normally (code 0, under a second after the turn), but
  **no clearing `bridge-session` record was written**, so the log still names the bridge session.
- **The next `--resume` does not reconnect by itself.** A turn in a new process showed no `bridge_state` event.
- **Turning it on again in that new process reused the same `bridge_session_id`**, so the same remote session (and,
  presumably, the same links) comes back. An `enabled: false` then wrote the clearing record.

So "on" belongs to the process, like the `session` permission grants in section 6a. A chat that wants Remote Control to
survive a restart (End chat, a permission-mode change, an exit) has to send the request again in the new process.

### What was not tested

These need the remote side, which means opening the link, and that was out of scope:

- **A message typed on claude.ai or the phone while the extension is also sending.** Both reach the same process: the
  bridge is inside the process the extension spawned, not a second CLI, so there is one writer and the log does not
  fork the way section 8's two processes did. The CLI's inbound filter accepts `user`, `control_request` and
  `control_cancel_request` messages from the bridge. Expect a remote turn to queue like a typed one (section 1), and to
  show up on stdout as an ordinary turn; whether it carries `isReplay` or any marker of where it came from is unknown.
- **Permission prompts.** The bundled code registers hooks on every control request the CLI sends to the host
  (`setOnControlRequestSent`, `setOnControlRequestResolved`) and, when the host resolves one, sends the bridge a
  `control_cancel_request` for it. That reads as: a `can_use_tool` prompt goes to both the extension's card and the
  remote surface, the first answer wins, and the other side is told to drop its copy. If the remote side answers
  first, the extension most likely receives a `control_cancel_request` (`{"type":"control_cancel_request",
  "request_id":"…"}`) on stdout for the card it is showing. `src/claudeChat.ts` does not handle that type today, so a
  build must close the card on it, and must not answer a request that was cancelled.
- **The first-use confirmation.** The code has a path that refuses with "Remote Control asks for a one-time
  confirmation before it's first enabled, and this session can't show it. Run /remote-control from an interactive
  Claude Code session." It did not trigger here, likely because this account had already used Remote Control. A build
  must show the error text of a failed `control_response` (`subtype: "error"`) as it comes, since that is where this
  and the org-policy refusals ("Remote Control is turned off for your organization") would arrive.

### For the build

1. **On:** send `{"subtype":"remote_control","enabled":true}`, show `session_url` (with a copy button) from the
   reply, and show plainly that the session is reachable remotely. Treat `bridge_state` as status only.
2. **Off:** send `enabled: false` and clear the link. Send it before closing stdin too, so the log does not keep a
   stale `bridge-session` record.
3. **`/rc` and `/remote-control` typed in the box** should be caught by the extension and turned into the request, since
   sent as a turn they are refused.
4. **Restarts drop it.** Re-send on the next process if the user had it on, or show it as off.
5. **Handle `control_cancel_request`** by closing the matching permission card.
6. **Skip `system`/`post_turn_summary`** and the `bridge-session` log record, like any other unknown type.
