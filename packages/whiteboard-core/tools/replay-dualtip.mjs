#!/usr/bin/env node
// Replay a `/calibration` capture (schema `wb-dualtip-calib/v1`) through the REAL dual-tip decision
// code and report what the teacher would have experienced — without building or installing anything.
//
//   node tools/replay-dualtip.mjs <capture.json> [--finger 12] [--small 6] [--big 10] [--sweep]
//
// It imports src/dual-tip-contact.ts, the same module the canvas hook calls per pointer event, so a
// tuning change is measured against real strokes rather than argued about. `--sweep` grids the
// thresholds and prints the error surface.
import { readFileSync } from 'node:fs';
import { createContactState, resolveHeadColourRole, updateContactState } from '../src/dual-tip-contact.ts';

const args = process.argv.slice(2);
const numericFlags = new Set(['--finger', '--small', '--big', '--aspect', '--fast']);
const paths = args.filter((a, i) => !a.startsWith('--') && !numericFlags.has(args[i - 1]));

if (paths.length === 0) {
  console.error(
    'usage: node tools/replay-dualtip.mjs <capture.json...> [--finger N] [--small N] [--big N] [--legacy] [--sweep] [--by-tilt]',
  );
  process.exit(1);
}

const path = paths[0];

const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);

  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

// Several captures can be replayed together (strokes are namespaced per file so ids cannot collide).
// Identical files are dropped rather than double-counted — an export saved twice under different names
// would otherwise silently double every number in the report.
const captures = [];
const seenFingerprints = new Set();

for (const p of paths) {
  const parsed = JSON.parse(readFileSync(p, 'utf8'));
  const fingerprint = `${parsed.session?.sessionId}:${parsed.samples?.length}`;

  if (seenFingerprints.has(fingerprint)) {
    console.log(`(skipping ${p} — same capture as one already loaded: ${fingerprint})`);
    continue;
  }
  seenFingerprints.add(fingerprint);
  captures.push({ path: p, parsed });
}

const capture = captures[0].parsed;
const stored = capture.session?.tabletInputSettings ?? {};
// `--legacy` scores the capture under the pre-v0.1.142 rulebook instead, so the two can be compared on
// the same strokes rather than argued about. It reads the LEGACY bands by default (its own fit: single
// frames run larger than a settled size), which any explicit --small/--big/--finger still overrides.
const useLegacy = args.includes('--legacy');
const legacyStored = stored.dualTipStylus?.legacyBands ?? {};
const config = {
  smallHeadMaxWidth: flag(
    'small',
    useLegacy
      ? (legacyStored.smallHeadMaxWidth ?? 7)
      : (stored.dualTipStylus?.smallHeadMaxWidth ?? 7),
  ),
  bigHeadMaxWidth: flag(
    'big',
    useLegacy ? (legacyStored.bigHeadMaxWidth ?? 11) : (stored.dualTipStylus?.bigHeadMaxWidth ?? 11),
  ),
  fingerMinWidth: flag(
    'finger',
    useLegacy ? (legacyStored.fingerMinWidth ?? 14) : (stored.singleFingerPan?.minWidth ?? 14),
  ),
  ...(useLegacy ? { mode: 'legacy' } : {}),
  // `--aspect off` / `--fast off` disable the tilt guard and the immediate-commit shortcut.
  maxAspect: args[args.indexOf('--aspect') + 1] === 'off' ? Infinity : flag('aspect', undefined),
  fastPathMarginPx: args[args.indexOf('--fast') + 1] === 'off' ? Infinity : flag('fast', undefined),
};

// Group samples into strokes and rebuild the per-frame travel the live code sees.
const strokes = new Map();

for (const { path: file, parsed } of captures) {
  for (const s of parsed.samples ?? []) {
    const key = `${file}#${s.strokeId}`;

    if (!strokes.has(key)) strokes.set(key, []);
    strokes.get(key).push(s);
  }
}
for (const rows of strokes.values()) rows.sort((a, b) => a.sampleIndex - b.sampleIndex);

/** Run one stroke through the state machine; returns what the board would have done. */
function replay(rows, cfg) {
  let state = createContactState();
  const [x0, y0] = [rows[0].clientX, rows[0].clientY];

  for (const r of rows) {
    state = updateContactState(
      state,
      {
        width: r.width,
        height: r.height,
        travelPx: Math.hypot(r.clientX - x0, r.clientY - y0),
        elapsedMs: r.tSinceStrokeStartMs,
      },
      cfg,
    );
  }

  return state;
}

function score(cfg) {
  const out = { penPans: 0, fingerDraws: 0, wrongColour: 0, strokes: 0, rows: [] };

  for (const rows of strokes.values()) {
    const label = rows[0].label;
    const state = replay(rows, cfg);
    const isFinger = state.routing === true;
    let verdict = 'ok';

    out.strokes += 1;

    if (label === 'finger') {
      if (!isFinger) {
        out.fingerDraws += 1;
        verdict = 'FINGER DREW instead of panning';
      }
    } else if (isFinger) {
      out.penPans += 1;
      verdict = 'PEN PANNED instead of writing';
    } else {
      // Score the INK the teacher sees, not the internal head label: a contact classified "finger" that
      // still writes has a colour, and getting that colour wrong is the bug they report.
      const role = resolveHeadColourRole(state.head);
      const expected = label === 'small' ? 'primary' : 'secondary';

      if (role !== expected) {
        out.wrongColour += 1;
        verdict = `wrong colour: ${label} head inked ${role} (classified "${state.head}")`;
      }
    }

    // Peak elongation seen in the stroke = how hard the pen was leaning. Failures concentrating in the
    // high bands means the measure itself is breaking down under tilt, not that a threshold is off.
    const peakAspect = Math.max(
      ...rows
        .filter((r) => r.maxDim > 1 && r.minDim > 0)
        .map((r) => r.maxDim / r.minDim),
      1,
    );

    out.rows.push({ label, size: state.size, head: state.head, routing: state.routing, verdict, peakAspect });
  }

  return out;
}

if (args.includes('--sweep')) {
  // Sweeps the tunables that turned out to matter: the size threshold, the head bands, how elongated a
  // contact may be and still count as a finger, and whether the immediate-commit shortcut runs at all.
  console.log('finger small big  aspect  fast |  pen-pans  finger-draws  wrong-colour   TOTAL');
  const results = [];

  for (const finger of [10, 11, 12, 13, 14]) {
    for (const small of [5, 6, 7, 8]) {
      for (const big of [9, 10, 11, 12]) {
        for (const maxAspect of [1.5, 1.75, 2, 2.5, 3, Infinity]) {
          for (const fastPathMarginPx of [2, 4, Infinity]) {
            if (big <= small) continue;
            const cfg = {
              smallHeadMaxWidth: small,
              bigHeadMaxWidth: big,
              fingerMinWidth: finger,
              maxAspect,
              fastPathMarginPx,
            };
            const r = score(cfg);
            const total = r.penPans + r.fingerDraws + r.wrongColour;

            results.push({ finger, small, big, maxAspect, fastPathMarginPx, ...r, total });
          }
        }
      }
    }
  }
  results.sort((a, b) => a.total - b.total || a.penPans - b.penPans);
  const fmt = (v) => (Number.isFinite(v) ? String(v) : 'off');

  for (const r of results.slice(0, 15)) {
    console.log(
      `${String(r.finger).padStart(6)}${String(r.small).padStart(6)}${String(r.big).padStart(4)}` +
        `${fmt(r.maxAspect).padStart(8)}${fmt(r.fastPathMarginPx).padStart(6)} |` +
        `${String(r.penPans).padStart(10)}${String(r.fingerDraws).padStart(14)}` +
        `${String(r.wrongColour).padStart(14)}${String(r.total).padStart(8)}`,
    );
  }
  console.log(`\n(best of ${results.length} combinations, over ${strokes.size} strokes)`);
} else {
  const r = score(config);

  console.log(`capture: ${path}`);
  console.log(
    `config : ${useLegacy ? 'LEGACY rulebook' : 'height-aware rulebook'}  finger>=${config.fingerMinWidth}  small<=${config.smallHeadMaxWidth}  big<=${config.bigHeadMaxWidth}`,
  );
  console.log(`strokes: ${r.strokes}\n`);
  for (const row of r.rows) {
    if (row.verdict !== 'ok') {
      console.log(`  ${row.label.padEnd(7)} settled size ${String(row.size).padStart(4)}  → ${row.verdict}`);
    }
  }

  const pct = (n, of) => (of ? `${((100 * n) / of).toFixed(1)}%` : '—');
  const byLabel = (label) => r.rows.filter((row) => row.label === label);
  const failed = (label) => byLabel(label).filter((row) => row.verdict !== 'ok').length;
  const totalFailed = r.penPans + r.fingerDraws + r.wrongColour;

  console.log(`\n${'class'.padEnd(10)}${'strokes'.padStart(9)}${'failed'.padStart(9)}${'failure rate'.padStart(15)}`);
  for (const label of ['small', 'big', 'finger']) {
    const n = byLabel(label).length;

    console.log(`${label.padEnd(10)}${String(n).padStart(9)}${String(failed(label)).padStart(9)}${pct(failed(label), n).padStart(15)}`);
  }
  console.log(
    `${'ALL'.padEnd(10)}${String(r.strokes).padStart(9)}${String(totalFailed).padStart(9)}${pct(totalFailed, r.strokes).padStart(15)}`,
  );
  if (args.includes('--by-tilt')) {
    const bands = [
      [1, 1.5, 'flat'],
      [1.5, 2, 'leaning'],
      [2, 2.5, 'tilted'],
      [2.5, 3, 'hard tilt'],
      [3, Infinity, 'extreme'],
    ];

    console.log(`\n${'tilt (peak w:h)'.padEnd(22)}${'strokes'.padStart(9)}${'failed'.padStart(9)}${'failure rate'.padStart(15)}`);
    for (const [lo, hi, name] of bands) {
      const inBand = r.rows.filter((row) => row.peakAspect >= lo && row.peakAspect < hi);
      const bad = inBand.filter((row) => row.verdict !== 'ok').length;
      const range = hi === Infinity ? `${lo}+` : `${lo}-${hi}`;

      console.log(
        `${`${name} (${range})`.padEnd(22)}${String(inBand.length).padStart(9)}${String(bad).padStart(9)}${pct(bad, inBand.length).padStart(15)}`,
      );
    }
  }

  console.log(
    `\nby failure mode:` +
      `\n  pen strokes that panned : ${String(r.penPans).padStart(2)}  (${pct(r.penPans, r.strokes)} of all strokes)` +
      `\n  fingers that drew       : ${String(r.fingerDraws).padStart(2)}  (${pct(r.fingerDraws, r.strokes)})` +
      `\n  wrong stroke colour     : ${String(r.wrongColour).padStart(2)}  (${pct(r.wrongColour, r.strokes)})`,
  );
}
