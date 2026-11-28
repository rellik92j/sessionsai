// Sets up the folders for a manual check of keep-warm against an interactive terminal (docs/dev/keep-alive.md section
// 8). It makes no `claude` call: it only writes files, and the README it writes tells the user what to type. Not part
// of the extension: it is not bundled, not tested, and not packaged.
//
//   node scripts/prepare-keep-warm-check.mjs [<folder>] [--check sa72|sa33] [--repo <checkout>] [--pr <number>]
//
//   <folder>         Where to put it (default: ~/<check>-keep-warm-check). Must be outside this repo and outside any
//                    synced folder (OneDrive, Dropbox, Google Drive, iCloud).
//   --check <name>   sa72 (default): pings from the extension's keep-warm module (scripts/keep-session-warm.mjs) at
//                    about 0, 50 and 100 minutes, then a terminal resume at about 110, to see whether repeated pings
//                    keep the terminal's own cache entry alive. sa33 (done): one ping from trial-keep-warm.mjs.
//   --repo <dir>     The checkout whose scripts the README points at (default: this one, or the main checkout when this
//                    script runs from an agent worktree under .claude/worktrees/, which is deleted after its PR).
//   --pr <number>    The PR that adds the scripts the check needs, named in the README's "before you start".
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
    else if (a === '--check') opts.check = next();
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (opts.folder) throw new Error(`one folder only (got ${opts.folder} and ${a})`);
    else opts.folder = a;
  }
  opts.check ??= 'sa72';
  if (!READMES[opts.check]) throw new Error(`--check is sa72 or sa33 (got ${opts.check})`);
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

function readmeSa33({ root, repo, pr }) {
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
1. ${prText} must be merged first.
   It adds scripts/show-session-cache.mjs, which the steps below use to read a session's cache numbers.

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
Step 3. Between 15 and 50 minutes after step 2, ping the warm session only
${rule}
This account's cache lasts 1 hour from its last read. The ping must land while the terminal's entry from step 2 is
still alive: a ping reads that entry and refreshes its lifetime, but it cannot recreate one that has expired (its
own entry ends about 1.9k tokens past the terminal's, so the terminal's next request diverges before it). A first
run of this check pinged after the hour and measured nothing but that. (No time to wait? See "Quick version".)

Note the time of step 2, then ping 15 to 50 minutes after it:

     cd $warm
     node $ping --cwd $warm --resume $warmId --say "Keep-alive ping. Reply with only: ok" '--' --no-session-persistence

The '--' is quoted so PowerShell passes it to node as it is. There is no --model and no --setting-sources on
purpose: the ping must use the same model and settings as the terminal.

In its output, check:
  - "turn 1: model claude-haiku-..." (the session's model).
  - The "request ...: input ..., cache read ..., cache write ..." line. The terminal's entry is still alive, so
    expect a cache read of nearly the whole context (the terminal's) and a write of only about 2k tokens (the
    ping's own tail). A read of 0 means the entry had already expired: start again.
  - "log N lines before" and "log N lines after" show the same N: the ping left the session's log alone.

Do not ping the control session.

${rule}
Step 4. More than 60 minutes after step 2, resume both in the terminal and ask one question
${rule}
Wait until more than an hour has passed since step 2 (so the control's entry has expired), but resume warm within
an hour of the ping. The ping is what keeps warm's entry alive past that hour.

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
  - warm:    cache read should be nearly the whole context (well over 90%). The ping then kept the terminal's own
             entry alive past its hour, and keep-warm works for terminal resumes.
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
prefix as the terminal. Step 4 proves less in this version, because step 2's cache is still warm anyway; it does
not show that a ping keeps an entry alive past its hour.
`;
}

function readmeSa72({ root, repo, pr }) {
  const warm = `${root}/warm`;
  const control = `${root}/control`;
  const branch = 'keep-session-cache-warm-on-a-schedule';
  const prText = pr ? `PR #${pr} (branch ${branch})` : `The PR from branch ${branch}`;
  const rule = '-'.repeat(100);
  return `SA-72 timed check: do repeated keep-warm pings keep a terminal session's own cache entry alive?
Prepared by scripts/prepare-keep-warm-check.mjs --check sa72 (SA-35). Background: docs/dev/keep-alive.md, section 8.

SA-33 showed that one -p ping, sent while a terminal session's cache entry is still alive, keeps it alive past its
hour. This check asks what happens after that. Each ping's text now differs on purpose (it carries its number and
time), so each ping should read the terminal's own entry and refresh it, rather than the previous ping's longer
entry. If that works, a session kept warm for hours still resumes warm in the terminal.

The pings come from the extension's own keep-warm code (out/keepWarm.js), through scripts/keep-session-warm.mjs:
the same schedule, ping text, retry and spend cap the extension will use. It pings at about 0, 50 and 100 minutes.

This folder holds two session folders, each with four synthetic text files (random filler words, nothing real):
  warm      the session that is kept warm
  control   the same steps without any ping, to show what a cold resume looks like
The whole check costs about 20 cents at Haiku API prices and touches no real project. It takes about two hours, most
of it waiting. All commands below are for PowerShell.

${rule}
Before you start (once)
${rule}
1. ${prText} must be merged first. It adds scripts/keep-session-warm.mjs.

2. Bring the main checkout up to date and compile it. keep-session-warm.mjs loads out/keepWarm.js, which only exists
   after a compile. The main checkout is on main:

     cd ${repo}
     git pull --ff-only
     npm run compile

3. Make sure the computer will not sleep for the next two hours (Settings > System > Power). If it sleeps past the
   cache's expiry, keep-warm stops by design ("the cache expired while the computer was asleep") and the check has
   to start again.

4. Paste these into every PowerShell window you use for the check:

     $repo    = '${repo}'
     $warm    = '${warm}'
     $control = '${control}'
     $show    = "$repo/scripts/show-session-cache.mjs"
     $keep    = "$repo/scripts/keep-session-warm.mjs"

${rule}
Step 1. Build two Haiku sessions of 50k to 100k tokens (a few minutes)
${rule}
First the warm session:

     cd $warm
     claude --model haiku

If Claude asks whether you trust the folder, say yes. Then type this prompt:

     Read part-1.txt, part-2.txt, part-3.txt and part-4.txt in this folder, each in full, then reply with only: done

Allow the reads if it asks. When it replies "done", type /exit. Then get the session id and show its requests:

     $warmId = node $show --cwd $warm --latest-id
     node $show --cwd $warm --id $warmId

The "last:" line's context should be roughly 50k to 100k tokens (SA-33's came to about 100k), on claude-haiku-*.

Then the control session, the same way:

     cd $control
     claude --model haiku
       (the same prompt, then /exit)
     $controlId = node $show --cwd $control --latest-id
     node $show --cwd $control --id $controlId

Write both ids down. In a new PowerShell window, set them again with  $warmId = '<id>'  and  $controlId = '<id>'
(or re-run the two --latest-id lines).

${rule}
Step 2. Resume each once in the terminal (about a minute). This is minute 0.
${rule}
A session's second request rewrites about 4.5k tokens even when nothing changed. This gets that out of the way, and
it gives both sessions a fresh terminal cache entry at the same moment. Control first, then warm:

     cd $control
     claude --resume $controlId --model haiku
       type:  Without using any tools, reply with only: ok
       then:  /exit

     cd $warm
     claude --resume $warmId --model haiku
       (the same, then /exit)

Note the time: this is minute 0. --model haiku keeps the terminal on the session's model; the cache is per model.
Then run  node $show --cwd $warm --id $warmId  and note the "last:" line's context: each ping should read about that
much from the cache.

${rule}
Step 3. Straight after step 2, start keeping the warm session warm (leave it running about 105 minutes)
${rule}
In its own PowerShell window (paste the variables from "Before you start" and set $warmId first):

     node $keep --cwd $warm --id $warmId --minutes 105 --ping-now --cap 0.25

--ping-now makes the first ping go at once, while the terminal's entry from step 2 is alive; the module then pings
50 minutes after each ping, so at about minute 0, 50 and 100. It stops by itself after 105 minutes and prints a
table of its pings. There is no --model on purpose: the ping must use the session's own model and settings. If the
log was written in the last 10 seconds it skips and tries again 30 seconds later; that is expected right after /exit.

While it runs:
  - Do not open either session in a terminal, in VS Code or anywhere else. Leave the control session alone entirely.
  - Do not close the window. Ctrl+C stops it early (and spoils the check).

At its first ping, check its "ping 1 init:" line: "model claude-haiku-..." and "permissionMode dontAsk".
Then, for every ping, the "ping N ok; cache read R, write W" line:
  - R about the context you noted in step 2, and W about 2k (1,924 in SA-33): the ping read the terminal's own entry
    and refreshed it. This is what the varying text is for.
  - R about 2k more than that, and W near 0: the ping read an earlier ping's entry instead. Note which pings did.
  - R near 0 and W the whole context: the cache had expired. Note the times.

${rule}
Step 4. Between minute 105 and minute 115, resume both in the terminal and ask one question
${rule}
After keep-session-warm has stopped (minute 105), and before minute 115:

     cd $warm
     claude --resume $warmId --model haiku
       type:  Without using any tools, what is the closing word at the end of part-4.txt? Reply with only that word.
       then:  /exit

     cd $control
     claude --resume $controlId --model haiku
       (the same question, then /exit)

Expected answers: "lantern" for warm, "copper" for control.

By minute 110, the terminal's entry from step 2 has outlived its hour twice over. It can only still be there if the
pings at minutes 50 and 100 refreshed it, not just their own entries.

${rule}
Step 5. Read the cache numbers
${rule}
     node $show --cwd $warm --id $warmId
     node $show --cwd $control --id $controlId

The "last:" line of each is step 4's request (entrypoint "cli", the interactive terminal):
  - warm:    cache read should be nearly the whole context (well over 90%). Repeated pings with varying text then
             keep the terminal's own entry alive for as long as keep-warm runs.
  - control: cache read should be small (the shared tool definitions and system prompt, about 29k at most) and cache
             write nearly the whole context. That is the cold resume keep-warm saves.
If warm looks like control, the pings refreshed only their own entries; say so, and paste the numbers.

${rule}
What to report back (for docs/dev/keep-alive.md section 8)
${rule}
Paste into the chat, or as a comment on SA-72:
  - keep-session-warm's whole output from step 3, including its "init:" lines and the table at the end
  - the context you noted in step 2
  - the "last:" lines from step 5 for both sessions
  - the clock times of steps 2 and 4
  - the output of  claude --version

${rule}
If the warm session missed
${rule}
First check the table from step 3. If every ping read about the step 2 context and wrote about 2k, the pings did read
the terminal's entry, and the miss is something else: a different tool list (an MCP server, plugin or setting that
the terminal loads and -p does not), or a sleep. Give the agent the warm log's path from step 5; its "api-request"
records may show what each process sent.
`;
}

const READMES = { sa72: readmeSa72, sa33: readmeSa33 };

function main(opts) {
  const root = resolve(opts.folder ?? join(homedir(), `${opts.check}-keep-warm-check`));
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
  writeFileSync(readmePath, READMES[opts.check]({ root: slash(root), repo, pr: opts.pr }).replace(/\n/g, '\r\n'));
  console.log(`${slash(readmePath)}: steps for ${opts.check.toUpperCase()}, scripts from ${repo}`);
}

try {
  main(parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(`prepare-keep-warm-check: ${err.message}`);
  process.exit(1);
}
