// Client-side filtering of a loaded question set (the server narrows by class/topic/due/source/q;
// result and the live search box narrow further without a round trip).

import type { AttemptResult, Question, QuestionSourceKind } from '@/lib/api/types';

import { isDue } from './verdict';

export type ResultFilter = 'any' | AttemptResult | 'unseen';

export interface BankFilters {
  classId: string | null;
  topic: string | null;
  source: QuestionSourceKind | null;
  dueOnly: boolean;
  result: ResultFilter;
  q: string;
}

export const EMPTY_FILTERS: BankFilters = {
  classId: null,
  topic: null,
  source: null,
  dueOnly: false,
  result: 'any',
  q: '',
};

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

export function matchesSearch(question: Question, q: string): boolean {
  const needle = normalize(q);

  if (!needle) return true;
  const hay = normalize(
    [
      question.stem,
      question.topic,
      question.subtopic ?? '',
      question.answer,
      ...(question.choices ?? []),
      ...question.tags,
    ].join(' '),
  );

  return hay.includes(needle);
}

export function applyFilters(questions: Question[], filters: BankFilters, now = Date.now()): Question[] {
  return questions.filter((question) => {
    if (filters.classId && question.classId !== filters.classId) return false;
    if (filters.topic && question.topic !== filters.topic) return false;
    if (filters.source && question.source.kind !== filters.source) return false;
    if (filters.dueOnly && !isDue(question.srs.dueAt, now)) return false;
    if (filters.result === 'unseen' && question.stats.attempts > 0) return false;
    if (filters.result !== 'any' && filters.result !== 'unseen' && question.stats.lastResult !== filters.result)
      return false;

    return matchesSearch(question, filters.q);
  });
}

/** Distinct topics, most questions first, ties alphabetical. */
export function topicsOf(questions: Question[]): { topic: string; count: number }[] {
  const counts = new Map<string, number>();

  for (const question of questions) counts.set(question.topic, (counts.get(question.topic) ?? 0) + 1);

  return Array.from(counts.entries())
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
}

export function sourcesOf(questions: Question[]): QuestionSourceKind[] {
  return Array.from(new Set(questions.map((q) => q.source.kind))).sort();
}

export const SOURCE_LABEL: Record<QuestionSourceKind, string> = {
  canvas_quiz: 'Canvas quiz',
  derivita: 'Derivita',
  pdf: 'PDF',
  slides: 'Slides',
  video: 'Video',
  lecture: 'Lecture',
  photo: 'Photo',
  manual: 'Manual',
  ai_similar: 'AI similar',
  mock: 'Mock exam',
};

export const TYPE_LABEL: Record<Question['type'], string> = {
  free: 'Work it out',
  mcq: 'Multiple choice',
  code_output: 'Predict output',
  code_write: 'Write code',
  label_image: 'Label the image',
  matching: 'Match the pairs',
  fill_blank: 'Fill the blanks',
};

/** Merges a streamed/created batch into the list, replacing same-id entries and prepending new ones. */
export function mergeQuestions(existing: Question[], incoming: Question[]): Question[] {
  const byId = new Map(existing.map((q) => [q.id, q]));
  const fresh: Question[] = [];

  for (const question of incoming) {
    if (byId.has(question.id)) byId.set(question.id, question);
    else fresh.push(question);
  }

  return [...fresh, ...existing.map((q) => byId.get(q.id) ?? q)];
}
