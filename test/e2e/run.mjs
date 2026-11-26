// Runs the end-to-end scenarios in one isolated VS Code (docs/dev/e2e.md).
//
//   npm run test:e2e                     every scenario
//   npm run test:e2e -- stop permission  only the scenarios whose name contains one of the words
//
// Exits 1 when a scenario fails. A failing scenario leaves a screenshot and the stand-in's events in .e2e-out/.
// E2E_KEEP=1 keeps the sandbox folder (logs, settings, events) and prints where it is.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUT, events, launch, makeSandbox, removeSandbox, resetOut, sessionIdFor } from './harness.mjs';
import { SCENARIOS } from './scenarios.mjs';

const SCENARIO_TIMEOUT_MS = 90_000;

const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const chosen = SCENARIOS.map((sc, i) => ({ ...sc, id: sessionIdFor(i + 1), title: sc.prompt })).filter(
  (sc) => !filters.length || filters.some((f) => sc.name.includes(f)),
);
if (!chosen.length) {
  console.error(`No scenario matches ${filters.join(', ')}. Scenarios: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  process.exit(2);
}

resetOut();
const s = makeSandbox(chosen.map((sc) => ({ id: sc.id, prompt: sc.prompt })));
console.log(`Sandbox: ${s.dir}`);

let app;
let page;
const results = [];
try {
  ({ app, page } = await launch(s));
  for (const sc of chosen) {
    const started = Date.now();
    const ctx = { page, s, id: sc.id, title: sc.title };
    try {
      await Promise.race([
        sc.run(ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`scenario took over ${SCENARIO_TIMEOUT_MS / 1000}s`)), SCENARIO_TIMEOUT_MS)),
      ]);
      results.push({ name: sc.name, ok: true, ms: Date.now() - started });
      console.log(`ok   ${sc.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (err) {
      const shot = path.join(OUT, `${sc.name}.png`);
      await page.screenshot({ path: shot }).catch(() => undefined);
      writeFileSync(path.join(OUT, `${sc.name}.events.json`), JSON.stringify(events(s, sc.id), null, 2));
      results.push({ name: sc.name, ok: false, error: err.message });
      console.log(`FAIL ${sc.name}: ${err.message}\n     screenshot: ${shot}`);
      // Close whatever the failure left open (a menu, a dialog) so the next scenario starts clean.
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }
} catch (err) {
  console.error(`The harness could not run: ${err.stack || err.message}`);
  if (page) await page.screenshot({ path: path.join(OUT, 'harness.png') }).catch(() => undefined);
  results.push({ name: 'harness', ok: false, error: err.message });
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

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
