import type { CardDraft } from './api';
import type { Question } from '@/lib/api/types';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { createFlashcard, deleteFlashcard, listFlashcards, updateFlashcard } from './api';

import { useStudyQueriesEnabled } from '@/lib/api/hooks';

/** Under ['study','questions'] so anything that refreshes the bank refreshes the decks too. */
export const FLASHCARDS_KEY = ['study', 'questions', 'flashcards'] as const;

export const useFlashcards = () =>
  useQuery({
    queryKey: FLASHCARDS_KEY,
    queryFn: listFlashcards,
    staleTime: 30_000,
    enabled: useStudyQueriesEnabled(),
  });

export function useFlashcardMutations() {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['study', 'questions'] });
    void queryClient.invalidateQueries({ queryKey: ['study', 'mastery'] });
  };

  const create = useMutation({ mutationFn: (draft: CardDraft) => createFlashcard(draft), onSuccess: refresh });
  const update = useMutation({
    mutationFn: ({ card, draft }: { card: Question; draft: CardDraft }) => updateFlashcard(card, draft),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (card: Question) => deleteFlashcard(card), onSuccess: refresh });

  return { create, update, remove, refresh };
}
