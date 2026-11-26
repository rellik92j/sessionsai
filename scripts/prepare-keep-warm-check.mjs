// Sets up the folders for SA-33, the manual check that a no-persist ping warms the prompt cache for a session resumed
// in an interactive terminal (docs/dev/keep-alive.md section 8). It makes no `claude` call: it only writes files, and
// the README it writes tells the user what to type. Not part of the extension: it is not bundled, not tested, and not
// packaged.
//
//   node scripts/prepare-keep-warm-check.mjs [<folder>] [--repo <checkout>] [--pr <number>]
//
//   <folder>         Where to put it (default: ~/sa33-keep-warm-check). Must be outside this repo and outside any
//                    synced folder (OneDrive, Dropbox, Google Drive, iCloud).
//   --repo <dir>     The checkout whose scripts the README points at (default: this one, or the main checkout when this
//                    script runs from an agent worktree under .claude/worktrees/, which is deleted after its PR).
//   --pr <number>    The PR that adds scripts/show-session-cache.mjs, named in the README's "before you start".
//
// It writes <folder>/README.txt and two session folders, warm/ and control/, each with part-1.txt to part-4.txt:
// synthetic filler (random common words from a fixed seed, nothing real), about 130 KB per folder, which is about
// what brought a haiku session to ~50k tokens in the SA-29 trial. Each folder's last line holds a different closing
// word, so the check's final question shows the model really has the files in context. Running it again rewrites
// these files and leaves anything else in the folder alone.

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--repo') opts.repo = next();
    else if (a === '--pr') opts.pr = next();
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (opts.folder) throw new Error(`one folder only (got ${opts.folder} and ${a})`);
    else opts.folder = a;
  }
  return opts;
}

const THIS_CHECKOUT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The main checkout for a worktree at <main>/.claude/worktrees/<name>, otherwise the checkout itself. */
function mainCheckout(dir) {
  const m = /^(.*)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(dir);
  return m ? m[1] : dir;
}

const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const slash = (p) => p.replace(/\\/g, '/');

// A tiny seeded generator (mulberry32), so a folder's text is the same on every run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'river stone window garden morning evening harbor meadow candle ladder basket bridge cottage valley orchard ' +
  'lantern pebble kettle blanket chimney fence pasture market village wagon barrel thimble compass journal ' +
  'paper pencil table chair carpet curtain mirror pillow saddle anchor rudder sail island shore tide current ' +
  'cloud thunder breeze frost meadowlark sparrow heron otter badger rabbit squirrel beetle cricket moth ' +
  'quiet bright gentle steady narrow broad ancient modest patient careful simple distant hollow golden silver ' +
  'walks carries gathers counts mends folds sorts follows watches waits returns opens closes lifts paints ' +
  'slowly often rarely early later nearly almost always never again together apart along across beneath ' +
  'the a an of to in on at by with from for over under near behind beyond between through around and but or ' +
  'baker weaver miller tailor carpenter shepherd gardener potter sailor teacher keeper painter clerk ' +
  'season harvest winter summer autumn spring letter story lesson recipe pattern measure balance rhythm ' +
  'copper timber linen wool clay bread honey salt apple barley onion pepper butter cheese cider tea'
).split(/\s+/);

/** One part file: a header, numbered sections of wrapped filler, and an optional last line. */
function partText(random, part, parts, targetBytes, lastLine) {
  const pick = () => WORDS[Math.floor(random() * WORDS.length)];
  const sentence = () => {
    const len = 7 + Math.floor(random() * 12);
    const words = Array.from({ length: len }, pick);
    words[0] = words[0][0].toUpperCase() + words[0].slice(1);
    return words.join(' ') + '.';
  };
  const lines = [`Part ${part} of ${parts}. Synthetic filler text for a prompt cache check. It has no meaning.`, ''];
  let size = lines.join('\n').length;
  let section = 0;
  while (size < targetBytes) {
    section++;
    const block = [`Section ${part}.${section}`];
    let line = '';
    for (let s = 0; s < 14; s++) {
      for (const w of sentence().split(' ')) {
        if (line && line.length + 1 + w.length > 100) {
          block.push(line);
          line = w;
        } else line = line ? `${line} ${w}` : w;
      }
    }
    if (line) block.push(line);
    block.push('');
    lines.push(...block);
    size += block.join('\n').length + 1;
  }
  if (lastLine) lines.push(lastLine, '');
  return lines.join('\n');
}

const PARTS = 4;
const PART_BYTES = 33_000;
const FOLDERS = [
  { name: 'warm', seed: 3301, word: 'lantern' },
  { name: 'control', seed: 3302, word: 'copper' },
];

function writeSessionFolder(root, { name, seed, word }) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const random = rng(seed);
  let bytes = 0;
  for (let p = 1; p <= PARTS; p++) {
    const last = p === PARTS ? `The closing word of this file set is ${word}.` : undefined;
    const text = partText(random, p, PARTS, PART_BYTES, last);
    writeFileSync(join(dir, `part-${p}.txt`), text);
    bytes += Buffer.byteLength(text);
  }
  return bytes;
}

function readme({ root, repo, pr }) {
  const warm = `${root}/warm`;
  const control = `${root}/control`;
  const prText = pr ? `PR #${pr} (branch prepare-keep-warm-terminal-check)` : 'The PR from branch prepare-keep-warm-terminal-check';
  const rule = '-'.repeat(100);
  return `SA-33 terminal check: does a no-persist ping warm the prompt cache for an interactive terminal resume?
Prepared by scripts/prepare-keep-warm-check.mjs (SA-40). Background: docs/dev/keep-alive.md, section 8.

This folder holds two session folders, each with four synthetic text files (random filler words, nothing real):
  warm      the session that gets one no-persist ping
  control   the same steps without the ping, to show what a cold resume looks like
About 130 KB per folder. Read in full, that brings a haiku session to roughly 50k tokens.
The whole check costs a few cents at haiku API prices, and it touches no real project.
All commands below are for PowerShell.

${rule}
Before you start (once)
${rule}
1. ${prText} must be merged first. It adds scripts/show-session-cache.mjs, which the steps below use
   to read a session's cache numbers.

2. Bring the main checkout up to date and compile it. trial-keep-warm.mjs loads out/claudeChat.js, which only
   exists after a compile. The main checkout is on main:

     cd ${repo}
     git pull --ff-only
     npm run compile

3. Paste these into every PowerShell window you use for the check:

     $repo    = '${repo}'
     $warm    = '${warm}'
     $control = '${control}'
     $show    = "$repo/scripts/show-session-cache.mjs"
     $ping    = "$repo/scripts/trial-keep-warm.mjs"

${rule}
Step 1. Build two ~50k-token sessions (a few minutes)
${rule}
First the warm session:

     cd $warm
     claude --model haiku

If Claude asks whether you trust the folder, say yes. Then type this prompt:

     Read part-1.txt, part-2.txt, part-3.txt and part-4.txt in this folder, each in full, then reply with only: done

Allow the reads if it asks. When it replies "done", type /exit. Then get the session id and show its requests:

     $warmId = node $show --cwd $warm --latest-id
     node $show --cwd $warm --id $warmId

The "last:" line's context should be roughly 40k to 60k tokens, on claude-haiku-*.

Then the control session, the same way:

     cd $control
     claude --model haiku
       (the same prompt, then /exit)
     $controlId = node $show --cwd $control --latest-id
     node $show --cwd $control --id $controlId

Write both ids down. In a new PowerShell window, set them again with  $warmId = '<id>'  and  $controlId = '<id>'
(or re-run the two --latest-id lines).

${rule}
Step 2. Resume each once in the terminal (about a minute)
${rule}
A session's second request rewrites about 4.5k tokens even when nothing changed. This gets that out of the way.

     cd $warm
     claude --resume $warmId --model haiku
       type:  Without using any tools, reply with only: ok
       then:  /exit

     cd $control
     claude --resume $controlId --model haiku
       (the same, then /exit)

Note the time. --model haiku keeps the terminal on the session's model; the cache is per model.

${rule}
Step 3. More than an hour later, ping the warm session only
${rule}
This account's cache lasts 1 hour. Waiting longer than that after step 2 means that, when you come back in step 4,
only the ping can have put the warm session's conversation in the cache. (No time to wait? See "Quick version".)

More than 60 minutes after step 2:

     cd $warm
     node $ping --cwd $warm --resume $warmId --say "Keep-alive ping. Reply with only: ok" '--' --no-session-persistence

The '--' is quoted so PowerShell passes it to node as it is. There is no --model and no --setting-sources on
purpose: the ping must use the same model and settings as the terminal.

In its output, check:
  - "turn 1: model claude-haiku-..." (the session's model).
  - The "request ...: input ..., cache read ..., cache write ..." line. After an hour the cache has expired, so
    expect a small read and a write of nearly the whole context. That write is what step 4 should read.
  - "log N lines before" and "log N lines after" show the same N: the ping left the session's log alone.

Do not ping the control session.

${rule}
Step 4. Two minutes after the ping, resume both in the terminal and ask one question
${rule}
     cd $warm
     claude --resume $warmId --model haiku
       type:  Without using any tools, what is the closing word at the end of part-4.txt? Reply with only that word.
       then:  /exit

     cd $control
     claude --resume $controlId --model haiku
       (the same question, then /exit)

Expected answers: "lantern" for warm, "copper" for control.

${rule}
Step 5. Read the cache numbers
${rule}
     node $show --cwd $warm --id $warmId
     node $show --cwd $control --id $controlId

The "last:" line of each is step 4's request (entrypoint "cli", the interactive terminal):
  - warm:    cache read should be nearly the whole context (well over 90%). The -p ping then wrote the same prefix
             the interactive terminal reads, and keep-warm works for terminal resumes.
  - control: cache read should be small (the shared tool definitions and system prompt at most) and cache write
             nearly the whole context. That is the cold resume the ping saved.
If warm looks like control, the ping warmed a prefix the terminal does not send (see "If the warm session missed").

Where the numbers come from, to check by hand: show-session-cache prints the log's path, which is
~/.claude/projects/<the folder path with every character other than a letter or digit turned into ->/<id>.jsonl
The last line in it with "type":"assistant" and "isSidechain":false has message.usage, with:
  cache_read_input_tokens       read from the cache
  cache_creation_input_tokens   written to the cache (cache_creation.ephemeral_1h_input_tokens: on the 1-hour TTL)
  input_tokens                  sent uncached
The context is the three added up.

${rule}
What to report back (for docs/dev/keep-alive.md section 8)
${rule}
Paste into the chat, or as a comment on SA-33:
  - the ping's output from step 3 (the turn, request and cost lines, and both log line counts)
  - the "last:" lines from step 5 for both sessions
  - the clock times of steps 2, 3 and 4
  - the output of  claude --version

${rule}
If the warm session missed
${rule}
The likely cause is a different tool list: an MCP server, plugin or setting that one of the two loads and the other
does not. Tools come first in the cached prefix, so one difference is a full miss. The session's log has
"api-request" records that may show what each process sent; give the agent the warm log's path from step 5 and it
can compare them.

${rule}
Quick version (about 5 minutes, weaker)
${rule}
If you cannot wait an hour: do steps 1 and 2 for warm only, then step 3 straight away, and step 4 two minutes later.
The evidence is then the ping's own cache read in step 3: the only cache entry it could read the conversation from
was written by the terminal in step 2, so a read of nearly the whole context means the -p ping sends the same
prefix as the terminal. Step 4 proves less in this version, because step 2's cache is still warm anyway.
`;
}

function main(opts) {
  const root = resolve(opts.folder ?? join(homedir(), 'sa33-keep-warm-check'));
  const repo = slash(resolve(opts.repo ?? mainCheckout(THIS_CHECKOUT)));

  if (/onedrive|dropbox|google drive|icloud/i.test(root)) {
    throw new Error(`${root} looks like a synced folder; pick a plain local one`);
  }
  for (const checkout of new Set([THIS_CHECKOUT, resolve(repo)])) {
    if (inside(root, checkout)) throw new Error(`${root} is inside the checkout ${checkout}; pick a folder outside it`);
  }

  mkdirSync(root, { recursive: true });
  for (const f of FOLDERS) {
    const bytes = writeSessionFolder(root, f);
    console.log(`${slash(join(root, f.name))}: ${PARTS} parts, ${Math.round(bytes / 1024)} KB, closing word "${f.word}"`);
  }
  const readmePath = join(root, 'README.txt');
  writeFileSync(readmePath, readme({ root: slash(root), repo, pr: opts.pr }).replace(/\n/g, '\r\n'));
  console.log(`${slash(readmePath)}: steps for SA-33, scripts from ${repo}`);
}

try {
  main(parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(`prepare-keep-warm-check: ${err.message}`);
  process.exit(1);
}
