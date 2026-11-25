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

test('local agent files, scratch files and sources are refused', async () => {
  const { packageProblems } = await load();
  const leaks = [
    '.claude/settings.local.json',
    '.claude/agents/ext-worker.md',
    '.tmp/wt-ls.txt',
    'src/extension.ts',
    'dist/extension.js.map',
    'sessionsai-0.4.9.vsix',
  ];
  const problems = packageProblems([...GOOD, ...leaks], [...GOOD_IGNORED, '.claude/settings.local.json']);
  assert.deepEqual(problems, leaks.map((f) => `should not ship: ${f}`));
});

test('any other gitignored file is refused, but the bundle and kept node_modules files are not', async () => {
  const { packageProblems } = await load();
  const problems = packageProblems([...GOOD, 'notes.local.txt'], [...GOOD_IGNORED, 'notes.local.txt']);
  assert.deepEqual(problems, ['gitignored, local-only file would ship: notes.local.txt']);
});
