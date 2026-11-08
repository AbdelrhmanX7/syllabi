// React Query over the conversation routes + one streaming hook for `/ai/ask` (the shell's
// QueryClientProvider is global). A finished stream is written straight into the detail cache so the
// thread never flashes empty between «done» and the refetch.
import type { AskStreamState } from './lib/stream';
import type {
  AskRequest,
  TutorContext,
  TutorConversation,
  TutorConversationDetail,
  TutorMessage,
  TutorMode,
} from './types';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { askTutor, getConversation, listConversations } from './api';
import {
  appendMessages,
  applyQuizTurn,
  conversationRow,
  mergeConversation,
  newConversation,
} from './lib/conversations';
import { EMPTY_STREAM, reduceAskFrame } from './lib/stream';

import { describeError } from '@/lib/api/errors';
import { useStudyQueriesEnabled } from '@/lib/api/hooks';

export const tutorKeys = {
  all: ['study', 'tutor'] as const,
  lists: ['study', 'tutor', 'list'] as const,
  list: (classId?: string | null) => ['study', 'tutor', 'list', classId ?? ''] as const,
  detail: (id: string) => ['study', 'tutor', 'detail', id] as const,
};

export const useConversations = (classId?: string | null) =>
  useQuery({
    queryKey: tutorKeys.list(classId),
    queryFn: () => listConversations(classId),
    enabled: useStudyQueriesEnabled(),
    staleTime: 15_000,
  });

export const useConversation = (id?: string | null) =>
  useQuery({
    queryKey: tutorKeys.detail(id ?? ''),
    queryFn: () => getConversation(id!),
    enabled: useStudyQueriesEnabled() && !!id,
    staleTime: 60_000,
  });

export interface SendArgs {
  classId?: string | null;
  conversationId?: string | null;
  mode: TutorMode;
  question: string;
  context?: TutorContext;
}

export interface AskRunState {
  status: 'idle' | 'streaming' | 'done' | 'error';
  /** The user turn being answered (shown before the server echoes it). */
  pending: TutorMessage | null;
  stream: AskStreamState;
  error: string | null;
}

const IDLE_RUN: AskRunState = { status: 'idle', pending: null, stream: EMPTY_STREAM, error: null };

/**
 * Sends one question and streams the answer. Resolves with the conversation id (new or existing)
 * once `done` lands, null when it failed or was cancelled. Starting a new send aborts the previous.
 */
export function useAsk() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AskRunState>(IDLE_RUN);
  const controllerRef = useRef<AbortController | null>(null);
  const streamRef = useRef<AskStreamState>(EMPTY_STREAM);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState((current) => (current.status === 'streaming' ? { ...current, status: 'done' } : current));
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    streamRef.current = EMPTY_STREAM;
    setState(IDLE_RUN);
  }, []);

  const send = useCallback(
    async ({ classId, conversationId, mode, question, context }: SendArgs): Promise<string | null> => {
      controllerRef.current?.abort();
      const controller = new AbortController();

      controllerRef.current = controller;
      const now = new Date().toISOString();
      const pending: TutorMessage = {
        role: 'user',
        text: question,
        createdAt: now,
        mode,
        ...(context ? { context } : {}),
      };

      streamRef.current = EMPTY_STREAM;
      setState({ status: 'streaming', pending, stream: EMPTY_STREAM, error: null });

      const body: AskRequest = {
        ...(classId ? { classId } : {}),
        ...(conversationId ? { conversationId } : {}),
        mode,
        question,
        ...(context ? { context } : {}),
      };

      try {
        await askTutor(
          body,
          (frame) => {
            if (controller.signal.aborted) return;
            streamRef.current = reduceAskFrame(streamRef.current, frame);
            const next = streamRef.current;

            setState((current) => ({ ...current, stream: next }));
          },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) return null;
        setState((current) => ({ ...current, status: 'error', error: describeError(error) }));

        return null;
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }

      if (controller.signal.aborted) return null;
      const final = streamRef.current;

      if (final.error) {
        setState((current) => ({ ...current, status: 'error', error: final.error }));

        return null;
      }

      const id = final.conversationId ?? conversationId ?? null;

      if (id) {
        const assistant: TutorMessage = {
          role: 'assistant',
          text: final.text,
          createdAt: new Date().toISOString(),
          mode,
          ...(final.sources.length ? { sources: final.sources } : {}),
        };

        queryClient.setQueryData<TutorConversationDetail>(tutorKeys.detail(id), (previous) => {
          const next = appendMessages(
            previous ?? newConversation(id, classId ?? null, question, mode, now),
            pending,
            assistant,
          );

          return final.quiz ? applyQuizTurn(next, final.quiz) : next;
        });
        const detail = queryClient.getQueryData<TutorConversationDetail>(tutorKeys.detail(id));

        if (detail) {
          const row = conversationRow(detail);

          for (const key of [tutorKeys.list(classId), tutorKeys.list(null)]) {
            queryClient.setQueryData(key, (list?: TutorConversation[]) => mergeConversation(list ?? [], row));
          }
        }
        void queryClient.invalidateQueries({ queryKey: tutorKeys.lists });
      }

      setState((current) => ({ ...current, status: 'done' }));

      return id;
    },
    [queryClient],
  );

  return { state, send, cancel, reset };
}

export function useInvalidateTutor() {
  const queryClient = useQueryClient();

  return () => queryClient.invalidateQueries({ queryKey: tutorKeys.all });
}
