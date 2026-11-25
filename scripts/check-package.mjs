// Checks the list of files `vsce` would put in the .vsix, and fails if something is missing or should not ship.
// It runs in two places, from this one list of rules:
//   - CI (.github/workflows/test.yml), on a clean checkout. Gitignored folders such as .claude/ and .tmp/ never
//     exist there, so CI can only catch a .vscodeignore rule that would let one in.
//   - Every local `vsce package` (and `npm run package`), through the `vscode:prepublish` script. This is the run that
//     sees the real local-only files, because releases are packaged on the developer's machine.
//
//   node scripts/check-package.mjs [--list]      --list prints every packaged file first

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files the extension cannot work without. The webview scripts and styles in media/ are required too, but they are
 * listed by `mediaFiles()` from the checkout, so a new one is covered without editing this list.
 */
export const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/extension.js',
  'node_modules/@vscode/codicons/dist/codicon.css',
  'node_modules/@vscode/codicons/dist/codicon.ttf',
];

/** Sources, tests, tooling, local agent files and scratch output: none of it belongs in the .vsix. */
export const FORBIDDEN = /^(src|test|scripts|out|docs|\.claude|\.github|\.vscode|\.tmp)\/|\.map$|\.ts$|\.vsix$/;

/** Gitignored paths that are meant to ship: the bundle and the runtime files kept from node_modules. */
export const IGNORED_BUT_SHIPPED = /^(dist|node_modules)\//;

/**
 * What is wrong with a package file list. `ignored` is the subset of `files` that git ignores, or undefined when
 * git could not be asked. `required` is every file that must ship: REQUIRED plus the media/ files.
 */
export function packageProblems(files, ignored, required = REQUIRED) {
  const have = new Set(files);
  const problems = [];
  for (const f of required) if (!have.has(f)) problems.push(`missing from the package: ${f}`);
  const flagged = new Set();
  for (const f of files) {
    if (FORBIDDEN.test(f)) {
      problems.push(`should not ship: ${f}`);
      flagged.add(f);
    }
  }
  for (const f of ignored ?? []) {
    if (!IGNORED_BUT_SHIPPED.test(f) && !flagged.has(f)) problems.push(`gitignored, local-only file would ship: ${f}`);
  }
  return problems;
}

/** The subset of `files` git ignores, or undefined when this is not a git checkout or git is not installed. */
function gitIgnored(files) {
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: ROOT,
      input: files.join('\n') + '\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch (e) {
    // Exit status 1 means "none of them is ignored"; anything else means git could not answer.
    return e.status === 1 ? [] : undefined;
  }
}

/**
 * Every file in media/: the webview scripts and styles the sidebar, transcript and overview load, and the icon.
 * Tracked files come from git, so a stray local file is not demanded; without git, the folder is read instead.
 */
function mediaFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', 'media'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = out.split('\0').filter(Boolean);
    if (files.length) return files;
  } catch {
    // Not a git checkout, or git is not installed: fall through to the folder.
  }
  return readdirSync(path.join(ROOT, 'media'), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(ROOT, path.join(d.parentPath ?? d.path, d.name)).replace(/\\/g, '/'));
}

async function main() {
  const { listFiles } = createRequire(import.meta.url)('@vscode/vsce');
  const files = (await listFiles({ cwd: ROOT })).map((f) => f.replace(/\\/g, '/'));
  if (process.argv.includes('--list')) console.log(files.join('\n'));

  const ignored = gitIgnored(files);
  if (!ignored) console.warn('check-package: git is not available, so only the fixed patterns were checked.');

  const problems = packageProblems(files, ignored, [...REQUIRED, ...mediaFiles()]);
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    console.error(`check-package: ${problems.length} problem(s) in the .vsix file list. Fix .vscodeignore and try again.`);
    process.exit(1);
  }
  console.log(`check-package: ${files.length} files, nothing missing, nothing local-only.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
