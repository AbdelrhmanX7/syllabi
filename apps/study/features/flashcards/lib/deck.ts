// Pure flashcard logic: what counts as a card, decks (class → topic), session order and grades.
import type { AttemptResult, Question } from '@/lib/api/types';

/** The tag that makes a bank question a flashcard (front = stem, back = answer). */
export const FLASHCARD_TAG = 'flashcard';

export const isFlashcard = (question: Pick<Question, 'tags'>): boolean =>
  (question.tags ?? []).some((tag) => tag.toLowerCase() === FLASHCARD_TAG);

/** Tags with the flashcard tag added once. */
export const withFlashcardTag = (tags: string[] | undefined): string[] =>
  isFlashcard({ tags: tags ?? [] }) ? [...(tags ?? [])] : [...(tags ?? []), FLASHCARD_TAG];

/** Never reviewed. */
export const isNew = (card: Pick<Question, 'srs'>): boolean => (card.srs?.reps ?? 0) === 0;

/** Due now: a new card, or a reviewed one whose due date has passed. */
export function isDue(card: Pick<Question, 'srs'>, now = Date.now()): boolean {
  if (isNew(card)) return true;
  const due = Date.parse(card.srs.dueAt);

  return !Number.isFinite(due) || due <= now;
}

export interface TopicDeck {
  /** `${classId}::${topic}` */
  key: string;
  classId: string;
  topic: string;
  cards: Question[];
  due: number;
}

export interface ClassDecks {
  classId: string;
  topics: TopicDeck[];
  count: number;
  due: number;
}

export const deckKey = (classId: string, topic: string) => `${classId}::${topic}`;

const topicOf = (card: Question) => card.topic?.trim() || 'General';

/**
 * Cards grouped by class, then topic. Classes follow `classOrder` (the class list), unknown ones
 * after; topics are alphabetical.
 */
export function groupDecks(cards: Question[], classOrder: string[] = [], now = Date.now()): ClassDecks[] {
  const byClass = new Map<string, Map<string, Question[]>>();

  for (const card of cards) {
    if (!isFlashcard(card)) continue;
    const topics = byClass.get(card.classId) ?? new Map<string, Question[]>();

    byClass.set(card.classId, topics);
    const topic = topicOf(card);

    topics.set(topic, [...(topics.get(topic) ?? []), card]);
  }

  const rank = (classId: string) => {
    const index = classOrder.indexOf(classId);

    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };

  return [...byClass.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([classId, topics]) => {
      const decks: TopicDeck[] = [...topics.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([topic, list]) => ({
          key: deckKey(classId, topic),
          classId,
          topic,
          cards: list,
          due: list.filter((card) => isDue(card, now)).length,
        }));

      return {
        classId,
        topics: decks,
        count: decks.reduce((sum, deck) => sum + deck.cards.length, 0),
        due: decks.reduce((sum, deck) => sum + deck.due, 0),
      };
    });
}

/**
 * The session queue: overdue reviewed cards (oldest due first), then new cards (oldest first).
 * With `all`, the not-yet-due cards follow, soonest first.
 */
export function orderSession(cards: Question[], opts: { all?: boolean; now?: number } = {}): Question[] {
  const now = opts.now ?? Date.now();
  const time = (value: string) => {
    const parsed = Date.parse(value);

    return Number.isFinite(parsed) ? parsed : 0;
  };
  const byDue = (a: Question, b: Question) => time(a.srs.dueAt) - time(b.srs.dueAt) || a.id.localeCompare(b.id);
  const byCreated = (a: Question, b: Question) => time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id);
  const reviewedDue = cards.filter((card) => !isNew(card) && isDue(card, now)).sort(byDue);
  const fresh = cards.filter(isNew).sort(byCreated);
  const later = opts.all ? cards.filter((card) => !isDue(card, now)).sort(byDue) : [];

  return [...reviewedDue, ...fresh, ...later];
}

export type Grade = 'again' | 'hard' | 'good' | 'easy';

export const GRADES: { grade: Grade; label: string; key: string }[] = [
  { grade: 'again', label: 'Again', key: '1' },
  { grade: 'hard', label: 'Hard', key: '2' },
  { grade: 'good', label: 'Good', key: '3' },
  { grade: 'easy', label: 'Easy', key: '4' },
];

/** The FSRS rating the attempt API takes as `selfRating` (1 Again … 4 Easy). */
export const gradeRating = (grade: Grade): 1 | 2 | 3 | 4 =>
  grade === 'again' ? 1 : grade === 'hard' ? 2 : grade === 'good' ? 3 : 4;

/** How the bank records it: Again → wrong, Hard → partial, Good / Easy → right. */
export const gradeResult = (grade: Grade): AttemptResult =>
  grade === 'again' ? 'wrong' : grade === 'hard' ? 'partial' : 'right';

/** Keyboard 1–4 → grade. */
export const gradeForKey = (key: string): Grade | null => GRADES.find((entry) => entry.key === key)?.grade ?? null;

export interface SessionTally {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

export const EMPTY_TALLY: SessionTally = { again: 0, hard: 0, good: 0, easy: 0 };

export const tallyAdd = (tally: SessionTally, grade: Grade): SessionTally => ({ ...tally, [grade]: tally[grade] + 1 });

/** Share of cards recalled (Good or Easy), 0–100. */
export function recallPercent(tally: SessionTally): number {
  const total = tally.again + tally.hard + tally.good + tally.easy;

  return total ? Math.round(((tally.good + tally.easy) / total) * 100) : 0;
}
