#!/usr/bin/env node
/**
 * uitest — the pre-ship UI harness.
 *
 *   node tools/uitest/run.mjs                     every scenario
 *   node tools/uitest/run.mjs figures-web         one or more by name
 *   node tools/uitest/run.mjs --list              what is available
 *
 * Env:
 *   MOBILE=1      phone viewport (390x844) instead of desktop
 *   TABLET=1      students' Galaxy Tab A7/A6 portrait (800x1280, DPR 1.5); TABLET=land for 1280x800
 *   GEOM=1        dump every figure's measured geometry
 *   HEADFUL=1     show the browser
 *   UITEST_OUT=…  where screenshots and logs go (default: a tmpdir)
 *
 * Exit code is non-zero if any surface failed, so this is usable as a gate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Check } from './lib/asserts.mjs';
import { launchBrowser, isMobile, isGeom, isHeadful, viewportLabel, viewportSuffix } from './lib/browser.mjs';
import { ensureApp, stopSpawned, warm } from './lib/dev-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = path.join(HERE, 'scenarios');

const log = (msg = '') => process.stdout.write(`${msg}\n`);

async function loadScenarios() {
  const files = fs
    .readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .sort();

  const loaded = [];

  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(SCENARIO_DIR, file)).href);

    loaded.push({
      name: mod.name || path.basename(file, '.mjs'),
      title: mod.title || '',
      apps: mod.apps || (mod.app ? [mod.app] : []),
      warmup: mod.warmup || [],
      run: mod.run,
      file: path.join(SCENARIO_DIR, file),
    });
  }

  return loaded;
}

const argv = process.argv.slice(2);
const wanted = argv.filter((a) => !a.startsWith('-'));
const all = await loadScenarios();

if (argv.includes('--list') || argv.includes('-l')) {
  log('scenarios:');
  for (const s of all) log(`  ${s.name.padEnd(24)} ${s.apps.join(', ').padEnd(16)} ${s.title}`);
  process.exit(0);
}

const unknown = wanted.filter((w) => !all.some((s) => s.name === w));

if (unknown.length) {
  log(`unknown scenario(s): ${unknown.join(', ')}`);
  log(`available: ${all.map((s) => s.name).join(', ')}`);
  process.exit(2);
}

const selected = wanted.length ? all.filter((s) => wanted.includes(s.name)) : all;

const OUT =
  process.env.UITEST_OUT ||
  path.join(os.tmpdir(), 'ka-uitest', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));

fs.mkdirSync(OUT, { recursive: true });

log('════════════════════════════════════════════════════════════════');
log(`uitest — ${selected.length} scenario(s)`);
log(`  viewport : ${viewportLabel()}`);
log(`  browser  : ${isHeadful() ? 'headful (HEADFUL=1)' : 'headless'}`);
log(`  geometry : ${isGeom() ? 'dumped (GEOM=1)' : 'asserted only'}`);
log(`  artifacts: ${OUT}`);
log('════════════════════════════════════════════════════════════════');

const browser = await launchBrowser();
const runs = [];

try {
  for (const scenario of selected) {
    log(`\n╔══ ${scenario.name} — ${scenario.title}`);

    const surfaces = [];
    const startedAt = Date.now();
    const out = path.join(OUT, scenario.name);

    fs.mkdirSync(out, { recursive: true });

    let error = null;

    try {
      const apps = {};

      for (const appName of scenario.apps) {
        apps[appName] = await ensureApp(appName, { log: (m) => log(`   ${m}`) });
      }

      for (const [appName, route] of scenario.warmup) {
        if (apps[appName]) await warm(apps[appName].origin, route);
      }

      const ctx = {
        browser,
        apps,
        app: apps[scenario.apps[0]],
        out,
        log,
        env: { mobile: isMobile(), geom: isGeom(), headful: isHeadful() },
        surface(label) {
          log(`\n── ${label}`);
          const check = new Check(label, log);

          surfaces.push(check);

          return check;
        },
        async shot(page, name) {
          const file = path.join(out, `${name}${viewportSuffix()}.png`);

          await page.screenshot({ path: file, fullPage: true }).catch(() => {});

          return file;
        },
        write(name, data) {
          const file = path.join(out, name);

          fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');

          return file;
        },
      };

      await scenario.run(ctx);
    } catch (err) {
      error = err;
      const check = new Check(`${scenario.name} (harness)`, log);

      check.fail('scenario threw before finishing', String(err && err.stack ? err.stack.split('\n')[0] : err));
      surfaces.push(check);
    }

    const failed = surfaces.filter((s) => !s.passed);

    runs.push({
      scenario: scenario.name,
      surfaces,
      failed,
      ms: Date.now() - startedAt,
      out,
      error,
    });

    log(`╚══ ${scenario.name}: ${surfaces.length - failed.length}/${surfaces.length} surfaces passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }
} finally {
  await browser.close().catch(() => {});
  await stopSpawned((m) => log(m));
}

// ── report ──────────────────────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);
const rows = runs.map((r) => ({
  status: r.failed.length === 0 ? 'PASS' : 'FAIL',
  scenario: r.scenario,
  surfaces: `${r.surfaces.length - r.failed.length}/${r.surfaces.length}`,
  time: `${(r.ms / 1000).toFixed(1)}s`,
}));

log('\n════════════════════════════════════════════════════════════════');
log(`${pad('RESULT', 8)}${pad('SCENARIO', 26)}${pad('SURFACES', 10)}TIME`);
log('────────────────────────────────────────────────────────────────');
for (const row of rows) log(`${pad(row.status, 8)}${pad(row.scenario, 26)}${pad(row.surfaces, 10)}${row.time}`);
log('════════════════════════════════════════════════════════════════');

const failedRuns = runs.filter((r) => r.failed.length > 0);

if (failedRuns.length) {
  log('\nfailures:');
  for (const run of failedRuns) {
    for (const surface of run.failed) {
      log(`  ${run.scenario} › ${surface.label}`);
      for (const failure of surface.failures) log(`      ✗ ${failure}`);
    }
  }
}

const notes = runs.flatMap((r) => r.surfaces.flatMap((s) => s.notes.map((n) => `  ${r.scenario} › ${n}`)));

if (notes.length) {
  log('\nnotes:');
  for (const note of notes) log(note);
}

log(`\nartifacts: ${OUT}`);

fs.writeFileSync(
  path.join(OUT, 'summary.json'),
  JSON.stringify(
    {
      when: new Date().toISOString(),
      env: { mobile: isMobile(), geom: isGeom(), headful: isHeadful() },
      runs: runs.map((r) => ({
        scenario: r.scenario,
        ms: r.ms,
        out: r.out,
        surfaces: r.surfaces.map((s) => ({ label: s.label, passed: s.passed, failures: s.failures, notes: s.notes })),
      })),
    },
    null,
    2,
  ),
  'utf8',
);

log(`\n${failedRuns.length === 0 ? 'ALL SCENARIOS PASSED' : `${failedRuns.length} SCENARIO(S) FAILED`}`);
process.exit(failedRuns.length === 0 ? 0 : 1);
