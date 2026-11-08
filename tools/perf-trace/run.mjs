#!/usr/bin/env node
/**
 * perf-trace — trace a whole user flow on the students' tablets and say where the time goes.
 *
 *   cd apps/study && TRACE_BUILD=1 next build --profile && next start -p 3022   # source maps + React profiling
 *   node tools/perf-trace/run.mjs [scenario] [--device a6|a7|both] [--base http://localhost:3022]
 *
 * Scenarios live in ./scenarios (default: landing). Each phase of the flow is cut out of one
 * continuous Chrome trace + CPU profile, and reported as:
 *   - wall time, long tasks (>50 ms) and total blocking time on the main thread
 *   - style/layout, paint, GC and script-load time
 *   - JS self time by ORIGINAL source file (via the build's source maps), and by «our code that
 *     caused it» (the nearest apps/ or packages/ frame up the stack)
 * Writes report.md, a trace-<device>.json and a profile-<device>.cpuprofile per device (open in chrome://tracing, DevTools
 * Performance «Load profile», or ui.perfetto.dev).
 *
 * Devices (root CLAUDE.md «Target devices»): CPU is throttled to approximate each tablet on a fast
 * desktop — A6 (SM-T585, Exynos 7870) 8×, A7 (SM-T505, Snapdragon 662) 4× — on an LTE-like link.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import playwright from 'playwright';

import { loadSourceMap } from './sourcemap.mjs';

const { chromium } = playwright;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const DEVICES = {
  a6: {
    label: 'Galaxy Tab A6 SM-T585 (8× CPU)',
    cpu: 8,
    ua: 'Mozilla/5.0 (Linux; Android 8.1.0; SM-T585) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  },
  a7: {
    label: 'Galaxy Tab A7 SM-T505 (4× CPU)',
    cpu: 4,
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  },
};

// The most common student device in prod (Oct 2026 device_profile): Galaxy Tab A9+, Snapdragon 695.
DEVICES.a9 = {
  label: 'Galaxy Tab A9+ SM-X216B (3× CPU)',
  cpu: 3,
  ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
};
// A mid-range Android phone (Galaxy A15/A16 class, Helio G99) — 57% of users are mid-tier Android.
DEVICES.phone = {
  label: 'Mid Android phone (4× CPU, 412×915)',
  cpu: 4,
  viewport: { width: 412, height: 915 },
  dpr: 2.625,
  ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
};

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);

  return i >= 0 ? args[i + 1] : def;
};
const scenarioName = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'landing';
const base = flag('base', 'http://localhost:3022');
const which = flag('device', 'both');
const nextDir = path.resolve(ROOT, flag('next-dir', 'apps/study/.next'));
const out = path.resolve(flag('out', path.join(ROOT, 'tools/perf-trace/out', scenarioName)));

fs.mkdirSync(out, { recursive: true });
const { phases } = await import(path.join(HERE, 'scenarios', `${scenarioName}.mjs`));

/* ---------- source attribution ---------- */
const maps = new Map();
const lookupFor = (url) => {
  if (maps.has(url)) return maps.get(url);
  let look = null;
  const m = url.match(/\/_next\/(static\/.+?\.js)(\?|$)/);

  if (m) {
    // The map's name is not the chunk's: read it from the chunk's `//# sourceMappingURL=` line.
    const js = path.join(nextDir, m[1]);

    if (fs.existsSync(js)) {
      const ref = fs.readFileSync(js, 'utf8').match(/\/\/# sourceMappingURL=(\S+)\s*$/)?.[1];
      const file = ref && path.join(path.dirname(js), ref);

      if (file && fs.existsSync(file)) look = loadSourceMap(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  }
  maps.set(url, look);

  return look;
};
const tidy = (src) => {
  if (!src) return null;
  const s = src
    .replace(/^.*?(\/|^)(\.\.\/)*(?=apps\/|packages\/|node_modules\/)/, '')
    .replace(/^turbopack:\/\/\/\[project\]\//, '');
  const nm = s.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);

  return nm ? `npm:${nm[1]}` : s;
};
const sourceOf = (frame) => {
  const { url, lineNumber, columnNumber, functionName } = frame;

  if (!url) return functionName ? `(${functionName})` : '(native)';
  if (url.endsWith('.wasm') || url.includes('wasm://')) return '(wasm) rive';
  const look = lookupFor(url);
  const src = look ? tidy(look(lineNumber, columnNumber)) : null;

  return src ?? url.replace(base, '').split('?')[0];
};
const isOurs = (s) => /^(apps|packages)\//.test(s);

/* ---------- one device run ---------- */
async function runDevice(key) {
  const dev = DEVICES[key];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: dev.viewport ?? { width: 800, height: 1280 },
    deviceScaleFactor: dev.dpr ?? 1.5,
    isMobile: true,
    hasTouch: true,
    userAgent: dev.ua,
    locale: 'en-US',
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: dev.cpu });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 70,
    downloadThroughput: 9e6 / 8,
    uploadThroughput: 3e6 / 8,
  });

  const events = [];

  cdp.on('Tracing.dataCollected', (d) => events.push(...d.value));
  const traceDone = new Promise((r) => cdp.once('Tracing.tracingComplete', r));

  await cdp.send('Tracing.start', {
    categories: [
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'blink.user_timing',
      'v8.execute',
      'v8',
      'loading',
      '__metadata',
    ].join(','),
    transferMode: 'ReportEvents',
  });
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
  await cdp.send('Profiler.start');

  const marks = [];
  const errors = [];

  page.on('pageerror', (e) => errors.push(e.message));
  for (const [i, phase] of phases.entries()) {
    await cdp.send('Tracing.recordClockSyncMarker', { syncId: `phase-${i}` });
    marks.push(phase.name);
    try {
      await phase.run(page, { base });
    } catch (e) {
      errors.push(`${phase.name}: ${e.message.split('\n')[0]}`);
      break;
    }
  }
  await cdp.send('Tracing.recordClockSyncMarker', { syncId: 'phase-end' });

  const { profile } = await cdp.send('Profiler.stop');

  await cdp.send('Tracing.end');
  await traceDone;
  await browser.close();
  fs.writeFileSync(path.join(out, `trace-${key}.json`), JSON.stringify({ traceEvents: events }));
  // The sampled CPU profile on its own (DevTools «Load profile» / speedscope), for per-function digging.
  fs.writeFileSync(path.join(out, `profile-${key}.cpuprofile`), JSON.stringify(profile));

  return analyse(dev, events, profile, marks, errors);
}

/* ---------- analysis ---------- */
function analyse(dev, events, profile, marks, errors) {
  // Phase boundaries from the clock-sync markers.
  const sync = events.filter((e) => e.name === 'clock_sync' && e.args?.sync_id).map((e) => [e.args.sync_id, e.ts]);
  const at = Object.fromEntries(sync);
  const bounds = marks.map((name, i) => ({
    name,
    t0: at[`phase-${i}`],
    t1: at[`phase-${i + 1}`] ?? at['phase-end'],
  }));

  // The renderer main thread that did the most work.
  const names = new Map(events.filter((e) => e.name === 'thread_name').map((e) => [`${e.pid}:${e.tid}`, e.args.name]));
  const load = {};

  for (const e of events)
    if (e.name === 'RunTask' && names.get(`${e.pid}:${e.tid}`) === 'CrRendererMain')
      load[`${e.pid}:${e.tid}`] = (load[`${e.pid}:${e.tid}`] || 0) + (e.dur || 0);
  const main = Object.entries(load).sort((a, b) => b[1] - a[1])[0]?.[0];
  const onMain = events.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === 'X');

  // CPU samples on the trace clock.
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();

  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const samples = [];
  let t = profile.startTime;

  profile.samples.forEach((id, i) => {
    t += profile.timeDeltas[i] || 0;
    samples.push([t, id, profile.timeDeltas[i + 1] || 0]);
  });

  const CAT = {
    'style + layout': ['UpdateLayoutTree', 'Layout', 'RecalculateStyles', 'InvalidateLayout'],
    paint: ['Paint', 'PaintImage', 'Layerize', 'Commit', 'PrePaint', 'UpdateLayer'],
    gc: ['MajorGC', 'MinorGC', 'V8.GC_MARK_COMPACTOR', 'BlinkGC.AtomicPhase'],
    'script load': ['EvaluateScript', 'v8.compile', 'v8.compileModule', 'CacheScript', 'ParseHTML'],
  };
  const rows = [];

  for (const b of bounds) {
    if (b.t0 == null || b.t1 == null) continue;
    const inPhase = onMain.filter((e) => e.ts >= b.t0 && e.ts < b.t1);
    const tasks = inPhase.filter((e) => e.name === 'RunTask');
    const long = tasks.filter((e) => e.dur > 50000);
    const cats = Object.fromEntries(
      Object.entries(CAT).map(([k, list]) => [
        k,
        inPhase.filter((e) => list.includes(e.name)).reduce((s, e) => s + (e.dur || 0), 0) / 1000,
      ]),
    );
    const selfBy = {};
    const causeBy = {};

    for (const [ts, id, dt] of samples) {
      if (ts < b.t0 || ts >= b.t1) continue;
      const node = byId.get(id);
      const fn = node.callFrame.functionName;

      if (fn === '(idle)' || fn === '(program)' || fn === '(root)') continue;
      // Playwright's own injected script (locators, actionability checks) is harness, not app.
      if (!node.callFrame.url && !fn.startsWith('(') && fn !== 'requestAnimationFrame') continue;
      const ms = dt / 1000;
      const src = fn === '(garbage collector)' ? '(gc)' : sourceOf(node.callFrame);

      selfBy[src] = (selfBy[src] || 0) + ms;
      let cur = id;
      let ours = null;

      for (let hop = 0; cur && hop < 200; hop += 1) {
        const s = sourceOf(byId.get(cur).callFrame);

        if (isOurs(s)) {
          ours = s;
          break;
        }
        cur = parent.get(cur);
      }
      const key = ours ?? (src.startsWith('npm:') || src.startsWith('(') ? src : '(other)');

      causeBy[key] = (causeBy[key] || 0) + ms;
    }
    rows.push({
      phase: b.name,
      wallMs: (b.t1 - b.t0) / 1000,
      longTasks: long.length,
      longestMs: Math.max(0, ...long.map((e) => e.dur / 1000)),
      tbtMs: long.reduce((s, e) => s + (e.dur / 1000 - 50), 0),
      busyMs: tasks.reduce((s, e) => s + (e.dur || 0), 0) / 1000,
      cats,
      selfBy,
      causeBy,
    });
  }

  return { dev, rows, errors };
}

const top = (obj, n) =>
  Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .filter(([, v]) => v >= 1);
const ms = (v) => `${Math.round(v)} ms`;

function report(results) {
  const L = [`# perf-trace: ${scenarioName}`, '', `Base ${base} · ${new Date().toISOString()}`, ''];

  for (const { dev, rows, errors } of results) {
    L.push(`## ${dev.label}`, '');
    if (errors.length) L.push(`Errors: ${errors.join(' · ')}`, '');
    L.push('| phase | wall | main busy | long tasks | longest | TBT | style+layout | paint | GC | script load |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows)
      L.push(
        `| ${r.phase} | ${ms(r.wallMs)} | ${ms(r.busyMs)} | ${r.longTasks} | ${ms(r.longestMs)} | ${ms(r.tbtMs)} | ${ms(r.cats['style + layout'])} | ${ms(r.cats.paint)} | ${ms(r.cats.gc)} | ${ms(r.cats['script load'])} |`,
      );
    L.push('');
    for (const r of rows) {
      if (r.busyMs < 30) continue;
      L.push(`### ${r.phase}`, '');
      L.push(
        `JS by source file (self): ${
          top(r.selfBy, 8)
            .map(([k, v]) => `\`${k}\` ${ms(v)}`)
            .join(' · ') || '—'
        }`,
        '',
      );
      L.push(
        `Caused by our code: ${
          top(r.causeBy, 8)
            .map(([k, v]) => `\`${k}\` ${ms(v)}`)
            .join(' · ') || '—'
        }`,
        '',
      );
    }
  }

  return L.join('\n');
}

const keys = which === 'both' ? ['a6', 'a7'] : which === 'all' ? ['a6', 'a7', 'a9', 'phone'] : which.split(',');
const results = [];

for (const k of keys) results.push(await runDevice(k));
const md = report(results);

fs.writeFileSync(path.join(out, 'report.md'), md);
console.log(md);
console.log(`\nWrote ${out}/report.md and trace-*.json`);
