// Which `/today.aPlan` rows are worth a line on Today, most urgent first. Pure.
import type { RequirementStatus, TodayAPlanEntry } from '../types';

const RANK: Record<string, number> = { missed: 0, at_risk: 1, on_track: 2, met: 3 };

export const isRequirementStatus = (status: string): status is RequirementStatus => status in RANK;

/**
 * A row needs something to say: a top action or an alert. A class still building (or reported as
 * building with no action — a known backend slip for built plans) is left out, never spun on.
 */
export function visibleTodayPlans(entries: readonly TodayAPlanEntry[] | undefined): TodayAPlanEntry[] {
  return (entries ?? [])
    .filter((entry) => !!entry.topAction || (entry.alerts?.length ?? 0) > 0)
    .sort((a, b) => {
      const alertsFirst = Number((b.alerts?.length ?? 0) > 0) - Number((a.alerts?.length ?? 0) > 0);

      return alertsFirst || (RANK[a.status] ?? 4) - (RANK[b.status] ?? 4);
    });
}
