import type { CardDraft } from './api';
import type { Question, QuestionNote } from '@/lib/api/types';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { createFlashcard, deleteFlashcard, listFlashcards, saveCardNote, setCardBookmark, updateFlashcard } from './api';

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

type Marks = Pick<Question, 'bookmarked' | 'note'>;

/**
 * Bookmark + note writes. The decks list updates at once (and rolls back if the save fails); the
 * rest of the bank refreshes in the background. Rejects so the caller can say what went wrong.
 */
export function useCardMarks() {
  const queryClient = useQueryClient();

  const apply = (id: string, marks: Marks) => {
    const previous = queryClient.getQueryData<Question[]>(FLASHCARDS_KEY);

    queryClient.setQueryData<Question[]>(FLASHCARDS_KEY, (cards) =>
      cards?.map((card) => (card.id === id ? { ...card, ...marks } : card)),
    );

    return previous;
  };

  const save = async (id: string, marks: Marks, write: () => Promise<Question>) => {
    const previous = apply(id, marks);

    try {
      const saved = await write();

      apply(id, { bookmarked: saved.bookmarked, note: saved.note });
      void queryClient.invalidateQueries({
        queryKey: ['study', 'questions'],
        predicate: (query) => query.queryKey[2] !== 'flashcards',
      });

      return saved;
    } catch (err) {
      if (previous) queryClient.setQueryData(FLASHCARDS_KEY, previous);
      throw err;
    }
  };

  return {
    setBookmark: (card: Pick<Question, 'id'>, bookmarked: boolean) =>
      save(card.id, { bookmarked }, () => setCardBookmark(card, bookmarked)),
    saveNote: (card: Pick<Question, 'id'>, note: QuestionNote | null) =>
      save(card.id, { note }, () => saveCardNote(card, note)),
  };
}
