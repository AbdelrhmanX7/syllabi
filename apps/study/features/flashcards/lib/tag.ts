// Older servers save /ai/flashcards output without the 'flashcard' tag: add it (fire and forget) so
// the cards show up in the decks. Returns the card as tagged.
import type { Question } from '@/lib/api/types';

import { isFlashcard, withFlashcardTag } from './deck';

import { patchQuestion } from '@/lib/api/endpoints';

export function tagAsFlashcard(card: Question): Question {
  if (!card?.id || isFlashcard(card)) return card;
  const tags = withFlashcardTag(card.tags);

  void patchQuestion(card.id, { tags }).catch(() => undefined);

  return { ...card, tags };
}
