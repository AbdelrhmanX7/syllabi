/**
 * Contact capture — recording what the board saw and what it decided, so a classifier can be TRAINED
 * instead of hand-fitted.
 *
 * The thresholds have hit their ceiling: on a labelled capture the best achievable error is roughly
 * the same (~4%) for every statistic anyone has tried, because a big pen head and a fingertip can
 * report byte-identical footprints and the panel offers nothing else — pressure is a flat constant,
 * tilt is always 0, there is no twist. Beating that needs information a single summary number does
 * not carry: the SEQUENCE (how the footprint evolves), the TRAJECTORY (a finger scrolls, a pen
 * writes — they move differently), and the CONTEXT (which tool is live, what happened just before).
 * This module records all three per contact.
 *
 * It records the DECISION too, not just the input. A row that says only "these were the footprints"
 * cannot be scored against the shipped code; a row that also says "and the board routed it to pan at
 * frame 3, then locked the big head's colour at 50ms" can — which is what makes a capture a training
 * example rather than a log line.
 *
 * Runs on every touch frame of a live lesson, so it allocates one object per frame and nothing else:
 * no formatting, no derived geometry (the trainer can compute min/max/aspect from w/h far more
 * cheaply offline than the board can mid-stroke).
 */

import type { ContactState, DualTipHead } from './dual-tip-contact';

import { resolveHeadColourRole } from './dual-tip-contact';

/** One raw frame, exactly as the panel reported it. Field names are short because these are the bulk. */
export interface CapturedFrame {
  /** ms since the contact landed. */
  t: number;
  w: number;
  h: number;
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  twist: number;
  /** True for a frame recovered from getCoalescedEvents rather than delivered on its own. */
  coalesced: boolean;
}

/** What the board did with a contact, and when it committed to it. */
export interface CapturedDecision {
  /** true = navigate, false = write, null = never decided. */
  routing: boolean | null;
  /** When the routing verdict first latched — a verdict taken early on a tilt-corrupted frame is the
   *  known failure, so WHEN matters as much as WHAT. */
  routingLatchedAtMs: number | null;
  routingLatchedFrame: number | null;
  head: DualTipHead | null;
  colourRole: 'primary' | 'secondary' | null;
  colourLockedAtMs: number | null;
  /** A pan actually began for this contact (past the activation distance). */
  panStarted: boolean;
  /** The palm-reject window was open when this contact landed (a pen was down or just active). */
  palmRejectActive: boolean;
  /** A whole-hand (palm) eraser pass owned this contact. */
  wholeHandEraser: boolean;
  activeTool: string;
  effectiveTool: string;
}

/**
 * Where the contact happened, so a page of strokes can be REASSEMBLED for review.
 *
 * Judging a contact from its footprint alone is guesswork — an ellipse tells you nothing about
 * whether it should have been the small head. Seeing the word it belongs to does. That needs the
 * board's viewport at the time (client coordinates are a panned/zoomed view of the page, so without
 * it two contacts a minute apart do not share a coordinate system) plus which page they were on.
 */
export interface CapturedContext {
  documentId?: string;
  pageId?: string;
  /** Fabric viewport when the contact landed: scene = (client - pan) / zoom. */
  zoom?: number;
  panX?: number;
  panY?: number;
  canvasW?: number;
  canvasH?: number;
}

/** How much this contact is worth a human's attention. Higher = review this one first. */
export interface CapturedPriority {
  score: number;
  /** The two rulebooks reached different conclusions — this is the boundary region, by definition. */
  rulebookDisagrees: boolean;
  /** Distance (px) from the settled size to the nearest band edge. Small = the call was marginal. */
  edgeDistancePx: number;
  /** An undo followed within a couple of seconds — the strongest "that was wrong" signal there is. */
  undoFollowed: boolean;
  /** Epoch ms of that undo. Kept so a trainer can see HOW promptly it came — an undo 200ms after the
   *  release is a reflex about this stroke, one at 1.9s might be about the word. */
  undoneAtMs?: number;
}

export interface CapturedContact {
  contactId: string;
  /** Epoch ms the contact landed. */
  startedAt: number;
  durationMs: number;
  pointerType: string;
  frames: CapturedFrame[];
  decision: CapturedDecision;
  context?: CapturedContext;
  priority?: CapturedPriority;
}

/**
 * Frames kept per contact. A normal stroke is tens of frames; the cap only bites on a contact left
 * resting on the glass, where the tail carries no information the head does not already have.
 */
export const MAX_FRAMES_PER_CONTACT = 400;

/** One contact being recorded. */
interface OpenContact {
  contactId: string;
  startedAt: number;
  pointerType: string;
  frames: CapturedFrame[];
  decision: CapturedDecision;
  context?: CapturedContext;
  lastT: number;
  /** Frames seen INCLUDING any dropped past the cap, so `routingLatchedFrame` stays truthful. */
  seen: number;
}

export interface ContactRecorderOptions {
  /** Supplies contact ids. Injected so the recorder stays pure and tests read straightforwardly. */
  newId: () => string;
}

/**
 * Records contacts in flight. One recorder per board; contacts are keyed by pointer id, which the
 * platform guarantees unique among LIVE pointers — the id is reused after release, which is exactly
 * why {@link begin} closes any contact still open under the same id rather than assuming there
 * isn't one.
 */
export class ContactRecorder {
  private readonly open = new Map<number, OpenContact>();
  private readonly newId: () => string;

  constructor(options: ContactRecorderOptions) {
    this.newId = options.newId;
  }

  /**
   * Start recording a contact.
   *
   * @returns The contact abandoned under this pointer id, if one was still open. A dropped
   *          pointerup (routine on this hardware — it is what the self-heal watchdog exists for)
   *          would otherwise leak the previous contact, and silently dropping it would bias the
   *          training set toward strokes that ended cleanly.
   */
  begin(
    pointerId: number,
    info: {
      startedAt: number;
      pointerType: string;
      palmRejectActive: boolean;
      activeTool: string;
      effectiveTool: string;
      /** Viewport + page, captured once at touch-down so the strokes can be reassembled for review. */
      context?: CapturedContext;
    },
  ): CapturedContact | null {
    const abandoned = this.end(pointerId);

    this.open.set(pointerId, {
      contactId: this.newId(),
      startedAt: info.startedAt,
      pointerType: info.pointerType,
      context: info.context,
      frames: [],
      seen: 0,
      lastT: 0,
      decision: {
        routing: null,
        routingLatchedAtMs: null,
        routingLatchedFrame: null,
        head: null,
        colourRole: null,
        colourLockedAtMs: null,
        panStarted: false,
        palmRejectActive: info.palmRejectActive,
        wholeHandEraser: false,
        activeTool: info.activeTool,
        effectiveTool: info.effectiveTool,
      },
    });

    return abandoned;
  }

  /**
   * Record one frame and the classifier state it produced.
   *
   * `state` is the ContactState the live classifier just computed for this same frame — passed in
   * rather than recomputed, so the capture can never describe a decision the board did not take.
   */
  frame(pointerId: number, frame: CapturedFrame, state: ContactState): void {
    const contact = this.open.get(pointerId);

    if (!contact) return;

    contact.seen += 1;
    contact.lastT = frame.t;

    // Past the cap keep counting (for `seen`) but stop retaining — a contact resting on the glass
    // must not be able to grow without bound mid-lesson.
    if (contact.frames.length < MAX_FRAMES_PER_CONTACT) {
      contact.frames.push(frame);
    }

    if (contact.decision.routing === null && state.routing !== null) {
      contact.decision.routing = state.routing;
      contact.decision.routingLatchedAtMs = frame.t;
      contact.decision.routingLatchedFrame = contact.seen - 1;
    }

    if (state.head !== null) {
      contact.decision.head = state.head;
      contact.decision.colourRole = resolveHeadColourRole(state.head);
    }

    if (contact.decision.colourLockedAtMs === null && state.colourLocked) {
      contact.decision.colourLockedAtMs = frame.t;
    }
  }

  /** Note that this contact began a pan / was taken over by the whole-hand eraser. */
  mark(pointerId: number, mark: 'panStarted' | 'wholeHandEraser'): void {
    const contact = this.open.get(pointerId);

    if (contact) contact.decision[mark] = true;
  }

  /** Close a contact and return it, or null when nothing was open under that id. */
  end(pointerId: number): CapturedContact | null {
    const contact = this.open.get(pointerId);

    if (!contact) return null;

    this.open.delete(pointerId);

    return {
      contactId: contact.contactId,
      startedAt: contact.startedAt,
      durationMs: contact.lastT,
      pointerType: contact.pointerType,
      frames: contact.frames,
      decision: contact.decision,
      ...(contact.context ? { context: contact.context } : {}),
    };
  }

  /** Close everything still open (unmount, or the self-heal reaper clearing stranded pointers). */
  endAll(): CapturedContact[] {
    return Array.from(this.open.keys())
      .map((pointerId) => this.end(pointerId))
      .filter((contact): contact is CapturedContact => contact !== null);
  }

  get openCount(): number {
    return this.open.size;
  }
}

/**
 * What an undo is worth. Larger than every other signal COMBINED, on purpose: the others are the
 * board guessing that a call was close, this one is the teacher saying it was wrong. Shared with
 * {@link markContactsUndone} so the live score and the retro-mark can never drift apart.
 */
export const UNDO_PRIORITY_WEIGHT = 100;

/**
 * How much a contact is worth a human's attention.
 *
 * A lesson produces thousands of contacts and almost all of them are obvious — a clear pen head, a
 * clear finger, decided the same way by any rule you care to write. Reviewing those teaches nobody
 * anything and would bury the handful that decide the classifier. Three signals separate them, and
 * the first is by far the strongest:
 *
 * 1. THE TWO RULEBOOKS DISAGREE. We ship both, so the board can replay the other one over the same
 *    frames for free. Disagreement is not a heuristic for "near the boundary" — it IS the boundary,
 *    located exactly where the two candidate answers part company.
 * 2. THE SETTLED SIZE SITS ON A BAND EDGE. Within a pixel of a threshold, the call was a coin flip
 *    that happened to land; the label matters far more there than in the middle of a band.
 * 3. AN UNDO FOLLOWED. The teacher told us it was wrong, in the only vocabulary the board has.
 *
 * Scores are ordinal — the review UI sorts by them and nothing else reads the magnitude.
 */
export function scoreContactPriority(input: {
  /** The head this contact's own rulebook settled on. */
  head: DualTipHead | null;
  /** The head the OTHER rulebook reaches over the same frames, when it was computed. */
  altHead?: DualTipHead | null;
  /** Routing verdicts from each rulebook (true = navigate). */
  routing: boolean | null;
  altRouting?: boolean | null;
  /** Settled minor-axis size the decision was taken on. */
  size: number;
  bands: { smallHeadMaxWidth: number; bigHeadMaxWidth: number; fingerMinWidth: number };
  undoFollowed?: boolean;
}): CapturedPriority {
  const rulebookDisagrees =
    (input.altHead !== undefined && input.altHead !== input.head) ||
    (input.altRouting !== undefined && input.altRouting !== input.routing);
  const edges = [input.bands.smallHeadMaxWidth, input.bands.bigHeadMaxWidth, input.bands.fingerMinWidth];
  const edgeDistancePx =
    input.size > 0 ? Math.min(...edges.map((edge) => Math.abs(input.size - edge))) : Number.POSITIVE_INFINITY;
  const undoFollowed = input.undoFollowed === true;

  // Weights are ordering, not measurement: an undo outranks a disagreement, which outranks proximity.
  // A contact that never resolved (size 0) scores 0 — there is nothing for a reviewer to judge.
  let score = 0;

  if (undoFollowed) score += UNDO_PRIORITY_WEIGHT;
  if (rulebookDisagrees) score += 50;

  if (Number.isFinite(edgeDistancePx)) {
    score += Math.max(0, 10 - edgeDistancePx * 2);
  }

  return { score, rulebookDisagrees, edgeDistancePx, undoFollowed };
}

/**
 * How long after a contact ends an undo can still be read as being ABOUT that contact.
 *
 * Short on purpose. An undo at 1.5s is a teacher looking at what they just wrote and rejecting it;
 * an undo half a minute later is about something else entirely, and crediting it to the last stroke
 * would put a perfectly good contact at the top of the review queue forever.
 */
export const UNDO_ATTRIBUTION_WINDOW_MS = 2_000;

/**
 * Could an undo have been aimed at this contact?
 *
 * Only contacts that PUT SOMETHING ON THE PAGE are candidates. A contact routed to navigate, or one
 * that actually panned, left nothing for undo to remove — crediting an undo to it would say "the
 * board was wrong to pan" when the teacher was undoing the stroke before it.
 */
function couldBeUndone(contact: CapturedContact): boolean {
  return contact.decision.routing !== true && !contact.decision.panStarted;
}

/**
 * Retro-mark the contacts an undo was aimed at — the ONE signal the board cannot collect in the
 * moment.
 *
 * Every other priority signal is known by the time the finger lifts. This one arrives afterwards, by
 * definition: the teacher sees the stroke, decides it was wrong, and presses undo. So the contact is
 * already sealed and sitting in a buffer or a queue row when the evidence shows up, and the only way
 * to use it is to reach back.
 *
 * It marks EVERY eligible contact inside the window, not just the last one to lift. One stroke is
 * routinely more than one contact here — a dropped pointerup splits it, the dual-tip stylus re-lands
 * mid-letter, a palm rides along — so "the last contact" is not reliably the one that drew. Over-
 * marking a neighbour costs a reviewer one extra glance; missing the real one costs the signal
 * entirely, and the window is short enough that the blast radius is about one word.
 *
 * Mutates in place (these are the caller's own buffered rows) and is idempotent: a second undo does
 * not stack another 100, and the FIRST undo's timestamp is the one kept — it is the prompt one, and
 * therefore the informative one.
 *
 * @returns how many contacts were newly marked, so a caller can skip a pointless durable write.
 */
export function markContactsUndone(
  contacts: CapturedContact[],
  undoneAtMs: number,
  windowMs: number = UNDO_ATTRIBUTION_WINDOW_MS,
): number {
  let marked = 0;

  for (const contact of contacts) {
    if (contact.priority?.undoFollowed) continue;
    if (!couldBeUndone(contact)) continue;

    // Both clocks are Date.now() (the recorder stamps `startedAt`, frame `t` is measured off it), so
    // this subtraction is meaningful rather than a guess across two time bases.
    const sinceEndMs = undoneAtMs - (contact.startedAt + contact.durationMs);

    if (sinceEndMs < 0 || sinceEndMs > windowMs) continue;

    const previous = contact.priority;

    contact.priority = {
      score: (previous?.score ?? 0) + UNDO_PRIORITY_WEIGHT,
      rulebookDisagrees: previous?.rulebookDisagrees ?? false,
      edgeDistancePx: previous?.edgeDistancePx ?? Number.POSITIVE_INFINITY,
      undoFollowed: true,
      undoneAtMs,
    };
    marked += 1;
  }

  return marked;
}
