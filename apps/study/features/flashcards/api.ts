// Flashcards are bank questions tagged 'flashcard' (front = stem, back = answer) — thin wrappers over
// the shared /questions + /ai/flashcards endpoints.
import type { Grade } from './lib/deck';
import type { Question } from '@/lib/api/types';

import { FLASHCARD_TAG, gradeRating, isFlashcard, withFlashcardTag } from './lib/deck';
import { tagAsFlashcard } from './lib/tag';

import {
  aiFlashcards,
  attemptQuestion,
  createQuestions,
  deleteQuestion,
  listQuestions,
  patchQuestion,
} from '@/lib/api/endpoints';

const PAGE = 200;
const MAX_PAGES = 15;

/** Every flashcard (the list's `q` also matches tags; the tag check drops stems that merely mention it). */
export async function listFlashcards(): Promise<Question[]> {
  const out: Question[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res: { items: Question[]; next: string | null } = await listQuestions({
      q: FLASHCARD_TAG,
      limit: PAGE,
      cursor,
    });

    out.push(...res.items.filter(isFlashcard));
    if (!res.next) break;
    cursor = res.next;
  }

  return out;
}

export interface CardDraft {
  classId: string;
  topic: string;
  front: string;
  back: string;
}

export async function createFlashcard(draft: CardDraft): Promise<Question | undefined> {
  const [created] = await createQuestions([
    {
      classId: draft.classId,
      topic: draft.topic.trim() || 'General',
      type: 'free',
      difficulty: 2,
      stem: draft.front.trim(),
      answer: draft.back.trim(),
      solutionSteps: [],
      tags: [FLASHCARD_TAG],
    },
  ]);

  // A near-duplicate stem merges into an existing question; make sure that one is a card too.
  if (created && !isFlashcard(created)) return patchQuestion(created.id, { tags: withFlashcardTag(created.tags) });

  return created;
}

export const updateFlashcard = (card: Question, draft: CardDraft) =>
  patchQuestion(card.id, {
    classId: draft.classId,
    topic: draft.topic.trim() || 'General',
    stem: draft.front.trim(),
    answer: draft.back.trim(),
    tags: withFlashcardTag(card.tags),
  });

export const deleteFlashcard = (card: Question) => deleteQuestion(card.id);

/** Records a self-grade through the bank's attempt endpoint (no grader runs for `selfRating`). */
export async function gradeFlashcard(card: Question, grade: Grade, timeMs: number): Promise<void> {
  // An `error` frame throws from the transport.
  await attemptQuestion(card.id, { timeMs, selfRating: gradeRating(grade) }, () => undefined);
}

export type AiSource =
  | { kind: 'library'; id: string; title: string }
  | { kind: 'page'; id: string; title: string }
  | { kind: 'lecture'; id: string; title: string };

/**
 * `/ai/flashcards` from a library doc, notebook page or lecture; each streamed card is tagged as a
 * flashcard if the server did not already (`topic` only steers the demo mock). Resolves with the cards.
 */
export async function makeFlashcards(
  classId: string,
  source: AiSource,
  onCard: (card: Question) => void,
  signal?: AbortSignal,
): Promise<Question[]> {
  const body =
    source.kind === 'library'
      ? { libraryId: source.id }
      : source.kind === 'page'
        ? { pageId: source.id }
        : { lectureId: source.id };
  const cards: Question[] = [];

  await aiFlashcards(
    { ...body, classId, count: 10, topic: source.title },
    (frame) => {
      if (frame.event !== 'question') return;
      const card = tagAsFlashcard(frame.data as Question);

      cards.push(card);
      onCard(card);
    },
    signal,
  );

  return cards;
}
