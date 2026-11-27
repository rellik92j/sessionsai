# End-to-end tests of the transcript view's chat

`npm test` checks logic: `activation.test.js` drives the bundle against a fake VS Code API, but nothing there opens VS
Code or clicks in a webview. `npm run test:e2e` does: it starts a real VS Code with this extension, opens transcripts
from the sidebar, chats with a stand-in `claude`, and clicks the buttons a person would (Send, Stop, End chat, Allow,
Deny, the tab's close button, the sidebar's right-click menu and the modal it opens).

It is local and opt-in. It is not part of `npm test` or of the `test` CI check, and it never calls a model.

## Running it

```
npm run test:e2e                      # every area, about three minutes after the first run
npm run test:e2e -- --area chat       # only the chat area; --area chat,sidebar for several
npm run test:e2e -- --only stream     # one scenario, by its exact name (comma-separate for several)
npm run test:e2e -- stop permission   # only scenarios whose name contains one of the words
```

An unknown area or scenario name exits 2 and lists the valid ones. The flags combine: `--area chat --only stop` runs
`stop` if it is in chat.

### When to run what

The e2e suite is for UI changes, and a PR runs only the area it changes: a change to the transcript chat runs
`--area chat`, a sidebar change runs `--area sidebar`. The full suite (no flag) runs before each release. It is not in
CI, and a change with no UI (parsers, data, docs, scripts) runs none. Give the count from the last line in the PR body.

It bundles `dist/extension.js` first, so it tests the working tree as it is. A VS Code window opens on the desktop
while it runs; leave it alone until it closes. The first run downloads VS Code (stable), about 1 GB on disk once
unpacked, into one folder shared by every checkout and worktree; later runs reuse it. `E2E_VSCODE_VERSION=1.148.0`
pins a version.

The shared folder is `%LOCALAPPDATA%\sessionsai-e2e\vscode` on Windows and `~/.cache/sessionsai-e2e/vscode`
elsewhere. Set `SESSIONSAI_E2E_CACHE` to use another folder. To clear it, delete that folder (nothing is running
while no e2e run is open); the next run downloads again. It is kept outside the checkout because its deep paths break
`git worktree remove` on Windows. Runs started at the same time take a `.lock` folder in it, so only one downloads;
a lock not refreshed for a minute is taken over. Old checkouts may still have an unused `.vscode-test/`, which is
safe to delete.

The output has one line per scenario (`ok   chat/stream`), then one count per area, and ends with
`Total: N passed, M failed`. The command exits 1 if any scenario failed. For each
failure, `.e2e-out/` holds `<scenario>.png`, a screenshot of the window at the moment it failed (an agent can Read
it), and `<scenario>.events.json`, what the stand-in recorded. `E2E_KEEP=1` keeps the sandbox folder (settings,
session logs, the events file) and prints its path.

Windows is where it has been run. The harness has a POSIX terminal stub too, but has not been run on macOS or Linux.

## What keeps it isolated

- **VS Code** is the copy in the shared cache folder above, started with a throwaway `--user-data-dir` and `--extensions-dir` in a
  temp folder (`sessionsai-e2e-*`), so the user's own VS Code, settings and extensions are never touched. Environment
  variables starting `VSCODE_` or `ELECTRON_` are dropped, so it cannot attach to a VS Code that is already running.
- **Sessions** come from a temp `CLAUDE_CONFIG_DIR` holding one synthetic session per scenario. The settings point
  `claudeSessions.projectsDir`, `copilotDir` and `vscodeUserDir` into the sandbox, so the real `~/.claude`, `~/.copilot`
  and VS Code chat folders are never read.
- **`claudeSessions.sources`**, which tools' sessions the sidebar starts on, is set once for the whole run by
  `makeSandbox`: `["claude", "copilot-cli"]` when any chosen scenario has `source: 'copilot-cli'` (the chat area's
  `copilot-` scenarios), otherwise `["claude"]`. So it changes with the areas chosen, and the source chips may be left
  otherwise by an earlier scenario. A scenario that depends on which tools show sets the chips itself and puts them back
  afterwards, as `sidebar`'s `withClaudeOnly` and `other-tools`' `withEveryTool` do; it never relies on the starting
  value.
- **The chat's `claude`** is `test/e2e/stand-in-claude.mjs`. The extension runs it instead of `claude.exe` only when
  the environment variable `SESSIONSAI_E2E_CLAUDE` names it (see `chatLaunch` and `spawnChat` in
  `src/transcriptPanel.ts`); it runs on VS Code's own Node (`ELECTRON_RUN_AS_NODE`). Nobody else sets that variable,
  and there is no setting for it.
- **The chat's `copilot`**, for a GitHub Copilot CLI session, is `test/e2e/stand-in-copilot.mjs`, run the same way
  when `SESSIONSAI_E2E_COPILOT` names it (see `copilotLaunch` and `spawnCopilot`). Copilot CLI sessions are written to
  the sandbox's `COPILOT_HOME` (`copilotDir`), and the `sources` setting lists them only when a scenario has one.
- **The terminals** Resume, Continue, Send and New Claude Code Session open run `claudeSessions.claudeCommand` (or
  `copilotCommand` for a Copilot CLI session), which the sandbox sets to a stub (`terminal-stub.mjs`, run by a copy of
  Node's own executable, since a `.cmd` file cannot take a multi-line argument). It appends a `terminal-resume` line to
  the events file with `argv` (each argument, so a multi-line handoff arrives whole), `args` (the same joined by
  spaces) and `cwd` (the folder it started in), and does nothing else. The sandbox path must contain no space.
- **The Claude Code extension** is `test/e2e/claude-code-stub/`, loaded as a second `--extensionDevelopmentPath` with
  the id `anthropic.claude-code`, so SessionsAI offers Open in Claude Code Chat (sidebar menu and the transcript's
  "Open in chat" button). Its `claude-vscode.editor.open` command only appends a `claude-code-open` line (with the
  session id) to the events file; it opens nothing.
- `claudeSessions.closeTranscriptOnResume` is off, so the transcript tab stays open after its Resume or Open in chat
  button, and a scenario can check what is left in it.
- `window.dialogStyle`, `window.titleBarStyle` and `window.menuStyle` are `custom`, so the modals and the sidebar's
  context menu are drawn in the page, where Playwright can see and click them.

## Between scenarios

All scenarios share one VS Code window, so before each one the runner calls `resetWorkbench` (in `harness.mjs`): it
presses Escape to close any picker or menu left open, then closes every editor and editor group
(`workbench.action.closeAllGroups`, bound in the sandbox's `keybindings.json` to Ctrl+Alt+Shift+F12) and waits until
the editor area is one empty group. The sandbox sets `terminal.integrated.confirmOnKill` to `never` so closing the
terminals asks nothing, and lists the command in `terminal.integrated.commandsToSkipShell` so the key works while a
terminal has focus.

Before the key, the reset blurs whatever has focus, so the key is pressed in the workbench rather than in a webview. A
key pressed in a transcript closes the transcript's own webview while the key is still down. That left the window
with focus nowhere (`document.hasFocus()` false), and once a scenario hung in the reset until its 90 s ran out. After
the editors close, a window that still has no focus (closing a terminal can do it) gets a click on the empty editor
area. The reset has its own 20 s limit, and a reset that runs over fails its scenario with "the reset before the
scenario took over 20s".

The reason: Resume, Continue and Send open their terminal beside the active editor, so each one adds an editor group.
Over a full run, the dozens of them squeezed the side bar to its narrowest. There a card's hover buttons are wider than the
view, so Playwright scrolled the card under the sticky group header to click one, and `continue-card-button` failed in
every full run while passing in its own area. A scenario therefore starts with no tabs open. One that needs a tab opens it
itself. A transcript closed by the reset while its chat is still replying lets the reply finish, as closing the tab does.
The reset leaves the sidebar's own state (grouping, chips, search box) alone. Scenarios that change that state still put
it back themselves.

One side effect to know when writing a scenario: with no preview tab left to reuse, the first transcript a scenario
opens from the sidebar is a new tab, and a new webview tab does not take the keyboard. The workbench's focus is left on
nothing. Without the reset, a click usually only switched the shared preview tab to another session, so the keyboard
stayed in that webview. Typing into the page still works, because Playwright focuses an input before it types. A key
pressed on the page itself (`frame.press('body', 'F3')`) does not, because `body` cannot take focus, so the key goes to
the workbench and the page never sees it. A scenario that presses keys in a transcript clicks inside the page first, as
`transcript-search-highlights` does before F3.

Opening a new tab also takes longer than switching the preview tab, so what a click or double-click sets off lands
later. A double-click is two clicks and then the double-click: the first click opens the preview tab, and the
double-click then turns it into a tab of its own and brings it forward, which closes a menu or palette opened in the
meantime. A scenario that double-clicks a card waits until the page has no Keep open button before it goes on, as
`overview-opens` does before View > Command Palette.

## The stand-in claude

It speaks the stream-json protocol of `claude -p --resume <id> --input-format stream-json --output-format stream-json`
([claude-stream-json.md](claude-stream-json.md)) with real record shapes and synthetic text, and it appends to the
session's log the records Claude Code would, with the same `uuid`s as its stdout events, so the transcript view
reads the turn from the log as it does for the real CLI. It is deterministic and free.

Each user message plays a script, picked by a word in it:

| Message contains | What happens |
|---|---|
| `permission` | A Bash call, then a `can_use_tool` control request. It waits for the answer: Allow logs a tool result and "The command ran…"; Deny logs the error result with the extension's deny message and "…carrying on without it." With `slowly` in the message as well, 12 more lines follow the answer, one every 450 ms, so a scenario can act while that reply runs. With `session` as well, the request offers Claude Code's suggestions (a `Bash(echo *)` rule and Accept edits), as Allow for this session needs. What Allow for this session grants holds for the rest of the process: a later `permission` turn runs without asking (`permission-skipped`), and the next `init` reports the new mode. A grant whose `destination` is not `session` is recorded as `settings-write`, which a scenario asserts never happens. |
| anything else | A slow reply: 12 lines, one every 450 ms, streamed as `text_delta`s. |

With `lingering` in a message (either script), the process stays up for 2.5 s after its last turn has ended and its stdin has closed, before it exits. That holds open the gap where the reply is over but the process is still there. It must stay under the extension's 3 s grace, after which the extension kills the process.

An `interrupt` control request stops either script where it is: the partial text and a `[Request interrupted by
user]` record go to the log, and the turn ends with the interrupted `result`. Closing stdin does not interrupt; the
running turn finishes and then the process exits, as the real CLI does.

It writes what happened to it to the events file (`SESSIONSAI_E2E_EVENTS`), one JSON line each: `start`,
`turn-start`, `permission-asked`, `permission-answered` (with `behavior`, `message` and `updatedPermissions`),
`permission-skipped`, `settings-write`, `interrupt`, `turn-end`
(`how`: `completed` or `interrupted`), `stdin-end`, `exit`. The terminal stub adds `terminal-resume` and the Claude
Code stub `claude-code-open`. Scenarios assert on these, because they show what the process actually saw, which the
page alone cannot.

## The stand-in copilot

Copilot CLI runs one process per message (`copilot --resume=<id> --output-format json --stream on`, the message on
stdin), so the stand-in plays one turn and exits. It writes Copilot CLI's JSON lines to stdout and appends the same
records, with the same `id`s, to the session's `events.jsonl` (shapes from `test/fixtures/copilot-stream/`, synthetic
text). Every message streams the same 12-line reply as the stand-in claude; one containing the word `edit` first makes
an `apply_patch` call, which runs when the arguments allow writes (`--allow-tool=write` or `--allow-all-tools`) and is
declined otherwise, as Copilot CLI declines what it cannot ask about.

Its events: `start` (with `args`), `turn-start` (`text`: the message exactly as it came on stdin), `tool` (`allowed`),
`turn-end`, `exit`. Stop kills the process, so a stopped turn records neither `turn-end` nor `exit`; scenarios check
that its `pid` is gone instead.

## Areas

Scenarios are grouped by what they exercise, one module per area in `test/e2e/scenarios/`: `chat`, `transcript`,
`sidebar`, `resume`, `overview` and `other-tools`. The runner finds areas by file name, so an
area's name is its file name and no list needs editing. Two people adding scenarios to different areas never touch the
same file. Shared steps (`openTranscript`, `chatHere`, `send`, `click`, `sidebarMenu`, `modal`, `assert`, `waitFor`,
`waitEvent`, ...) live in `harness.mjs`; a helper only one area uses stays in that area's module.

An area module exports `{ name, scenarios, sessions? }` as its default. Each scenario's `prompt` creates its own
synthetic session. An area that needs more sessions (a project with several, a log with a particular shape) lists them
in `sessions: [{ key, prompt }]`; they are created for the area alone, and a scenario reads them from
`ctx.fixtures[key]` as `{ id, title }`. To add an area, create `test/e2e/scenarios/<area>.mjs`:

```js
import { assert, openTranscript } from '../harness.mjs';

export default {
  name: 'sidebar', // must equal the file name
  sessions: [{ key: 'second', prompt: 'E2E sidebar, a second session' }], // optional
  scenarios: [{ name: 'sidebar-opens', prompt: 'E2E sidebar opens', async run(ctx) { /* ... */ } }],
};
```

A scenario (or an area session) that needs a log of its own shape gives `log: ({ id, cwd }) => jsonlText`, and
`files: ({ id, cwd }) => ({ '<path relative to the project folder>': text })` for files beside it, such as a subagent's
log. The sandbox writes them before VS Code starts. `transcript.mjs` builds its logs with a small `Log` class and keeps
each one by session id, so a scenario can append records to the log of an open session.

An area that needs sessions in several project folders, or another tool's log, exports `seed(s)`, which the runner
calls with the sandbox right after it is made and before VS Code starts, to write them. Use `log` and `files` for a
session in the default project folder whose log has a particular shape; use `seed(s)` for anything beyond that (the
`sidebar` area seeds two projects and a Copilot CLI session). Seeded sessions show beside every other area's, so the
`sidebar` scenarios find theirs by id and ignore every other card, those that count them first set the source chips to
Claude Code alone (see `claudeSessions.sources` above), and a scenario that changes shared state (grouping,
filters, the search box, tabs) puts it back, so the next one starts clean.

Scenario names stay unique across areas, since `--only` and the failure screenshots use them. Session ids are numbered
over every area, so a scenario's session does not change with the areas chosen.

## The scenarios

Area `chat`, `test/e2e/scenarios/chat.mjs`, each on its own session (a Claude Code session, or a Copilot CLI one for
the `copilot-` scenarios, which set `source: 'copilot-cli'`):

| Name | What it checks |
|---|---|
| `stream` | Open a transcript from the sidebar, pick Chat here in the ⌄ menu, send; the reply streams into the pending part (part of it shows before the rest), then lands in the logged conversation and the chat bar says Ready. |
| `end-chat-mid-reply` | End chat during the reply: the bar says Claude is finishing, the reply is not interrupted and ends up whole in the log, then the process exits. |
| `stop` | Stop during the reply: the stand-in gets an interrupt, the turn ends interrupted, the bar says "Last turn stopped", and the process stays up. |
| `permission-allow` | A permission card shows with Allow and Deny and the bar waits for an answer; Allow reaches the stand-in as `allow` and the reply carries on. |
| `permission-deny` | Deny reaches the stand-in as `deny` with the extension's deny message, and the reply carries on without the tool. |
| `permission-allow-for-session` | A card with suggestions offers Allow for this session and says what it grants; the stand-in gets the grants with `destination: "session"` only, the picker follows to Accept edits, and a second turn runs the command without asking or a restart. After End chat the picker is back on Ask me, and the next chat starts with `--permission-mode default`. |
| `close-tab-mid-reply` | Closing the transcript tab during the reply lets it finish (no interrupt, whole reply in the log), then stdin closes and the process exits. |
| `resume-while-replying-wait` | Right-click the session in the sidebar, Resume Session: the "still replying" modal shows; Wait for the Reply lets the reply finish, the process exits, and only then does the terminal start. |
| `resume-while-replying-stop` | The same modal; Stop It Now interrupts the reply, the process exits, then the terminal starts. |
| `waiting-message-enter` | End chat mid-reply, then send with Enter: the box empties, the message shows below the reply (checked by DOM order) with the "waits for the previous reply to finish" pill, and the bar says it starts a new chat after it. A second message makes it "Your 2 messages…". Once the reply ends and the process exits, one new chat gets both, in order, and the pills go. |
| `waiting-message-queue-button` | While the ended chat finishes, the Send button reads Queue; sending with it waits and goes to the new chat as above. |
| `waiting-message-stop` | Stop on the finishing reply with a message waiting: the reply is interrupted and the message goes to a new chat at once: its turn starts under 2.5 s after Stop, where waiting for the rest of the reply (about 4 s) would take longer. |
| `waiting-message-after-reply-before-exit` | The stand-in lingers after its reply ends. In that gap the bar has stopped saying "finishing"; a message sent then shows as waiting, the bar says "Your message starts a new chat once the ended one has stopped…", the Send button reads Queue, and the message goes to a new chat once the process has exited. |
| `waiting-message-below-denied-card` | End chat at an open permission card, then send: the card shows as denied with no Allow/Deny buttons, the waiting message sits below it, and it goes to a new chat after the reply. |
| `waiting-message-tab-closed` | Close the tab with a message waiting: the reply finishes, and no new chat starts. |
| `waiting-message-{sidebar,topbar}-{resume,open-chat}-{wait,stop}` | With a message waiting, Resume Session or Open in Claude Code Chat, from the sidebar's right-click menu or the transcript's top bar, then Wait for the Reply or Stop It Now in the modal: the message goes back to the box, no new chat starts, and the terminal (or the Claude Code chat stub) opens only after the process has exited. Eight scenarios. |
| `queued-not-waiting` | A second message in a chat that was not ended shows the usual "queued" pill, not the waiting one, and goes to the same process. |
| `live-indicator` | The session is open in "a terminal" (a synthetic `<pid>.json` in the sandbox's `CLAUDE_CONFIG_DIR/sessions`, under the runner's own pid, and a background subagent and shell appended to its log): the sidebar card says "Live in a terminal · idle", and the transcript's notice above the message box says so and lists both. A task notification in the log takes the subagent off the list; deleting the registry file (the process exited) takes the notice and the card's tag away. |
| `live-sidebar-resume` | The same live session: Resume Session and Open in Claude Code Chat from the sidebar's right-click menu each show the modal that names the subagent and the shell; Cancel opens nothing. |
| `live-topbar-resume` | The same from the transcript's top bar (Open in chat, Resume), then Resume Anyway does start the terminal. |
| `live-chat-here` | Chat here on the live session: the modal shows, Cancel starts no chat process, and the message stays in the box. |
| `copilot-stream` | A Copilot CLI session: Chat here starts `--resume=<id> --output-format json --stream on` with no allowances, the reply streams in (the bar says Copilot is working), lands in the logged conversation, and the bar shows the last turn. |
| `copilot-second-message` | A second message is a new process resuming the same session id, and the session log has both prompts. |
| `copilot-stop` | Stop kills the turn's process (its pid is gone, no `turn-end`), the bar says "Last turn stopped", the reply never finishes in the log, and the next message starts a new turn. |
| `copilot-message-intact` | A message with quotes, a newline, `%`, `$`, backticks, `^`, a pipe and `<b>` reaches the stand-in's stdin and the log exactly as typed, and none of it is on the command line. |
| `copilot-modes` | The picker offers Read only (the default), Allow edits and Allow all tools; Allow edits passes `--allow-tool=write` and the edit runs; Read only passes nothing, the edit is declined, and the tab notes that Allow edits would let it run. |
| `copilot-resume-while-replying` | Resume Session from the sidebar during a Copilot reply: the "Copilot is still replying" modal names two GitHub Copilot CLI processes; Stop It Now kills the turn's process, and then the terminal starts. |
| `copilot-terminal-guard` | Resume Session from the sidebar opens the terminal; then Chat here refuses with a warning naming two GitHub Copilot CLI processes, starts nothing, and the message stays in the box. |
| `copilot-shell-id-refused` | A Copilot CLI session whose folder name, and so its id, has a `&` (written by the area's `seed`; Windows allows `&` in a folder name, not `"` or `\|`): Resume Session and Copy Resume Command from the sidebar, the transcript's Resume, and Send to this session in GitHub Copilot CLI each show the refusal and start no terminal; Chat here shows it in the tab, starts no stand-in, and the message stays in the box. |

Area `transcript`, `test/e2e/scenarios/transcript.mjs`, reading a session as a chat, each on a synthetic log built for it:

| Name | What it checks |
|---|---|
| `transcript-tool-rows` | The tool group says "3 tool calls · 1 failed"; rows start closed, show a check or the failure mark; opening an edit shows its diff (removed and added sides), a command its input and output, a failed one its error; a click closes a row again. |
| `transcript-hide-tool-calls` | The Tool calls switch hides every tool row, keeps the replies, and turns both the hero and the top bar switch off; it is put back at the end. |
| `transcript-jump-to-latest` | A transcript opens at its bottom with no jump button; scrolled up, the button shows, and clicking it goes back to the bottom. |
| `transcript-mid-turn-and-session-messages` | A prompt logged as a queued command shows with the "sent mid-turn" pill (a typed one does not); another session's message is a card with its sender, "session message" pill and text. |
| `transcript-subagent-run` | A subagent block in the session has Open run; it opens the run's own log with no message box and a Back to session button, which returns to the session. |
| `transcript-search-highlights` | Searching in the sidebar and opening the session marks every match in message text (not in a tool call), starts at the first ("1 of 3", in view), F3 and Shift+F3 move and wrap, Escape clears. |
| `transcript-details-panel` | The panel's sections count and list changed files (with New), to-dos, skills and prompts; a section folds and opens; a folded one (Web) opens; clicking a prompt scrolls to it and flashes it. |
| `transcript-prompt-cost` | Each prompt shows `$0.10 · 2m` style cost and duration beside it, and the details panel's prompts show the same figures. |
| `transcript-live-update` | Records appended to an open session's log appear in the tab in place (the page is not rebuilt, the reader's scroll stays), the new-messages dot shows when scrolled up and clears on Jump to latest, and at the bottom the page follows along. |
| `transcript-other-branch` | A reply appended to the log from a second writer, parented on the first answer, shows in place with the "other branch" pill, under the question it answers. |

Area `sidebar`, `test/e2e/scenarios/sidebar.mjs`. Its sessions are synthetic and seeded: four Claude Code sessions in two
projects (`alpha-api`, two sessions minutes old, one with an edit, a skill, a commit, a pull request, an agent and a
cost; `beta-web`, three and forty days old) and one Copilot CLI session in `beta-web`. Four plain sessions open in tabs.

| Name | What it checks |
|---|---|
| `sidebar-groups-by-project` | Projects are groups with an avatar of their initials, their folder, a count and their sessions newest first; a header folds and unfolds its cards. |
| `sidebar-groups-by-date` | Recent puts each session under its date group (Today, Yesterday, Previous 7 Days, ...), in order, and the cards name their project. |
| `sidebar-workspace-filter` | Workspace leaves only the sessions started in the open folder, and turns off again. |
| `sidebar-source-chips` | A chip per tool with its count, and All; on Claude Code alone only its chip is lit; adding Copilot CLI shows it, with a tag naming each card's tool; with everything on, a click shows just that tool. |
| `sidebar-card-details` | A card shows its title, latest prompt, agent, tool, branch, prompt count, pull request and cost; a plain session shows none of the optional ones; hovering shows the quick actions. |
| `sidebar-search-words` | Words in any case, an exact phrase (with the matching passage and its highlight), `-` exclusion, `OR`, file paths searched and tool output not, the no-matches message, the summary. |
| `sidebar-search-filters` | `source:`, `file:`, `skill:`, `has:commits`, `has:pr`, `has:edits` and their `-` forms, and a filter with a word. |
| `sidebar-search-help` | The ? button lists the filters, clicking one adds it to the box; Escape, the clear button and `/` behave. |
| `sidebar-click-opens-preview-tab` | A click opens a transcript in the preview tab (which offers Keep open) and the next click replaces it. |
| `sidebar-double-click-keeps-tab` | A double-click gives the session a tab of its own; the next clicks use one preview tab beside it. |
| `sidebar-keep-open-button` | Keep open in the transcript does the same. |

Area `resume`, `test/e2e/scenarios/resume.mjs`: resuming, continuing and starting sessions, on the harness's plain
two-record sessions, one per scenario. `seed` adds a project agent (`e2e-reviewer`) and a user agent (`e2e-planner`) for
the pickers' agent step. Each scenario reads the terminal stub's `argv` and `cwd` (or the Claude Code stub's
`claude-code-open`) recorded since its own action. The pickers are the workbench's quick picks, clicked by their exact
labels (`choose`, `typeIn`, `cancelStep` in the module). Resume Session and the Continue commands are hidden from the
command palette (`when: false` in `package.json`), so the palette's entries here are New Claude Code Session… and
Search Sessions… (whose rows have a Resume button).

| Name | What it checks |
|---|---|
| `resume-sidebar-menu`, `resume-sidebar-card-button`, `resume-sidebar-ctrl-enter`, `resume-topbar`, `resume-search-quick-pick` | Resume Session from the sidebar's right-click menu, the card's play button, Ctrl+Enter on a card, the transcript's top bar and the Search Sessions… picker's Resume button: the terminal runs the stub with `--resume <id>` and starts in the session's folder. |
| `resume-closes-transcript-setting` | With `closeTranscriptOnResume` on, Resume in the top bar closes the transcript tab after the terminal starts. The setting is put back. |
| `continue-sidebar-menu`, `continue-card-button`, `continue-topbar` | Continue in New Session: `--name "Continued: <title>"` and the handoff (the session's title, last prompt and reply) as one argument, with no option flags. |
| `continue-with-model-sidebar-menu` | Continue in New Session with Tool or Model…: the tool, model, effort and agent pickers list what they should (the session's own model, the project and user agents), and the choices become `--model`, `--effort` and `--agent` before `--name`. |
| `continue-with-model-topbar-chevron` | The top bar's ⌄: a typed model name, effort left on Default (no `--effort`), an empty agent name goes back to the list, a typed agent name is passed. |
| `continue-with-model-defaults` | Every step on Default leaves all three flags out. |
| `continue-with-model-cancel` | Escape at the tool, model, effort, agent and typed-model steps opens nothing. |
| `continue-with-model-other-tools` | Claude Code Chat gets the handoff as a new chat (no further steps); GitHub Copilot CLI has two steps and gets `--model`, `--reasoning-effort`, `--name` and a prompt pointing at a handoff file that holds the handoff. |
| `send-to-cli-resumes-session`, `send-to-cli-with-handoff` | The message box's Send menu to the Claude Code CLI: `--resume <id> <message>`, or with "A new session, with a handoff" a handoff that ends with the message. |
| `send-with-model-and-effort`, `send-with-model-effort-and-agent` | Send with a model and effort…: two steps for the same session (no agent), three for a handoff, and the flags come before the message. |
| `send-with-model-cancel` | Cancelling either step opens nothing and leaves the message in the box. |
| `send-to-claude-code-chat` | Send to the Claude Code chat: this session with the message in its input box, then a new chat with a handoff ending in it; the box empties each time. |
| `new-session-palette`, `new-session-sidebar-plus` | New Claude Code Session… from the palette and the sidebar's +: the folder, model, effort and agent pickers (a blank session is not offered a session model), the flags only (no prompt, no name), the folder; all defaults pass no arguments. |
| `new-session-cancel` | Escape at the folder, model, effort and agent steps opens nothing. |

The folder picker's "Choose a folder…" opens the operating system's dialog, which Playwright cannot drive, so it is not covered.

Area `overview`, `test/e2e/scenarios/overview.mjs`: the Overview tab, and the cost, token, request, context and prompt-cache
figures wherever they appear. Its sessions are synthetic and seeded in two projects of their own (`overview-north` and
`overview-south`): five Claude Code sessions with known token counts, one a day old and a second today (the context
85% full, a warm 1-hour cache, an agent), one half full with an expired 5-minute cache, one nine days old, one forty,
and one on a model with no price. The module computes every expected figure from the token counts and `src/prices.json`,
and the overview scenarios narrow the page to the two projects, so the sessions of other areas do not change a total.

| Name | What it checks |
|---|---|
| `overview-opens` | The dashboard button at the top of the sidebar opens the tab on the current workspace, with the six ranges; Open Overview from the command palette shows that tab instead of opening a second; the Projects menu offers the workspace and all projects. |
| `overview-projects` | All projects, then picking projects in the menu (search box, no-match message), pills that remove a project, clicking a project's name in the table to show just it and again to go back. |
| `overview-totals-and-tables` | The five totals and their notes, the Projects table (sessions, prompts, cost, most expensive first) and the Models table (cost and share, no unpriced model). |
| `overview-cost-chart` | One bar a day, each worded with its day, cost, sessions and cost by model; the legend by model and by project, plain bars under Total; hovering a bar shows that day's breakdown. |
| `overview-ranges` | Week, month, 7, 30, 90 days and all time: the totals and the number of bars for each, with the nine- and forty-day-old sessions falling on the right sides; the range survives picking a project. |
| `overview-sessions-list` | Recent and Most expensive lists with project, agent chip, prompt count and cost in the range (an unpriced session is left out of the second); clicking a row opens its transcript. |
| `overview-card-figures` | Sidebar cards: the cost; the context badge from half full, yellow from 80%; the cache countdown while warm and no badge once expired; no cost for a model with no price. |
| `overview-transcript-figures` | The tiles at the top of a transcript (context, prompt cache, cost and requests, tokens and the share read from cache), the cost breakdown row by row and its total, the top bar's copy of them, and the message box saying the context is nearly full. |
| `overview-transcript-cold-and-unpriced` | An expired cache (time since, 5-minute), a window half full not warned about, a single request worded as one, and the message box saying resuming would re-cache the whole context. |
| `overview-transcript-unpriced` | A model with no price: tokens counted, cost $0.00, and the breakdown names the model. |
| `overview-session-details-costs` | Session details lists each prompt with its cost and cost bar, and the conversation shows the same cost beside each prompt. |

Area `other-tools`, `test/e2e/scenarios/other-tools.mjs`, README's "GitHub Copilot CLI and VS Code Chat sessions too".
Its sessions are synthetic and seeded: a Copilot CLI session (`session-state/<id>/` with a view, a failing command and an
edit, two prompts, and a record type nobody knows) and a VS Code Chat session (a `.jsonl` patch log under
`workspaceStorage/<hash>/chatSessions/`, with a reading, a tool call and a custom title). Both have "otools" in their
title, and each reply has a word nothing else has. The scenarios switch every tool's chip on, search `otools` (a search
opens every group) and put the chips and the search box back, so they hold whichever areas run beside them.

| Name | What it checks |
|---|---|
| `other-tools-sidebar-marking` | Each card names its tool (Copilot CLI, VS Code Chat) with title, branch and prompt count; the tool's chip shows just its sessions; hovering offers Resume (worded for the tool) and Continue, and no Open in Claude Code chat. |
| `other-tools-menu-offers` | The right-click menu offers Resume, Continue, Open Transcript, Open Raw Log and Copy Session ID for both; Copy Resume Command for Copilot CLI only; Rename and Open in Claude Code Chat for neither. |
| `other-tools-copilot-transcript` | The Copilot CLI session reads as prompts and replies in order, with its tool calls (view, bash, edit), the failed one marked and showing its error, and neither the injected context nor the reasoning shown; its page has Resume for the GitHub Copilot CLI and no Claude Code buttons. |
| `other-tools-vscode-chat-transcript` | The VS Code Chat session reads as prompts and replies, a file reference as code, a tool call with its hint and output; Resume is Open in Chat and Continue is a new chat; no Claude Code buttons. |
| `other-tools-search` | A word in a reply finds each session and the card shows the highlighted passage; a prompt phrase, `source:copilot`, `source:chat` and `-source:chat` pick the right one; the word is marked in the opened chat. |
| `other-tools-copilot-resume` | Resume Session from the menu runs `<copilotCommand> --resume <id>` in the terminal, once, and starts nothing new. |
| `other-tools-copilot-continue` | Continue in New Session runs the Copilot command with no `--resume`, a `--name` after the session, access to the handoff folder and a prompt pointing at a handoff file that carries the session's prompts. |
| `other-tools-vscode-chat-open` | Open in Chat (hover button, and the transcript's button) says the chat belongs to another folder, offering Open Folder in New Window and Read Transcript, which opens the conversation; no terminal starts. |
| `other-tools-chat-here-offered` | A Copilot CLI session's message-box menu starts with Chat here, chosen, then its tools; a VS Code Chat session's has no Chat here, cannot send to the same session, and has no chat bar. |

Not covered: what Continue in a new chat does in VS Code Chat itself (chat is off in the test window), and Open Folder in
New Window (it would open a second window).

## Writing a scenario

Add an entry to `scenarios` in the area's module under `test/e2e/scenarios/` (or make a new area, above):

```js
{
  name: 'my-scenario',              // what `--only my-scenario` and `npm run test:e2e -- my` match
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
npm run test:e2e -- --area <the area the PR changes>
```

`npm ci` is needed when the branch changed `package-lock.json`; the VS Code download is shared, so a new worktree
reuses it. Report the `Total` line. For a failure,
Read `.e2e-out/<scenario>.png` and `.e2e-out/<scenario>.events.json`, and say which step timed out (the message
names it). A PR that changes the chat's behaviour on purpose may need its scenario changed in the same PR.
