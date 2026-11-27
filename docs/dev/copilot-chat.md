# Chat here with a GitHub Copilot CLI session

What `src/copilotChat.ts` relies on, checked against GitHub Copilot CLI 1.0.93 on Windows (native `copilot.exe` from
winget) on 2026-11-26, with throwaway sessions in a scratch folder.

## One process per message

Copilot CLI has no long-lived streaming input like Claude Code's stream-json mode, so each message runs:

```
copilot --resume=<session id> --output-format json --stream on [allowances]
```

in the session's folder, with the message written to its stdin and stdin then closed.

- **Piped stdin is the prompt.** With no `-p`, Copilot CLI reads the prompt from a piped stdin and runs it
  non-interactively, as `-p` would. The message never reaches a command line, so quotes, newlines, `%`, `$`,
  backticks, `^` and `|` arrive as typed (checked: the session log's `user.message` content was byte for byte the
  message), there is no Windows command-line length limit, and an npm `.cmd` shim run through cmd.exe has nothing to
  rewrite. (`-p <text>` works too when spawned without a shell, but not through a shim.)
- **Same session, same log.** Each run with `--resume=<id>` appends to `~/.copilot/session-state/<id>/events.jsonl`:
  a `session.resume`, the turn's records, and a `session.shutdown` at exit. Three runs in a row left one log with all
  three prompts, and the final `result` line names the same `sessionId` each time.
- **`=` forms.** `--resume=<id>` keeps the value in one argument; `--prompt=-x` showed values starting with `-` are
  accepted in that form.
- An unknown session id exits with code 1 and prints `Error: No session, task, or name matched '<id>'.` as plain text,
  not JSON.

## The JSON output

`--output-format json` writes one JSON object per line: the session's own event records (the shapes `events.jsonl`
holds, with the **same `id`** for every record that is also logged) plus ephemeral ones marked `"ephemeral": true`
that the log does not keep. `--stream on` (the default) adds the deltas. What the chat uses:

| Record | Use |
|---|---|
| `user.message` | The message was taken; its `id` is the pending bubble's, so it leaves once the log has it. |
| `assistant.message_start`, `assistant.message_delta` (ephemeral) | The reply as it streams, by `data.messageId`. |
| `assistant.reasoning_delta` (ephemeral), `assistant.reasoning` | "Thinking…" while it streams. |
| `assistant.tool_call_delta` (ephemeral) | A tool call while its input streams, by `toolCallId`. |
| `assistant.message` | The finished text and `toolRequests`; its `id` is in the log. `arguments` is an object, or a string for a custom tool such as `apply_patch`. |
| `tool.execution_start`, `tool.execution_complete` | The call's state: `success`, or `error.code` `"denied"` when it needed approval. |
| `session.error` | Shown as an error. |
| `result` | Last line: `sessionId`, `exitCode`, and usage totals that are running totals for the session, not this turn. |

Everything else (`session.mcp_*`, `session.skills_loaded`, `model.call_*`, `session.usage_checkpoint`,
`assistant.idle`, ...) is skipped, as is any type the chat does not know and any line that is not JSON.

## Permissions

In this mode Copilot CLI cannot ask. A tool call no rule allows is declined at once: the log records
`permission.requested`, then `permission.completed` with `"kind": "denied-no-approval-rule-and-could-not-request-from-user"`
(neither is on stdout), and stdout has `tool.execution_complete` with `success: false` and `error.code: "denied"`. The
model carries on without it.

With no allowances, reading a file in the session's folder (`view`) ran; creating a file (`apply_patch`) and a shell
command (`powershell`) were declined. With `--allow-tool=write` the file edit ran and the shell command was still
declined. So the picker maps:

| Mode | Arguments | What runs |
|---|---|---|
| Read only (default) | none | reading and searching in the session's folder |
| Allow edits | `--allow-tool=write` | file edits as well |
| Allow all tools | `--allow-all-tools` | shell commands too; paths are still limited to the folder (no `--allow-all-paths`) |

## Stop

Stop kills the turn's process tree (`src/copilotProcess.ts`). On Windows the chat runs `taskkill /pid <pid> /T /F`,
so a shim's `copilot` and any command it was running go too. On macOS and Linux each turn starts detached, as the
leader of its own process group, which the commands copilot starts join. Stop sends SIGTERM to that group, and SIGKILL
3 s later if `copilot` itself is still running. The SIGKILL is skipped once `copilot` has exited, because its pid (the
group's id) may then belong to another process. A detached turn no longer gets signals sent to the extension host's
group. If the extension host dies without stopping a turn, the turn's output pipe closes, and copilot is expected to end
the next time it writes to it. That case has not been tested.

`test/copilotProcess.test.js` checks this with a stand-in turn that starts a command, on the `process-tree` CI job's
Linux and macOS runners. It has not been checked with the real Copilot CLI on either platform.

A run killed mid-reply left the log ending at `assistant.turn_start` with no `turn_end`; the next `--resume` of the
session worked normally.
