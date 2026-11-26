// Runs the end-to-end scenarios in one isolated VS Code (docs/dev/e2e.md).
//
//   npm run test:e2e                          every area
//   npm run test:e2e -- --area chat           only the chat area (--area chat,sidebar for several)
//   npm run test:e2e -- --only stream         one scenario, by its exact name (repeat or comma-separate for several)
//   npm run test:e2e -- stop permission       only the scenarios whose name contains one of the words
//
// Scenarios live one module per area in test/e2e/scenarios/. Exits 1 when a scenario fails, 2 when an area or scenario
// name matches nothing. A failing scenario leaves a screenshot and the stand-in's events in .e2e-out/.
// E2E_KEEP=1 keeps the sandbox folder (logs, settings, events) and prints where it is.

import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OUT, events, launch, makeSandbox, removeSandbox, resetOut, sessionIdFor } from './harness.mjs';

const SCENARIO_TIMEOUT_MS = 90_000;
const AREAS_DIR = fileURLToPath(new URL('./scenarios/', import.meta.url));

/** Splits `--flag a,b`, `--flag=a,b` and repeats of them into one list; everything else is a positional word. */
function parseArgs(argv) {
  const flags = { area: [], only: [] };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(area|only)(?:=(.*))?$/.exec(argv[i]);
    if (m) {
      const value = m[2] ?? argv[++i];
      if (!value) fail(`--${m[1]} needs a value`);
      flags[m[1]].push(...value.split(',').map((v) => v.trim()).filter(Boolean));
    } else if (argv[i].startsWith('-')) {
      fail(`Unknown option ${argv[i]}. Options: --area <a,b>, --only <scenario>`);
    } else {
      words.push(argv[i]);
    }
  }
  return { ...flags, words };
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

/** Every area module, by file name: adding an area is adding a file. */
async function loadAreas() {
  const files = readdirSync(AREAS_DIR).filter((f) => f.endsWith('.mjs')).sort();
  const areas = [];
  for (const f of files) {
    const area = (await import(pathToFileURL(path.join(AREAS_DIR, f)).href)).default;
    const expected = f.replace(/\.mjs$/, '');
    if (!area || area.name !== expected || !Array.isArray(area.scenarios)) {
      fail(`scenarios/${f} must export default { name: '${expected}', scenarios: [...] }`);
    }
    areas.push(area);
  }
  return areas;
}

const args = parseArgs(process.argv.slice(2));
const allAreas = await loadAreas();
const known = allAreas.map((a) => a.name);
const unknown = args.area.filter((a) => !known.includes(a));
if (unknown.length) fail(`Unknown area ${unknown.join(', ')}. Areas: ${known.join(', ')}`);

// Session ids are numbered over every area, so a scenario keeps its session whichever areas are chosen.
let n = 0;
const planned = [];
for (const area of allAreas) {
  const fixtures = {};
  const fixtureSessions = (area.sessions ?? []).map((f) => ({ key: f.key, id: sessionIdFor(++n), prompt: f.prompt }));
  for (const f of fixtureSessions) fixtures[f.key] = { id: f.id, title: f.prompt };
  const scenarios = area.scenarios.map((sc) => ({ ...sc, area: area.name, id: sessionIdFor(++n), title: sc.prompt, fixtures }));
  planned.push({ area, fixtureSessions, scenarios });
}

const everyScenario = planned.flatMap((p) => p.scenarios);
const missing = args.only.filter((name) => !everyScenario.some((sc) => sc.name === name));
if (missing.length) fail(`No scenario named ${missing.join(', ')}. Scenarios: ${everyScenario.map((sc) => sc.name).join(', ')}`);

const chosenAreas = planned.filter((p) => !args.area.length || args.area.includes(p.area.name));
const chosen = chosenAreas
  .flatMap((p) => p.scenarios)
  .filter((sc) => !args.only.length || args.only.includes(sc.name))
  .filter((sc) => !args.words.length || args.words.some((w) => sc.name.includes(w)));
if (!chosen.length) fail(`No scenario matches ${[...args.area, ...args.only, ...args.words].join(', ')}. Scenarios: ${everyScenario.map((sc) => sc.name).join(', ')}`);

resetOut();
const sandboxSessions = [
  ...chosenAreas.filter((p) => chosen.some((sc) => sc.area === p.area.name)).flatMap((p) => p.fixtureSessions),
  ...chosen,
].map((x) => ({ id: x.id, prompt: x.prompt, log: x.log, files: x.files }));
const s = makeSandbox(sandboxSessions);
console.log(`Sandbox: ${s.dir}`);

let app;
let page;
const results = [];
try {
  ({ app, page } = await launch(s));
  for (const sc of chosen) {
    const started = Date.now();
    const ctx = { page, s, id: sc.id, title: sc.title, fixtures: sc.fixtures };
    try {
      await Promise.race([
        sc.run(ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`scenario took over ${SCENARIO_TIMEOUT_MS / 1000}s`)), SCENARIO_TIMEOUT_MS)),
      ]);
      results.push({ area: sc.area, name: sc.name, ok: true, ms: Date.now() - started });
      console.log(`ok   ${sc.area}/${sc.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (err) {
      const shot = path.join(OUT, `${sc.name}.png`);
      await page.screenshot({ path: shot }).catch(() => undefined);
      writeFileSync(path.join(OUT, `${sc.name}.events.json`), JSON.stringify(events(s, sc.id), null, 2));
      results.push({ area: sc.area, name: sc.name, ok: false, error: err.message });
      console.log(`FAIL ${sc.area}/${sc.name}: ${err.message}\n     screenshot: ${shot}`);
      // Close whatever the failure left open (a menu, a dialog) so the next scenario starts clean.
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }
} catch (err) {
  console.error(`The harness could not run: ${err.stack || err.message}`);
  if (page) await page.screenshot({ path: path.join(OUT, 'harness.png') }).catch(() => undefined);
  results.push({ area: 'harness', name: 'harness', ok: false, error: err.message });
} finally {
  if (app) {
    const closed = app.close().catch(() => undefined);
    const timedOut = await Promise.race([closed.then(() => false), new Promise((r) => setTimeout(() => r(true), 20_000))]);
    if (timedOut) app.process()?.kill();
  }
  if (process.env.E2E_KEEP) {
    console.log(`Kept the sandbox: ${s.dir}`);
  } else {
    await removeSandbox(s);
  }
}

console.log('');
for (const area of [...new Set(results.map((r) => r.area))]) {
  const mine = results.filter((r) => r.area === area);
  const bad = mine.filter((r) => !r.ok).length;
  console.log(`${area}: ${mine.length - bad} passed, ${bad} failed`);
}
const failed = results.filter((r) => !r.ok);
console.log(`Total: ${results.length - failed.length} passed, ${failed.length} failed`);
writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
