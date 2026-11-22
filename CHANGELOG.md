# Changelog

All notable changes to SessionsAI (published as Claude Sessions before 0.4.0) are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).
Numbers in parentheses are the pull requests that made each change. Each version heading links to its GitHub release, which has the release notes and the `.vsix` for installing that version with **Install from VSIX…**.

## [0.4.6](https://github.com/rellik92j/sessionsai/releases/tag/v0.4.6) - 2026-11-22

### Added
- **Changelog.** The Marketplace listing has a Changelog tab covering every release since 0.2.1. (#43)

### Changed
- **The GitHub repository is now [rellik92j/sessionsai](https://github.com/rellik92j/sessionsai)**, renamed from `claude-sessions-vscode`. The listing's Repository link points at the new name, and old links redirect. (#44)

## [0.4.5](https://github.com/rellik92j/sessionsai/releases/tag/v0.4.5) - 2026-11-20

### Added
- **Reply from the transcript.** Every transcript now ends with a message box. Type your next message and press Enter, and it is sent to the session. The transcript tab then closes, as it does after Resume. A line under the box says what Send will do. (#42)
- **Smart routing of your message.** By default the message goes to the same session. It switches to a new session with a handoff when the context is 80% full or when the prompt cache has expired on more than 100k tokens. The menu next to Send lets you choose the session, the tool, and the model and effort for the CLIs. Your tool choice is remembered for each kind of session. (#42)
- **Delivery by tool.** Claude Code CLI resumes the session with your message. Copilot CLI resumes with it through `-i`. VS Code Chat opens a new agent-mode chat and sends it at once. The Claude Code extension only fills its input box, because it can't submit. A session already running in a SessionsAI terminal gets the message on the clipboard. (#42)
- **`claudeSessions.transcriptLineWidth` setting.** Caps how wide transcript prose runs: `full` (the default, as before), `comfortable` or `narrow`. (#41)
- **Search filter help.** A `?` button in the sidebar search box lists the filters. Clicking one adds it to the query. (#41)

### Changed
- **Calmer sidebar.** Sessions are flat rows with hairline separators and use VS Code's own list hover and focus colors. Live sessions keep a tint and a green edge. (#41)
- **Transcripts fit narrow tabs.** The Session details panel docks from 900px wide and closes when a tab narrows below that, instead of covering the conversation in split editors. Top-bar buttons drop their labels as the bar narrows, starting with the secondary ones. (#41)
- **Quieter transcripts.** Only messages that are new since the session last reloaded animate. Labels use sentence case, and the "New" file tag has a tooltip that explains it. (#41)

## [0.4.4](https://github.com/rellik92j/sessionsai/releases/tag/v0.4.4) - 2026-11-20

### Added
- **Rename sessions.** Right-click a Claude Code session, use the pencil in its transcript, or use the Command Palette. The name is written the way `/rename` writes it, so it also shows in Claude Code and its extension. You get a warning for a session that was active in the last three minutes, because a running Claude Code may write its own name back. This is the only time the extension writes to session logs. (#40)
- **Session details panel.** A panel beside a transcript that you can toggle, open by default in wide windows. It shows:
  - files changed, commits (click one for `git show`) and pull requests
  - the session's to-do list, skills, slash commands, subagents and MCP servers
  - web lookups, files read and tools that failed
  - every prompt, so you can jump to it (#40)
- **Compare changed files.** Hover a changed file to diff it against the last commit before the session, see only the session's own edits, or find other sessions that changed it. (#40)
- **Cost and time per prompt.** Each prompt shows the cost of its reply at API prices and how long the reply took. The panel's prompt list adds a cost bar. (#40)
- **Search filters.** `file:`, `skill:` and `has:commits|pr|edits` for Claude Code sessions. Put `-` in front of any of them to exclude matches. Skills in the panel link to these searches. (#40)

## [0.4.3](https://github.com/rellik92j/sessionsai/releases/tag/v0.4.3) - 2026-11-17

### Added
- **Current week and Current month ranges.** The overview's time range offers these next to the last 7, 30 or 90 days and all time. The week starts on Monday, so on a Sunday it also covers the six days before. The month starts on the 1st. (#38)
- **Claude Fable 5.2 and Claude Mythos 5.2 prices.** Both cost $8 / $40 per million input / output tokens, with cache reads at $0.20 and fast mode at double. Their usage previously showed no cost. (#37)

### Changed
- The overview's range buttons wrap onto a second line in a narrow editor tab instead of running off the edge. (#38)

## [0.4.2](https://github.com/rellik92j/sessionsai/releases/tag/v0.4.2) - 2026-11-14

### Added
- **Continue in Claude Code Chat.** If the Claude Code extension is installed, the tool picker in **Continue in New Session with Tool or Model…** lists **Claude Code Chat** after Claude Code CLI. It opens a new Claude Code tab with the handoff typed into the input box but not sent, so you can review it first. Without the extension the picker is unchanged. (#35)

### Changed
- **Sonnet 4.5 pricing.** The separate rate for Sonnet 4.5 prompts over 200K tokens was removed to match the synced price list, so those prompts are costed at the standard rate. (#34)
- The README's Install section says that the Claude Code extension enables Open in Claude Code Chat and the new Continue target. (#36)

## [0.4.1](https://github.com/rellik92j/sessionsai/releases/tag/v0.4.1) - 2026-10-07

### Added
- **Transcripts close when you resume from them.** In a transcript tab, Resume, Continue in New Session (with or without picking a model) and Open in Claude Code now close the tab once the session or its continuation has opened. (#32)
- **`claudeSessions.closeTranscriptOnResume` setting.** On by default. Turn it off to keep transcripts open. Resuming from the sidebar or the quick pick never closes an open transcript. (#32)

### Fixed
- **Cancelling keeps the transcript.** The transcript stays open if you cancel the model picker, dismiss a warning, or the session can't be opened here, for example a VS Code chat that belongs to another window. (#32)

## [0.4.0](https://github.com/rellik92j/sessionsai/releases/tag/v0.4.0) - 2026-10-07

### Added
- **New icon** for the Marketplace listing. (#31)

### Changed
- **Claude Sessions is now SessionsAI, on the VS Code Marketplace.** Install it by searching for SessionsAI in the Extensions view or with `code --install-extension rellik92j.sessionsai`. VS Code now updates it automatically. (#31)
- **New extension ID.** The ID changed from `local.claude-sessions` to `rellik92j.sessionsai`. VS Code treats the new ID as a different extension, so if you installed an earlier `.vsix`, uninstall Claude Sessions first. Command, view and setting IDs still start with `claudeSessions.`, so your settings and keybindings carry over. (#31)
- **New name in the UI.** The Activity Bar title, Command Palette category, settings section and overview tab say SessionsAI. "Search Claude Sessions for This File" is now "Search Sessions for This File". (#31)

## [0.3.2](https://github.com/rellik92j/sessionsai/releases/tag/v0.3.2) - 2026-10-07

### Added
- **Claude Haiku 5.5 prices.** Its sessions used to show no cost. Prompts up to 100K tokens cost $0.10 / $0.50 per million input / output tokens, and longer prompts cost 5x. Cache reads and writes count toward the 100K. (#24)
- **Claude Mythos Preview prices, and Sonnet 4.5 prompts over 200K tokens at their higher rate.** (#25)

### Fixed
- **Sonnet 5.5 cache reads** cost $0.10 per million tokens. They were shown at twice that. (#24)

### Internal
- Model prices moved from a hard-coded table in `src/usage.ts` to `src/prices.json`. (#25)
- A weekly GitHub workflow (`scripts/sync-prices.mjs`) syncs prices from LiteLLM's price list, runs `npm test`, and opens a `sync-model-prices` PR for review. (#25, #27, #29)

## [0.3.1](https://github.com/rellik92j/sessionsai/releases/tag/v0.3.1) - 2026-10-06

### Added
- **Continue in New Session finds your handoff notes.** If you asked the earlier session to write a handoff, for example "save a handoff.md" or a handoff skill, the new session's prompt opens with a "Handoff notes from that session" section. It lists every place the notes were written, marks the latest, and tells the new session to read them first. Notes are found whether they were saved with edit tools or shell commands, or published as an Artifact or doc (Claude Code sessions only). (#20)
- **Search Claude Sessions for This File.** Right-click a file in the Explorer or an editor tab, or use the Command Palette, to search the sidebar for that file's name. (#22)

### Changed
- **Search covers files Claude touched.** Claude Code session search now includes the paths of files that its tools read or edited, so it finds sessions that touched a file without naming it. (#22)
- The README covers Copilot CLI and VS Code Chat. (#19, #23)

## [0.3.0](https://github.com/rellik92j/sessionsai/releases/tag/v0.3.0) - 2026-10-06

### Added
- **Copilot CLI and VS Code Chat sessions.** GitHub Copilot CLI sessions and VS Code Chat conversations are listed next to Claude Code sessions. Each card has a badge naming its tool, and you can search all of them and read any of them as a transcript. (#18)
- **Source chips.** All · Claude · Copilot CLI · VS Code Chat, each with a count. Click a chip to show only that tool, then click others to add them. In search, `source:copilot` and `-source:chat` filter by tool. (#18)
- **Resume for each tool.** For Copilot CLI, Resume runs `copilot --resume`. For VS Code Chat, **Open in Chat** opens the conversation. If the chat belongs to another folder, it offers to open that folder in a new window. (#18)
- **Continue in New Session for every tool.** A Copilot CLI session continues in Copilot CLI, and a VS Code chat continues in a new agent-mode chat with the handoff in the input box. **Continue in New Session with Tool or Model…** moves work between Claude Code, Copilot CLI and VS Code Chat. (#18)
- **Overview source chips.** Cost is labelled "Claude only", because the other tools' logs record no token usage. (#18)
- **New settings:** `claudeSessions.sources`, `copilotDir`, `vscodeUserDir` and `copilotCommand`. (#18)
- Sessions with no known folder are grouped under "No folder". (#18)

## [0.2.9](https://github.com/rellik92j/sessionsai/releases/tag/v0.2.9) - 2026-10-06

### Changed
- **Sharper handoff in Continue in New Session.** The handoff carries Claude's whole final reply, and only very long replies are cut, from the end. If your last request was short, like "yes, ship it", the request before it comes along too. (#16)
- **Skills and connectors in the handoff.** The handoff lists the skills the session used and the connectors and MCP servers whose tools it called. A skill you typed as `/name` counts, and the command becomes your last request. (#16, #17)

### Fixed
- **Less noise in the handoff.** Scratch files and saved tool output no longer show up as "… outside the project". Memory, plan and skill files under `~/.claude` are named. (#16)
- Continuing a continued session no longer names it "Continued: Continued: …". (#16)

## [0.2.8](https://github.com/rellik92j/sessionsai/releases/tag/v0.2.8) - 2026-10-05

### Added
- **Colored overview bars.** **Color by** splits each day's bar by Model or Project, or choose Total for plain bars. There is a legend and a breakdown for each day on hover. Each model and project keeps its color when you change the range. (#15)

### Changed
- **The overview opens on your workspace.** It starts with the projects in the folders you have open. The **Projects** menu switches to All projects or lets you tick specific ones. With no folder open it shows everything. (#15)
- **Recent sessions first.** The overview's session list starts with the most recently active sessions and can switch to the most expensive. (#15)

## [0.2.7](https://github.com/rellik92j/sessionsai/releases/tag/v0.2.7) - 2026-10-05

### Added
- **Overview page.** A dashboard button at the top of the sidebar, or **Claude Sessions: Open Overview**, opens a summary in an editor tab with:
  - total cost at Claude API prices, sessions, prompts, projects and active days
  - cost per day
  - each project's and model's share of the cost
  - the most expensive sessions, which open their transcript when clicked (#13)
- **Time range.** Switch between the last 7, 30 or 90 days and all time. Cost is counted on the day each request was made, so a session that runs over several days is split across them. (#13)
- **Project filter.** Narrow the overview to one or more projects from the **Projects** menu, or click a project's name in the table. The overview also follows the sidebar's Workspace filter. (#13)

### Changed
- The README explains the usage stats and has new screenshots. (#11)

### Fixed
- The usage stats strip that stays under the top bar has a solid background, so conversation text no longer shows through it. (#12)

## [0.2.6](https://github.com/rellik92j/sessionsai/releases/tag/v0.2.6) - 2026-10-05

### Added
- **Usage stats in transcripts.** Each transcript shows how full the context window was at the last request, and whether the prompt cache is still warm, with a countdown. It also shows token counts and the cost at Claude API prices, subagents included. **Cost breakdown** shows the cost of each token type. On a Pro or Max plan, the cost is what the session would have cost through the API. (#9)
- **Sticky stats.** Once you scroll past the header, a one-line version of the stats stays in the top bar. Click it to return to the top. (#9)
- **Card badges.** Cards show the cost, the context once it is 50% full, and a countdown while the prompt cache is warm. (#9)
- **Continue in New Session with Model…** Pick the model and effort level for the new session instead of your Claude Code defaults. It is in a card's right-click menu, and on the arrow next to Continue in New Session in a transcript. (#9)

## [0.2.5](https://github.com/rellik92j/sessionsai/releases/tag/v0.2.5) - 2026-10-05

### Changed
- **New README for first-time users.** It explains what the extension does, with screenshots, install steps, and sections on privacy, keyboard shortcuts and settings. The extension itself is unchanged. (#7)

## [0.2.4](https://github.com/rellik92j/sessionsai/releases/tag/v0.2.4) - 2026-10-05

### Added
- **Continue in New Session.** Starts a new Claude Code CLI session in the old session's project folder, from a session card (button or right-click menu) or from the transcript's top bar. Its first message is a handoff with:
  - your last request and Claude's last reply
  - the files edited and read, and any open to-dos
  - the current `git status` and the old transcript's path

  Claude is asked to summarize where things stand and to wait for your instruction before changing anything. The new session is named "Continued: <title>", so it is easy to find in `/resume`. (#5)

## [0.2.3](https://github.com/rellik92j/sessionsai/releases/tag/v0.2.3) - 2026-10-05

### Added
- **Transcript preview tab.** Clicking a session opens its transcript in one shared preview tab, and the next transcript you click replaces it, like VS Code's preview editors. To keep a transcript open, double-click the session, press **Keep open** in the transcript's top bar, or choose *Open Transcript in New Tab* from the right-click menu. If a session already has its own tab, that tab is focused. (#3)
- **`claudeSessions.reuseTranscriptTab` setting.** On by default. Turn it off to get one tab per transcript, as before. (#3)

## [0.2.2](https://github.com/rellik92j/sessionsai/releases/tag/v0.2.2) - 2026-10-05

### Added
- **Transcript search.** The sidebar search and *Search Sessions…* now match your prompts and Claude's replies, but not tool output. Sessions found this way show the matching passage. (#1)
- **Search operators.** Use `"exact phrase"` to match a phrase, `-word` or `-"phrase"` to exclude, and `a OR b` to match either. (#1)
- **Open at the match.** A transcript opened from a search highlights the words, starts at the first match, and shows a bar to step through matches: F3 for the next, Shift+F3 for the previous, Esc to clear. (#1)

### Fixed
- Search matches inside the colored agent, project and PR chips are readable again. (#1)
- The packaged extension no longer includes the repository's `.claude/` folder. (#2)

## [0.2.1](https://github.com/rellik92j/sessionsai/releases/tag/v0.2.1) - 2026-10-04

The first release, as Claude Sessions.

### Added
- **Sessions sidebar.** A card for every Claude Code session, read from `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). Each card shows the title, latest prompt, time, branch, prompt count, and agent and PR badges, and a pulsing dot marks recently active sessions. Nothing is uploaded.
- **Search, grouping and filtering.** An instant search box (press `/`), grouping by project or by date, and a Workspace filter.
- **Card actions and keyboard.** Hover actions to resume, open in Claude Code chat, read the transcript or copy the ID. A right-click menu to copy the resume command, open the raw JSONL or the PR, or open the project folder. Arrow keys to move, Enter to read and Ctrl+Enter to resume.
- **Transcript view.** A chat-style layout with markdown, tables and syntax-highlighted code. Tool calls expand to show their input and output, with diffs for edits. Also day separators, a switch to hide tool calls, and a jump-to-latest button.
- **Resume in a Claude Code terminal** (`claude --resume <id>`), in an editor tab or the panel.
- **Open in Claude Code Chat**, styling that follows your theme, and automatic refresh when session logs change.
- **Settings:** `projectsDir`, `groupBy`, `currentWorkspaceOnly`, `hideEmptySessions`, `claudeCommand`, `terminalLocation` and `showThinking`, all under `claudeSessions.`.
