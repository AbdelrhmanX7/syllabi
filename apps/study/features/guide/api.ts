// Guide / exam schedule / exam results endpoints + React Query hooks.
import type {
  ClassGuide,
  ExamBlueprint,
  ExamBlueprintState,
  ExamResultInput,
  ExamResultRow,
  ExamScheduleEntry,
} from './types';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { studyGet, studyPatch, studyPost, studyPut } from '@/lib/api/http';
import { studyKeys, useStudyQueriesEnabled } from '@/lib/api/hooks';

const enc = encodeURIComponent;

export const getGuide = (classId: string) => studyGet<ClassGuide>(`/classes/${enc(classId)}/guide`);
export const putGuide = (classId: string, markdown: string) =>
  studyPut<ClassGuide>(`/classes/${enc(classId)}/guide`, { markdown });

export const getSchedule = (classId: string) =>
  studyGet<ExamScheduleEntry[]>(`/classes/${enc(classId)}/exams-schedule`);
export const putSchedule = (classId: string, schedule: ExamScheduleEntry[]) =>
  studyPut<ExamScheduleEntry[]>(`/classes/${enc(classId)}/exams-schedule`, { schedule });

export const listResults = (classId: string) => studyGet<ExamResultRow[]>(`/classes/${enc(classId)}/exam-results`);
export const createResult = (classId: string, body: ExamResultInput) =>
  studyPost<ExamResultRow>(`/classes/${enc(classId)}/exam-results`, body);
export const patchResult = (classId: string, resultId: string, patch: Partial<ExamResultInput>) =>
  studyPatch<ExamResultRow>(`/classes/${enc(classId)}/exam-results/${enc(resultId)}`, patch);

export const getBlueprint = (classId: string) =>
  studyGet<ExamBlueprintState>(`/classes/${enc(classId)}/exam-blueprint`);
/** `null` resets to the course default (or none). */
export const putBlueprint = (classId: string, blueprint: ExamBlueprint | null) =>
  studyPut<ExamBlueprintState>(`/classes/${enc(classId)}/exam-blueprint`, blueprint ? blueprint : { blueprint: null });

export const guideKeys = {
  guide: (classId: string) => ['study', 'guide', classId] as const,
  schedule: (classId: string) => ['study', 'exams-schedule', classId] as const,
  results: (classId: string) => ['study', 'exam-results', classId] as const,
  blueprint: (classId: string) => ['study', 'exam-blueprint', classId] as const,
};

export function useGuide(classId: string) {
  const enabled = useStudyQueriesEnabled();

  return useQuery({
    queryKey: guideKeys.guide(classId),
    queryFn: () => getGuide(classId),
    enabled: enabled && !!classId,
    staleTime: 60_000,
    retry: false,
  });
}

export function useSaveGuide(classId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (markdown: string) => putGuide(classId, markdown),
    onSuccess: (guide) => qc.setQueryData(guideKeys.guide(classId), guide),
  });
}

export function useSchedule(classId: string) {
  const enabled = useStudyQueriesEnabled();

  return useQuery({
    queryKey: guideKeys.schedule(classId),
    queryFn: () => getSchedule(classId),
    enabled: enabled && !!classId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Schedules of many classes at once (the Today countdown). */
export function useSchedules(classIds: string[]) {
  const enabled = useStudyQueriesEnabled();

  return useQueries({
    queries: classIds.map((classId) => ({
      queryKey: guideKeys.schedule(classId),
      queryFn: () => getSchedule(classId),
      enabled: enabled && !!classId,
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
}

export function useSaveSchedule(classId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (schedule: ExamScheduleEntry[]) => putSchedule(classId, schedule),
    onSuccess: (schedule) => qc.setQueryData(guideKeys.schedule(classId), schedule),
  });
}

export function useResults(classId: string) {
  const enabled = useStudyQueriesEnabled();

  return useQuery({
    queryKey: guideKeys.results(classId),
    queryFn: () => listResults(classId),
    enabled: enabled && !!classId,
    staleTime: 60_000,
    retry: false,
  });
}

/** POST (no id) or PATCH (id); refreshes the list plus the class / Today summaries that carry the latest. */
export function useSaveResult(classId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: ExamResultInput }) =>
      id ? patchResult(classId, id, body) : createResult(classId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: guideKeys.results(classId) });
      void qc.invalidateQueries({ queryKey: studyKeys.today });
      void qc.invalidateQueries({ queryKey: ['study', 'classes'] });
    },
  });
}

export function useBlueprint(classId: string) {
  const enabled = useStudyQueriesEnabled();

  return useQuery({
    queryKey: guideKeys.blueprint(classId),
    queryFn: () => getBlueprint(classId),
    enabled: enabled && !!classId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useSaveBlueprint(classId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (blueprint: ExamBlueprint | null) => putBlueprint(classId, blueprint),
    onSuccess: (state) => qc.setQueryData(guideKeys.blueprint(classId), state),
  });
}
