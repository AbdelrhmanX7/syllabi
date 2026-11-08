import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDualTipSize,
  createContactState,
  foldContactSize,
  isFingerContact,
  isFingerContactLegacy,
  readingContactSize,
  resolveHeadColourRole,
  updateContactState,
  type ContactFrame,
  type DualTipBands,
  type DualTipConfig,
} from '../src/dual-tip-contact';

// The teacher's calibrated ViewSonic bands (whiteboard-core defaults).
const BANDS: DualTipBands = { smallHeadMaxWidth: 7, bigHeadMaxWidth: 11 };

/** Fold a whole sequence of frames, as a live contact does. */
const foldAll = (readings: Array<[number, number]>): number =>
  readings.reduce((size, [width, height]) => foldContactSize(size, { width, height }), 0);

test('reading size is the MINOR axis, not the major one', () => {
  // A tilted contact: stretched along one axis. The minor axis is what survives the tilt.
  assert.equal(readingContactSize({ width: 5, height: 19 }), 5);
  assert.equal(readingContactSize({ width: 19, height: 5 }), 5);
});

test('a placeholder reading (<=1px both dims) carries no size', () => {
  assert.equal(readingContactSize({ width: 0, height: 0 }), 0);
  assert.equal(readingContactSize({ width: 1, height: 1 }), 0);
  // One real dimension is enough to be a usable reading.
  assert.equal(readingContactSize({ width: 1, height: 9 }), 1);
});

test('a placeholder never seeds or lowers the running minimum', () => {
  // The panel opens with placeholders, then reports the real footprint.
  assert.equal(foldAll([[0, 0], [1, 1], [6, 8]]), 6);
  // ...and a placeholder arriving mid-contact leaves the estimate alone.
  assert.equal(foldAll([[6, 8], [0, 0]]), 6);
});

test('the running minimum never rises — a tilt cannot inflate an established contact', () => {
  // Small head, flat at first, then tilted hard for the rest of the stroke.
  const size = foldAll([[6, 6], [7, 14], [8, 22], [9, 26]]);

  assert.equal(size, 6);
  assert.equal(classifyDualTipSize(size, BANDS), 'small');
});

test('SYMPTOM 1: a small head whose touch-down frame is tilt-inflated still resolves to small', () => {
  // The tip rolls onto the glass: the very first real frame is fat, the true width shows a frame later.
  const readings: Array<[number, number]> = [[0, 0], [9, 17], [6, 12], [6, 9]];

  // Deciding off the first usable frame alone gets it wrong — this is the bug being fixed.
  assert.equal(classifyDualTipSize(readingContactSize({ width: 9, height: 17 }), BANDS), 'big');
  // Deciding off the running minimum gets it right.
  assert.equal(classifyDualTipSize(foldAll(readings), BANDS), 'small');
});

test('SYMPTOM 2: a tilted big head classifies as a head, never as a finger', () => {
  // Big head held at an angle: the MAJOR axis runs past a finger's threshold while the minor axis holds.
  const reading = { width: 10, height: 21 };

  assert.equal(Math.max(reading.width, reading.height) >= 14, true, 'major axis looks finger-sized');
  assert.equal(classifyDualTipSize(readingContactSize(reading), BANDS), 'big');
});

test('a real finger still classifies as a finger', () => {
  assert.equal(classifyDualTipSize(foldAll([[16, 18], [15, 20]]), BANDS), 'finger');
});

test('band edges are inclusive on the upper bound', () => {
  assert.equal(classifyDualTipSize(7, BANDS), 'small');
  assert.equal(classifyDualTipSize(7.01, BANDS), 'big');
  assert.equal(classifyDualTipSize(11, BANDS), 'big');
  assert.equal(classifyDualTipSize(11.01, BANDS), 'finger');
});

test('an unknown size defers instead of guessing', () => {
  assert.equal(classifyDualTipSize(0, BANDS), null);
  assert.equal(classifyDualTipSize(-1, BANDS), null);
});

// --- finger-vs-head routing, against the labelled touch-down frames from the ViewSonic capture ---
// (dualtip-ViewSonic-20260815-0830.json, 34 strokes; these are verbatim readings from that file.)

const RULE = { minWidth: 14 };

test('every labelled FINGER touch-down still routes to pan', () => {
  const fingers = [
    { width: 14, height: 15 },
    { width: 15, height: 16 },
    { width: 16, height: 17 },
    { width: 16, height: 24 }, // aspect 1.50 — the most elongated finger in the capture
    { width: 17, height: 23 },
    { width: 18, height: 22 },
  ];

  for (const f of fingers) {
    assert.equal(isFingerContact(f, RULE), true, `${f.width}x${f.height} should be a finger`);
  }
});

test('a TILTED big head is not mistaken for a finger, however fat its minor axis reads', () => {
  // Minor axis 12 — past any size threshold — but a sliver, so it is a leaning pen.
  assert.equal(isFingerContact({ width: 12, height: 26 }, { minWidth: 12 }), false);
  // A small head tilted hard — the extreme case, aspect 3.33.
  assert.equal(isFingerContact({ width: 6, height: 20 }, { minWidth: 12 }), false);
});

test('a finger that lands a little elongated is still a finger', () => {
  // From the tilted capture: real fingers reached 1.65-1.69 at the deciding frame. A guard tight enough
  // to reject them (the old 1.5) made them write instead of scroll.
  assert.equal(isFingerContact({ width: 13, height: 22 }, { minWidth: 12 }), true, 'aspect 1.69');
  assert.equal(isFingerContact({ width: 17, height: 28 }, { minWidth: 12 }), true, 'aspect 1.65');
});

test('the teacher\'s size setting is honoured, not bypassed', () => {
  const contact = { width: 13, height: 15 };

  assert.equal(isFingerContact(contact, { minWidth: 14 }), false, 'below the setting → writes');
  assert.equal(isFingerContact(contact, { minWidth: 12 }), true, 'at/above the setting → navigates');
});

test('a round contact at the threshold is a finger; the same size elongated is not', () => {
  assert.equal(isFingerContact({ width: 14, height: 15 }, RULE), true);
  assert.equal(isFingerContact({ width: 14, height: 30 }, RULE), false);
});

test('no usable reading → defer rather than route', () => {
  assert.equal(isFingerContact({ width: 0, height: 0 }, RULE), null);
  assert.equal(isFingerContact({ width: 1, height: 1 }, RULE), null);
});

// --- the per-contact state machine: both decisions, one contact, replayed frame by frame ---
// Thresholds are the ones the replay harness scores best on the teacher's current pen (the 2026-08-16
// ViewSonic capture, 104 labelled strokes + 59 labelled fingers): 5 failures, 4 of them the big/small
// collision no threshold can split.
const CONFIG: DualTipConfig = { smallHeadMaxWidth: 5, bigHeadMaxWidth: 10, fingerMinWidth: 11 };

/** Feed a whole contact through the state machine, the way trackTouchPointer does live. */
const run = (frames: ContactFrame[], config: DualTipConfig = CONFIG) =>
  frames.reduce((state, frame) => updateContactState(state, frame, config), createContactState());

/**
 * A stroke that stays put (writing) or travels (panning). Sampled every 25ms so a handful of frames
 * carries the contact past the settle window, the way a real stroke does.
 */
const stroke = (readings: Array<[number, number]>, travelPerFrame = 0): ContactFrame[] =>
  readings.map(([width, height], i) => ({
    width,
    height,
    travelPx: i * travelPerFrame,
    elapsedMs: i * 25,
  }));

/** Frames lifted verbatim from a labelled stroke in the capture: [width, height, msSinceLanding]. */
const recorded = (frames: Array<[number, number, number]>): ContactFrame[] =>
  frames.map(([width, height, elapsedMs]) => ({ width, height, travelPx: 0, elapsedMs }));

test('a tilted BIG head writes — it neither pans nor takes the small head colour', () => {
  // Verbatim from the capture: this head LANDS at 11 — the teacher's finger threshold exactly — and only
  // reads below it once the tip has bedded in. Deciding on the touch-down frame would send it off to pan
  // and the ink would be unrecoverable, because a contact routed to pan can never become the draw
  // pointer. Waiting for the settled size is what saves it. (Travel is left at 0 so the settle window is
  // what closes the verdict; in the capture the stroke moved and committed at 19ms on the same size.)
  const state = run(
    recorded([
      [11, 16, 0], [12, 15, 6], [10, 16, 13], [13, 17, 19], [11, 15, 25],
      [12, 14, 31], [11, 15, 36], [11, 16, 43], [13, 15, 49], [11, 14, 55], [9, 11, 73],
    ]),
  );

  assert.equal(state.routing, false, 'must not be routed to pan');
  // Assert the INK, not the band. Landing this fat, the contact is still measuring above the big-head
  // limit when the settle window closes, so the band it locks is `finger` — which writes in the very
  // same secondary colour (resolveHeadColourRole maps everything but `small` to it, exactly so that a
  // head too fat to name cannot fall back to the small pen's colour). The teacher sees one colour;
  // pinning the label instead would fail on a naming detail nobody can observe.
  assert.equal(resolveHeadColourRole(state.head), 'secondary', 'must keep the secondary colour');
  assert.notEqual(state.head, 'small', 'must never be read as the small head');
});

test('a tilted SMALL head keeps the primary colour', () => {
  // The most elongated small-head landing in the 2026-08-16 capture (4x8, aspect 2) — and it goes on
  // reporting fatter frames than it landed with, which is exactly the case the running minimum exists
  // for: the estimate can never be dragged back up by them.
  const state = run(recorded([[4, 8, 0], [6, 9, 25], [5, 9, 37], [6, 11, 43], [5, 10, 55], [4, 9, 61]]));

  assert.equal(state.routing, false);
  assert.equal(state.head, 'small');
});

test('a BIG head whose footprint collapses mid-stroke still inks the secondary colour', () => {
  // Also verbatim from the capture, and the reason the settle window is 50ms rather than 150ms. This
  // head lands at a minor axis of 8 and keeps thinning as the teacher writes — 6 by 48ms, 5 by 54ms,
  // 3 by 149ms. A window that stays open long enough to see the tail records the thinnest reading of a
  // stroke that is half over and paints a big head in the small pen's colour; 11 of the capture's 48
  // big-head strokes failed that way. The window closes while the reading still describes the tip.
  const frames: Array<[number, number, number]> = [
    [9, 8, 0], [8, 8, 23], [7, 8, 36], [8, 6, 48], [9, 5, 54], [7, 7, 59], [8, 8, 66],
    [7, 6, 102], [5, 5, 108], [6, 3, 149], [8, 4, 156], [9, 4, 185],
  ];

  assert.equal(resolveHeadColourRole(run(recorded(frames)).head), 'secondary');
  assert.equal(
    resolveHeadColourRole(run(recorded(frames), { ...CONFIG, settleMs: 150 }).head),
    'primary',
    'the old 150ms window is what mis-coloured it — if this ever agrees, the window stopped mattering',
  );
});

test('a finger pans, and commits early enough not to trail ink', () => {
  // An obvious finger: round and well past the threshold, so it commits on its first usable frame.
  const first = updateContactState(
    createContactState(),
    { width: 15, height: 16, travelPx: 0, elapsedMs: 0 },
    CONFIG,
  );

  assert.equal(first.routing, true, 'obvious finger commits immediately, before any travel');
});

test('a borderline finger waits for the settled size instead of guessing on frame one', () => {
  const config = { ...CONFIG, fingerMinWidth: 13 };
  const first = updateContactState(
    createContactState(),
    { width: 14, height: 15, travelPx: 0, elapsedMs: 0 },
    config,
  );

  assert.equal(first.routing, null, 'inside the fast-path margin → defer');

  const settled = run(stroke([[14, 15], [14, 15], [13, 15], [13, 14]], 4), config);

  assert.equal(settled.routing, true, 'and once it has travelled/settled it still pans');
});

test('the routing verdict is FROZEN — a shrinking contact keeps panning', () => {
  // v0.1.142's bug: the running minimum kept falling, the verdict flipped, and the pan was cancelled
  // mid-gesture leaving a contact that neither panned nor drew (17 of 18 fingers in the capture).
  const state = run(stroke([[15, 16], [15, 16], [14, 15], [13, 14], [11, 13], [9, 11], [8, 10]], 4));

  assert.equal(state.routing, true, 'still a finger despite the size collapsing to head territory');
});

test('the colour locks after the settle window and never repaints mid-stroke', () => {
  const frames = [
    ...stroke([[9, 12], [9, 12], [9, 11]]),
    { width: 4, height: 6, travelPx: 0, elapsedMs: 400 }, // a late light-pressure dip
  ];
  const state = run(frames);

  assert.equal(state.colourLocked, true);
  assert.equal(state.head, 'big', 'the late dip must not repaint the stroke');
});

test('with dual-tip off the stroke keeps one colour, but routing still works', () => {
  const state = run(stroke([[15, 16], [15, 16]]), { ...CONFIG, dualTipEnabled: false });

  assert.equal(state.head, null, 'no head is reported');
  assert.equal(state.routing, true, 'a finger still pans');
});

test('a contact between the big-head limit and the finger threshold writes in the BIG head colour', () => {
  // The reported bug: with big<=10 and finger>=12, a contact settling at 11 falls in the gap — it is
  // classified "finger" yet is not routed to pan, so it writes. It must not take the small pen's colour.
  // Pinned to a 12px finger threshold because the gap is the subject; the shipped default leaves none.
  const state = run(
    stroke([[11, 13], [11, 12], [11, 12], [11, 12], [11, 12], [11, 12], [11, 12]]),
    { ...CONFIG, fingerMinWidth: 12 },
  );

  assert.equal(state.routing, false, 'it writes rather than pans');
  assert.equal(state.head, 'finger');
  assert.equal(resolveHeadColourRole(state.head), 'secondary', 'must not ink as the small pen');
});

test('only the small band takes the primary colour', () => {
  assert.equal(resolveHeadColourRole('small'), 'primary');
  assert.equal(resolveHeadColourRole('big'), 'secondary');
  assert.equal(resolveHeadColourRole('finger'), 'secondary');
  // Nothing read yet → the stroke keeps the normal pen colour.
  assert.equal(resolveHeadColourRole(null), 'primary');
});

// ---------------------------------------------------------------------------------------------
// The legacy rulebook (what shipped through v0.1.141), kept switchable from Settings.
//
// These tests are not here to bless it — they pin the two behaviours the height-aware rulebook was
// fitted to repair, on the SAME recorded frames as the tests above. Every comparison below holds the
// BANDS fixed and varies only the rulebook: swapping both at once would prove nothing about either.
// If a change ever makes the two agree here, the switch has stopped meaning anything.
// ---------------------------------------------------------------------------------------------

/** Legacy's own calibration: the values that shipped with it (v0.1.141), not the settled-size fit. */
const LEGACY_CONFIG: DualTipConfig = {
  smallHeadMaxWidth: 7,
  bigHeadMaxWidth: 11,
  fingerMinWidth: 14,
  mode: 'legacy',
};
/** The same numbers under the current rulebook — the A/B that isolates the algorithm. */
const { mode: _legacyMode, ...HEIGHT_AWARE_ON_LEGACY_BANDS } = LEGACY_CONFIG;

test('the rulebook defaults to height-aware — legacy is only ever opt-in', () => {
  // The tip rolls onto the glass fat (9x17) and reports its true size a frame later.
  const frames = recorded([[9, 17, 0], [6, 12, 25], [6, 9, 37]]);

  assert.equal(run(frames, HEIGHT_AWARE_ON_LEGACY_BANDS).head, 'small', 'no mode means the fitted rulebook');
  assert.equal(run(frames, LEGACY_CONFIG).head, 'big', 'legacy locks the head it saw on frame one');
});

test('LEGACY: a tilted big head is routed to pan — the lost-ink failure, reproduced', () => {
  // Verbatim from the capture, the same landing as 'a tilted BIG head writes' above: 11x16 at
  // touch-down. Legacy measures the MAJOR axis (16) against its finger threshold (14), so it navigates
  // instead of writing — and no later frame can undo that, because a contact routed to pan never
  // becomes the draw pointer.
  const frames = recorded([
    [11, 16, 0], [12, 15, 6], [10, 16, 13], [13, 17, 19], [11, 15, 25],
    [12, 14, 31], [11, 15, 36], [11, 16, 43], [13, 15, 49], [11, 14, 55], [9, 11, 73],
  ]);
  let state = createContactState();

  // Assert what the live hook ACTS on, not the end state: the pan starts on the first frame that says
  // finger once the contact has travelled, and from that moment the ink is unrecoverable. Legacy's
  // final frame happens to read below the threshold again — which is precisely the instability, not an
  // acquittal, so reading only the last verdict would hide the bug.
  const legacyVerdicts = frames.reduce<Array<boolean | null>>((verdicts, frame, index) => {
    const previous = index === 0 ? createContactState() : undefined;

    return [
      ...verdicts,
      (state = updateContactState(previous ?? state, frame, LEGACY_CONFIG)).routing,
    ];
  }, []);

  assert.ok(legacyVerdicts.includes(true), 'legacy calls the tilted head a finger and pans away from it');
  assert.equal(legacyVerdicts[0], true, 'and it does so from the touch-down frame');
  assert.equal(run(frames, HEIGHT_AWARE_ON_LEGACY_BANDS).routing, false, 'height-aware keeps it writing');
  assert.ok(
    !legacyVerdicts.every((verdict) => verdict === legacyVerdicts[0]),
    'the verdict also moves mid-stroke — one contact, several answers',
  );
});

test('LEGACY: the colour is taken from the touch-down frame and locked there', () => {
  const frames = recorded([[9, 17, 0], [6, 12, 25], [6, 9, 37]]);

  assert.equal(resolveHeadColourRole(run(frames, LEGACY_CONFIG).head), 'secondary', 'locked on frame one');
  assert.equal(
    resolveHeadColourRole(run(frames, HEIGHT_AWARE_ON_LEGACY_BANDS).head),
    'primary',
    'the settled size finds the small head the first frame hid',
  );
});

test('LEGACY: write-vs-navigate is re-decided every frame, never frozen', () => {
  // A contact whose reported footprint grows mid-stroke flips its own verdict under legacy. That is the
  // mechanism behind a stroke being yanked away into a pan halfway through.
  const afterSmallFrame = updateContactState(
    createContactState(),
    { width: 6, height: 9, travelPx: 0, elapsedMs: 0 },
    LEGACY_CONFIG,
  );

  assert.equal(afterSmallFrame.routing, false);

  const afterFatFrame = updateContactState(
    afterSmallFrame,
    { width: 8, height: 20, travelPx: 4, elapsedMs: 20 },
    LEGACY_CONFIG,
  );

  assert.equal(afterFatFrame.routing, true, 'the verdict moved — legacy holds no memory of it');
});

test('LEGACY: a placeholder frame decides nothing, exactly as the old code deferred', () => {
  const state = updateContactState(
    createContactState(),
    { width: 1, height: 1, travelPx: 0, elapsedMs: 0 },
    LEGACY_CONFIG,
  );

  assert.equal(state.routing, null, 'no verdict from a placeholder');
  assert.equal(state.head, null);
  assert.equal(state.colourLocked, false);
});

test('LEGACY: isFingerContactLegacy is the major axis with no tilt guard', () => {
  // 12x26 — a pen head leaned right over. The height-aware rule reads the elongation (aspect 2.17, past
  // the guard) and keeps it writing; legacy sees 26 >= 14 and calls it a finger.
  assert.equal(isFingerContactLegacy({ width: 12, height: 26 }, { minWidth: 14 }), true);
  assert.equal(isFingerContact({ width: 12, height: 26 }, { minWidth: 11 }), false);
  // A genuine fingertip is round, and is a finger under both.
  assert.equal(isFingerContactLegacy({ width: 15, height: 16 }, { minWidth: 14 }), true);
  assert.equal(isFingerContact({ width: 15, height: 16 }, { minWidth: 11 }), true);
  assert.equal(isFingerContactLegacy({ width: 1, height: 1 }, { minWidth: 14 }), null, 'placeholder defers');
});
