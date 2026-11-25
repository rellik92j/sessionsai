// Loads the bundled extension (dist/extension.js) against a fake VS Code API and drives the sidebar and
// transcript webviews. Catches packaging problems such as a dependency failing to load at activation.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
    RelativePattern: class {},
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
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
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

function writeSession(dir, id, lines) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('bundled extension activates, fills the sidebar, and renders a transcript', async () => {
  // EXT_DIR lets this run against an unpacked .vsix to check what actually ships.
  const extDir = process.env.EXT_DIR || path.join(__dirname, '..');
  const bundle = path.join(extDir, 'dist', 'extension.js');
  assert.ok(fs.existsSync(bundle), 'run `npm run bundle` first');

  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-'));
  const ts = new Date().toISOString();
  writeSession(path.join(projectsDir, 'C--repo'), 'aaaa-1111', [
    { type: 'user', message: { content: 'Add a **dark mode** toggle' }, cwd: 'C:\\repo', gitBranch: 'main', timestamp: ts },
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
    await new Promise((r) => setTimeout(r, 300));
    const msg = posted.filter((m) => m.type === 'state').pop();
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
    await state.commands['claudeSessions.searchForFile'](vscode.Uri.file(path.join('C:', 'repo', 'toggle.ts')));
    assert.deepEqual(posted.filter((m) => m.type === 'setQuery').pop(), { type: 'setQuery', query: 'toggle.ts' });
    await state.commands['claudeSessions.searchForFile'](vscode.Uri.file(path.join('C:', 'repo', 'dark mode.md')));
    assert.equal(posted.filter((m) => m.type === 'setQuery').pop().query, '"dark mode.md"');

    // Opening from a search passes the words on to the transcript page.
    handler({ type: 'run', command: 'openTranscript', id: 'aaaa-1111', highlight: ['const', 42] });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(state.panels.length, 1, 'existing panel reused');
    assert.match(state.panels[0].webview.html, /<body class="line-full" data-session="[^"]*" data-highlight="\[&quot;const&quot;\]">/);
    assert.deepEqual(state.errors, []);

    // The transcriptLineWidth setting becomes a class on the page; an unknown value falls back to full.
    state.config = { ...(state.config ?? {}), transcriptLineWidth: 'narrow' };
    handler({ type: 'run', command: 'openTranscript', id: 'aaaa-1111' });
    await new Promise((r) => setTimeout(r, 100));
    assert.match(state.panels[0].webview.html, /<body class="line-narrow"/);
    state.config.transcriptLineWidth = 'huge';
    handler({ type: 'run', command: 'openTranscript', id: 'aaaa-1111' });
    await new Promise((r) => setTimeout(r, 100));
    assert.match(state.panels[0].webview.html, /<body class="line-full"/);
    delete state.config.transcriptLineWidth;

    // Transcripts share one preview tab until kept open (Keep open button, or keepOpen from a double-click).
    const open = (id, ...args) =>
      state.commands['claudeSessions.openTranscript']({ ...sessionA, id, title: `Session ${id}` }, ...args);
    const sessionA = { id: 'aaaa-1111', filePath: path.join(projectsDir, 'C--repo', 'aaaa-1111.jsonl'), projectDir: 'C--repo', promptCount: 1 };
    const keepButton = /data-cmd="keepOpen"/;
    assert.match(state.panels[0].webview.html, keepButton, 'first tab is the preview');
    await open('bbbb');
    assert.equal(state.panels.length, 1, 'preview tab reused for another session');
    assert.equal(state.panels[0].title, 'Session bbbb');
    await state.panels[0].onMessage({ command: 'keepOpen' });
    await new Promise((r) => setTimeout(r, 50));
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
    await new Promise((r) => setTimeout(r, 300));
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
    await new Promise((r) => setTimeout(r, 300));
    const tm = state.terminals.pop();
    assert.equal(titles.length, 4, 'tool, model, effort, agent');
    assert.deepEqual(tm.shellArgs.slice(0, 6), ['--model', 'sonnet', '--effort', 'xhigh', '--name', 'Continued: Session bbbb']);
    // Default for both adds no flags; cancelling starts nothing.
    state.pick = (items) => items[0];
    await state.panels[0].onMessage({ command: 'continueInNewSessionWithModel' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(state.terminals.pop().shellArgs[0], '--name');
    state.pick = () => undefined;
    await state.panels[0].onMessage({ command: 'continueInNewSessionWithModel' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(state.terminals.length, 0);
    // Continuing a continued session doesn't stack the prefix.
    await state.commands['claudeSessions.continueInNewSession']({ ...sessionA, title: 'Continued: Continued: Session aaaa' });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(state.terminals.pop().shellArgs.slice(0, 2), ['--name', 'Continued: Session aaaa']);

    // Message box: the page says where it sends; sending resumes this session with the message as one argument.
    const composerData = (html) =>
      JSON.parse(/data-composer="([^"]*)"/.exec(html)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
    const box = composerData(state.panels[0].webview.html);
    assert.equal(box.target, 'claude', "the session's own tool by default");
    assert.deepEqual(box.targets.map((t) => [t.id, t.same]), [['claude', true], ['copilot-cli', false], ['vscode-chat', false]]);
    assert.equal(box.context, 0);
    assert.equal(typeof box.cacheExpires, 'number', 'when the prompt cache lapses, for the default');
    assert.equal(typeof box.contextTokens, 'number', 'and how big the conversation is');
    state.config = { ...(state.config ?? {}), closeTranscriptOnResume: false };
    const sendBox = async (msg) => {
      state.panelPosts.length = 0;
      await state.panels[0].onMessage({ command: 'send', ...msg });
      await new Promise((r) => setTimeout(r, 300));
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
    await new Promise((r) => setTimeout(r, 200));
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
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('C:\\repo') }];
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
  await new Promise((r) => setTimeout(r, 300));
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
    // Renamed but started without --agent: agent-name holds its name, which is no agent.
    writeSession(dir, 'plain-0002', [
      { type: 'custom-title', customTitle: 'Tidy the docs' },
      { type: 'agent-name', agentName: 'Tidy the docs' },
      { type: 'user', message: { content: 'Tidy the README' }, cwd: 'C:\\work\\demo', timestamp: '2026-11-19T09:00:00.000Z' },
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
    writeSession(path.join(projectsDir, 'C--repo'), shared, [
      { type: 'user', message: { content: 'Fix the login race' }, cwd: 'C:\\repo', timestamp: new Date().toISOString() },
    ]);
    fs.cpSync(path.join(fixtures, 'copilot-cli'), path.join(copilotDir, 'session-state'), { recursive: true });
    const chats = path.join(userDir, 'workspaceStorage', 'abc123', 'chatSessions');
    fs.mkdirSync(chats, { recursive: true });
    fs.copyFileSync(path.join(fixtures, 'vscode-chat', '63869299-99f3-491c-89c4-bb361f7147f7.jsonl'), path.join(chats, '63869299-99f3-491c-89c4-bb361f7147f7.jsonl'));
    fs.writeFileSync(path.join(userDir, 'workspaceStorage', 'abc123', 'workspace.json'), JSON.stringify({ folder: 'file:///c%3A/work/site' }));
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
      await new Promise((r) => setTimeout(r, 300));
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
