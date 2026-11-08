// A plan endpoints + React Query hooks. `/today`'s A plan fields ride on the shell's `useToday` cache.
import type { APlanPhase } from './lib/poll';
import type { APlan, APlanRefreshResult, APlanResponse, GradePlan, TodayAPlanFields } from './types';
import type { Today } from '@/lib/api/types';

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { normalizeAPlan } from './lib/normalize';
import { aPlanPoll, basePhase, isBuilding, POLL_CAP_MS } from './lib/poll';

import { studyGet, studyPatch, studyPost } from '@/lib/api/http';
import { studyKeys, useToday } from '@/lib/api/hooks';

const enc = encodeURIComponent;

export const getGradePlan = (classId: string) => studyGet<GradePlan>(`/classes/${enc(classId)}/grade-plan`);
/** 200 = the plan (maybe `stale`), 202 = `{ status: 'building' }` while the first build runs. */
export const getAPlan = (classId: string) => studyGet<APlanResponse>(`/classes/${enc(classId)}/a-plan`);
export const refreshAPlan = (classId: string) =>
  studyPost<APlanRefreshResult>(`/classes/${enc(classId)}/a-plan/refresh`);
export const setTargetLetter = (classId: string, targetLetter: string) =>
  studyPatch<unknown>(`/classes/${enc(classId)}`, { targetLetter });

export const aplanKeys = {
  gradePlan: (classId: string) => ['study', 'grade-plan', classId] as const,
  aPlan: (classId: string) => ['study', 'a-plan', classId] as const,
};

export const useGradePlan = (classId: string, enabled = true) =>
  useQuery({
    queryKey: aplanKeys.gradePlan(classId),
    queryFn: () => getGradePlan(classId),
    enabled: !!classId && enabled,
    staleTime: 60_000,
    retry: false,
  });

export interface APlanState {
  /** The normalized plan, or null while building / loading / on error. */
  plan: APlan | null;
  phase: APlanPhase;
  /** The previous build's failure, while a new one runs. */
  lastError: string | null;
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
  refreshing: boolean;
  /** After `timed_out`: start waiting again. */
  retry: () => void;
}

/**
 * The live a-plan with its poll loop: 202 → poll every 5 s, a stale plan or a pending Refresh → every
 * 10 s, each capped at 3 min (lib/poll.ts). Refresh = POST (202) then wait for a new `generatedAt`.
 */
export function useAPlan(classId: string): APlanState {
  const queryClient = useQueryClient();
  const [refreshFrom, setRefreshFrom] = useState<string | null>(null);
  const phaseClock = useRef<{ phase: string; since: number }>({ phase: 'loading', since: Date.now() });
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  // When the current phase began — reset whenever the phase changes.
  const sinceFor = (data: APlanResponse | undefined) => {
    const phase = basePhase(data, refreshFrom);

    if (phaseClock.current.phase !== phase) phaseClock.current = { phase, since: Date.now() };

    return phaseClock.current.since;
  };

  const query = useQuery({
    queryKey: aplanKeys.aPlan(classId),
    queryFn: () => getAPlan(classId),
    enabled: !!classId,
    staleTime: 60_000,
    retry: false,
    refetchInterval: (q) =>
      aPlanPoll({ data: q.state.data, refreshFrom, since: sinceFor(q.state.data), now: Date.now() }).intervalMs,
  });
  const data = query.data;
  const since = sinceFor(data);
  const { phase, intervalMs } = aPlanPoll({ data, refreshFrom, since, now: Date.now() });

  // The cap passes between polls: wake up once to show it.
  useEffect(() => {
    if (intervalMs === false) return;
    const timer = window.setTimeout(rerender, Math.max(0, since + POLL_CAP_MS - Date.now()) + 50);

    return () => window.clearTimeout(timer);
  }, [intervalMs, since]);

  // A refresh is done once a new plan arrives (or the wait gave up).
  useEffect(() => {
    if (refreshFrom !== null && phase !== 'refreshing' && phase !== 'building') setRefreshFrom(null);
  }, [phase, refreshFrom]);

  const mutation = useMutation({
    mutationFn: () => refreshAPlan(classId),
    onMutate: () => setRefreshFrom(data && !isBuilding(data) ? data.generatedAt : null),
    onSettled: () => {
      phaseClock.current = { phase: 'loading', since: Date.now() };
      void queryClient.invalidateQueries({ queryKey: aplanKeys.aPlan(classId) });
    },
    onError: () => setRefreshFrom(null),
  });

  const plan = useMemo(() => (data && !isBuilding(data) ? normalizeAPlan(data) : null), [data]);

  return {
    plan,
    phase,
    lastError: isBuilding(data) ? data.lastError : null,
    error: query.error,
    isLoading: query.isLoading,
    refresh: () => mutation.mutate(),
    refreshing: mutation.isPending || phase === 'refreshing',
    retry: () => {
      phaseClock.current = { phase: 'loading', since: Date.now() };
      void query.refetch();
    },
  };
}

function useInvalidatePlan(classId: string) {
  const queryClient = useQueryClient();

  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: aplanKeys.gradePlan(classId) }),
      queryClient.invalidateQueries({ queryKey: aplanKeys.aPlan(classId) }),
      queryClient.invalidateQueries({ queryKey: studyKeys.today }),
    ]);
}

export function useSetTargetLetter(classId: string) {
  const invalidate = useInvalidatePlan(classId);

  return useMutation({ mutationFn: (letter: string) => setTargetLetter(classId, letter), onSuccess: invalidate });
}

/** `/today` with the A plan additions typed in. */
export function useTodayAPlan() {
  const query = useToday();

  return { ...query, data: query.data as (Today & TodayAPlanFields) | undefined };
}
