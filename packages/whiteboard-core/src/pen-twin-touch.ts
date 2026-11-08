/**
 * Pen-twin touch discrimination — the pure decisions behind the Fabric touch-starvation guard.
 *
 * THE LIVE RULE (useWhiteboardCanvas, blockTouchFromFabricOnPenDevice) is POSITIVE identification —
 * isPenTwinTouchStart below: a touchstart contact is the pen's own twin iff a 'pen' pointerdown is still
 * down, landed moments ago, and landed there. Everything else on a pen device is starved, with no
 * radius/proximity guessing: the Samsung tablet reported palm contacts with tip-sized radii, so the
 * heuristic isPenTwinTouchContact (kept for reference and its tests) let palms ink dots and straight
 * lines. Blink dispatches each contact's pointerdown BEFORE its touchstart, in the same task, so the
 * pen-down record always exists by the time its twin touchstart is judged.
 *
 * On a real-pen device (ThinkPad active pen) the whiteboard's Fabric canvas is created WITHOUT
 * pointer-event mode, so Fabric binds its freehand drawing to the raw TOUCH stream. On this hardware
 * the PEN itself inks THROUGH that touch stream — the pen's own contact arrives as a `touch`, and it
 * MUST reach Fabric or the pen draws nothing (the v0.1.86 regression: blocking all touch killed the
 * pen). But a FINGER/PALM landing on the glass is ALSO a touch; if it reaches Fabric while the pen is
 * down, Fabric (non-pointer mode) folds every touch into ONE brush path, so the finger's coordinates
 * jump into the pen's stroke — the "weird shapes/lines" glitch.
 *
 * So for each touch we must answer one question: is this the pen's OWN twin contact (let it ink), or a
 * finger/palm (starve it — it may only pan/zoom via the pointer handlers)? This module is that decision,
 * kept pure + dependency-free so it is unit-testable and shared by the live canvas hook.
 *
 * SIGNALS, in priority order:
 *   0. `Touch.touchType` (Touch Events L2: 'stylus' | 'direct'), when the browser reports it (WebKit;
 *      not Chromium). AUTHORITATIVE: 'stylus' IS the pen, 'direct' is a finger — no radius guessing,
 *      because a finger's radius on some panels reads tiny or 0 and used to pass as a "pen tip" (the
 *      Android "a finger leaves a dot" bug). Absent → fall through to the heuristics below.
 *   1. Contact RADIUS. A pen tip reports a tiny footprint; a finger/palm reports the panel's large one.
 *      Checked FIRST: a DEFINITIVELY large contact (> 2× the pen-tip radius) is a palm/finger and is
 *      rejected even when it lands right next to the pen — a palm heel can rest against the pen hand, so
 *      proximity alone must never rescue a clearly-large contact.
 *   2. PROXIMITY to the live pen position. This hardware sometimes reports the pen twin's radius as 0
 *      (unknown), so size alone can't identify it. When the radius is unknown or only moderately above
 *      the tip size, we fall back to distance: a contact within one frame's reach of where the pen
 *      currently is is treated as the pen's own twin.
 *
 * BIAS (documented, deliberate): when ambiguous NEAR the pen (radius unknown/moderate + close), we PASS.
 * Blocking the pen's twin kills inking (a dead pen — the v0.1.86/87 regression we must never reintroduce);
 * letting one stray finger through is a single, recoverable glitch. Ambiguity therefore always resolves
 * toward letting the touch ink.
 */

export interface PenTwinTouchGeometry {
  /** Touch.touchType ('stylus' | 'direct') where the browser reports it; undefined elsewhere. */
  touchType?: string;
  /** Touch.radiusX in CSS px (0 or undefined when the panel does not report a footprint). */
  radiusX?: number;
  /** Touch.radiusY in CSS px (0 or undefined when the panel does not report a footprint). */
  radiusY?: number;
  /** Touch.clientX. */
  clientX: number;
  /** Touch.clientY. */
  clientY: number;
}

export interface PenTwinTouchOptions {
  /** Pen-tip contact radius ceiling (px). A positive radius at or below this is the pen tip itself. */
  maxRadius: number;
  /** Max distance (px) from the live pen position for an unknown/moderate-radius contact to count as the
   *  pen's twin — generous enough to cover one frame of pen motion, yet far below the >100px a resting
   *  palm or a second finger lands from the tip. */
  maxDistance: number;
}

/**
 * Decide whether a single touch contact is plausibly the pen's OWN twin (→ let it reach Fabric to ink)
 * rather than a finger/palm (→ starve it). Pure: no DOM, no refs, no time.
 *
 * @param touch        The contact geometry (radius + client position).
 * @param lastPenPoint Where the pen currently is (client coords), or `null` when no pen is down. Only a
 *                     live pen produces a point, so the proximity signal is inert while the pen is up.
 */
export function isPenTwinTouchContact(
  touch: PenTwinTouchGeometry,
  lastPenPoint: { x: number; y: number } | null,
  options: PenTwinTouchOptions,
): boolean {
  const { maxRadius, maxDistance } = options;

  // (0) The browser SAID what it is. 'stylus' is the pen whatever its footprint; any other reported kind
  // ('direct') is a finger whatever its footprint — a finger that reads 1px must not pass as a tip.
  if (touch.touchType === 'stylus') {
    return true;
  }

  if (typeof touch.touchType === 'string' && touch.touchType !== '') {
    return false;
  }

  const contactRadius = Math.max(touch.radiusX || 0, touch.radiusY || 0);

  // (1) RADIUS FIRST. A definitively LARGE contact is a finger/palm — reject it even when it is right
  // next to the pen, because a palm heel can rest against the pen hand and would otherwise be rescued by
  // proximity. The 2× margin above the tip ceiling keeps a slightly-fat pen contact out of this bucket.
  if (contactRadius > maxRadius * 2) {
    return false;
  }

  // A tiny, POSITIVE radius is the pen tip itself — always the twin, regardless of whether a pen-down has
  // been registered yet (covers a touchstart that races ahead of the pen's pointerdown).
  if (contactRadius > 0 && contactRadius <= maxRadius) {
    return true;
  }

  // Radius is UNKNOWN (0) or only MODERATELY above the tip size — AMBIGUOUS. Size alone cannot decide, so
  // fall back to proximity: if we know where the pen is and this contact is within one frame's reach of
  // it, treat it as the pen's own twin. BIAS: when in doubt near the pen, PASS (see module header).
  if (lastPenPoint) {
    const dx = touch.clientX - lastPenPoint.x;
    const dy = touch.clientY - lastPenPoint.y;

    if (dx * dx + dy * dy <= maxDistance * maxDistance) {
      return true;
    }
  }

  return false;
}

export interface PenDownRecord {
  /** Raw PointerEvent.clientX of the latest 'pen' pointerdown. */
  x: number;
  /** Raw PointerEvent.clientY of that pointerdown. */
  y: number;
  /** When it was dispatched (ms, same clock as `now`). */
  at: number;
}

export interface PenTwinStartOptions {
  /** Max |Δx|, |Δy| (px) between the pen pointerdown and the touchstart contact for them to be one contact. */
  maxDistance: number;
  /** Max age (ms) of the pen pointerdown — its twin touchstart is dispatched right after it, in one task. */
  maxWindowMs: number;
}

/**
 * POSITIVE pen-twin identification at touchstart. The pen's own contact enters Fabric's raw touch stream
 * as a `touchstart` dispatched right after the pen's `pointerdown` (same task, same platform event, same
 * client position). So a touchstart contact IS the twin iff a pen is down (`penDown` non-null), that
 * pen-down is at most `maxWindowMs` old, and the contact is within `maxDistance` of it. Anything else —
 * a palm with a tip-sized radius, a finger landing next to the pen mid-stroke, a contact arriving while
 * no pen is down — is not the twin, whatever its radius. Pure: the caller records the pen-down.
 */
export function isPenTwinTouchStart(
  touch: { clientX: number; clientY: number },
  penDown: PenDownRecord | null,
  now: number,
  options: PenTwinStartOptions,
): boolean {
  if (!penDown || now - penDown.at > options.maxWindowMs) {
    return false;
  }

  return (
    Math.abs(touch.clientX - penDown.x) <= options.maxDistance && Math.abs(touch.clientY - penDown.y) <= options.maxDistance
  );
}
