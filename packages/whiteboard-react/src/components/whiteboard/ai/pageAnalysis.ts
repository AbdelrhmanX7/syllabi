import { wbT, type WbLocale, type WbStringKey } from '../../../i18n/strings';

import { extractJsonObject } from './markdownBlocks';

import type {
  BoardAiBlock,
  NormalizedBox,
  PageAnalysis,
  PageAnalysisQuestion,
  PageAnalysisType,
  PageAnalysisVerdict,
} from './types';

/**
 * «Check this page» — reading the model's page verdict defensively.
 *
 * The guest path asks for one fenced ```json block; models still return numbers as strings, boxes
 * as arrays or percentages, verdicts in odd spellings, and the odd trailing comma. Everything here
 * coerces or drops — it never throws, and a box that is not plausible is simply left out, which demotes
 * «Mark the mistakes» to list-only for that question instead of drawing a marker in the wrong place.
 */

const PAGE_TYPES: Record<string, PageAnalysisType> = {
  questions: 'questions',
  question: 'questions',
  explanation: 'explanation',
  solution: 'solution',
  blank: 'blank',
  empty: 'blank',
};

const VERDICTS: Record<string, PageAnalysisVerdict> = {
  correct: 'correct',
  right: 'correct',
  wrong: 'wrong',
  incorrect: 'wrong',
  unclear: 'unclear',
  unknown: 'unclear',
  no_answer: 'no_answer',
  none: 'no_answer',
  missing: 'no_answer',
};

const asString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);

  return undefined;
};

const asNumber = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : value;

  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * A normalised box from whatever the model sent: `{x,y,w,h}`, `{x,y,width,height}`, `[x,y,w,h]`,
 * in 0..1, 0..100 or 0..1000. Rejected when it is degenerate or falls off the page.
 */
export function sanitizeBox(value: unknown): NormalizedBox | undefined {
  let raw: Array<number | null>;

  if (Array.isArray(value)) {
    raw = value.slice(0, 4).map(asNumber);
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    raw = [
      asNumber(record.x ?? record.left),
      asNumber(record.y ?? record.top),
      asNumber(record.w ?? record.width),
      asNumber(record.h ?? record.height),
    ];
  } else {
    return undefined;
  }

  if (raw.length < 4 || raw.some((n) => n === null || n < 0)) return undefined;

  let [x, y, w, h] = raw as number[];
  const largest = Math.max(x!, y!, w!, h!);
  const divisor = largest > 100 ? 1000 : largest > 1.5 ? 100 : 1;

  x = x! / divisor;
  y = y! / divisor;
  w = w! / divisor;
  h = h! / divisor;

  if (w < 0.004 || h < 0.004) return undefined;
  if (w > 1.02 || h > 1.02) return undefined;
  if (x > 1 || y > 1 || x + w > 1.05 || y + h > 1.05) return undefined;

  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

function normalizeQuestion(value: unknown, index: number): PageAnalysisQuestion | null {
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const text = asString(record.text ?? record.question ?? record.stem) ?? '';
  const verdictRaw = (asString(record.verdict ?? record.status) ?? '').toLowerCase();
  const verdict = VERDICTS[verdictRaw] ?? (record.givenAnswer || record.given_answer ? 'unclear' : 'no_answer');
  const question: PageAnalysisQuestion = {
    n: asString(record.n ?? record.number ?? record.id) ?? String(index + 1),
    text,
    verdict,
  };
  const bbox = sanitizeBox(record.bbox ?? record.box);
  const givenAnswer = asString(record.givenAnswer ?? record.given_answer ?? record.studentAnswer);
  const givenAnswerBbox = sanitizeBox(record.givenAnswerBbox ?? record.given_answer_bbox ?? record.answerBbox);
  const correctAnswer = asString(record.correctAnswer ?? record.correct_answer ?? record.answer);
  const reason = asString(record.reason ?? record.explanation ?? record.why);

  if (bbox) question.bbox = bbox;
  if (givenAnswer) question.givenAnswer = givenAnswer;
  if (givenAnswerBbox) question.givenAnswerBbox = givenAnswerBbox;
  if (correctAnswer) question.correctAnswer = correctAnswer;
  if (reason) question.reason = reason;

  const confidence = asNumber(record.confidence);
  const choices = Array.isArray(record.choices) ? record.choices.map(asString).filter((c): c is string => Boolean(c)) : [];

  if (confidence !== null && confidence >= 0 && confidence <= 1) question.confidence = confidence;
  if (choices.length) question.choices = choices;

  if (!question.text && !question.correctAnswer && !question.givenAnswer) return null;

  return question;
}

/** A parsed object (or raw answer text containing a ```json block) → analysis, or null. */
export function parsePageAnalysis(input: unknown): PageAnalysis | null {
  const value = typeof input === 'string' ? extractJsonObject(input) : input;

  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const questionsRaw = Array.isArray(record.questions) ? record.questions : Array.isArray(record.items) ? record.items : [];
  const questions = questionsRaw
    .map((question, index) => normalizeQuestion(question, index))
    .filter((question): question is PageAnalysisQuestion => question !== null);
  const typeRaw = (asString(record.pageType ?? record.page_type ?? record.type) ?? '').toLowerCase();
  const pageType = PAGE_TYPES[typeRaw] ?? (questions.length > 0 ? 'questions' : 'other');

  return { pageType, questions };
}

export const PAGE_TYPE_LABELS: Record<PageAnalysisType, WbStringKey> = {
  questions: 'ai.pageType.questions',
  explanation: 'ai.pageType.explanation',
  solution: 'ai.pageType.solution',
  blank: 'ai.pageType.blank',
  other: 'ai.pageType.other',
};

export const VERDICT_LABELS: Record<PageAnalysisVerdict, WbStringKey> = {
  correct: 'ai.verdict.correct',
  wrong: 'ai.verdict.wrong',
  unclear: 'ai.verdict.unclear',
  no_answer: 'ai.verdict.no_answer',
};

/** Questions that can carry a red marker: wrong AND with a plausible box to put it next to. */
export function markableQuestions(analysis: PageAnalysis): PageAnalysisQuestion[] {
  return analysis.questions.filter((q) => q.verdict === 'wrong' && (q.givenAnswerBbox || q.bbox));
}

/**
 * The «Corrected copy» page: every question with its right answer (and why, when a given answer was
 * wrong). Goes onto a NEW page — the original is never touched.
 */
export function correctedVersionBlocks(
  analysis: PageAnalysis,
  title?: string,
  locale: WbLocale = 'en',
): BoardAiBlock[] {
  title ??= wbT(locale, 'ai.corrected.title');
  const blocks: BoardAiBlock[] = [{ type: 'heading', level: 2, text: title }];

  for (const question of analysis.questions) {
    const block: Extract<BoardAiBlock, { type: 'question' }> = {
      type: 'question',
      stem: question.text ? `${question.n}) ${question.text}` : wbT(locale, 'ai.corrected.questionN', { n: question.n }),
    };

    if (question.correctAnswer) block.answer = question.correctAnswer;
    if (question.verdict === 'wrong' && question.reason) {
      block.explanation = question.givenAnswer
        ? wbT(locale, 'ai.corrected.wrongGiven', { given: question.givenAnswer, reason: question.reason })
        : question.reason;
    }

    blocks.push(block);
  }

  return blocks;
}

/** Normalised box → scene rectangle of the analysed page. */
export function boxToScene(
  box: NormalizedBox,
  page: { left: number; top: number; width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  return {
    left: page.left + box.x * page.width,
    top: page.top + box.y * page.height,
    width: box.w * page.width,
    height: box.h * page.height,
  };
}
