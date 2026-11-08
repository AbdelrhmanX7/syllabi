/**
 * How a submitted answer is classified on a student's results screen — the one
 * implementation of it, shared by every student app.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 * The review payload's verdict is a boolean `isCorrect`, which the backend
 * computes as an `$eq` against the question's stored `answer` inside an
 * aggregation that never projects the question type. A writing (essay) question
 * has no stored answer, so the comparison is `null === "<the student's
 * paragraph>"` — false, always, whatever the essay scored.
 *
 * Read that boolean for an essay and every one of them renders wrong, in red,
 * including ones marked full marks. So essays are classified from their SCORE,
 * and `isCorrect` is consulted only for the multiple-choice questions it was
 * computed for.
 *
 * The second rule: a missing score means nobody has graded it — the model
 * errored, refused, or the question has no model answer to grade against. That
 * is a FAILURE TO DECIDE, and showing it as `0` turns it into a decision nobody
 * made: a mark the student's teacher never gave them. It resolves to `pending`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Deliberately shape-agnostic: the three student apps each have their own
 * answer type with its own field names, so each maps into `GradedAnswerShape`
 * at the call site rather than this file knowing about any of them.
 */

export type GradedVerdict = 'correct' | 'partial' | 'wrong' | 'unanswered' | 'pending';

export interface GradedAnswerShape {
  /** The question's own type. ABSENT READS AS `mcq`, and is never backfilled. */
  type?: string | null;
  /** MCQ ONLY — see the block comment. Never consulted for a writing question. */
  isCorrect: boolean;
  isAnswered: boolean;
  /** How many options the question offers. An essay has none. */
  optionCount: number;
  /** Whether the payload carried an answer key letter for this question. */
  hasCorrectAnswer: boolean;
  /** Marks awarded. Absent/null means nobody has graded it yet. */
  score?: number | null;
  maxScore?: number | null;
  gradingState?: 'graded' | 'pending' | null;
}

/**
 * Is this an essay rather than a multiple-choice question?
 *
 * `type === 'writing'` is authoritative. The second arm is a RENDERING fallback
 * for a row carrying neither options nor an answer key — there is no grid to
 * draw and no letter to compare, so the writing layout is the only one that can
 * say anything true about it.
 *
 * It requires BOTH to be missing on purpose. An MCQ whose options failed to
 * load still has its `correctAnswer` letter and must not be re-read as prose —
 * and on a paper whose teacher hid the answer key, options are present, so that
 * case is excluded by the option count instead.
 */
export const isWritingShape = (answer: GradedAnswerShape): boolean =>
  answer.type === 'writing' || (answer.optionCount === 0 && !answer.hasCorrectAnswer);

export const maxScoreOfShape = (answer: GradedAnswerShape): number =>
  typeof answer.maxScore === 'number' ? answer.maxScore : 0;

export const verdictOf = (answer: GradedAnswerShape): GradedVerdict => {
  if (!answer.isAnswered) return 'unanswered';

  if (!isWritingShape(answer)) return answer.isCorrect ? 'correct' : 'wrong';

  if (answer.gradingState === 'pending') return 'pending';

  const score = typeof answer.score === 'number' ? answer.score : undefined;

  if (score === undefined) return 'pending';

  const max = maxScoreOfShape(answer);

  if (max > 0 && score >= max) return 'correct';
  if (score <= 0) return 'wrong';

  return 'partial';
};

/**
 * Is this grade still an estimate the teacher may revise?
 *
 * Only writing answers are ever provisional — an MCQ's verdict is a letter
 * comparison settled at submit, and labelling it would be noise. A paper with no
 * published flag reads as unpublished, which is correct: publishing does not
 * exist yet, and no paper carries an essay yet either, so nothing changes today.
 */
export const isProvisional = (answer: GradedAnswerShape, resultsPublished?: boolean): boolean => {
  if (resultsPublished) return false;
  if (!isWritingShape(answer)) return false;

  const verdict = verdictOf(answer);

  return verdict === 'correct' || verdict === 'partial' || verdict === 'wrong';
};

export type GradedVerdictCounts = Record<GradedVerdict, number>;

export const countShapeVerdicts = (answers: GradedAnswerShape[]): GradedVerdictCounts => {
  const counts: GradedVerdictCounts = { correct: 0, partial: 0, wrong: 0, unanswered: 0, pending: 0 };

  answers.forEach((answer) => {
    counts[verdictOf(answer)] += 1;
  });

  return counts;
};

/** Marks sitting in questions nobody has scored — what a reported total is missing. */
export const pendingDegreeOfShapes = (answers: GradedAnswerShape[]): number =>
  answers.reduce((total, answer) => (verdictOf(answer) === 'pending' ? total + maxScoreOfShape(answer) : total), 0);

export const hasWritingShape = (answers: GradedAnswerShape[]): boolean => answers.some(isWritingShape);
