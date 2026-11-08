// The a-plan poll state machine. Pure: the hook passes the clock and when the current phase began.
//
//   building   — 202, the first build runs (20–60 s): poll every 5 s
//   refreshing — the owner pressed Refresh and the plan on screen is still the one from before
//   stale      — a cached plan whose inputs moved; the backend rebuilds it in the background
//   ready      — nothing to wait for
//   timed_out  — still building after POLL_CAP_MS: stop polling, offer a manual retry
//
// Every polling phase stops after POLL_CAP_MS, so a build that keeps failing never spins forever.
import type { APlanBuilding, APlanResponse } from '../types';

export const BUILD_POLL_MS = 5_000;
export const UPDATE_POLL_MS = 10_000;
export const POLL_CAP_MS = 3 * 60_000;

export type APlanPhase = 'loading' | 'building' | 'refreshing' | 'stale' | 'ready' | 'timed_out';

export const isBuilding = (data: APlanResponse | null | undefined): data is APlanBuilding =>
  !!data && data.status === 'building';

/**
 * The phase before the time cap. `refreshFrom` = the `generatedAt` on screen when Refresh was pressed
 * (null when no refresh is pending): server clocks are never compared with the device's.
 */
export function basePhase(
  data: APlanResponse | null | undefined,
  refreshFrom: string | null,
): Exclude<APlanPhase, 'timed_out'> {
  if (!data) return 'loading';
  if (isBuilding(data)) return 'building';
  if (refreshFrom !== null && data.generatedAt === refreshFrom) return 'refreshing';
  if (data.stale) return 'stale';

  return 'ready';
}

/** The phase after the cap, and how long until the next poll (false = do not poll). */
export function aPlanPoll(input: {
  data: APlanResponse | null | undefined;
  refreshFrom: string | null;
  /** When the current base phase began (ms). */
  since: number;
  now: number;
}): { phase: APlanPhase; intervalMs: number | false } {
  const phase = basePhase(input.data, input.refreshFrom);
  const expired = input.now - input.since >= POLL_CAP_MS;

  switch (phase) {
    case 'building':
      return expired ? { phase: 'timed_out', intervalMs: false } : { phase, intervalMs: BUILD_POLL_MS };
    case 'refreshing':
    case 'stale':
      // A rebuild that never lands leaves the old plan up — still correct to read, just not newest.
      return expired ? { phase: 'ready', intervalMs: false } : { phase, intervalMs: UPDATE_POLL_MS };
    default:
      return { phase, intervalMs: false };
  }
}
