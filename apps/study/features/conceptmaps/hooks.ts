// React Query wrappers for the concept-map endpoints (the shell's QueryClientProvider is global).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { createPracticeMap, listAttempts, listConceptMaps, makeShortAnswers, setMapScore } from './api';

export const conceptMapKeys = {
  all: ['study', 'concept-maps'] as const,
  list: (classId: string) => ['study', 'concept-maps', 'list', classId] as const,
  attempts: (mapId: string) => ['study', 'concept-maps', 'attempts', mapId] as const,
};

export const useConceptMaps = (classId: string) =>
  useQuery({
    queryKey: conceptMapKeys.list(classId),
    queryFn: () => listConceptMaps(classId),
    enabled: !!classId,
    staleTime: 30_000,
  });

export const useAttempts = (mapId: string | null | undefined) =>
  useQuery({
    queryKey: conceptMapKeys.attempts(mapId ?? ''),
    queryFn: () => listAttempts(mapId!),
    enabled: !!mapId,
  });

export function useInvalidateConceptMaps() {
  const queryClient = useQueryClient();

  return {
    maps: (classId?: string) =>
      queryClient.invalidateQueries({ queryKey: classId ? conceptMapKeys.list(classId) : conceptMapKeys.all }),
    attempts: (mapId: string) => queryClient.invalidateQueries({ queryKey: conceptMapKeys.attempts(mapId) }),
  };
}

/** Creates a practice map and adds it to the class list right away. */
export function useCreatePractice(classId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createPracticeMap,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conceptMapKeys.list(classId) });
    },
  });
}

export function useMakeShortAnswers() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: makeShortAnswers,
    onSuccess: () => {
      // The bank lists are the shell's / bank's queries; everything under 'study' that counts questions goes stale.
      void queryClient.invalidateQueries({ queryKey: ['study', 'questions'] });
      void queryClient.invalidateQueries({ queryKey: ['study', 'mastery'] });
    },
  });
}

/** «Enter her score» — PATCH /concept-maps/:id {score}. */
export function useSetMapScore(classId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ mapId, score }: { mapId: string; score: number | null }) => setMapScore(mapId, score),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conceptMapKeys.list(classId) });
    },
  });
}
