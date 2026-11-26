const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../scripts/check-package.mjs')).href);

const GOOD = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'media/icon.png',
  'dist/extension.js',
  'node_modules/@vscode/codicons/dist/codicon.ttf',
  'node_modules/@vscode/codicons/dist/codicon.css',
];
const GOOD_IGNORED = GOOD.filter((f) => /^(dist|node_modules)\//.test(f));

test('a clean package list has no problems', async () => {
  const { packageProblems } = await load();
  assert.deepEqual(packageProblems(GOOD, GOOD_IGNORED), []);
  assert.deepEqual(packageProblems(GOOD, undefined), []);
});

test('a missing required file is reported', async () => {
  const { packageProblems } = await load();
  const files = GOOD.filter((f) => f !== 'dist/extension.js');
  assert.deepEqual(packageProblems(files, []), ['missing from the package: dist/extension.js']);
});

test('the codicon stylesheet is required', async () => {
  const { packageProblems } = await load();
  const css = 'node_modules/@vscode/codicons/dist/codicon.css';
  assert.deepEqual(packageProblems(GOOD.filter((f) => f !== css), []), [`missing from the package: ${css}`]);
});

test('webview files in media/ are required when passed in, as main() does', async () => {
  const { packageProblems, REQUIRED } = await load();
  const media = ['media/icon.png', 'media/sidebar.js', 'media/sidebar.css', 'media/transcript.js'];
  const required = [...REQUIRED, ...media];
  assert.deepEqual(packageProblems([...GOOD, ...media], [], required), []);
  // What a `media/**` line in .vscodeignore would do: every one of them drops out of the list.
  assert.deepEqual(
    packageProblems(GOOD.filter((f) => !f.startsWith('media/')), [], required),
    media.map((f) => `missing from the package: ${f}`),
  );
});

test('every webview asset the source loads from media/ is tracked in git', () => {
  // mediaFiles() requires what git tracks in media/. This ties that list to what the code loads, so a renamed or
  // new asset that was never committed is caught here rather than in a broken webview.
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const root = path.join(__dirname, '..');
  const tracked = new Set(execFileSync('git', ['ls-files', 'media'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/));
  const loaded = new Set();
  for (const f of fs.readdirSync(path.join(root, 'src')).filter((n) => n.endsWith('.ts'))) {
    const text = fs.readFileSync(path.join(root, 'src', f), 'utf8');
    for (const m of text.matchAll(/(?:uri\(media|joinPath\(this\.mediaUri),\s*'([^']+)'/g)) loaded.add(`media/${m[1]}`);
  }
  assert.ok(loaded.size >= 6, `expected the sidebar, transcript and overview assets, found ${[...loaded]}`);
  for (const f of loaded) assert.ok(tracked.has(f), `${f} is loaded by a webview but not tracked in git`);
});

test('local agent files, scratch files and sources are refused', async () => {
  const { packageProblems } = await load();
  const leaks = [
    '.claude/settings.local.json',
    '.claude/agents/ext-worker.md',
    '.tmp/wt-ls.txt',
    'src/extension.ts',
    'dist/extension.js.map',
    'sessionsai-0.4.9.vsix',
    'releases/sessionsai-0.4.9.vsix',
    'releases/notes.txt',
  ];
  const problems = packageProblems([...GOOD, ...leaks], [...GOOD_IGNORED, '.claude/settings.local.json']);
  assert.deepEqual(problems, leaks.map((f) => `should not ship: ${f}`));
});

test('any other gitignored file is refused, but the bundle and kept node_modules files are not', async () => {
  const { packageProblems } = await load();
  const problems = packageProblems([...GOOD, 'notes.local.txt'], [...GOOD_IGNORED, 'notes.local.txt']);
  assert.deepEqual(problems, ['gitignored, local-only file would ship: notes.local.txt']);
});
