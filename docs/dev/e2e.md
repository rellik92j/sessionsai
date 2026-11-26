# End-to-end tests of the transcript view's chat

`npm test` checks logic: `activation.test.js` drives the bundle against a fake VS Code API, but nothing there opens VS
Code or clicks in a webview. `npm run test:e2e` does: it starts a real VS Code with this extension, opens transcripts
from the sidebar, chats with a stand-in `claude`, and clicks the buttons a person would (Send, Stop, End chat, Allow,
Deny, the tab's close button, the sidebar's right-click menu and the modal it opens).

It is local and opt-in. It is not part of `npm test` or of the `test` CI check, and it never calls a model.

## Running it

```
npm run test:e2e                      # every scenario, about three minutes after the first run
npm run test:e2e -- stop permission   # only scenarios whose name contains one of the words
```

It bundles `dist/extension.js` first, so it tests the working tree as it is. A VS Code window opens on the desktop
while it runs; leave it alone until it closes. The first run downloads VS Code (stable) into `.vscode-test/`,
about 1 GB on disk once unpacked; later runs reuse it. `E2E_VSCODE_VERSION=1.148.0` pins a version.

The output ends with one line per scenario and a count, and the command exits 1 if any scenario failed. For each
failure, `.e2e-out/` holds `<scenario>.png`, a screenshot of the window at the moment it failed (an agent can Read
it), and `<scenario>.events.json`, what the stand-in recorded. `E2E_KEEP=1` keeps the sandbox folder (settings,
session logs, the events file) and prints its path.

Windows is where it has been run. The harness has a POSIX terminal stub too, but has not been run on macOS or Linux.

## What keeps it isolated

- **VS Code** is the copy in `.vscode-test/`, started with a throwaway `--user-data-dir` and `--extensions-dir` in a
  temp folder (`sessionsai-e2e-*`), so the user's own VS Code, settings and extensions are never touched. Environment
  variables starting `VSCODE_` or `ELECTRON_` are dropped, so it cannot attach to a VS Code that is already running.
- **Sessions** come from a temp `CLAUDE_CONFIG_DIR` holding one synthetic session per scenario. The settings point
  `claudeSessions.projectsDir`, `copilotDir` and `vscodeUserDir` into the sandbox and show only Claude Code sessions,
  so the real `~/.claude`, `~/.copilot` and VS Code chat folders are never read.
- **The chat's `claude`** is `test/e2e/stand-in-claude.mjs`. The extension runs it instead of `claude.exe` only when
  the environment variable `SESSIONSAI_E2E_CLAUDE` names it (see `chatLaunch` and `spawnChat` in
  `src/transcriptPanel.ts`); it runs on VS Code's own Node (`ELECTRON_RUN_AS_NODE`). Nobody else sets that variable,
  and there is no setting for it.
- **Resume's terminal** runs `claudeSessions.claudeCommand`, which the sandbox sets to a stub script that only appends
  a `terminal-resume` line to the events file.
- **The Claude Code extension** is `test/e2e/claude-code-stub/`, loaded as a second `--extensionDevelopmentPath` with
  the id `anthropic.claude-code`, so SessionsAI offers Open in Claude Code Chat (sidebar menu and the transcript's
  "Open in chat" button). Its `claude-vscode.editor.open` command only appends a `claude-code-open` line (with the
  session id) to the events file; it opens nothing.
- `claudeSessions.closeTranscriptOnResume` is off, so the transcript tab stays open after its Resume or Open in chat
  button, and a scenario can check what is left in it.
- `window.dialogStyle`, `window.titleBarStyle` and `window.menuStyle` are `custom`, so the modals and the sidebar's
  context menu are drawn in the page, where Playwright can see and click them.

## The stand-in claude

It speaks the stream-json protocol of `claude -p --resume <id> --input-format stream-json --output-format stream-json`
([claude-stream-json.md](claude-stream-json.md)) with real record shapes and synthetic text, and it appends to the
session's log the records Claude Code would, with the same `uuid`s as its stdout events, so the transcript view
reads the turn from the log as it does for the real CLI. It is deterministic and free.

Each user message plays a script, picked by a word in it:

| Message contains | What happens |
|---|---|
| `permission` | A Bash call, then a `can_use_tool` control request. It waits for the answer: Allow logs a tool result and "The command ran…"; Deny logs the error result with the extension's deny message and "…carrying on without it." With `slowly` in the message as well, 12 more lines follow the answer, one every 450 ms, so a scenario can act while that reply runs. |
| anything else | A slow reply: 12 lines, one every 450 ms, streamed as `text_delta`s. |

An `interrupt` control request stops either script where it is: the partial text and a `[Request interrupted by
user]` record go to the log, and the turn ends with the interrupted `result`. Closing stdin does not interrupt; the
running turn finishes and then the process exits, as the real CLI does.

It writes what happened to it to the events file (`SESSIONSAI_E2E_EVENTS`), one JSON line each: `start`,
`turn-start`, `permission-asked`, `permission-answered` (with `behavior` and `message`), `interrupt`, `turn-end`
(`how`: `completed` or `interrupted`), `stdin-end`, `exit`. The terminal stub adds `terminal-resume` and the Claude
Code stub `claude-code-open`. Scenarios assert on these, because they show what the process actually saw, which the
page alone cannot.

## The scenarios

`test/e2e/scenarios.mjs`, each on its own session:

| Name | What it checks |
|---|---|
| `stream` | Open a transcript from the sidebar, pick Chat here in the ⌄ menu, send; the reply streams into the pending part (part of it shows before the rest), then lands in the logged conversation and the chat bar says Ready. |
| `end-chat-mid-reply` | End chat during the reply: the bar says Claude is finishing, the reply is not interrupted and ends up whole in the log, then the process exits. |
| `stop` | Stop during the reply: the stand-in gets an interrupt, the turn ends interrupted, the bar says "Last turn stopped", and the process stays up. |
| `permission-allow` | A permission card shows with Allow and Deny and the bar waits for an answer; Allow reaches the stand-in as `allow` and the reply carries on. |
| `permission-deny` | Deny reaches the stand-in as `deny` with the extension's deny message, and the reply carries on without the tool. |
| `close-tab-mid-reply` | Closing the transcript tab during the reply lets it finish (no interrupt, whole reply in the log), then stdin closes and the process exits. |
| `resume-while-replying-wait` | Right-click the session in the sidebar, Resume Session: the "still replying" modal shows; Wait for the Reply lets the reply finish, the process exits, and only then does the terminal start. |
| `resume-while-replying-stop` | The same modal; Stop It Now interrupts the reply, the process exits, then the terminal starts. |
| `waiting-message-enter` | End chat mid-reply, then send with Enter: the box empties, the message shows below the reply with the "waits for the previous reply to finish" pill, and the bar says it starts a new chat after it. A second message makes it "Your 2 messages…". Once the reply ends and the process exits, one new chat gets both, in order, and the pills go. |
| `waiting-message-queue-button` | While the ended chat finishes, the Send button reads Queue; sending with it waits and goes to the new chat as above. |
| `waiting-message-stop` | Stop on the finishing reply with a message waiting: the reply is interrupted and the message goes to a new chat at once. |
| `waiting-message-below-denied-card` | End chat at an open permission card, then send: the card shows as denied with no Allow/Deny buttons, the waiting message sits below it, and it goes to a new chat after the reply. |
| `waiting-message-tab-closed` | Close the tab with a message waiting: the reply finishes, and no new chat starts. |
| `waiting-message-{sidebar,topbar}-{resume,open-chat}-{wait,stop}` | With a message waiting, Resume Session or Open in Claude Code Chat, from the sidebar's right-click menu or the transcript's top bar, then Wait for the Reply or Stop It Now in the modal: the message goes back to the box, no new chat starts, and the terminal (or the Claude Code chat stub) opens only after the process has exited. Eight scenarios. |
| `queued-not-waiting` | A second message in a chat that was not ended shows the usual "queued" pill, not the waiting one, and goes to the same process. |

## Writing a scenario

Add an entry to `SCENARIOS` in `test/e2e/scenarios.mjs`:

```js
{
  name: 'my-scenario',              // what `npm run test:e2e -- my` matches
  prompt: 'E2E my scenario',        // the session's first prompt, which is its title in the sidebar and the tab
  async run(ctx) {                  // ctx: { page, s (the sandbox), id (session id), title }
    const frame = await openTranscript(ctx);
    await chatHere(frame);
    await send(frame, 'Tell me twelve lines.');
    await midReply(ctx);
    await click(ctx, '#chat-stop');
    await waitEvent(ctx.s, ctx.id, 'interrupt');
  },
}
```

Throw to fail; `assert(ok, message)` is there for that. Things to know:

- **Webviews are frames.** `frameWith(page, selector)` finds the webview frame whose document has `selector`, and
  `transcript(ctx)` the session's transcript. The transcript page is rebuilt into a new frame when its shape
  changes (a tool call does it), so look the frame up again for each step, as `liveText`, `chatState`, `logged` and
  `click` do, rather than keeping one across a reply.
- **The workbench is `page`.** Tabs, modals (`.monaco-dialog-box`), context menus (`.monaco-menu`) and the activity
  bar are in the main page.
- **Wait, do not sleep.** `waitFor(what, check, timeout)` polls; `waitEvent(s, id, name, match)` waits for the
  stand-in to record something. Events carry `i`, their position in the file, to order events from different
  processes (the chat and the terminal stub).
- **A new behaviour of the stand-in** goes in `stand-in-claude.mjs` as another script picked by a word in the message.
  Use real record shapes (from `docs/dev/claude-stream-json.md` or `test/fixtures/claude-stream/`) and synthetic text,
  never lines from a real log.

## Running it on a PR branch (reviewers)

In the PR's worktree:

```
git fetch origin
git switch --detach origin/<branch>
npm ci
npm run test:e2e
```

`npm ci` is needed when the branch changed `package-lock.json`; the VS Code download in `.vscode-test/` is per
worktree, so the first run in a new worktree downloads it. Report the pass count from the last line. For a failure,
Read `.e2e-out/<scenario>.png` and `.e2e-out/<scenario>.events.json`, and say which step timed out (the message
names it). A PR that changes the chat's behaviour on purpose may need its scenario changed in the same PR.
