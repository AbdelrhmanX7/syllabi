// The buddy's «Custom AI» data: its experts (ours, edited, your own), what it remembers, and the
// log of its answers. Mock in sample mode (features/buddy/mock.ts), the server otherwise.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useStudyQueriesEnabled } from '@/lib/api/hooks';
import { studyDelete, studyGet, studyPost, studyPut } from '@/lib/api/http';

export type ExpertGives = 'steps' | 'quiz' | 'similar' | null;

export interface BuddyExpert {
  id: string;
  name: string;
  /** When the buddy should use it (one sentence). */
  when: string;
  /** Its rules, one per line. */
  job: string[];
  gives: ExpertGives;
  weakTopics: boolean;
  enabled: boolean;
  origin: 'builtin' | 'edited' | 'custom';
}
export type ExpertEdit = Pick<BuddyExpert, 'name' | 'when' | 'job' | 'gives' | 'weakTopics' | 'enabled'>;

export interface BuddyNote {
  text: string;
  at: string;
  /** Who wrote it: an expert's id, «quiz», or «you». */
  by: string;
  classId: string | null;
}

export interface BuddyTraceStep {
  kind: string;
  name: string;
  models: string[];
  ms: number;
  costUsd: number;
  detail: string;
}
export interface BuddyTurn {
  id: string;
  at: string;
  question: string;
  handwritten: boolean;
  skill: string;
  expert: string;
  pickedBy: 'button' | 'picker' | 'fallback';
  status: 'done' | 'error';
  error: string | null;
  trace: BuddyTraceStep[];
  reply: { say?: string; verdict?: string; steps?: string[]; quiz?: { question: string; choices: string[]; answer: number; why: string }; similar?: { title: string; markdown: string }; marks: number } | null;
  quizAnswer: { choice: number; correct: boolean } | null;
  rating: 'up' | 'down' | null;
  models: string[];
  costUsd: number;
  latencyMs: number;
  /** Only on a single turn: the page as the buddy saw it. */
  imageUrl?: string | null;
}

const enc = encodeURIComponent;

export const listExperts = () => studyGet<{ experts: BuddyExpert[] }>('/ai/buddy/experts').then((r) => r.experts);
export const saveExpert = (id: string, edit: ExpertEdit) => studyPut<{ id: string }>(`/ai/buddy/experts/${enc(id)}`, edit);
export const removeExpert = (id: string) => studyDelete(`/ai/buddy/experts/${enc(id)}`);
export const listNotes = () => studyGet<{ notes: BuddyNote[] }>('/ai/buddy/memory').then((r) => r.notes);
export const addNote = (text: string) => studyPost('/ai/buddy/memory', { text });
export const forgetNote = (note: Pick<BuddyNote, 'text' | 'classId'>) => studyPost('/ai/buddy/memory/forget', { text: note.text, ...(note.classId ? { classId: note.classId } : {}) });
export const listTurns = (rating?: 'up' | 'down') => studyGet<{ turns: BuddyTurn[] }>(`/ai/buddy/turns?limit=40${rating ? `&rating=${rating}` : ''}`).then((r) => r.turns);
export const getTurn = (id: string) => studyGet<BuddyTurn>(`/ai/buddy/turns/${enc(id)}`);
export const rateTurn = (id: string, rating: 'up' | 'down' | null) => studyPost(`/ai/buddy/turns/${enc(id)}/rating`, { rating });

export const buddyKeys = {
  experts: ['study', 'buddy', 'experts'] as const,
  notes: ['study', 'buddy', 'notes'] as const,
  turns: (rating?: string) => ['study', 'buddy', 'turns', rating ?? 'all'] as const,
  turn: (id: string) => ['study', 'buddy', 'turn', id] as const,
};

export const useBuddyExperts = () => useQuery({ queryKey: buddyKeys.experts, queryFn: listExperts, enabled: useStudyQueriesEnabled() });
export const useBuddyNotes = () => useQuery({ queryKey: buddyKeys.notes, queryFn: listNotes, enabled: useStudyQueriesEnabled() });
export const useBuddyTurns = (rating?: 'up' | 'down') => useQuery({ queryKey: buddyKeys.turns(rating), queryFn: () => listTurns(rating), enabled: useStudyQueriesEnabled() });
export const useBuddyTurn = (id: string | null) => useQuery({ queryKey: buddyKeys.turn(id ?? ''), queryFn: () => getTurn(id!), enabled: useStudyQueriesEnabled() && !!id });

export function useBuddyMutations() {
  const queryClient = useQueryClient();
  const refresh = (key: readonly unknown[]) => () => void queryClient.invalidateQueries({ queryKey: key });

  return {
    saveExpert: useMutation({ mutationFn: ({ id, edit }: { id: string; edit: ExpertEdit }) => saveExpert(id, edit), onSuccess: refresh(buddyKeys.experts) }),
    removeExpert: useMutation({ mutationFn: removeExpert, onSuccess: refresh(buddyKeys.experts) }),
    addNote: useMutation({ mutationFn: addNote, onSuccess: refresh(buddyKeys.notes) }),
    forgetNote: useMutation({ mutationFn: forgetNote, onSuccess: refresh(buddyKeys.notes) }),
    rateTurn: useMutation({ mutationFn: ({ id, rating }: { id: string; rating: 'up' | 'down' | null }) => rateTurn(id, rating), onSuccess: refresh(['study', 'buddy', 'turns']) }),
  };
}
