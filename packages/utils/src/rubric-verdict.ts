/**
 * What a grader did with a writing question's rubric ON ONE ANSWER — which
 * points it counted, which it said were missing, and which it never mentioned.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS SHARED
 *
 * The same split is rendered on five screens now — the teacher marking queue,
 * the admin writing-marking screen, and the three student apps' results
 * screens. The grouping rule is the part that must not drift: it decides what
 * a student is told about their own answer, and every variant of it that gets
 * written by hand invents a slightly different story for the same data.
 *
 * Dependency-free on purpose, and also reachable as `@repo/utils/rubric-verdict`
 * — it runs on a results screen that should not pull `motion` and `date-fns` in
 * behind it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface RubricVerdictInput {
  /** The QUESTION's rubric, as authored. The denominator — never derived from the split. */
  rubric?: readonly string[] | null;
  /** Points the grader says THIS answer hit. */
  matched?: readonly string[] | null;
  /** Points the grader says THIS answer missed. */
  missing?: readonly string[] | null;
}

export interface RubricVerdict {
  /**
   * Did the grader report a breakdown at all?
   *
   * ⚠️ `false` is NOT «the answer matched nothing» — it is «nobody told us».
   * A screen that draws an empty checklist on a `false` here is making a claim
   * about the student's answer that no grader made.
   */
  verdictKnown: boolean;
  /** Rubric points COUNTED for this answer. */
  matched: string[];
  /** Rubric points the grader explicitly says are missing. */
  missing: string[];
  /**
   * Rubric points the grader placed in NEITHER list.
   *
   * The grader is asked to echo the rubric back, but it is a language model and
   * it can drop or reword a point. Anything it did not place stays visible here
   * rather than being silently folded into `missing` — nobody said those were
   * missed, and a student counting «2 + 1» against a five-point rubric would
   * otherwise have two points vanish with no trace.
   */
  unplaced: string[];
}

/** The rubric as it counts: trimmed, with the blank rows an editing UI leaves behind dropped. */
export const cleanRubricPoints = (points: readonly string[] | null | undefined): string[] =>
  (points ?? []).map((point) => point.trim()).filter((point) => point.length > 0);

export const rubricVerdictOf = ({ rubric, matched, missing }: RubricVerdictInput): RubricVerdict => {
  const points = cleanRubricPoints(rubric);

  /*
   * `== null` on purpose: both `null` and `undefined` are «the grader said
   * nothing». Only an actual array — INCLUDING AN EMPTY ONE — is a verdict, and
   * an empty `matched` really does mean the answer earned no rubric point.
   */
  const verdictKnown = matched != null || missing != null;

  if (!verdictKnown) {
    return { verdictKnown: false, matched: [], missing: [], unplaced: points };
  }

  const matchedPoints = cleanRubricPoints(matched);
  const missingPoints = cleanRubricPoints(missing);
  const placed = new Set([...matchedPoints, ...missingPoints]);

  return {
    verdictKnown: true,
    matched: matchedPoints,
    missing: missingPoints,
    unplaced: points.filter((point) => !placed.has(point)),
  };
};

/** Is there anything to draw at all? A verdict nobody reported renders nothing. */
export const hasRubricVerdict = (verdict: RubricVerdict): boolean =>
  verdict.verdictKnown && (verdict.matched.length > 0 || verdict.missing.length > 0 || verdict.unplaced.length > 0);
