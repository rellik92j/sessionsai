// Loads the bundled extension (dist/extension.js) against a fake VS Code API and drives the sidebar and
// transcript webviews. Catches packaging problems such as a dependency failing to load at activation.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

// The user's agents are read from CLAUDE_CONFIG_DIR/agents (else ~/.claude/agents). Every test here starts with that
// pointed at an empty temp folder, so agents on this machine never add a step to a picker a test drives.
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
const emptyConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-config-'));
process.env.CLAUDE_CONFIG_DIR = emptyConfigDir;
test.after(() => {
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  }
  fs.rmSync(emptyConfigDir, { recursive: true, force: true });
});

function fakeVscode(state) {
  class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = (f) => (this.listeners.push(f), { dispose() {} });
    }
    fire(x) {
      this.listeners.forEach((f) => f(x));
    }
  }
  const disposable = { dispose() {} };
  const uri = (p) => ({ fsPath: p, toString: () => 'file://' + p });
  const webview = (posted) => ({
    cspSource: 'vscode-webview:',
    options: {},
    html: '',
    asWebviewUri: (u) => uri(u.fsPath),
    onDidReceiveMessage: (f) => ((webview.handler = f), disposable),
    postMessage: async (m) => posted.push(m),
  });
  return {
    EventEmitter,
    Uri: { file: uri, joinPath: (b, ...p) => uri(path.join(b.fsPath, ...p)), parse: uri },
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    RelativePattern: class {
      constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
      }
    },
    ViewColumn: { Active: -1, Beside: -2 },
    TerminalLocation: { Panel: 1 },
    ConfigurationTarget: { Global: 1 },
    extensions: { getExtension: (id) => state.extensions?.[id], onDidChange: () => disposable },
    env: { clipboard: { writeText: async () => {} }, openExternal: async () => {} },
    workspace: {
      workspaceFolders: [],
      // Every source reads from temp folders (state.config), never from this machine's real sessions.
      getConfiguration: () => ({
        get: (k, d) => (k === 'projectsDir' ? state.projectsDir : k in (state.config ?? {}) ? state.config[k] : d),
        update: async () => {},
      }),
      // Watchers are kept in state.watchers, so a test can fire one as if its files had changed on disk.
      createFileSystemWatcher: (pattern) => {
        const w = { pattern, change: [], create: [], disposed: false };
        (state.watchers ??= []).push(w);
        return {
          onDidCreate: (f) => (w.create.push(f), disposable),
          onDidChange: (f) => (w.change.push(f), disposable),
          onDidDelete: () => disposable,
          dispose: () => (w.disposed = true),
        };
      },
      onDidChangeConfiguration: () => disposable,
      onDidChangeWorkspaceFolders: () => disposable,
      registerTextDocumentContentProvider: () => disposable,
    },
    window: {
      registerWebviewViewProvider: (id, provider) => ((state.providers[id] = provider), disposable),
      createWebviewPanel: () => {
        const panel = { webview: webview(state.panelPosts), reveal() {}, title: '' };
        panel.onDidDispose = (f) => ((panel.dispose = f), disposable);
        panel.webview.onDidReceiveMessage = (f) => ((panel.onMessage = f), disposable);
        state.panels.push(panel);
        return panel;
      },
      onDidCloseTerminal: () => disposable,
      createTerminal: (options) => (state.terminals.push(options), { show() {}, sendText(t) { options.sent = t; } }),
      showErrorMessage: (m) => state.errors.push(m),
      showWarningMessage: async () => undefined,
      showInformationMessage: async (m) => (state.infos?.push(m), undefined),
      setStatusBarMessage() {},
      // Tests answer quick picks by setting state.pick to a function of the items and options.
      showQuickPick: async (items, options) => state.pick?.(items, options),
      // Tests answer input boxes the same way, with state.input.
      showInputBox: async (options) => state.input?.(options),
    },
    commands: {
      registerCommand: (id, f) => ((state.commands[id] = f), disposable),
      executeCommand: async (id, ...args) => state.commands[id]?.(...args),
    },
    _webview: webview,
  };
}

/**
 * Resolves once `condition()` is truthy, checking every 10 ms; throws after `timeout` ms naming `what`. Use it in place
 * of a fixed sleep wherever the step has something to wait for: a slow CI runner can take longer than any fixed sleep.
 * A step that checks nothing happened (a cancelled pick) has nothing to wait for and keeps its sleep.
 */
async function waitFor(condition, what, timeout = 10000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The sidebar's last `state` post, once the session store has finished loading. */
async function waitForLoadedState(posted) {
  const last = () => posted.filter((m) => m.type === 'state').pop();
  await waitFor(() => last()?.loaded === true, 'the sidebar to post a loaded state');
  return last();
}

function writeSession(dir, id, lines) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/**
 * Moves the session folder `from` recorded in fixtures copied under `dir` to `to`, an empty folder it creates, so a
 * test never reads a real folder (C:\repo, a home folder) and its .claude/agents. Rewrites the raw and JSON forms.
 */
function relocate(dir, from, to) {
  fs.mkdirSync(to, { recursive: true });
  const json = (s) => JSON.stringify(s).slice(1, -1);
  for (const name of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile()) {
      const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, text.split(json(from)).join(json(to)).split(from).join(to));
    }
  }
}

test('bundled extension activates, fills the sidebar, and renders a transcript', async () => {
  // EXT_DIR lets this run against an unpacked .vsix to check what actually ships.
  const extDir = process.env.EXT_DIR || path.join(__dirname, '..');
  const bundle = path.join(extDir, 'dist', 'extension.js');
  assert.ok(fs.existsSync(bundle), 'run `npm run bundle` first');

  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-'));
  // The session's folder: an empty temp folder, so no project agents.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-repo-'));
  const ts = new Date().toISOString();
  writeSession(path.join(projectsDir, 'C--repo'), 'aaaa-1111', [
    { type: 'user', message: { content: 'Add a **dark mode** toggle' }, cwd: repo, gitBranch: 'main', timestamp: ts },
    {
      type: 'assistant',
      message: {
        id: 'm1',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Done:\n\n```ts\nconst x = 1;\n```' }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 20000, cache_creation: { ephemeral_1h_input_tokens: 20000 }, cache_read_input_tokens: 0, output_tokens: 500 },
      },
      effort: 'high',
      timestamp: ts,
    },
    { type: 'ai-title', aiTitle: 'Dark mode toggle' },
  ]);

  const noSources = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-none-'));
  const state = {
    projectsDir,
    config: { copilotDir: noSources, vscodeUserDir: noSources },
    providers: {},
    commands: {},
    panels: [],
    panelPosts: [],
    errors: [],
    terminals: [],
  };
  const vscode = fakeVscode(state);
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[bundle];
    const ext = require(bundle);
    // globalState: a plain object, so the test can see what is remembered.
    const globalState = { get: (k) => state.memento?.[k], update: async (k, v) => ((state.memento ??= {})[k] = v) };
    ext.activate({ subscriptions: [], extensionUri: vscode.Uri.file(extDir), globalState });

    const provider = state.providers['claudeSessions.list'];
    assert.ok(provider, 'sidebar webview provider registered');

    const posted = [];
    let handler;
    const view = {
      visible: true,
      webview: { ...vscode._webview(posted), onDidReceiveMessage: (f) => ((handler = f), { dispose() {} }) },
      onDidChangeVisibility: () => ({ dispose() {} }),
      onDidDispose: () => ({ dispose() {} }),
      show() {},
    };
    provider.resolveWebviewView(view);
    assert.match(view.webview.html, /sidebar\.js/);
    assert.match(view.webview.html, /codicon\.css/);

    handler({ type: 'ready' });
    const msg = await waitForLoadedState(posted);
    assert.ok(msg, 'state posted to sidebar');
    assert.equal(msg.loaded, true);
    assert.equal(msg.total, 1);
    assert.equal(msg.groups[0].sessions[0].title, 'Dark mode toggle');

    await state.commands['claudeSessions.openTranscript']({ sessionId: 'aaaa-1111' });
    const html = state.panels[0]?.webview.html ?? '';
    assert.match(html, /<strong>dark mode<\/strong>/);
    assert.match(html, /hljs-keyword/);
    assert.doesNotMatch(html, /data-highlight/);
    // Usage stats: context, a warm 1-hour cache, cost (10 input at $4, 20k 1h writes at $8 and 500 output at $20 per MTok = $0.17).
    assert.match(html, /claude-opus-5-5 · high/);
    assert.match(html, /20k<span> \/ 1M<\/span>/);
    assert.match(html, /class="stat cache" data-expires="\d+"/);
    assert.match(html, /<div class="stat-value">\$0\.17<\/div>/);
    // The same stats, compact, in the sticky top bar, with a second tool-call switch.
    assert.match(html, /<div class="topbar-stats"><button class="strip-stats" id="to-top"[^>]*>.*claude-opus-5-5 · high.*20k \/ 1M · 2%.*\$0\.17/);
    assert.equal(html.match(/data-tools-toggle/g)?.length ?? 0, 0, 'no tool calls in this session, so no switches');
    const card = msg.groups[0].sessions[0];
    assert.ok(Math.abs(card.cost - 0.17004) < 1e-6);
    assert.ok(card.cacheExpires > Date.now());

    // Search: the sidebar sends the query, the host answers with matching ids, snippets and highlight words.
    const search = (query) => {
      handler({ type: 'search', query });
      return posted.filter((m) => m.type === 'searchResults').pop();
    };
    let results = search('"x = 1" toggle');
    assert.equal(results.query, '"x = 1" toggle');
    // Results are session keys, which stay unique across sources.
    assert.deepEqual(results.ids, ['claude:aaaa-1111']);
    assert.deepEqual(results.highlight, ['x = 1', 'toggle']);
    assert.match(results.snippets['claude:aaaa-1111'], /x = 1/);
    // Matched on the card alone: no snippet.
    results = search('dark OR nothing');
    assert.deepEqual(results.ids, ['claude:aaaa-1111']);
    assert.deepEqual(results.snippets, {});
    assert.deepEqual(search('"toggle dark"').ids, []);
    assert.deepEqual(search('toggle -const').ids, []);

    // Right-clicking a file searches the sidebar for its name, quoted when it has spaces.
    await state.commands['claudeSessions.searchForFile'](vscode.Uri.file(path.join(repo, 'toggle.ts')));
    assert.deepEqual(posted.filter((m) => m.type === 'setQuery').pop(), { type: 'setQuery', query: 'toggle.ts' });
    await state.commands['claudeSessions.searchForFile'](vscode.Uri.file(path.join(repo, 'dark mode.md')));
    assert.equal(posted.filter((m) => m.type === 'setQuery').pop().query, '"dark mode.md"');

    // Opening from a search passes the words on to the transcript page.
    handler({ type: 'run', command: 'openTranscript', id: 'aaaa-1111', highlight: ['const', 42] });
    await waitFor(() => /data-highlight=/.test(state.panels[0].webview.html), 'the transcript to render with highlights');
    assert.equal(state.panels.length, 1, 'existing panel reused');
    assert.match(state.panels[0].webview.html, /<body class="line-full" data-session="[^"]*" data-highlight="\[&quot;const&quot;\]">/);
    assert.deepEqual(state.errors, []);

    // The transcriptLineWidth setting becomes a class on the page; an unknown value falls back to full.
    state.config = { ...(state.config ?? {}), transcriptLineWidth: 'narrow' };
    handler({ type: 'run', command: 'openTranscript', id: 'aaaa-1111' });
    await waitFor(() => !/line-full/.test(state.panels[0].webview.html), 'the transcript to render again');
    assert.match(state.panels[0].webview.html, /<body class="line-narrow"/);
    state.config.transcriptLineWidth = 'huge';
    handler({ type: 'run', command: 'openTranscript', id: 'aaaa-1111' });
    await waitFor(() => !/line-narrow/.test(state.panels[0].webview.html), 'the transcript to render again');
    assert.match(state.panels[0].webview.html, /<body class="line-full"/);
    delete state.config.transcriptLineWidth;

    // Transcripts share one preview tab until kept open (Keep open button, or keepOpen from a double-click).
    const open = (id, ...args) =>
      state.commands['claudeSessions.openTranscript']({ ...sessionA, id, title: `Session ${id}` }, ...args);
    const sessionA = { id: 'aaaa-1111', filePath: path.join(projectsDir, 'C--repo', 'aaaa-1111.jsonl'), projectDir: 'C--repo', cwd: repo, promptCount: 1 };
    const keepButton = /data-cmd="keepOpen"/;
    assert.match(state.panels[0].webview.html, keepButton, 'first tab is the preview');
    await open('bbbb');
    assert.equal(state.panels.length, 1, 'preview tab reused for another session');
    assert.equal(state.panels[0].title, 'Session bbbb');
    await state.panels[0].onMessage({ command: 'keepOpen' });
    await waitFor(() => !keepButton.test(state.panels[0].webview.html), 'the kept tab to render again');
    assert.doesNotMatch(state.panels[0].webview.html, keepButton, 'kept tab drops the button');
    await open('cccc');
    assert.equal(state.panels.length, 2, 'next transcript gets a new preview tab');
    await open('bbbb');
    assert.equal(state.panels.length, 2, 'kept session is focused, not reopened');
    assert.equal(state.panels[1].title, 'Session cccc', 'preview untouched');
    await open('cccc', [], true);
    assert.equal(state.panels.length, 2, 'keepOpen on the previewed session promotes it');
    assert.doesNotMatch(state.panels[1].webview.html, keepButton);
    await state.commands['claudeSessions.openTranscriptInNewTab']({ ...sessionA, id: 'dddd', title: 'Session dddd' });
    await open('eeee');
    assert.equal(state.panels.length, 4);
    assert.doesNotMatch(state.panels[2].webview.html, keepButton, 'Open in New Tab keeps it open');
    assert.match(state.panels[3].webview.html, keepButton);
    state.panels[3].dispose();
    await open('ffff');
    assert.equal(state.panels.length, 5, 'closing the preview tab means a new one next time');
    assert.deepEqual(state.errors, []);

    // Continue in new session: the CLI is the terminal's process, with the handoff as one argument (no shell typing).
    await state.panels[0].onMessage({ command: 'continueInNewSession' });
    await waitFor(() => state.terminals.length > 0, 'a terminal');
    const t = state.terminals.pop();
    assert.ok(t, 'terminal created');
    assert.equal(t.shellPath, 'claude');
    assert.equal(t.sent, undefined, 'nothing typed into a shell');
    assert.deepEqual(t.shellArgs.slice(0, 2), ['--name', 'Continued: Session bbbb']);
    const handoff = t.shellArgs[2];
    assert.equal(t.shellArgs.length, 3);
    assert.match(handoff, /## My last request\nAdd a \*\*dark mode\*\* toggle/);
    assert.match(handoff, /## Your last reply\nDone:/);
    assert.match(handoff, /wait for my instruction\.$/);
    assert.deepEqual(state.errors, []);

    // With model: tool, model, effort and agent picks (Default agent), then --model and --effort ahead of the handoff.
    const titles = [];
    state.pick = (items, options) => {
      titles.push(options.title);
      return items.find((i) => i.value === ['claude', 'sonnet', 'xhigh'][titles.length - 1]);
    };
    await state.panels[0].onMessage({ command: 'continueInNewSessionWithModel' });
    await waitFor(() => state.terminals.length > 0, 'a terminal');
    const tm = state.terminals.pop();
    assert.equal(titles.length, 4, 'tool, model, effort, agent');
    assert.deepEqual(tm.shellArgs.slice(0, 6), ['--model', 'sonnet', '--effort', 'xhigh', '--name', 'Continued: Session bbbb']);
    // Default for both adds no flags; cancelling starts nothing.
    state.pick = (items) => items[0];
    await state.panels[0].onMessage({ command: 'continueInNewSessionWithModel' });
    await waitFor(() => state.terminals.length > 0, 'a terminal');
    assert.equal(state.terminals.pop().shellArgs[0], '--name');
    state.pick = () => undefined;
    await state.panels[0].onMessage({ command: 'continueInNewSessionWithModel' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(state.terminals.length, 0);
    // Continuing a continued session doesn't stack the prefix.
    await state.commands['claudeSessions.continueInNewSession']({ ...sessionA, title: 'Continued: Continued: Session aaaa' });
    await waitFor(() => state.terminals.length > 0, 'a terminal');
    assert.deepEqual(state.terminals.pop().shellArgs.slice(0, 2), ['--name', 'Continued: Session aaaa']);

    // Message box: the page says where it sends; sending resumes this session with the message as one argument.
    const composerData = (html) =>
      JSON.parse(/data-composer="([^"]*)"/.exec(html)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
    const box = composerData(state.panels[0].webview.html);
    assert.equal(box.target, 'here', 'Chat here by default, for a Claude Code session');
    assert.deepEqual(box.targets.map((t) => [t.id, t.same]), [['here', true], ['claude', true], ['copilot-cli', false], ['vscode-chat', false]]);
    assert.deepEqual(box.chat.modes.map((m) => m.id), ['default', 'acceptEdits', 'plan', 'auto']);
    assert.equal(box.chat.mode, 'default');
    assert.match(state.panels[0].webview.html, /id="chat-live"/);
    assert.match(state.panels[0].webview.html, /id="chat-mode"/);
    assert.equal(box.context, 0);
    assert.equal(typeof box.cacheExpires, 'number', 'when the prompt cache lapses, for the default');
    assert.equal(typeof box.contextTokens, 'number', 'and how big the conversation is');
    state.config = { ...(state.config ?? {}), closeTranscriptOnResume: false };
    const sendBox = async (msg) => {
      state.panelPosts.length = 0;
      await state.panels[0].onMessage({ command: 'send', ...msg });
      await waitFor(() => state.panelPosts.some((m) => m.type === 'sent' || m.type === 'sendFailed'), 'the page to hear sent or sendFailed');
      return state.panelPosts.map((m) => m.type).filter((t) => t === 'sent' || t === 'sendFailed').pop();
    };
    assert.equal(await sendBox({ text: 'Add tests\nfor it', target: 'claude', mode: 'same' }), 'sent');
    const rt = state.terminals.pop();
    assert.equal(rt.shellPath, 'claude');
    assert.deepEqual(rt.shellArgs, ['--resume', 'bbbb', 'Add tests\nfor it']);
    assert.equal(rt.sent, undefined, 'nothing typed into a shell');
    // A new session with a handoff that ends with the message.
    assert.equal(await sendBox({ text: 'Next step', target: 'claude', mode: 'handoff' }), 'sent');
    const ht = state.terminals.pop();
    assert.deepEqual(ht.shellArgs.slice(0, 2), ['--name', 'Continued: Session bbbb']);
    assert.match(ht.shellArgs[2], /Carry on with my next request:\n\nNext step$/);
    // VS Code Chat can't take a message into this session, so it gets a handoff, sent at once; and is remembered.
    let chatOpen;
    state.commands['workbench.action.chat.newChat'] = () => {};
    state.commands['workbench.action.chat.open'] = (o) => (chatOpen = o);
    assert.equal(await sendBox({ text: 'Over to chat', target: 'vscode-chat', mode: 'same' }), 'sent');
    assert.equal(chatOpen.isPartialQuery, false);
    assert.match(chatOpen.query, /Over to chat$/);
    assert.equal(state.memento['composerTarget.claude'], 'vscode-chat');
    await state.panels[0].onMessage({ command: 'refresh' });
    await waitFor(() => composerData(state.panels[0].webview.html).target !== 'here', 'the transcript to render again');
    assert.equal(composerData(state.panels[0].webview.html).target, 'vscode-chat', 'the last tool chosen is the next default');
    // Nothing to send, or an unknown target: nothing happens and the page keeps the text.
    assert.equal(await sendBox({ text: '   ', target: 'claude', mode: 'same' }), 'sendFailed');
    assert.equal(await sendBox({ text: 'x', target: 'nope', mode: 'same' }), 'sendFailed');
    assert.equal(state.terminals.length, 0);
    delete state.config.closeTranscriptOnResume;
    delete state.memento['composerTarget.claude'];
    assert.deepEqual(state.errors, []);

    // Overview: one editor tab, filled when its page is ready, for the range the page asks for.
    await state.commands['claudeSessions.openOverview']();
    await state.commands['claudeSessions.openOverview']();
    const overview = state.panels[state.panels.length - 1];
    assert.equal(state.panels.length, 6, 'overview opened once');
    assert.match(overview.webview.html, /overview\.js/);
    state.panelPosts.length = 0;
    overview.onMessage({ type: 'ready', range: 7, scope: 'workspace' });
    const ov = state.panelPosts.filter((m) => m.type === 'state').pop();
    assert.ok(ov, 'state posted to overview');
    assert.equal(ov.scope, 'all', 'no folder open, so the workspace scope shows all projects');
    assert.equal(ov.hasWorkspace, false);
    assert.equal(ov.overview.range, 7);
    assert.equal(ov.overview.totals.sessions, 1);
    assert.ok(Math.abs(ov.overview.totals.cost - 0.17004) < 1e-6);
    assert.match(ov.overview.projects[0].name, /repo/);
    assert.deepEqual(ov.overview.models.map((m) => m.model), ['opus-5-5']);
    // Project filter: keys from allProjects; unknown ones are dropped.
    const repoKey = ov.overview.allProjects[0].key;
    overview.onMessage({ type: 'setFilters', range: 30, scope: 'pick', projects: [repoKey, 'nowhere'] });
    const filtered = state.panelPosts.filter((m) => m.type === 'state').pop();
    assert.equal(filtered.scope, 'pick');
    assert.equal(filtered.overview.range, 30);
    assert.deepEqual(filtered.overview.filter, [repoKey]);
    assert.equal(filtered.overview.totals.sessions, 1);
    // With a folder open, the workspace scope shows only sessions started inside it.
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(path.join(projectsDir, 'elsewhere')) }];
    overview.onMessage({ type: 'setFilters', range: 30, scope: 'workspace' });
    const ws = state.panelPosts.filter((m) => m.type === 'state').pop();
    assert.equal(ws.scope, 'workspace');
    assert.deepEqual(ws.workspaceKeys, []);
    assert.equal(ws.overview.totals.sessions, 0);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(repo) }];
    overview.onMessage({ type: 'setFilters', range: 30, scope: 'workspace' });
    assert.equal(state.panelPosts.filter((m) => m.type === 'state').pop().overview.totals.sessions, 1);
    vscode.workspace.workspaceFolders = [];

    // Assets referenced by the webviews must exist on disk.
    for (const f of ['media/sidebar.js', 'media/sidebar.css', 'media/transcript.js', 'media/transcript.css', 'media/overview.js', 'media/overview.css','node_modules/@vscode/codicons/dist/codicon.css', 'node_modules/@vscode/codicons/dist/codicon.ttf']) {
      assert.ok(fs.existsSync(path.join(extDir, f)), `${f} exists`);
    }
  } finally {
    Module._load = originalLoad;
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(noSources, { recursive: true, force: true });
  }
});

/** Activates the bundle against fake VS Code with the given state; returns the sidebar's posts and message handler. */
async function activateWithSidebar(state) {
  const extDir = process.env.EXT_DIR || path.join(__dirname, '..');
  const bundle = path.join(extDir, 'dist', 'extension.js');
  const vscode = fakeVscode(state);
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[bundle];
    require(bundle).activate({ subscriptions: [], extensionUri: vscode.Uri.file(extDir) });
  } finally {
    Module._load = originalLoad;
  }
  const posted = [];
  let handler;
  state.providers['claudeSessions.list'].resolveWebviewView({
    visible: true,
    webview: { ...vscode._webview(posted), onDidReceiveMessage: (f) => ((handler = f), { dispose() {} }) },
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
    show() {},
  });
  handler({ type: 'ready' });
  await waitForLoadedState(posted);
  return { vscode, posted, send: handler, last: (type) => posted.filter((m) => m.type === type).pop() };
}

test('the --agent agent is a label on the sidebar card, the transcript header and the Overview rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-agent-label-'));
  const projectsDir = path.join(root, 'claude');
  const noSources = path.join(root, 'none');
  try {
    const dir = path.join(projectsDir, 'C--work-demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'claude-code', 'agent-setting.jsonl'), path.join(dir, 'agent-0001.jsonl'));
    const demo = path.join(root, 'demo');
    relocate(dir, 'C:\\work\\demo', demo);
    // Renamed but started without --agent: agent-name holds its name, which is no agent.
    writeSession(dir, 'plain-0002', [
      { type: 'custom-title', customTitle: 'Tidy the docs' },
      { type: 'agent-name', agentName: 'Tidy the docs' },
      { type: 'user', message: { content: 'Tidy the README' }, cwd: demo, timestamp: '2026-11-19T09:00:00.000Z' },
    ]);
    const state = { projectsDir, config: { copilotDir: noSources, vscodeUserDir: noSources }, providers: {}, commands: {}, panels: [], panelPosts: [], errors: [], terminals: [] };
    const { send, last } = await activateWithSidebar(state);
    const cards = last('state').groups.flatMap((g) => g.sessions);
    const card = (id) => cards.find((c) => c.id === `claude:${id}`);
    assert.equal(card('agent-0001').agent, 'planner');
    // A rename is the title, exactly as typed, whether or not the session ran under --agent.
    assert.equal(card('agent-0001').title, 'Plan the release');
    assert.equal(card('plain-0002').agent, undefined, 'no agent, no label');
    assert.equal(card('plain-0002').title, 'Tidy the docs');
    send({ type: 'search', query: 'planner' });
    assert.deepEqual(last('searchResults').ids, ['claude:agent-0001'], 'the label is searchable');

    const chip = /<span class="chip agent" title="Agent"><i class="codicon codicon-hubot"><\/i>planner<\/span>/;
    await state.commands['claudeSessions.openTranscript']({ sessionKey: 'claude:agent-0001' });
    assert.match(state.panels[0].webview.html, chip);
    assert.match(state.panels[0].webview.html, /<h1>Plan the release<\/h1>/);
    await state.commands['claudeSessions.openTranscript']({ sessionKey: 'claude:plain-0002' });
    assert.doesNotMatch(state.panels[0].webview.html, /chip agent/);
    assert.match(state.panels[0].webview.html, /<h1>Tidy the docs<\/h1>/);

    await state.commands['claudeSessions.openOverview']();
    const overview = state.panels[state.panels.length - 1];
    overview.onMessage({ type: 'ready', range: 0, scope: 'all' });
    const ov = state.panelPosts.filter((m) => m.type === 'state').pop().overview;
    assert.deepEqual(ov.recentSessions.map((s) => [s.id, s.agent, s.title]), [['claude:agent-0001', 'planner', 'Plan the release'], ['claude:plain-0002', undefined, 'Tidy the docs']]);
    assert.deepEqual(state.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Copilot CLI and VS Code Chat sessions: source chips, filters, search, transcripts and actions', async () => {
  const fixtures = path.join(__dirname, 'fixtures');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-sources-'));
  const projectsDir = path.join(root, 'claude');
  const copilotDir = path.join(root, 'copilot');
  const userDir = path.join(root, 'Code', 'User');
  try {
    // One Claude session whose id is also a Copilot session's id, to check keys keep them apart.
    const shared = 'b380c8e3-1729-4e04-a560-1517aa38fb97';
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    writeSession(path.join(projectsDir, 'C--repo'), shared, [
      { type: 'user', message: { content: 'Fix the login race' }, cwd: repo, timestamp: new Date().toISOString() },
    ]);
    fs.cpSync(path.join(fixtures, 'copilot-cli'), path.join(copilotDir, 'session-state'), { recursive: true });
    // The fixtures ran in a home folder and C:\Users\me\repo; here those are empty temp folders.
    relocate(copilotDir, 'C:\\Users\\bisch', path.join(root, 'home'));
    relocate(copilotDir, 'C:\\Users\\me\\repo', path.join(root, 'me-repo'));
    const chats = path.join(userDir, 'workspaceStorage', 'abc123', 'chatSessions');
    fs.mkdirSync(chats, { recursive: true });
    fs.copyFileSync(path.join(fixtures, 'vscode-chat', '63869299-99f3-491c-89c4-bb361f7147f7.jsonl'), path.join(chats, '63869299-99f3-491c-89c4-bb361f7147f7.jsonl'));
    const site = path.join(root, 'work', 'site');
    fs.mkdirSync(site, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'workspaceStorage', 'abc123', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(site).href }));
    // An empty chat in an empty window: hidden like any empty session.
    const empty = path.join(userDir, 'globalStorage', 'emptyWindowChatSessions');
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(empty, 'e0.jsonl'), JSON.stringify({ kind: 0, v: { version: 3, sessionId: 'e0', customTitle: 'Untouched', requests: [] } }) + '\n');

    const state = {
      projectsDir,
      config: { copilotDir, vscodeUserDir: userDir },
      providers: {},
      commands: {},
      panels: [],
      panelPosts: [],
      errors: [],
      terminals: [],
      infos: [],
    };
    const { posted, send, last } = await activateWithSidebar(state);
    let msg = last('state');
    const cards = msg.groups.flatMap((g) => g.sessions);
    const bySource = (src) => cards.filter((c) => c.source === src);
    assert.equal(bySource('claude').length, 1);
    assert.equal(bySource('copilot-cli').length, 2, 'the real capture and the synthetic one with tool calls');
    assert.equal(bySource('vscode-chat').length, 1, 'the empty chat is hidden');
    assert.equal(new Set(cards.map((c) => c.id)).size, cards.length, 'keys are unique across sources');
    assert.ok(cards.some((c) => c.id === `claude:${shared}`) && cards.some((c) => c.id === `copilot-cli:${shared}`));
    assert.deepEqual(msg.sources.map((x) => [x.id, x.count, x.on]), [['claude', 1, true], ['copilot-cli', 2, true], ['vscode-chat', 1, true]]);
    const chat = bySource('vscode-chat')[0];
    assert.equal(chat.title, 'Chat session overview');
    assert.match(chat.projectPath, /work[\\/]site$/);

    // Chips filter for this window only.
    send({ type: 'setSources', value: ['copilot-cli'] });
    msg = last('state');
    assert.equal(msg.total, 2);
    assert.deepEqual(msg.sources.map((x) => x.on), [false, true, false]);
    assert.deepEqual(msg.sources.map((x) => x.count), [1, 2, 1], 'counts ignore the source filter');
    send({ type: 'setSources', value: ['nonsense'] });
    assert.equal(last('state').total, 0);
    assert.equal(last('state').hiddenBySource, true);
    send({ type: 'setSources', value: null });
    assert.equal(last('state').total, 4, 'anything but a list means every source');

    // source: narrows the search and is never highlighted.
    send({ type: 'search', query: 'source:copilot' });
    let results = last('searchResults');
    assert.deepEqual(results.ids.sort(), bySource('copilot-cli').map((c) => c.id).sort());
    assert.deepEqual(results.highlight, []);
    send({ type: 'search', query: '-source:claude -source:cli' });
    assert.deepEqual(last('searchResults').ids, [chat.id]);
    send({ type: 'search', query: 'login source:chat' });
    assert.deepEqual(last('searchResults').ids, []);

    // Transcripts render with each source's parser and branding.
    await state.commands['claudeSessions.openTranscript']({ sessionKey: chat.id });
    let html = state.panels[0].webview.html;
    assert.match(html, /source-avatar/);
    assert.match(html, /<strong>Copilot<\/strong>/);
    assert.match(html, /<span>Open in Chat<\/span>/);
    assert.match(html, /data-cmd="continueInNewSession" title="Start a new chat/);
    await state.commands['claudeSessions.openTranscript']({ sessionKey: `copilot-cli:${shared}` });
    html = state.panels[0].webview.html;
    assert.match(html, /GitHub Copilot CLI/);
    assert.match(html, /Create Chat Session/);
    // "Chat here" is for Claude Code sessions only: not offered, and refused if asked for.
    assert.doesNotMatch(html, /id="chat-live"|id="chat-bar"|&quot;here&quot;/);
    state.panelPosts.length = 0;
    await state.panels[0].onMessage({ command: 'chatSend', text: 'hello' });
    assert.deepEqual(state.panelPosts.map((m) => m.type), ['sendFailed']);

    // Open in Claude Code Chat refuses other sources; resuming Copilot runs its CLI in the session's folder.
    const copilotSession = { sessionKey: `copilot-cli:${shared}` };
    await state.commands['claudeSessions.openInClaudeCode'](copilotSession);
    assert.equal(state.terminals.length, 0);
    assert.match(state.infos.pop(), /only for Claude Code sessions/);
    await state.commands['claudeSessions.resume'](copilotSession);
    const t = state.terminals.pop();
    assert.equal(t.sent, `copilot --resume ${shared}`);
    assert.match(t.name, /^GitHub Copilot CLI · /);
    await state.commands['claudeSessions.resume']({ sessionKey: `claude:${shared}` });
    assert.equal(state.terminals.pop().sent, `claude --resume ${shared}`);
    // A chat from another workspace offers that folder's window instead of opening here.
    await state.commands['claudeSessions.resume']({ sessionKey: chat.id });
    assert.match(state.infos.pop(), /VS Code opens a chat only in the window of its own folder/);

    // Continue in New Session, Copilot CLI: one shell line pointing at the handoff file, which the CLI may read.
    await state.commands['claudeSessions.continueInNewSession'](copilotSession);
    const ct = state.terminals.pop();
    assert.match(ct.name, /^GitHub Copilot CLI · Continued: Create Chat Session/);
    const line = ct.sent;
    assert.doesNotMatch(line, /\n/);
    const [, dir] = /--add-dir "([^"]+)"/.exec(line);
    const [, file] = /Read the handoff in (.+?\.md):/.exec(line);
    assert.ok(file.startsWith(dir));
    assert.match(line, /--name "Continued: Create Chat Session" -i "/);
    const copilotHandoff = fs.readFileSync(file, 'utf8');
    fs.rmSync(file);
    assert.match(copilotHandoff, /^I'm continuing work from an earlier GitHub Copilot CLI session \("Create Chat Session"\)/);
    assert.match(copilotHandoff, /## My last request\nThis is a chat session/);
    assert.match(copilotHandoff, /## Your last reply\nHello!/);

    // VS Code Chat: a new chat in agent mode with the handoff typed in but not sent.
    const chatOpens = [];
    state.commands['workbench.action.chat.newChat'] = () => chatOpens.push('new');
    state.commands['workbench.action.chat.open'] = (o) => chatOpens.push(o);
    await state.commands['claudeSessions.continueInNewSession']({ sessionKey: chat.id });
    assert.equal(chatOpens[0], 'new');
    assert.equal(chatOpens[1].mode, 'agent');
    assert.equal(chatOpens[1].isPartialQuery, true);
    assert.match(chatOpens[1].query, /^I'm continuing work from an earlier VS Code Chat session \("Chat session overview"\)/);

    // Into another tool: pick Claude Code for the Copilot session; the earlier replies are Copilot's, not "yours".
    state.pick = (items) => items.find((i) => i.value === 'claude') ?? items[0];
    await state.commands['claudeSessions.continueInNewSessionWithModel'](copilotSession);
    const cc = state.terminals.pop();
    assert.equal(cc.shellPath, 'claude');
    const crossHandoff = cc.shellArgs[cc.shellArgs.length - 1];
    assert.match(crossHandoff, /## Copilot's last reply\nHello!/);
    // A VS Code chat as the target takes no model or effort.
    let picks = 0;
    state.pick = (items) => (picks++, items.find((i) => i.value === 'vscode-chat'));
    chatOpens.length = 0;
    await state.commands['claudeSessions.continueInNewSessionWithModel']({ sessionKey: `claude:${shared}` });
    assert.equal(picks, 1);
    assert.match(chatOpens[1].query, /earlier Claude Code session/);
    assert.match(chatOpens[1].query, /## Claude's last reply|## My last request/);

    // The Claude Code chat is offered only with the Claude Code extension, right after its CLI, and takes no model or
    // effort; the handoff goes into a new tab's input box as the open command's second argument.
    let tools;
    state.pick = (items) => ((tools = items), undefined);
    await state.commands['claudeSessions.continueInNewSessionWithModel'](copilotSession);
    assert.ok(!tools.some((i) => i.value === 'claude-chat'));
    state.extensions = { 'anthropic.claude-code': { extensionUri: { fsPath: root } } };
    const claudeOpens = [];
    state.commands['claude-vscode.editor.open'] = (...args) => claudeOpens.push(args);
    picks = 0;
    state.pick = (items) => ((tools = items), picks++, items.find((i) => i.value === 'claude-chat'));
    await state.commands['claudeSessions.continueInNewSessionWithModel'](copilotSession);
    assert.deepEqual(tools.map((i) => i.value), ['copilot-cli', 'claude', 'claude-chat', 'vscode-chat']);
    assert.match(tools[1].label, /Claude Code CLI$/);
    assert.equal(picks, 1);
    assert.equal(state.terminals.length, 0, 'no terminal');
    assert.equal(claudeOpens.length, 1);
    const [sessionId, prompt] = claudeOpens[0];
    assert.equal(sessionId, undefined, 'a new conversation, not a resumed one');
    assert.match(prompt, /^I'm continuing work from an earlier GitHub Copilot CLI session/);
    assert.match(prompt, /## Copilot's last reply\nHello!/);
    state.extensions = undefined;
    assert.deepEqual(state.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude Code agents: an agent step after effort for a new Claude Code CLI session, passed as --agent', async () => {
  const fixtures = path.join(__dirname, 'fixtures', 'claude-agents');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-agents-'));
  const projectsDir = path.join(root, 'projects');
  const repo = path.join(root, 'repo');
  const bare = path.join(root, 'bare');
  // The user's agents are read from CLAUDE_CONFIG_DIR/agents, so this keeps the test away from ~/.claude/agents.
  const configDir = path.join(root, 'config');
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    fs.cpSync(path.join(fixtures, 'project'), path.join(repo, '.claude', 'agents'), { recursive: true });
    fs.cpSync(path.join(fixtures, 'user'), path.join(configDir, 'agents'), { recursive: true });
    fs.mkdirSync(bare);
    const id = 'aaaa-2222';
    const ts = new Date().toISOString();
    writeSession(path.join(projectsDir, 'repo'), id, [{ type: 'user', message: { content: 'Plan the release' }, cwd: repo, timestamp: ts }]);
    writeSession(path.join(projectsDir, 'bare'), 'bbbb-3333', [{ type: 'user', message: { content: 'No agents here' }, cwd: bare, timestamp: ts }]);
    const state = {
      projectsDir,
      config: { copilotDir: path.join(root, 'none'), vscodeUserDir: path.join(root, 'none') },
      providers: {},
      commands: {},
      panels: [],
      panelPosts: [],
      errors: [],
      terminals: [],
      infos: [],
    };
    await activateWithSidebar(state);
    const session = { sessionKey: `claude:${id}` };
    const continueWithModel = (s = session) => state.commands['claudeSessions.continueInNewSessionWithModel'](s);
    const OTHER = '\0other-agent';

    // Tool, then model, effort and agent counted from 1: the agent step lists Default first, the project's agents,
    // the user's, and a typed name last.
    let shown = [];
    const answer = (values) => (items, options) => (shown.push({ items, title: options.title }), items.find((i) => i.value === values[shown.length - 1]));
    state.pick = answer(['claude', undefined, 'high', 'ship-it']);
    await continueWithModel();
    assert.deepEqual(shown.map((s) => s.title), [
      'Continue in New Session: tool',
      'Continue in New Session (1/3): model',
      'Continue in New Session (2/3): effort',
      'Continue in New Session (3/3): agent',
    ]);
    const agentStep = shown[3].items;
    assert.match(agentStep[0].label, /Default \(no agent\)$/);
    assert.equal(agentStep[0].value, undefined);
    assert.deepEqual(agentStep.slice(1).map((i) => [i.value, i.description]), [
      ['planner', 'project agent'],
      ['ship-it', 'project agent'],
      ['reviewer', 'user agent'],
      [OTHER, 'any agent Claude Code knows, as for claude --agent'],
    ]);
    assert.match(agentStep[4].label, /Enter an agent name…$/);
    assert.match(agentStep[3].detail, /^Reviews a diff/);
    let t = state.terminals.pop();
    assert.equal(t.shellPath, 'claude');
    assert.deepEqual(t.shellArgs.slice(0, 6), ['--effort', 'high', '--agent', 'ship-it', '--name', 'Continued: Plan the release']);

    // Default (no agent) adds no flag.
    shown = [];
    state.pick = answer(['claude', undefined, undefined, undefined]);
    await continueWithModel();
    t = state.terminals.pop();
    assert.equal(shown.length, 4);
    assert.deepEqual(t.shellArgs.slice(0, 2), ['--name', 'Continued: Plan the release']);

    // A typed name, trimmed. An empty name, or Esc in the name box, goes back to the list rather than cancelling.
    shown = [];
    state.pick = answer(['claude', undefined, undefined, OTHER, OTHER, OTHER]);
    const typed = ['   ', undefined, '  plugin:helper  '];
    state.input = () => typed.shift();
    await continueWithModel();
    assert.equal(shown.length, 6, 'the agent list came back twice');
    assert.deepEqual(state.terminals.pop().shellArgs.slice(0, 4), ['--agent', 'plugin:helper', '--name', 'Continued: Plan the release']);
    state.input = undefined;

    // Cancelling the agent step starts nothing.
    shown = [];
    state.pick = (items, options) => (shown.push(options.title), shown.length < 4 ? items.find((i) => i.value === 'claude') ?? items[0] : undefined);
    await continueWithModel();
    assert.equal(shown.length, 4);
    assert.equal(state.terminals.length, 0);

    // No agents in the session's folder or the user's: the step still shows, with Default and a typed name.
    fs.rmSync(path.join(configDir, 'agents'), { recursive: true });
    shown = [];
    state.pick = answer(['claude', undefined, undefined, undefined]);
    await continueWithModel({ sessionKey: 'claude:bbbb-3333' });
    assert.equal(shown[3].title, 'Continue in New Session (3/3): agent');
    assert.deepEqual(shown[3].items.map((i) => i.value), [undefined, OTHER]);
    assert.deepEqual(state.terminals.pop().shellArgs.slice(0, 2), ['--name', 'Continued: No agents here']);

    // Copilot CLI as the target: no agent step (its custom agents are a different thing), and the count says so.
    shown = [];
    state.pick = answer(['copilot-cli', undefined, undefined, 'planner']);
    await continueWithModel();
    assert.deepEqual(shown.slice(1).map((s) => s.title), ['Continue in New Session (1/2): model', 'Continue in New Session (2/2): effort']);
    assert.doesNotMatch(state.terminals.pop().sent, /--agent/);

    // Send with a model into a new Claude Code session: model, effort, agent.
    await state.commands['claudeSessions.openTranscript'](session);
    const send = async (mode) => {
      shown = [];
      state.pick = answer([undefined, undefined, 'ship-it']);
      await state.panels[0].onMessage({ command: 'send', text: 'Next', target: 'claude', mode, pickModel: true });
      await waitFor(() => state.terminals.length > 0, 'a terminal');
      return state.terminals.pop();
    };
    t = await send('handoff');
    assert.deepEqual(shown.map((s) => s.title), ['Send (1/3): model', 'Send (2/3): effort', 'Send (3/3): agent']);
    assert.deepEqual(t.shellArgs.slice(0, 4), ['--agent', 'ship-it', '--name', 'Continued: Plan the release']);
    // Resuming this same session: Claude Code ignores --agent with --resume, so there is no agent step.
    t = await send('same');
    assert.deepEqual(shown.map((s) => s.title), ['Send (1/2): model', 'Send (2/2): effort']);
    assert.deepEqual(t.shellArgs, ['--resume', id, 'Next']);
    assert.deepEqual(state.errors, []);
  } finally {
    if (savedConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subagent runs render as their own collapsible speakers in the transcript', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-subagents-'));
  const projectsDir = path.join(root, 'claude');
  try {
    fs.cpSync(path.join(__dirname, 'fixtures', 'claude-subagents'), projectsDir, { recursive: true });
    relocate(projectsDir, 'C:\\repo', path.join(root, 'repo'));
    const state = {
      projectsDir,
      config: { copilotDir: path.join(root, 'none'), vscodeUserDir: path.join(root, 'none') },
      providers: {},
      commands: {},
      panels: [],
      panelPosts: [],
      errors: [],
      terminals: [],
      infos: [],
    };
    const { send, last } = await activateWithSidebar(state);
    await state.commands['claudeSessions.openTranscript']({ sessionKey: 'claude:5e1f0c2a-1111-4222-8333-944455556666' });
    const html = state.panels[0].webview.html;
    const blocks = [...html.matchAll(/<div class="msg subagent">[\s\S]*?<\/details>\s*<\/div>\s*<\/div>/g)].map((m) => m[0]);
    assert.equal(blocks.length, 2);
    assert.match(blocks[0], /<strong>release-checker<\/strong><span class="pill subagent-pill">subagent<\/span>/);
    assert.match(blocks[0], /<span class="subagent-desc">Check release 1\.2\.0<\/span>/);
    assert.match(blocks[0], /class="subagent-prompt" open><summary>.*Prompt/, 'a short prompt is shown open');
    assert.match(blocks[0], /Check that release 1\.2\.0 is ready to ship/);
    // It ran in the background: the launch says so, and its reply is its own block where it arrived.
    assert.match(blocks[0], /codicon-run-all"><\/i>background<\/span>/);
    assert.match(blocks[0], /Started in the background/);
    assert.doesNotMatch(blocks[0], /88 of 88 pass/);
    assert.match(blocks[1], /<strong>Subagent<\/strong><time/, 'a one-off agent: generic label, no pill');
    assert.match(blocks[1], /Faster search/);
    const handbacks = [...html.matchAll(/<div class="msg subagent handback">[\s\S]*?<\/details>\s*<\/div>\s*<\/div>/g)].map((m) => m[0]);
    assert.equal(handbacks.length, 1);
    assert.match(handbacks[0], /<strong>release-checker<\/strong><span class="pill subagent-pill">subagent<\/span><span class="pill subagent-pill"><i class="codicon codicon-reply"><\/i>reply<\/span>/);
    assert.match(handbacks[0], /<span class="subagent-desc">Reply: Check release 1\.2\.0<\/span>/);
    assert.match(handbacks[0], /88 of 88 pass/);
    assert.match(handbacks[0], /<details class="subagent-card" open>/, 'a short reply is shown open');
    assert.doesNotMatch(handbacks[0], /subagent-prompt/, 'the prompt is shown once, at the launch');
    assert.doesNotMatch(html, /FOREIGN REPLY|OTHER SESSION REPLY|Subagent hand-back/);
    // Order: the main reply is split around each run, so it doesn't read as one block.
    const order = ['have the release checker look first', 'release-checker</strong>', 'While that runs', '<strong>Subagent</strong>', 'Reply: Check release 1.2.0', 'Both agents are done', 'Docs Lead'].map((s) => html.indexOf(s));
    assert.ok(order.every((i) => i > 0), `all found: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.equal((html.match(/<div class="msg assistant">/g) ?? []).length, 3);

    // A long reply starts collapsed, with a one-line preview in its header.
    const sub = path.join(projectsDir, 'C--repo', '5e1f0c2a-1111-4222-8333-944455556666', 'subagents');
    const longLog = fs
      .readFileSync(path.join(sub, 'agent-a2222222222222222.jsonl'), 'utf8')
      .replace('- Faster search', `- Faster search${'\\n- more'.repeat(40)}`);
    fs.writeFileSync(path.join(sub, 'agent-a2222222222222222.jsonl'), longLog);
    await state.commands['claudeSessions.openTranscript']({ sessionKey: 'claude:5e1f0c2a-1111-4222-8333-944455556666' });
    const again = state.panels[0].webview.html;
    assert.match(again, /<details class="subagent-card">\s*<summary>[\s\S]*?<span class="subagent-preview">## Notes for 1\.2\.0 - Faster search - more/);

    // Background runs that hand back later: each reply where it arrived, a long one collapsed.
    await state.commands['claudeSessions.openTranscript']({ sessionKey: 'claude:9b9b9b9b-1111-4222-8333-944455556666' });
    const bg = state.panels[0].webview.html;
    const replies = [...bg.matchAll(/<div class="msg subagent handback">[\s\S]*?<\/details>\s*<\/div>\s*<\/div>/g)].map((m) => m[0]);
    assert.deepEqual(
      replies.map((b) => /<strong>([^<]*)<\/strong>/.exec(b)[1]),
      ['ext-worker', 'Subagent', 'ext-worker', 'reviewer', 'Subagent'],
    );
    assert.match(replies[0], /<details class="subagent-card">\s*<summary>[\s\S]*?<span class="subagent-preview">\*\*SA-1 is done up to the merge/, 'a long reply starts collapsed');
    assert.match(replies[2], /<details class="subagent-card" open>[\s\S]*Lint fixed in a second commit/);
    const bgOrder = ['waiting for their reports', 'SA-1 is done up to the merge', 'Asking it to fix the lint', 'no entry for 0.4.7', 'Noted: the changelog', 'Lint fixed', 'Verdict on PR #47', 'shared fixture moved', 'Ready for you to merge'].map((s) => bg.indexOf(s));
    assert.ok(bgOrder.every((i) => i > 0), `all found: ${bgOrder}`);
    assert.deepEqual([...bgOrder].sort((a, b) => a - b), bgOrder);
    assert.doesNotMatch(bg, /task-notification|Subagent hand-back/);

    // Searching for a subagent's reply finds the session.
    send({ type: 'search', query: '"88 of 88"' });
    assert.deepEqual(last('searchResults').ids, ['claude:5e1f0c2a-1111-4222-8333-944455556666']);
    assert.deepEqual(state.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a subagent's full run opens from the transcript as a read-only transcript of its own log", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-subagent-run-'));
  const projectsDir = path.join(root, 'claude');
  const ID = '5e1f0c2a-1111-4222-8333-944455556666';
  const BG = '9b9b9b9b-1111-4222-8333-944455556666';
  try {
    fs.cpSync(path.join(__dirname, 'fixtures', 'claude-subagents'), projectsDir, { recursive: true });
    relocate(projectsDir, 'C:\\repo', path.join(root, 'repo'));
    const state = {
      projectsDir,
      config: { copilotDir: path.join(root, 'none'), vscodeUserDir: path.join(root, 'none') },
      providers: {},
      commands: {},
      panels: [],
      panelPosts: [],
      errors: [],
      terminals: [],
      infos: [],
      // Claude Code is installed, so the parent page has its Open in chat button and the run's page must not.
      extensions: { 'anthropic.claude-code': { extensionUri: { fsPath: root } } },
    };
    await activateWithSidebar(state);
    await state.commands['claudeSessions.openTranscript']({ sessionKey: `claude:${ID}` });
    const panel = state.panels[0];
    const parent = panel.webview.html;
    // Launch, hand-back and the one-off drafter each offer their run; the side panel's Subagents rows open the same.
    const opens = [...parent.matchAll(/<button class="subagent-open" data-cmd="openSubagent" data-arg="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(opens, ['a1111111111111111', 'a2222222222222222', 'a1111111111111111']);
    const side = /<details class="side-section" data-section="agents"[\s\S]*?<\/details>/.exec(parent)[0];
    assert.deepEqual([...side.matchAll(/data-cmd="openSubagent" data-arg="([^"]+)"/g)].map((m) => m[1]), ['a1111111111111111', 'a2222222222222222']);
    assert.match(parent, /data-cmd="resume"/);

    await panel.onMessage({ command: 'openSubagent', arg: 'a1111111111111111' });
    assert.equal(state.panels.length, 1, 'opens in the preview tab, like any transcript');
    const run = panel.webview.html;
    assert.equal(panel.title, 'release-checker: Check release 1.2.0');
    assert.match(run, /<h1>release-checker: Check release 1\.2\.0<\/h1>/);
    assert.match(run, /<span class="chip agent" title="Agent type"><i class="codicon codicon-hubot"><\/i>release-checker<\/span>/);
    const parentTitle = /<h1>(.*?)<\/h1>/.exec(parent)[1];
    assert.ok(run.includes(`<i class="codicon codicon-arrow-left"></i>${parentTitle}</button>`), 'a chip names the session that ran it');
    assert.match(run, /<span>Back to session<\/span>/);
    // Its tool calls and text, in order, with the main session as the one prompting it.
    const order = ['Main session', 'Check that release 1.2.0 is ready to ship', '<strong>release-checker</strong>', 'npm test', '88 passing', '88 of 88 pass'].map((s) => run.indexOf(s));
    assert.ok(order.every((i) => i > 0), `all found: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    // Read-only: nothing that resumes, continues, sends to or renames it.
    for (const cmd of ['resume', 'continueInNewSession', 'continueInNewSessionWithModel', 'openInClaudeCode', 'rename']) {
      assert.doesNotMatch(run, new RegExp(`data-cmd="${cmd}"`), cmd);
    }
    assert.doesNotMatch(run, /id="composer"/);
    // And the messages are ignored even if one arrives.
    for (const command of ['resume', 'continueInNewSession', 'openInClaudeCode', 'rename']) {
      await panel.onMessage({ command });
    }
    await panel.onMessage({ command: 'send', text: 'hello', target: 'claude', mode: 'same' });
    // No chat either: the page has no chat, and a chat message is ignored.
    assert.doesNotMatch(run, /id="chat-live"|id="chat-bar"/);
    const postsBefore = state.panelPosts.length;
    await panel.onMessage({ command: 'chatSend', text: 'hello', permissionMode: 'auto' });
    assert.equal(state.panelPosts.length, postsBefore, 'no reply, no chat');
    assert.equal(state.terminals.length, 0, 'nothing was resumed or sent');
    assert.equal(panel.webview.html, run);

    // Back to the session that ran it.
    await panel.onMessage({ command: 'openParent' });
    assert.match(panel.webview.html, /data-cmd="resume"/);
    assert.equal(/<h1>(.*?)<\/h1>/.exec(panel.webview.html)[1], parentTitle);

    // A run whose log is missing has no open control, and asking for it anyway shows a message, not an error.
    await state.commands['claudeSessions.openTranscript']({ sessionKey: `claude:${BG}` });
    const bg = panel.webview.html;
    const reviewer = [...bg.matchAll(/<div class="msg subagent[^"]*">[\s\S]*?<\/details>\s*<\/div>\s*<\/div>/g)].map((m) => m[0]).filter((b) => b.includes('<strong>reviewer</strong>'));
    assert.equal(reviewer.length, 2);
    assert.ok(reviewer.every((b) => !b.includes('subagent-open')));
    await panel.onMessage({ command: 'openSubagent', arg: 'a7777777777777777' });
    assert.equal(panel.webview.html, bg);
    assert.match(state.infos.at(-1), /no longer on disk/);

    // The worker's run: the main session's follow-up is its own prompt, between its two replies; Keep open keeps it.
    await panel.onMessage({ command: 'openSubagent', arg: 'a5555555555555555' });
    const worker = panel.webview.html;
    assert.equal((worker.match(/<div class="msg user"/g) ?? []).length, 2);
    assert.ok(worker.indexOf('SA-1 is done up to the merge') < worker.indexOf('Fix the lint warning'));
    assert.ok(worker.indexOf('Fix the lint warning') < worker.indexOf('Lint fixed in a second commit'));
    await panel.onMessage({ command: 'keepOpen' });
    await panel.onMessage({ command: 'openParent' });
    assert.equal(state.panels.length, 2, 'the kept run stays; the session opens in a new preview tab');
    assert.match(state.panels[1].webview.html, /data-cmd="resume"/);

    // A log deleted after the page rendered: a message, no throw.
    fs.rmSync(path.join(projectsDir, 'C--repo', BG, 'subagents', 'agent-a6666666666666666.jsonl'));
    await state.panels[1].onMessage({ command: 'openSubagent', arg: 'a6666666666666666' });
    assert.match(state.infos.at(-1), /no longer on disk/);
    assert.deepEqual(state.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('New Claude Code Session: folder, model, effort and agent, started as argv in that folder', async () => {
  const fixtures = path.join(__dirname, 'fixtures', 'claude-agents');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-new-'));
  // The projects folder and every folder a session starts in are under the temp root. This test needs user agents,
  // so it points CLAUDE_CONFIG_DIR at its own folder with some, then puts back the file's empty sandbox.
  const configDir = path.join(root, 'config');
  const projectsDir = path.join(configDir, 'projects');
  const repo = path.join(root, 'repo');
  const other = path.join(root, 'other');
  const picked = path.join(root, 'picked');
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.cpSync(path.join(fixtures, 'project'), path.join(repo, '.claude', 'agents'), { recursive: true });
    fs.cpSync(path.join(fixtures, 'user'), path.join(configDir, 'agents'), { recursive: true });
    fs.mkdirSync(other);
    fs.mkdirSync(picked);
    const state = {
      projectsDir,
      config: { copilotDir: path.join(root, 'none'), vscodeUserDir: path.join(root, 'none') },
      providers: {},
      commands: {},
      panels: [],
      panelPosts: [],
      errors: [],
      terminals: [],
      infos: [],
    };
    const { vscode } = await activateWithSidebar(state);
    const folder = (p) => ({ name: path.basename(p), uri: { ...vscode.Uri.file(p), scheme: 'file' } });
    // A virtual folder has no path a terminal can start in, so it is not offered.
    vscode.workspace.workspaceFolders = [folder(repo), folder(other), { name: 'remote', uri: { ...vscode.Uri.file('/r'), scheme: 'vscode-vfs' } }];
    let dialogs = [];
    let dialogAnswer;
    vscode.window.showOpenDialog = async (options) => (dialogs.push(options), dialogAnswer);
    let shown = [];
    const answer = (values) => (items, options) => (shown.push({ items, title: options.title }), items.find((i) => i.value === values[shown.length - 1]));
    const run = async (values) => {
      shown = [];
      dialogs = [];
      state.pick = answer(values);
      return state.commands['claudeSessions.newClaudeSession']();
    };
    const OTHER_FOLDER = '\0other-folder';
    const OTHER_AGENT = '\0other-agent';

    // Workspace folders first, then a folder dialog; model, effort and agent counted from 1 after it.
    assert.equal(await run([repo, 'opus', 'high', 'ship-it']), true);
    assert.deepEqual(shown.map((s) => s.title), [
      'New Claude Code Session: folder',
      'New Claude Code Session (1/3): model',
      'New Claude Code Session (2/3): effort',
      'New Claude Code Session (3/3): agent',
    ]);
    assert.deepEqual(shown[0].items.map((i) => i.value), [repo, other, OTHER_FOLDER]);
    // No session is being continued, so none of its model or effort is offered.
    assert.ok(!shown[1].items.some((i) => i.description === 'used by this session'));
    assert.ok(!shown[2].items.some((i) => i.description === 'used by this session'));
    // The agents of the chosen folder, then the user's.
    assert.deepEqual(shown[3].items.map((i) => [i.value, i.description]).slice(1, -1), [
      ['planner', 'project agent'],
      ['ship-it', 'project agent'],
      ['reviewer', 'user agent'],
    ]);
    let t = state.terminals.pop();
    assert.equal(t.shellPath, 'claude');
    assert.deepEqual(t.shellArgs, ['--model', 'opus', '--effort', 'high', '--agent', 'ship-it']);
    assert.equal(t.cwd, repo);
    assert.equal(t.name, 'Claude Code · repo');
    assert.equal(t.sent, undefined, 'argv, never sendText');

    // All defaults: claude with no arguments, in the folder chosen.
    assert.equal(await run([other, undefined, undefined, undefined]), true);
    t = state.terminals.pop();
    assert.deepEqual(t.shellArgs, []);
    assert.equal(t.cwd, other);
    // That folder has no project agents: only the user's are listed, including the planner the repo's own one hid.
    assert.deepEqual(shown[3].items.map((i) => [i.value, i.description]).slice(1, -1), [
      ['planner', 'user agent'],
      ['reviewer', 'user agent'],
    ]);

    // A typed agent name, and the claudeCommand setting split into executable and leading arguments.
    state.config.claudeCommand = 'npx claude';
    state.input = () => '  plugin:helper ';
    assert.equal(await run([repo, undefined, 'max', OTHER_AGENT]), true);
    t = state.terminals.pop();
    assert.equal(t.shellPath, 'npx');
    assert.deepEqual(t.shellArgs, ['claude', '--effort', 'max', '--agent', 'plugin:helper']);
    delete state.config.claudeCommand;
    state.input = undefined;

    // "Choose a folder…" opens a folder dialog; the folder picked there is where the session starts.
    dialogAnswer = [vscode.Uri.file(picked)];
    assert.equal(await run([OTHER_FOLDER, 'sonnet', undefined, undefined]), true);
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].canSelectFolders, true);
    assert.equal(dialogs[0].canSelectFiles, false);
    t = state.terminals.pop();
    assert.equal(t.cwd, picked);
    assert.deepEqual(t.shellArgs, ['--model', 'sonnet']);

    // No folder open: straight to the dialog, with no folder step.
    vscode.workspace.workspaceFolders = undefined;
    assert.equal(await run(['haiku', undefined, undefined]), true);
    assert.equal(dialogs.length, 1);
    assert.equal(shown[0].title, 'New Claude Code Session (1/3): model');
    t = state.terminals.pop();
    assert.equal(t.cwd, picked);
    assert.deepEqual(t.shellArgs, ['--model', 'haiku']);

    // Cancelling at any step opens nothing: the dialog, then each quick pick in turn.
    dialogAnswer = undefined;
    assert.equal(await run([]), false);
    assert.equal(dialogs.length, 1);
    vscode.workspace.workspaceFolders = [folder(repo)];
    assert.equal(await run([OTHER_FOLDER]), false);
    assert.equal(dialogs.length, 1);
    for (let step = 0; step < 4; step++) {
      // Answers the steps before `step` with their first value and cancels `step` itself.
      shown = [];
      state.pick = (items, options) => (shown.push(options.title), shown.length - 1 < step ? items[0] : undefined);
      assert.equal(await state.commands['claudeSessions.newClaudeSession'](), false);
      assert.equal(shown.length, step + 1);
    }
    assert.equal(state.terminals.length, 0);
    assert.deepEqual(state.errors, []);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = emptyConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a reply from the other branch of a forked log renders under its own prompt, marked as the other branch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-forked-'));
  const projectsDir = path.join(root, 'claude');
  const ID = '2b2b2b2b-1111-4222-8333-944455556666';
  try {
    fs.mkdirSync(path.join(projectsDir, 'C--repo'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'claude-code', 'forked-session.jsonl'), path.join(projectsDir, 'C--repo', `${ID}.jsonl`));
    relocate(projectsDir, 'C:\\repo', path.join(root, 'repo'));
    const state = {
      projectsDir,
      config: { copilotDir: path.join(root, 'none'), vscodeUserDir: path.join(root, 'none') },
      providers: {},
      commands: {},
      panels: [],
      panelPosts: [],
      errors: [],
      terminals: [],
      infos: [],
    };
    await activateWithSidebar(state);
    await state.commands['claudeSessions.openTranscript']({ sessionKey: `claude:${ID}` });
    const html = state.panels[0].webview.html;
    const mark = 'codicon-git-branch"></i>other branch</span>';
    const pill = html.indexOf(mark);
    assert.ok(pill > 0, 'the forked reply is marked');
    assert.equal(html.indexOf(mark, pill + 1), -1, 'only the forked reply is marked');
    const order = ['Explain the whole config pipeline', 'No response requested.', 'other branch</span>', 'reads, merges, then validates', 'Which file holds the defaults?', 'defaults.ts'].map((s) => html.indexOf(s));
    assert.ok(order.every((at) => at > 0), String(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.deepEqual(state.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a prompt typed while Claude was mid-turn renders as a user message marked as sent mid-turn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-queued-'));
  const projectsDir = path.join(root, 'claude');
  const ID = '0e0e0e0e-1111-4222-8333-944455556666';
  try {
    fs.mkdirSync(path.join(projectsDir, 'C--repo'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'claude-code', 'queued-prompt.jsonl'), path.join(projectsDir, 'C--repo', `${ID}.jsonl`));
    relocate(projectsDir, 'C:\\repo', path.join(root, 'repo'));
    const state = {
      projectsDir,
      config: { copilotDir: path.join(root, 'none'), vscodeUserDir: path.join(root, 'none') },
      providers: {},
      commands: {},
      panels: [],
      panelPosts: [],
      errors: [],
      terminals: [],
      infos: [],
    };
    const { send, last } = await activateWithSidebar(state);
    await state.commands['claudeSessions.openTranscript']({ sessionKey: `claude:${ID}` });
    const html = state.panels[0].webview.html;
    const users = [...html.matchAll(/<div class="msg user" id="msg-\d+"><div class="msg-meta">([\s\S]*?)<\/div><div class="bubble">([\s\S]*?)<\/div><\/div>/g)];
    assert.equal(users.length, 3);
    assert.doesNotMatch(users[0][1], /sent mid-turn/);
    assert.match(users[0][1], /turn-chip/, 'the prompt that started the turn carries its cost');
    assert.match(users[1][1], /codicon-history"><\/i>sent mid-turn<\/span>/);
    assert.doesNotMatch(users[1][1], /turn-chip/, 'a queued prompt has no cost of its own');
    assert.match(users[1][2], /read the handoff file if there is one/);
    assert.doesNotMatch(users[2][1], /sent mid-turn/);

    send({ type: 'search', query: '"read the handoff file if there is one"' });
    assert.deepEqual(last('searchResults').ids, [`claude:${ID}`]);
    assert.deepEqual(state.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a message from another session that arrived mid-turn renders as a session message from its sender', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-queued-peer-'));
  const projectsDir = path.join(root, 'claude');
  const ID = '0f0f0f0f-2222-4333-8444-955566667777';
  try {
    fs.mkdirSync(path.join(projectsDir, 'C--repo'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'claude-code', 'queued-peer-message.jsonl'), path.join(projectsDir, 'C--repo', `${ID}.jsonl`));
    relocate(projectsDir, 'C:\\repo', path.join(root, 'repo'));
    const state = {
      projectsDir,
      config: { copilotDir: path.join(root, 'none'), vscodeUserDir: path.join(root, 'none') },
      providers: {},
      commands: {},
      panels: [],
      panelPosts: [],
      errors: [],
      terminals: [],
      infos: [],
    };
    const { send, last } = await activateWithSidebar(state);
    await state.commands['claudeSessions.openTranscript']({ sessionKey: `claude:${ID}` });
    const html = state.panels[0].webview.html;
    const peers = [...html.matchAll(/<div class="msg peer">[\s\S]*?<strong>([^<]*)<\/strong><span class="pill">session message<\/span>[\s\S]*?<div class="peer-card">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g)];
    assert.equal(peers.length, 2);
    assert.equal(peers[0][1], 'Project Lead — split the parser work');
    assert.match(peers[0][2], /start on the parser scope now/);
    assert.match(peers[1][2], /Hold off on the Copilot reader/);

    send({ type: 'search', query: '"start on the parser scope now"' });
    assert.deepEqual(last('searchResults').ids, [`claude:${ID}`]);
    assert.deepEqual(state.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an open transcript follows its log as it grows, redrawing only what changed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-live-'));
  const projectsDir = path.join(root, 'claude');
  const ID = '1a1a1a1a-1111-4222-8333-944455556666';
  const log = path.join(projectsDir, 'C--repo', `${ID}.jsonl`);
  try {
    // The session so far: a prompt, a Read with its result, and an Edit still waiting for its result.
    const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-code', 'live-session.jsonl'), 'utf8').trimEnd().split('\n');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, lines.slice(0, 5).join('\n') + '\n');
    relocate(projectsDir, 'C:\\repo', path.join(root, 'repo'));
    const repo = JSON.stringify(path.join(root, 'repo')).slice(1, -1);
    const rest = lines.slice(5).map((l) => l.split('C:\\\\repo').join(repo));
    const state = {
      projectsDir,
      config: { copilotDir: path.join(root, 'none'), vscodeUserDir: path.join(root, 'none') },
      providers: {},
      commands: {},
      panels: [],
      panelPosts: [],
      errors: [],
      terminals: [],
      infos: [],
    };
    const { posted } = await activateWithSidebar(state);
    await state.commands['claudeSessions.openTranscript']({ sessionKey: `claude:${ID}` });
    const panel = state.panels[0];
    const page = panel.webview.html;
    // The page's blocks as drawn: one per entry, a prompt and the reply so far.
    const conversation = /<main class="conversation">\n([\s\S]*)\n<\/main>/.exec(page)[1];
    const pageBlocks = conversation.split(/\n?<div class="block" data-block="\d+">/).slice(1).map((b) => b.replace(/<\/div>$/, ''));
    const shown = pageBlocks.length;
    assert.equal(shown, 2);
    assert.match(page, /codicon-circle-large-outline status pending/, 'the Edit has no result yet');

    // The session watcher fires; the model re-reads the logs, and each open tab looks at its own.
    const sessionWatcher = state.watchers.find((w) => w.pattern.pattern === '*/*.jsonl');
    const reload = async () => {
      const before = posted.filter((m) => m.type === 'state').length;
      sessionWatcher.change.forEach((f) => f());
      await waitFor(() => posted.filter((m) => m.type === 'state').length > before, 'the model to reload', 5000);
    };
    const updates = () => state.panelPosts.filter((m) => m.type === 'update');

    // Nothing changed on disk: the tab is left alone.
    await reload();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(updates().length, 0, 'a log that did not change is not redrawn');

    // The Edit's result, the reply, the turn's end, a second prompt and its answer arrive.
    fs.appendFileSync(log, rest.join('\n') + '\n');
    await reload();
    await waitFor(() => updates().length === 1, 'the tab to post an update');
    assert.equal(panel.webview.html, page, 'the page is patched in place, not rebuilt');
    const { patch, heroStats, side, composer, title } = updates()[0];
    assert.ok(patch.length > shown, `new entries: ${patch.length} after ${shown}`);
    assert.equal(patch.added, patch.length - shown);
    const indexes = patch.blocks.map((b) => b.index);
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), 'in order');
    for (const b of patch.blocks.filter((x) => x.index < shown)) {
      assert.notEqual(b.html, pageBlocks[b.index], `block ${b.index} is only resent because it changed`);
    }
    // An earlier entry changed: the Edit's result landed on the tool call already on the page, and the reply that
    // followed it joined the same entry.
    const edit = patch.blocks.find((b) => b.index < shown && /tool-name">Edit</.test(b.html));
    assert.ok(edit, 'the Edit block is resent');
    assert.match(edit.html, /codicon-check status ok/);
    assert.match(edit.html, /<strong>loadConfig<\/strong>/);
    const added = patch.blocks.filter((b) => b.index >= shown).map((b) => b.html).join('');
    assert.match(added, /Now run the tests/);
    assert.match(added, /All 12 tests pass\./);
    // The rest of the page follows too: usage, side panel, the message box's view of the context.
    assert.match(heroStats, /class="stats"/);
    assert.match(side, /data-section="prompts"/);
    assert.equal(typeof composer.contextTokens, 'number');
    assert.equal(title, /<h1>(.*?)<\/h1>/.exec(page)[1]);

    // And once it is up to date, another reload sends nothing.
    await reload();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(updates().length, 1);
    assert.deepEqual(state.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a subagent run's tab follows the run's own log", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-live-run-'));
  const projectsDir = path.join(root, 'claude');
  const ID = '5e1f0c2a-1111-4222-8333-944455556666';
  const AGENT = 'a1111111111111111';
  try {
    fs.cpSync(path.join(__dirname, 'fixtures', 'claude-subagents'), projectsDir, { recursive: true });
    relocate(projectsDir, 'C:\\repo', path.join(root, 'repo'));
    const state = {
      projectsDir,
      config: { copilotDir: path.join(root, 'none'), vscodeUserDir: path.join(root, 'none') },
      providers: {},
      commands: {},
      panels: [],
      panelPosts: [],
      errors: [],
      terminals: [],
      infos: [],
    };
    await activateWithSidebar(state);
    await state.commands['claudeSessions.openTranscript']({ sessionKey: `claude:${ID}` });
    const panel = state.panels[0];
    await panel.onMessage({ command: 'openSubagent', arg: AGENT });
    const page = panel.webview.html;
    const runLog = path.join(projectsDir, 'C--repo', ID, 'subagents', `agent-${AGENT}.jsonl`);
    const watcher = state.watchers.find((w) => w.pattern.pattern === path.basename(runLog) && !w.disposed);
    assert.ok(watcher, "the tab watches the run's log");
    assert.equal(watcher.pattern.base.fsPath, path.dirname(runLog));

    const updates = () => state.panelPosts.filter((m) => m.type === 'update');
    fs.appendFileSync(
      runLog,
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        agentId: AGENT,
        sessionId: ID,
        parentUuid: 'r1u4',
        message: { role: 'assistant', id: 'msg_live_r9', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Release 1.2.0 handed over to the main session.' }] },
        uuid: 'r1a9',
        timestamp: '2026-11-20T10:02:00.000Z',
      }) + '\n',
    );
    watcher.change.forEach((f) => f());
    await waitFor(() => updates().length === 1, "the run's tab to post an update");
    assert.equal(panel.webview.html, page);
    const { patch, composer } = updates()[0];
    // The reply joins the agent's last entry, after its tool call: that one block is redrawn.
    assert.equal(patch.blocks.length, 1);
    assert.equal(patch.blocks[0].index, patch.length - 1);
    assert.match(patch.blocks[0].html, /Release 1\.2\.0 handed over to the main session\./);
    assert.equal(composer, undefined, 'a run has no message box');

    // Going back to the session stops watching the run.
    await panel.onMessage({ command: 'openParent' });
    assert.ok(watcher.disposed);
    assert.deepEqual(state.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Chat here: refuses a second writer, shows start errors in the tab, and spawns the CLI without a shell', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-chat-'));
  const projectsDir = path.join(root, 'claude');
  const repo = path.join(root, 'repo');
  const ID = '7c7c7c7c-1111-4222-8333-944455556666';
  const log = path.join(projectsDir, 'C--repo', `${ID}.jsonl`);
  try {
    fs.mkdirSync(repo);
    writeSession(path.dirname(log), ID, [
      { type: 'user', message: { content: 'Start the chat test' }, cwd: repo, uuid: 'l-1', timestamp: new Date().toISOString() },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Ready.' }] }, uuid: 'l-2', timestamp: new Date().toISOString() },
    ]);
    const state = {
      projectsDir,
      config: { copilotDir: path.join(root, 'none'), vscodeUserDir: path.join(root, 'none') },
      providers: {},
      commands: {},
      panels: [],
      panelPosts: [],
      errors: [],
      terminals: [],
      infos: [],
    };
    const { vscode } = await activateWithSidebar(state);
    const warnings = [];
    vscode.window.showWarningMessage = async (m) => (warnings.push(m), undefined);
    await state.commands['claudeSessions.openTranscript']({ sessionKey: `claude:${ID}` });
    const panel = state.panels[0];
    const chatSend = async (text) => {
      state.panelPosts.length = 0;
      await panel.onMessage({ command: 'chatSend', text, permissionMode: 'acceptEdits' });
      return state.panelPosts.find((m) => m.type === 'sent' || m.type === 'sendFailed')?.type;
    };
    const posted = (type) => state.panelPosts.filter((m) => m.type === type);

    // The log was written moments ago, perhaps by another Claude Code: asked first, and refused when not confirmed.
    assert.equal(await chatSend('hello'), 'sendFailed');
    assert.match(warnings.pop(), /written \d+s ago.*fork its log/);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(log, old, old);

    // Claude Code that cannot be found: the error shows in the tab, and the message goes back to the box.
    state.config.claudeCommand = path.join(root, 'missing', 'claude.exe');
    assert.equal(await chatSend('hello'), 'sent');
    await waitFor(() => posted('chatRestore').length, 'the message to come back');
    assert.equal(posted('chatRestore')[0].text, 'hello');
    await waitFor(() => posted('chatLive').some((m) => /needs the Claude Code executable/.test(m.html)), 'the error in the tab');

    // A real process, spawned without a shell in the session's folder: node, which rejects Claude Code's flags and
    // exits. Its exit code and stderr show in the tab, and the message it never took comes back.
    state.config.claudeCommand = process.execPath;
    assert.equal(await chatSend('hello again'), 'sent');
    await waitFor(() => posted('chatLive').some((m) => /exit code 9/.test(m.html)), 'the crash in the tab');
    assert.match(posted('chatLive').pop().html, /bad option: --resume/);
    await waitFor(() => posted('chatRestore').length, 'the message to come back');
    assert.equal(posted('chatRestore')[0].text, 'hello again');
    await waitFor(() => posted('chatState').at(-1)?.busy === false, 'the chat to settle');
    const stateMsg = posted('chatState').at(-1);
    assert.equal(stateMsg.running, false);
    assert.equal(stateMsg.mode, 'acceptEdits', 'the mode the page asked for');

    // The permission mode can change while no chat runs.
    state.panelPosts.length = 0;
    await panel.onMessage({ command: 'chatMode', mode: 'plan' });
    assert.equal(posted('chatState').at(-1).mode, 'plan');
    await panel.onMessage({ command: 'chatMode', mode: 'bypassPermissions' });
    assert.equal(posted('chatState').length, 1, 'an unknown mode is ignored');

    // Open in a terminal this extension started: Chat here refuses, naming the forked log.
    await state.commands['claudeSessions.resume']({ sessionKey: `claude:${ID}` });
    assert.equal(state.terminals.length, 1);
    assert.equal(await chatSend('hello'), 'sendFailed');
    assert.match(warnings.pop(), /open in a terminal.*fork its log/);

    // Closing the window ends every chat process.
    await require(path.join(process.env.EXT_DIR || path.join(__dirname, '..'), 'dist', 'extension.js')).deactivate();
    assert.deepEqual(state.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Chat here: Resume, Send to the CLI and Open in Claude Code ask to end the chat, which holds the session until its process exits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-chat-'));
  const projectsDir = path.join(root, 'claude');
  const repo = path.join(root, 'repo');
  const ID = '7d7d7d7d-1111-4222-8333-944455556666';
  const log = path.join(projectsDir, 'C--repo', `${ID}.jsonl`);
  // A stand-in for claude.exe that stays up between turns, answers each message with a result, and on stdin EOF
  // writes to the session log (as Claude Code does) and exits a moment later: the window the guards must cover.
  const standIn = path.join(root, 'stand-in.js');
  fs.writeFileSync(
    standIn,
    `const fs = require('fs');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.includes('"type":"user"')) {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 5 }) + '\\n');
    }
  }
});
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ type: 'system', subtype: 'stand-in', uuid: 's-' + process.pid }) + '\\n');
  setTimeout(() => process.exit(0), 400);
});
setInterval(() => {}, 1000);
`,
  );
  const cp = require('child_process');
  const realSpawn = cp.spawn;
  const spawned = [];
  cp.spawn = (exe, args, opts) => {
    if (exe !== process.execPath || !args.includes('--input-format')) {
      return realSpawn(exe, args, opts);
    }
    const earlierExited = spawned.every((c) => c.exitCode !== null || c.signalCode !== null);
    const child = realSpawn(process.execPath, [standIn], opts);
    spawned.push(Object.assign(child, { earlierExited }));
    return child;
  };
  const alive = (child) => child.exitCode === null && child.signalCode === null;
  try {
    fs.mkdirSync(repo);
    writeSession(path.dirname(log), ID, [
      { type: 'user', message: { content: 'Start the guard test' }, cwd: repo, uuid: 'g-1', timestamp: new Date().toISOString() },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Ready.' }] }, uuid: 'g-2', timestamp: new Date().toISOString() },
    ]);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(log, old, old);
    const state = {
      projectsDir,
      config: { copilotDir: path.join(root, 'none'), vscodeUserDir: path.join(root, 'none'), claudeCommand: process.execPath },
      providers: {},
      commands: {},
      panels: [],
      panelPosts: [],
      errors: [],
      terminals: [],
      infos: [],
      extensions: { 'anthropic.claude-code': { extensionUri: { fsPath: root } } },
    };
    const { vscode } = await activateWithSidebar(state);
    const warnings = [];
    let answer;
    vscode.window.showWarningMessage = async (m) => (warnings.push(m), answer);
    const opened = [];
    state.commands['claude-vscode.editor.open'] = (...a) => opened.push(a);
    const session = { sessionKey: `claude:${ID}` };
    await state.commands['claudeSessions.openTranscript'](session);
    const panel = state.panels[0];
    const posted = (type) => state.panelPosts.filter((m) => m.type === type);
    const chatSend = async (text) => {
      state.panelPosts.length = 0;
      await panel.onMessage({ command: 'chatSend', text });
      return state.panelPosts.find((m) => m.type === 'sent' || m.type === 'sendFailed')?.type;
    };
    const turnDone = () => waitFor(() => posted('chatState').at(-1)?.busy === false && posted('chatState').at(-1)?.running, 'the turn to end');

    assert.equal(await chatSend('hello'), 'sent');
    await turnDone();
    assert.equal(spawned.length, 1);

    // Declined: each refuses, starts nothing, and the chat carries on.
    const held = /being chatted with in its transcript tab.*fork its log/;
    assert.equal(await state.commands['claudeSessions.resume'](session), false);
    assert.match(warnings.pop(), held);
    assert.equal(await state.commands['claudeSessions.sendMessage'](session, 'to the CLI', 'claude', 'same', false), false);
    assert.match(warnings.pop(), held);
    assert.equal(await state.commands['claudeSessions.openInClaudeCode'](session), false);
    assert.match(warnings.pop(), held);
    assert.deepEqual(state.terminals, []);
    assert.deepEqual(opened, []);
    assert.ok(alive(spawned[0]), 'the chat process is still up');

    // Accepted: the chat ends, its process has exited, and only then does the session open elsewhere.
    answer = 'End Chat and Resume';
    // The session's folder is open in this window, so nothing else is asked.
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: repo, scheme: 'file' } }];
    assert.equal(await state.commands['claudeSessions.openInClaudeCode'](session), true);
    vscode.workspace.workspaceFolders = [];
    assert.match(warnings.pop(), held);
    assert.ok(!alive(spawned[0]), 'exited before the session opened elsewhere');
    assert.equal(opened[0][0], ID);
    answer = undefined;

    // Chatting again: the old process's own last log write is no other writer's, so nothing is asked.
    assert.equal(await chatSend('again'), 'sent');
    await turnDone();
    assert.equal(spawned.length, 2);
    assert.deepEqual(warnings, []);

    // End chat lets go of the process only once it has exited: until then the session is held, and a new message
    // waits for it rather than putting a second process on the log.
    const ending = panel.onMessage({ command: 'chatEnd' });
    assert.equal(await state.commands['claudeSessions.resume'](session), false);
    assert.match(warnings.pop(), held, 'still held while its process exits');
    assert.equal(await chatSend('third'), 'sent');
    await ending;
    assert.equal(spawned.length, 3);
    assert.ok(spawned[2].earlierExited, 'the new process started after the old one exited');
    await turnDone();
    assert.deepEqual(warnings, []);

    // Closing the tab: held until the process exits, and window close waits for that shutdown.
    panel.dispose();
    assert.equal(await state.commands['claudeSessions.resume'](session), false);
    assert.match(warnings.pop(), held);
    assert.ok(alive(spawned[2]));
    await require(path.join(process.env.EXT_DIR || path.join(__dirname, '..'), 'dist', 'extension.js')).deactivate();
    assert.ok(spawned.every((c) => !alive(c)), 'no chat process outlives the window');
    assert.deepEqual(state.terminals, []);
    assert.deepEqual(state.errors, []);
  } finally {
    cp.spawn = realSpawn;
    for (const c of spawned) {
      if (alive(c)) c.kill();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
