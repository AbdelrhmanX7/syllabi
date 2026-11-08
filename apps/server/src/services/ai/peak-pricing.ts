/**
 * DeepSeek peak/valley pricing: peak hours are billed at 2× on ALL billing items.
 * Peak windows (UTC): 01:00–04:00 and 06:00–10:00, **Monday to Friday**.
 *
 * Current published rates (per 1M tokens, effective 2026-09-10 04:00 UTC, when
 * every Pro request began routing to V4.1 Flash at Flash prices):
 *   input cache hit   $0.003 off-peak / $0.006 peak
 *   input cache miss  $0.15  off-peak / $0.3   peak
 *   output            $0.6   off-peak / $1.2   peak
 * A cache hit is still ~50× cheaper than a miss, so prompt-prefix stability
 * remains the single biggest cost lever — see services/ai/text-provider.ts.
 *
 * Behaviour, windows AND days are env-switchable so a DeepSeek policy change is a
 * config edit, not a redeploy:
 *   DEEPSEEK_PEAK_AVOIDANCE   'off' | 'false' | '0'  → disable entirely (default: on)
 *   DEEPSEEK_PEAK_WINDOWS_UTC '1-4,6-10'             → retune the hour windows
 *   DEEPSEEK_PEAK_DAYS_UTC    '1-5'                  → retune the UTC weekdays
 *                                                      (0=Sun … 6=Sat; default Mon–Fri)
 *
 * Hour windows are half-open [start, end) on the UTC hour; day ranges are
 * INCLUSIVE on both ends (a weekday range reads naturally as "Mon to Fri").
 */
const DEFAULT_PEAK_WINDOWS_UTC = "1-4,6-10";
const DEFAULT_PEAK_DAYS_UTC = "1-5"; // Monday–Friday, per DeepSeek's published policy

/**
 * The published rates from the header comment above, as data — the single source other
 * modules (e.g. the offline grader-eval cost estimate in scripts/lib/grader-eval.ts) should
 * derive from instead of hardcoding their own copy that silently goes stale on a repricing.
 */
export const DEEPSEEK_FLASH_RATES_USD_PER_M = {
  offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
};

function isAvoidanceEnabled(): boolean {
  const raw = process.env.DEEPSEEK_PEAK_AVOIDANCE?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true; // default ON
  return !["off", "false", "0", "no"].includes(raw);
}

/** Parse "1-4,6-10" → [[1,4],[6,10]]. Returns [] on anything malformed (fail open). */
function parseWindows(raw: string): Array<[number, number]> {
  const windows: Array<[number, number]> = [];

  for (const part of raw.split(",")) {
    const match = part.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (!match) return [];

    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
    if (start < 0 || start > 23 || end < 1 || end > 24 || start >= end) return [];

    windows.push([start, end]);
  }

  return windows;
}

/**
 * Parse "1-5" / "1-5,0" / "3" → the set of UTC weekday numbers (0=Sun … 6=Sat).
 * Returns null on anything malformed, which the caller treats as fail-open.
 *
 * Unlike the hour windows these ranges are INCLUSIVE, so "1-5" is Mon,Tue,Wed,
 * Thu,Fri — five days, not four. Reusing the half-open hour parser here would
 * have silently dropped Friday from every peak window.
 */
function parseDays(raw: string): Set<number> | null {
  const days = new Set<number>();

  for (const part of raw.split(",")) {
    const match = part.trim().match(/^(\d)\s*(?:-\s*(\d))?$/);
    if (!match) return null;

    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start > 6 || end > 6 || start > end) return null;

    for (let d = start; d <= end; d++) days.add(d);
  }

  return days.size > 0 ? days : null;
}

/**
 * True when `now` falls inside a DeepSeek 2×-priced peak window, judged ONLY by the
 * configured windows and days.
 *
 * This is the BILLING predicate: what DeepSeek charges does not depend on whether we happen
 * to be avoiding peak hours. `DEEPSEEK_PEAK_AVOIDANCE` is a scheduling kill switch, and
 * routing billing through it understated every peak turn by half whenever it was off.
 * Misconfiguration still fails open (false), because a broken window string should not
 * invent a 2× charge.
 */
export function isDeepSeekPeakInstant(now: Date = new Date()): boolean {
  const rawDays = process.env.DEEPSEEK_PEAK_DAYS_UTC?.trim() || DEFAULT_PEAK_DAYS_UTC;
  const days = parseDays(rawDays);
  if (days === null) return false; // malformed → don't block anything
  if (!days.has(now.getUTCDay())) return false; // weekends are never peak

  const raw = process.env.DEEPSEEK_PEAK_WINDOWS_UTC?.trim() || DEFAULT_PEAK_WINDOWS_UTC;
  const windows = parseWindows(raw);
  if (windows.length === 0) return false; // malformed → don't block anything

  const hour = now.getUTCHours();
  return windows.some(([start, end]) => hour >= start && hour < end);
}

/**
 * True when `now` is a peak window AND peak avoidance is switched on — the SCHEDULING
 * predicate: "should this deferrable job wait?". Fails OPEN (false) when disabled or
 * misconfigured, so cost control never stops real work.
 *
 * ⚠️ Never bill from this one: `DEEPSEEK_PEAK_AVOIDANCE=off` makes it report off-peak while
 * DeepSeek still charges 2×. Use `isDeepSeekPeakInstant` for money.
 */
export function isDeepSeekPeakHour(now: Date = new Date()): boolean {
  return isAvoidanceEnabled() && isDeepSeekPeakInstant(now);
}
