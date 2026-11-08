import { wbT, type WbLocale } from '../../../i18n/strings';

import { REMAKE_STAGE_LINES } from './remakeDraft';

import type { CSSProperties } from 'react';

import type { RemakeDraft } from './remakeDraft';

/**
 * The generating state of the «Similar copy» draft page, as pure decisions: which orb animation each
 * stage shows, which line the status card says, and when the board chrome steps aside.
 */

/** The `thinking-orbs` states this flow uses (a subset of the library's nine). */
export type RemakeOrbState = 'searching' | 'composing' | 'shaping' | 'solving' | 'breathing';

/** Stage index (see `REMAKE_STAGE_LINES`) → orb. Before any status line the page is being read. */
const STAGE_ORBS: readonly RemakeOrbState[] = ['searching', 'composing', 'shaping', 'solving'];

/**
 * reading = searching (a scan sweeps the globe), writing questions = composing, drawing the page =
 * shaping, verifying = solving, done = breathing.
 */
export function remakeOrbState(draft: Pick<RemakeDraft, 'phase' | 'clock'> | null): RemakeOrbState {
  if (!draft || draft.phase !== 'generating') return 'breathing';

  return STAGE_ORBS[Math.min(Math.max(draft.clock.stage, 0), STAGE_ORBS.length - 1)]!;
}

/** Each orb inked in one brand hue — the four fronts of the dissolve gradient, purple when done. */
export const REMAKE_ORB_COLORS: Record<RemakeOrbState, string> = {
  searching: '#006fee',
  composing: '#6e8cff',
  shaping: '#ec4899',
  solving: '#2f5bea',
  breathing: '#2f5bea',
};

/** Shown once the partial `questions` frame lands: the text exists, the page is being cleaned. */
export const REMAKE_QUESTIONS_READY_LINE = wbT('en', 'ai.remake.questionsReady');

/**
 * The status card's line: the stage's canonical line. The server's own status text only moves the
 * stage (see `remakeStageOf`); it is not shown.
 */
export function remakeStatusText(
  draft: Pick<RemakeDraft, 'clock' | 'questionsReady'> | null,
  _statusLine?: string | null,
  _locale?: WbLocale,
): string {
  if (draft?.questionsReady) return REMAKE_QUESTIONS_READY_LINE;

  return REMAKE_STAGE_LINES[Math.min(Math.max(draft?.clock.stage ?? 0, 0), REMAKE_STAGE_LINES.length - 1)]!;
}

/**
 * The board chrome (toolbar, dock, title bar, page controls, quick pen, host cluster) steps aside
 * while the draft page is being made AND on screen — through the finishing reveal — and comes back
 * for the review card, or the moment the teacher leaves the page.
 */
export function remakeChromeHidden(draft: Pick<RemakeDraft, 'phase'> | null, onPage: boolean): boolean {
  return Boolean(draft && onPage && (draft.phase === 'generating' || draft.phase === 'revealing'));
}

/** What the editor needs to know about a running draft (chrome + the page-list thumbnail orb). */
export interface RemakeGeneratingInfo {
  /** The transient page being made. */
  pageId: string;
  /** Still generating (the thumbnail orb shows only then). */
  generating: boolean;
  /** Board chrome should be hidden right now. */
  chromeHidden: boolean;
  orb: RemakeOrbState;
}

export function remakeGeneratingInfo(draft: RemakeDraft | null, onPage: boolean): RemakeGeneratingInfo | null {
  if (!draft) return null;

  return { pageId: draft.pageId, generating: draft.phase === 'generating', chromeHidden: remakeChromeHidden(draft, onPage), orb: remakeOrbState(draft) };
}

export const sameGeneratingInfo = (a: RemakeGeneratingInfo | null, b: RemakeGeneratingInfo | null): boolean =>
  a === b || Boolean(a && b && a.pageId === b.pageId && a.generating === b.generating && a.chromeHidden === b.chromeHidden && a.orb === b.orb);

/** Chrome slide/fade, ms. */
export const CHROME_HIDE_MS = 200;

/** Which edge the piece slides toward; `none` = fade only (for chrome that carries its own transform). */
export type ChromeEdge = 'top' | 'bottom' | 'start' | 'end' | 'none';

/**
 * Inline style that slides a piece of chrome off toward its edge and fades it. `visibility` (delayed
 * on the way out) takes it out of hit-testing, so its `pointer-events-auto` children can never catch a
 * tap while hidden. Transform/opacity only — composited, no layout or paint on Android.
 */
export function chromeHideStyle(hidden: boolean, edge: ChromeEdge, base?: CSSProperties): CSSProperties {
  const offset =
    edge === 'none' ? undefined : edge === 'top' ? 'translateY(-16px)' : edge === 'bottom' ? 'translateY(16px)' : edge === 'start' ? 'translateX(16px)' : 'translateX(-16px)';

  return {
    ...base,
    opacity: hidden ? 0 : 1,
    // Shown = no transform at all: a transform makes a containing block for fixed descendants.
    ...(edge === 'none' ? {} : { transform: hidden ? offset : undefined }),
    visibility: hidden ? 'hidden' : 'visible',
    transition: hidden
      ? `opacity ${CHROME_HIDE_MS}ms ease-in, transform ${CHROME_HIDE_MS}ms ease-in, visibility 0s linear ${CHROME_HIDE_MS}ms`
      : `opacity ${CHROME_HIDE_MS}ms ease-out, transform ${CHROME_HIDE_MS}ms ease-out, visibility 0s linear 0s`,
    // Out of hit-testing at once (visibility only flips after the fade).
    ...(hidden ? { pointerEvents: 'none' as const } : {}),
  };
}
