/**
 * Slide intros — the "play the PowerPoint animation when the page opens" policy.
 *
 * A page whose source slide had an entrance animation / Morph transition gets a short clip rendered
 * natively at import time. When the page is entered the clip plays ONCE in the page-background layer,
 * under the ink, and then the static page raster takes over. Nothing here touches the document model:
 * an intro is a presentation detail resolved by the host per page id.
 *
 * This module is the pure half — the decision of whether a resolution that has just landed is still
 * allowed to play. It is deliberately free of React/DOM so it can be unit-tested.
 */

/**
 * The transition a slide asks to be entered with, straight out of the deck.
 *
 * `inClip` decides who draws it. When the native renderer could pair the two slides it rendered the
 * transition INTO the clip, and the clip's opening frames are the transition itself. When it could
 * not, the transition is described here and drawn natively (see utils/pageTransitions).
 */
export interface PageTransition {
  /** The deck's own name: fade, push, wipe, cover, uncover, split, cut, zoom, morph, a p14 exotic… */
  kind: string;
  durationMs: number;
  /** Motion direction, compass values only: l, r, u, d, or a diagonal (ld, lu, rd, ru). */
  direction?: string;
  /** Kind-specific modifier: in/out for split and zoom. */
  option?: string;
  /**
   * Axis, for the kinds that have one. Follows OOXML: `horz` splits along a horizontal line, so the
   * halves move vertically; `vert` splits along a vertical line.
   */
  orient?: 'horz' | 'vert';
  /** True when the clip already opens with this transition; false when we draw it. */
  inClip: boolean;
}

/**
 * One resolved slide intro.
 *
 * `url` is playable by a `<video>` element (a `blob:` URL of an mp4), or null for a page that has
 * only a transition and no animation to play afterwards.
 */
export interface PageIntro {
  url: string | null;
  durationMs: number;
  transition?: PageTransition;
}

/** Resolves the intro clip for a page, or `null` when that page has none (yet). */
export type ResolvePageIntro = (pageId: string) => Promise<PageIntro | null>;

/**
 * What a page has waiting for it, answered SYNCHRONOUSLY.
 *
 * Entering a page with a transition means holding the outgoing page on screen while the new one
 * loads, and that has to be decided before the load starts — long before the async resolver could
 * answer. A page with neither a clip nor a transition must navigate exactly as it did before this
 * feature existed, which is what this lookup protects.
 */
export interface PageIntroPeek {
  hasClip: boolean;
  hasTransition: boolean;
}

/** Synchronous "is there anything here?" for a page. Null means no. */
export type PeekPageIntro = (pageId: string) => PageIntroPeek | null;

/**
 * The intro state of the page on screen, published on the canvas wrapper as `data-page-intro` so a
 * test (or a teacher's bug report) can observe playback without reaching into React.
 *
 * - `none` — this page has no intro, or one could not be started.
 * - `loading` — an intro is being resolved, or is buffering before its first frame.
 * - `transition` — a transition into this page is being drawn natively.
 * - `playing` — frames are being painted into the page background.
 * - `done` — the clip finished; the static page raster is back.
 */
export type PageIntroStatus = 'none' | 'loading' | 'transition' | 'playing' | 'done';

export interface ResolvedIntroAttempt {
  /** The page the resolution was requested for. */
  requestedPageId: string;
  /** The page that is open now (the last page ENTERED), or null when none is. */
  currentPageId: string | null;
  /**
   * The visit token at request time vs now. A token is minted per page ENTER, so a re-entry of the
   * same page id (navigate away and back, re-open after an import) is a NEW visit and may play again.
   */
  requestedVisit: number;
  currentVisit: number;
  /** Whether an intro has already played during the CURRENT visit. */
  playedThisVisit: boolean;
}

/**
 * True when a resolution that just landed still belongs to the page on screen and nothing has played
 * for this visit yet. Everything else — a page switch during the await, a second resolution for a
 * visit that already played — is dropped.
 */
export function shouldPlayResolvedIntro(attempt: ResolvedIntroAttempt): boolean {
  if (attempt.playedThisVisit) return false;
  if (attempt.currentPageId === null) return false;
  if (attempt.requestedPageId !== attempt.currentPageId) return false;

  return attempt.requestedVisit === attempt.currentVisit;
}

/**
 * How long to wait for a clip to finish before giving up on it. `ended` is the normal end; a clip
 * whose container lies about its duration (or that stalls on a decode) must never leave the intro
 * layer painted over the page forever, so playback is also bounded by this.
 *
 * A duration of 0 (or negative, or not a number) means UNKNOWN, not "instant": it is what the
 * native probe reports when it could not parse a duration out of ffmpeg's banner. Treating it as a
 * length would cut a four-second morph off after the slack alone, so an unknown duration gets the
 * ceiling — the clip's own `ended` event is what normally stops it, and the ceiling is only there
 * so a stalled decode cannot hold the layer forever.
 */
export function resolveIntroTimeoutMs(durationMs: number): number {
  const isKnown = Number.isFinite(durationMs) && durationMs > 0;

  if (!isKnown) {
    return MAX_INTRO_TIMEOUT_MS;
  }

  return Math.min(durationMs + INTRO_TIMEOUT_SLACK_MS, MAX_INTRO_TIMEOUT_MS);
}

const INTRO_TIMEOUT_SLACK_MS = 1_500;
const MAX_INTRO_TIMEOUT_MS = 30_000;
