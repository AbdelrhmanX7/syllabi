/**
 * Dual-tip capacitive stylus — the pure contact-size decision, kept dependency-free so it is unit
 * testable and shared by the live canvas hook.
 *
 * On a touch-only panel (the teacher's ViewSonic) the dual-tip pen's SMALL head, its BIG head and a
 * bare FINGER all arrive as `pointerType === 'touch'`. Everything else the panel reports is dead: the
 * pressure is a flat constant, tilt is always 0, there is no twist and no button. The only signal that
 * separates them is the CONTACT FOOTPRINT — `PointerEvent.width` × `PointerEvent.height` — so this
 * module is the whole discrimination.
 *
 * TWO RULES, both learned the hard way from real device data:
 *
 * 1. MEASURE THE MINOR AXIS. Tilting the pen stretches the contact ellipse along one axis, so a tilted
 *    small head's `max(w, h)` climbs into the big head's range and a tilted big head's climbs into the
 *    finger's. Measured on 5,926 labelled ViewSonic samples: 26.5% misclassification on the major axis
 *    vs ~7% on the minor axis.
 *
 * 2. TAKE THE SMALLEST READING, NOT THE FIRST. A digitizer never reports a patch smaller than the
 *    physical tip — tilt and pressure only ever inflate it. So across a contact's life the MINIMUM
 *    minor-axis reading is the closest estimate of the real head, and a single frame (especially the
 *    touch-down frame, where the tip is still rolling onto the glass) is the least trustworthy one.
 *    Classifying off one frame is what let a tilt mis-colour a stroke or refuse to draw it at all.
 *
 * ONE VERDICT PER CONTACT. Both questions asked about a contact — "which colour?" and "is this a finger
 * that should navigate instead of write?" — are answered from this one classification. They used to run
 * on different metrics (colour on the minor axis, finger-vs-pen on the major axis against a separate
 * threshold), which meant a tilted big head could measure "finger" on one axis while measuring "head" on
 * the other, and silently refuse to write. A contact must not get two different answers about what it is.
 */

/** What a single touch contact is, once its footprint is known. `null` = not known yet. */
export type DualTipHead = 'small' | 'big' | 'finger';

/**
 * Which rulebook decides what a contact is.
 *
 * - `height-aware` — the rules above: both answers off the MINOR axis, the size folded to a running
 *   minimum over a settle window, and a contact too elongated to be a fingertip read as a tilted pen.
 *   This is what the width-vs-height guard buys, and it is the default.
 * - `legacy` — what shipped through v0.1.141: the colour off the minor axis of ONE frame (the first
 *   usable one, then locked) and write-vs-navigate off the MAJOR axis, re-decided every frame. Kept
 *   switchable because it is the behaviour every stroke of muscle memory was built on, and because a
 *   pen whose heads the new fit does not suit can still be driven the old way.
 *
 * The two rulebooks read DIFFERENT numbers off the same contact — a single frame's major axis runs
 * several px larger than a settled minor axis — so each carries its own calibrated bands
 * (`DualTipStylusSettings.legacyBands`). Feeding one rulebook the other's thresholds is not a
 * degraded setting, it is a broken one.
 */
export type DualTipClassifier = 'height-aware' | 'legacy';

export interface DualTipBands {
  /** Minor-axis size (CSS px) at or below which a contact is the SMALL head. */
  smallHeadMaxWidth: number;
  /** Above `smallHeadMaxWidth` and at or below this → the BIG head. Larger still → a finger. */
  bigHeadMaxWidth: number;
}

/** A raw footprint reading off a PointerEvent, in CSS px. */
export interface ContactReading {
  width: number;
  height: number;
}

/**
 * Some panels report a placeholder footprint (both dimensions <= 1px) at touch-down and the real one
 * only a frame or two later. Such a reading carries no size information and must never be folded into
 * the running minimum — it would pin it near zero and make every contact look tip-sized forever.
 */
const PLACEHOLDER_MAX_PX = 1;

/**
 * The minor-axis size of one reading, or 0 when the panel reported only a placeholder.
 *
 * @param reading - Raw `width`/`height` off the pointer event (CSS px).
 * @returns The minor axis in CSS px, or 0 when there is no usable size yet.
 */
export function readingContactSize(reading: ContactReading): number {
  const width = reading.width || 0;
  const height = reading.height || 0;

  if (Math.max(width, height) <= PLACEHOLDER_MAX_PX) return 0;

  return Math.min(width, height);
}

/**
 * Fold a new reading into a contact's running-minimum size.
 *
 * Monotonically non-increasing once seeded: a later, larger (tilt-inflated) reading can never raise the
 * estimate. That is the property the whole feature rests on — it is what stops a mid-stroke tilt from
 * changing its mind about which head is writing.
 *
 * @param previousSize - The contact's size so far (0 if nothing usable has been read yet).
 * @param reading - The new raw footprint reading.
 * @returns The updated running-minimum size (0 while still unknown).
 */
export function foldContactSize(previousSize: number, reading: ContactReading): number {
  const size = readingContactSize(reading);

  if (size <= 0) return previousSize;
  if (previousSize <= 0) return size;

  return Math.min(previousSize, size);
}

/**
 * Classify a stabilized contact size into a head.
 *
 * @param size - A size from {@link foldContactSize} / {@link readingContactSize} (minor axis, CSS px).
 * @param bands - The device's calibrated thresholds.
 * @returns The head, or `null` while the size is still unknown so the caller can defer rather than guess.
 */
export function classifyDualTipSize(size: number, bands: DualTipBands): DualTipHead | null {
  if (size <= 0) return null;

  if (size <= bands.smallHeadMaxWidth) return 'small';
  if (size <= bands.bigHeadMaxWidth) return 'big';

  return 'finger';
}

/**
 * Which stroke colour a contact that IS writing should take.
 *
 * Only the SMALL band means the small head. Everything else that reaches the canvas takes the big
 * head's colour — including a contact classified `finger`, because a contact big enough to be called a
 * finger yet small enough that it was not routed to pan is far likelier to be the big head than the
 * small one. Mapping `finger` to the primary colour is what made every contact landing between the
 * big-head limit and the finger threshold write in the SMALL pen's colour.
 *
 * A consequence worth stating: for a contact that writes, «Small tip limit» alone decides the colour
 * and «Finger size» alone decides write-vs-navigate. «Big tip limit» sits between them and no longer
 * changes either outcome by itself.
 */
export function resolveHeadColourRole(head: DualTipHead | null): 'primary' | 'secondary' {
  return head === null || head === 'small' ? 'primary' : 'secondary';
}

/**
 * A contact this elongated is a pen held at an angle, not a finger.
 *
 * A fingertip presses a roughly round patch however it lands; a tilted pen head presses a sliver, so
 * elongation is what tells a fat-looking-but-tilted head from a genuine finger when their minor axes
 * collide.
 *
 * WAS 1.5, fitted on a first capture where no finger exceeded 1.50. A second capture — recorded
 * specifically with the pen leaned over — had fingers reaching 1.65 and 1.69 at the deciding frame, and
 * the tight guard threw them out: two real fingers wrote instead of scrolling. Widening to 2.0 costs
 * nothing on the first capture (1 error either way) and halves the failures on the second (4 -> 2).
 * A guard fitted to fingers that were never sampled leaning is a guard fitted to nothing.
 */
export const FINGER_MAX_ASPECT = 2;

export interface FingerContactRule {
  /** Minor-axis size (CSS px) at or above which a contact may be a finger (the «Finger size» setting). */
  minWidth: number;
  /** Above this width:height ratio the contact is a tilted pen, never a finger. */
  maxAspect?: number;
}

/** How far a contact must travel before a single-finger pan could start (mirrors the canvas hook). */
export const CONTACT_ACTIVATION_PX = 10;
/**
 * How long a contact's size keeps settling before the colour locks.
 *
 * This is a BUDGET, not a delay: the running minimum only falls, so every extra millisecond of window
 * drags both heads toward each other. It has to be long enough for the touch-down frame (the tip still
 * rolling onto the glass) to be outvoted and short enough that a big head cannot descend into the small
 * head's band. Where that balance sits depends on the physical pen, so it is refitted from a capture
 * whenever the pen changes — never by intuition.
 *
 * WAS 150, fitted on the first ViewSonic pen. The teacher's replacement pen has visibly smaller heads
 * (small settles at 1-4px, big at 3-9px against the old 1-3 / 6-8) and their strokes are shorter
 * (median 222ms vs 570ms), so 150ms covered most of a stroke and let big heads dive into the small
 * band: 11 of 48 big-head strokes inked the wrong colour. Refitted on the 2026-08-16 capture
 * (104 labelled strokes) the error curve is 4 @50ms, 6 @55, 7 @60, 9 @90, 11 @150 — flat below 50 but
 * starting to mis-colour small heads there, so 50 is the floor of the good region rather than a
 * knife-edge. At this panel's rate that is ~4 usable frames, which is what the fit rests on.
 */
export const CONTACT_SETTLE_MS = 50;
/**
 * A touch-down reading this far ABOVE the finger threshold is an obvious finger: commit immediately so
 * an ordinary pan never flashes tentative ink. Sized from the capture — between touch-down and the
 * commit moment a contact's measured size falls by about 1px, so 2px of headroom cannot be erased by
 * settling. Anything inside that margin waits for the settled size instead of guessing.
 */
export const FINGER_FAST_PATH_MARGIN_PX = 2;

export interface DualTipConfig extends DualTipBands {
  /** «Finger size» — minor-axis size at or above which a contact may be a finger. */
  fingerMinWidth: number;
  /** When false the stroke keeps its single colour (no head is reported); routing still runs. */
  dualTipEnabled?: boolean;
  /** Which rulebook to apply. Defaults to `height-aware`. */
  mode?: DualTipClassifier;
  maxAspect?: number;
  activationPx?: number;
  settleMs?: number;
  /** Headroom for the immediate-commit shortcut; pass Infinity to disable it entirely. */
  fastPathMarginPx?: number;
}

/** Per-contact state. Treat as opaque; create with {@link createContactState}. */
export interface ContactState {
  /** Running-minimum minor axis (0 = nothing usable read yet). */
  size: number;
  /** Frozen once decided: true = finger (navigate), false = pen head (write), null = still deciding. */
  routing: boolean | null;
  /** Current head for the stroke colour, refined until `colourLocked`. */
  head: DualTipHead | null;
  colourLocked: boolean;
}

export interface ContactFrame extends ContactReading {
  /** Distance travelled from where the contact landed, in CSS px. */
  travelPx: number;
  /** Time since the contact landed, in ms. */
  elapsedMs: number;
}

export function createContactState(): ContactState {
  return { size: 0, routing: null, head: null, colourLocked: false };
}

/**
 * Advance one contact by one frame — the single source of truth for both dual-tip decisions, shared by
 * the live canvas hook and the offline replay harness (`tools/replay-dualtip.mjs`), so a capture can be
 * re-simulated without a device build.
 *
 * WHY THE ROUTING WAITS. A single-finger pan cannot begin until the contact has travelled
 * `activationPx` anyway, and any ink drawn before that is discardable, so the verdict does not have to
 * be taken on the touch-down frame — which is the single most tilt-corrupted reading in the stroke, and
 * taking it there sent tilted pen heads off to pan (v0.1.143). It is instead taken at whichever comes
 * first: `activationPx` of travel, or `settleMs` elapsed — by which point the running minimum has
 * separated the classes cleanly. Measured on the ViewSonic capture: pen heads settle at 3–11, fingers
 * at 11–17.
 *
 * WHY IT IS THEN FROZEN. The running minimum keeps falling for as long as the contact lives, so a
 * verdict re-taken later drifts: in v0.1.142 a finger recognised at touch-down "shrank" below the
 * threshold mid-gesture, its pan was cancelled, and it neither panned nor drew (17 of 18 fingers in the
 * capture). One decision, held for the life of the contact.
 */
export function updateContactState(
  state: ContactState,
  frame: ContactFrame,
  config: DualTipConfig,
): ContactState {
  if (config.mode === 'legacy') return updateContactStateLegacy(state, frame, config);

  const size = foldContactSize(state.size, frame);
  const next: ContactState = { ...state, size };

  if (size <= 0) return next;

  const maxAspect = config.maxAspect ?? FINGER_MAX_ASPECT;
  const activationPx = config.activationPx ?? CONTACT_ACTIVATION_PX;
  const settleMs = config.settleMs ?? CONTACT_SETTLE_MS;
  const width = frame.width || 0;
  const height = frame.height || 0;
  const minor = Math.min(width, height);
  const aspect = minor > 0 ? Math.max(width, height) / minor : 1;
  const roundEnough = aspect <= maxAspect;

  if (next.routing === null) {
    const fastPathMargin = config.fastPathMarginPx ?? FINGER_FAST_PATH_MARGIN_PX;
    const obviousFinger =
      Number.isFinite(fastPathMargin) &&
      state.size <= 0 &&
      size >= config.fingerMinWidth + fastPathMargin &&
      roundEnough;

    if (obviousFinger) {
      next.routing = true;
    } else if (frame.travelPx >= activationPx || frame.elapsedMs >= settleMs) {
      next.routing = size >= config.fingerMinWidth && roundEnough;
    }
  }

  if (config.dualTipEnabled !== false && !next.colourLocked) {
    // Refine INSIDE the window only. The frame that closes the window must not also move the head:
    // the running minimum keeps falling for as long as the contact lives, so a late light-pressure dip
    // would otherwise repaint a stroke the teacher already watched appear. (Still classify when nothing
    // has been decided yet — a panel whose first usable reading arrives late must not end up colourless.)
    const windowClosed = frame.elapsedMs >= settleMs;

    if (!windowClosed || next.head === null) {
      next.head = classifyDualTipSize(size, config);
    }

    next.colourLocked = windowClosed && next.head !== null;
  }

  return next;
}

/**
 * The pre-v0.1.142 rulebook, kept executable rather than described.
 *
 * Reproduces exactly what shipped through v0.1.141, at both decision points:
 *
 * - COLOUR — classify the MINOR axis of a single frame and lock on the first frame that yields a head.
 *   No running minimum and no settle window: whatever the tip measured as it rolled onto the glass is
 *   what the whole stroke is coloured.
 * - WRITE-vs-NAVIGATE — the MAJOR axis against «Finger size», RE-DECIDED on every frame and never
 *   frozen. A frame reporting between the placeholder and the threshold cancels a pending pan (it is a
 *   pen tip, keep drawing); at or above the threshold the contact navigates.
 *
 * Both known costs of this rulebook are inherent to it, not bugs to fix here: tilting the pen inflates
 * the major axis, so a leaned-over big head measures finger-sized and its ink is lost; and a colour
 * taken from the touch-down frame is taken from the least trustworthy reading of the stroke. That is
 * precisely what the height-aware rulebook was fitted to repair — this one is offered as a choice, so
 * it must behave like its old self, warts included.
 */
function updateContactStateLegacy(state: ContactState, frame: ContactFrame, config: DualTipConfig): ContactState {
  const width = frame.width || 0;
  const height = frame.height || 0;
  const rawMax = Math.max(width, height);
  const next: ContactState = { ...state };

  // A placeholder frame carried no information in the old code either: it neither cancelled a pending
  // pan nor started one, and left the colour to a later frame.
  if (rawMax <= PLACEHOLDER_MAX_PX) return next;

  // The old colour ruler: this frame's minor axis, with no memory of any other frame.
  next.size = Math.min(width, height);
  // The old routing ruler: this frame's MAJOR axis. Recomputed every frame — a contact could be a
  // finger on one frame and a pen head on the next, which is how a mid-stroke tilt used to yank a
  // stroke away into a pan.
  next.routing = rawMax >= config.fingerMinWidth;

  if (config.dualTipEnabled !== false && !next.colourLocked) {
    next.head = classifyDualTipSize(next.size, config);
    next.colourLocked = next.head !== null;
  }

  return next;
}

/**
 * Write-vs-navigate under the {@link updateContactStateLegacy} rulebook: the MAJOR axis against the
 * finger threshold, with no tilt guard. Exported so a capture can be scored both ways offline.
 *
 * @returns true = finger, false = pen head, null = placeholder frame (defer, exactly as the old code did).
 */
export function isFingerContactLegacy(reading: ContactReading, rule: FingerContactRule): boolean | null {
  const width = reading.width || 0;
  const height = reading.height || 0;
  const rawMax = Math.max(width, height);

  if (rawMax <= PLACEHOLDER_MAX_PX) return null;

  return rawMax >= rule.minWidth;
}

/**
 * Is this contact a FINGER (navigate) rather than a pen head (write)?
 *
 * DECIDE THIS ONCE, AT TOUCH-DOWN, AND NEVER REVISIT IT. Unlike the colour, this verdict must not ride
 * the running minimum: that minimum only ever falls, so a finger recognised at touch-down would later
 * "shrink" below the threshold and have its pan cancelled — leaving a contact that neither pans nor
 * draws. And the reverse repair is impossible: a contact routed to pan never became the draw pointer,
 * so no later frame can retroactively open a stroke for it. Whatever is decided here, the teacher lives
 * with for the whole contact, which is why it takes the tilt guard rather than size alone.
 *
 * @param reading - The touch-down footprint (first frame with a usable size).
 * @param rule - The teacher's finger-size setting plus the tilt guard.
 * @returns true = finger, false = pen head, null = no usable reading yet (defer, do not guess).
 */
export function isFingerContact(reading: ContactReading, rule: FingerContactRule): boolean | null {
  const size = readingContactSize(reading);

  if (size <= 0) return null;
  if (size < rule.minWidth) return false;

  const width = reading.width || 0;
  const height = reading.height || 0;
  const minor = Math.min(width, height);
  const aspect = minor > 0 ? Math.max(width, height) / minor : 1;

  return aspect <= (rule.maxAspect ?? FINGER_MAX_ASPECT);
}
