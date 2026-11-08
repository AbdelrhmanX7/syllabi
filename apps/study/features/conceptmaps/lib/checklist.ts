// «Get to 10/10»: the few things that actually cost points, in the order she deducts for them —
// built from the core of the map only (never the AI reference's enrichment). Mirrors the grader's
// rubric (BE services/study/concept-maps.ts): a missing prompt term costs the most (it caps Key
// terms, Accurate relationships and Effort), a clearly wrong link −0.5, a term left undefined −0.5,
// unlabeled arrows only a little (the first 10 % are free). Where the grader's verdict has scored a
// criterion in full, its items are left out — she would not deduct there. Pure — unit-tested.
import type { MapDiff, MapGraph } from './mapDiff';
import type { Criterion, GradeVerdict, ReferenceMap } from '../types';

import { descriptionsOverlap, isDefinitionLabel } from './mapDiff';
import { matchTerms, normalizeTerm, termMatches } from './terms';

import { NO_PROMPT_TERMS_CODE } from '@/lib/api/errors';

export type ChecklistKind = 'term' | 'wrong' | 'label' | 'define' | 'wording';

export interface ChecklistItem {
  kind: ChecklistKind;
  /** The action, e.g. «Add Pangaea». */
  title: string;
  /** How, e.g. «Link it from Continental Drift: «described the breakup of»». */
  detail: string | null;
  /** Where a suggestion came from (the reference's path) — shown behind «why?». */
  why?: string | null;
  /** His node ids, for focusing the link on a drawing. */
  from?: string;
  to?: string;
}

export interface ChecklistInput {
  his: MapGraph | null;
  promptTerms: string[];
  reference?: ReferenceMap | null;
  diff?: MapDiff | null;
  verdict?: GradeVerdict | null;
  criteria?: Criterion[];
  /** Her model answer: where «her wording» for a definition comes from. */
  modelAnswer?: string | null;
}

export const CHECKLIST_CAP = 5;

const fullMarks = (criteria: Criterion[] | undefined, name: RegExp) => {
  const row = criteria?.find((item) => name.test(item.name));

  return Boolean(row && row.max > 0 && row.score >= row.max);
};

const stripMarkdown = (text: string) => text.replace(/\*\*|__|`/g, '').trim();

/** Her model answer's first sentence that mentions the term. */
export function herSentence(term: string, modelAnswer: string | null | undefined): string | null {
  if (!modelAnswer) return null;
  const sentences = stripMarkdown(modelAnswer)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  return sentences.find((sentence) => termMatches(term, sentence)) ?? null;
}

/**
 * Common relations in a concept map, most telling first: the reference's wording on a path edge
 * is matched here, and the arrow gets the short phrase that reads in its direction.
 */
const RELATIONS: { test: RegExp; forward: string; backward: string }[] = [
  { test: /\b(over|above|on top of|float)/i, forward: 'moves over', backward: 'lies beneath' },
  { test: /\b(beneath|below|under)/i, forward: 'lies beneath', backward: 'moves over' },
  { test: /\b(made of|consists? of|composed of)/i, forward: 'is made of', backward: 'makes up' },
  { test: /\b(part of|pieces? of|layer of)/i, forward: 'is part of', backward: 'is made of' },
  { test: /\b(type of|kind of|example of)/i, forward: 'is a type of', backward: 'includes' },
  { test: /\b(led to|leads to|developed into|became)/i, forward: 'later led to', backward: 'grew out of' },
  { test: /\b(explains?|supplied|mechanism|divides)/i, forward: 'explains', backward: 'is explained by' },
];

const relationPhrase = (label: string | null | undefined, forward: boolean): string | null => {
  const row = label ? RELATIONS.find((relation) => relation.test.test(label)) : undefined;

  return row ? (forward ? row.forward : row.backward) : null;
};

const relationRank = (label: string | null | undefined) =>
  label ? RELATIONS.findIndex((relation) => relation.test.test(label)) : -1;

export interface LabelSuggestion {
  /** «write «moves over»», or «add a linking phrase». */
  text: string;
  /** Where it came from in the reference — behind a «why?». */
  why: string | null;
}

export const NO_SUGGESTION = 'add a linking phrase';

/**
 * A short label for an unlabeled arrow `from → to`: the reference's own label for that pair; else
 * the most telling relation on a two-step path through the reference, phrased for this direction.
 */
export function suggestLabel(
  reference: ReferenceMap | null | undefined,
  fromLabel: string,
  toLabel: string,
): LabelSuggestion | null {
  if (!reference) return null;
  const find = (label: string) =>
    reference.nodes.find((node) => normalizeTerm(node.text) === normalizeTerm(label)) ??
    reference.nodes.find((node) => termMatches(label, node.text) || termMatches(node.text, label));
  const a = find(fromLabel);
  const b = find(toLabel);

  if (!a || !b) return null;
  const direct = reference.edges.find((edge) => edge.from === a.id && edge.to === b.id && edge.label);

  if (direct) return { text: `write «${direct.label}»`, why: null };
  const back = reference.edges.find((edge) => edge.from === b.id && edge.to === a.id && edge.label);

  if (back) {
    const phrase = relationPhrase(back.label, false);

    return {
      text: phrase ? `write «${phrase}»` : NO_SUGGESTION,
      why: `The reference has it the other way: ${b.text} «${back.label}» ${a.text}.`,
    };
  }
  // Two steps through a shared concept, any direction; the most telling relation on any such path.
  let best: { rank: number; phrase: string; why: string } | null = null;
  let fallbackWhy: string | null = null;

  for (const first of reference.edges) {
    const mid = first.from === a.id ? first.to : first.to === a.id ? first.from : null;

    if (!mid || mid === b.id) continue;
    for (const second of reference.edges) {
      if (!((second.from === mid && second.to === b.id) || (second.to === mid && second.from === b.id))) continue;
      const midText = reference.nodes.find((node) => node.id === mid)?.text ?? mid;
      const labels = [first.label, second.label].filter(Boolean).map((label) => `«${label}»`);
      const why = `The reference connects them through ${midText}${labels.length ? `: ${labels.join(' … ')}` : ''}.`;

      fallbackWhy ??= why;
      // Forward when the edge runs from the A side of the path towards B.
      for (const [edge, forward] of [
        [first, first.from === a.id],
        [second, second.from === mid],
      ] as const) {
        const rank = relationRank(edge.label);
        const phrase = relationPhrase(edge.label, forward);

        if (phrase && rank >= 0 && (!best || rank < best.rank)) best = { rank, phrase, why };
      }
    }
  }
  if (best) return { text: `write «${best.phrase}»`, why: best.why };

  return fallbackWhy ? { text: NO_SUGGESTION, why: fallbackWhy } : null;
}

/** Every item, highest-cost first; the card shows the first `CHECKLIST_CAP`. */
export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const { his, promptTerms, reference, diff, verdict, criteria, modelAnswer } = input;
  const items: ChecklistItem[] = [];
  const labelOf = new Map(his?.nodes.map((node) => [node.id, node.label]) ?? []);
  const kindOf = new Map(his?.nodes.map((node) => [node.id, node.kind]) ?? []);
  const termsFull = fullMarks(criteria, /key terms/i);
  const labelsFull = fullMarks(criteria, /label/i);
  const accurateFull = fullMarks(criteria, /accura/i);

  // 1. Every prompt term on the map.
  const termRows = his
    ? matchTerms(
        promptTerms,
        his.nodes.filter((node) => node.kind === 'concept').map((node) => ({ id: node.id, label: node.label })),
      )
    : [];
  const missing =
    his && promptTerms.length > 0
      ? termRows.filter((row) => !row.node).map((row) => row.term)
      : (verdict?.missingTerms ?? []);

  for (const term of missing) {
    const link = diff?.edges.find(
      (edge) => edge.cls === 'missing' && edge.tier === 'core' && reference?.nodes.some((n) => n.id === edge.refTo && termMatches(term, n.text)),
    );
    const fromText = link?.refFrom ? reference?.nodes.find((node) => node.id === link.refFrom)?.text : null;

    items.push({
      kind: 'term',
      title: `Add ${term}`,
      detail:
        fromText && link?.refLabel
          ? `Link it from ${fromText}: «${link.refLabel}», and give it a definition.`
          : 'Link it to the map and give it a definition.',
    });
  }

  // 2. Links the grader called wrong.
  if (!accurateFull)
    for (const link of verdict?.wrongLinks ?? [])
      items.push({ kind: 'wrong', title: `Fix ${link.from} → ${link.to}`, detail: link.why || null });

  // 3. Every arrow between two concepts labeled — except one already listed as wrong (fixing it labels it).
  const wrongPairs = new Set(
    (accurateFull ? [] : (verdict?.wrongLinks ?? [])).map((link) => `${normalizeTerm(link.from)}→${normalizeTerm(link.to)}`),
  );

  if (!labelsFull && his)
    for (const edge of his.edges) {
      if (edge.label || kindOf.get(edge.from) === 'note' || kindOf.get(edge.to) === 'note') continue;
      const from = labelOf.get(edge.from) ?? edge.from;
      const to = labelOf.get(edge.to) ?? edge.to;

      if (wrongPairs.has(`${normalizeTerm(from)}→${normalizeTerm(to)}`)) continue;

      const suggestion = suggestLabel(reference, from, to);

      items.push({
        kind: 'label',
        title: `Label ${from} → ${to}`,
        detail: suggestion?.text ?? NO_SUGGESTION,
        why: suggestion?.why ?? null,
        from: edge.from,
        to: edge.to,
      });
    }

  // 4. A definition per prompt term — first the ones with none, then ones that say something else.
  if (!termsFull && his) {
    const wording: ChecklistItem[] = [];

    for (const row of termRows) {
      if (!row.node) continue;
      const notes = his.edges
        .map((edge) => (edge.from === row.node!.id ? edge.to : edge.to === row.node!.id ? edge.from : null))
        .filter((id): id is string => Boolean(id && kindOf.get(id) === 'note'))
        .map((id) => labelOf.get(id) ?? '');
      const hers = herSentence(row.term, modelAnswer);
      const refDefinition = reference?.edges
        .filter((edge) => isDefinitionLabel(edge.label) && reference.nodes.find((n) => n.id === edge.from && termMatches(row.term, n.text)))
        .map((edge) => reference.nodes.find((node) => node.id === edge.to)?.text)
        .find(Boolean);
      const phrase = hers ?? refDefinition ?? null;

      if (notes.length === 0) {
        items.push({
          kind: 'define',
          title: `Define ${row.node.label}`,
          detail: phrase ? `Teacher’s wording: «${phrase}»` : 'Write a one-line definition under it.',
          from: row.node.id,
        });
        continue;
      }
      // A definition is there; flag it only when it misses the reference's definition of the term.
      if (refDefinition && !notes.some((note) => descriptionsOverlap(note, refDefinition)))
        wording.push({
          kind: 'wording',
          title: `Reword the definition of ${row.node.label}`,
          detail: `Closer to ${hers ? 'the teacher’s wording' : 'the reference'}: «${phrase}»`,
          from: row.node.id,
        });
    }
    items.push(...wording);
  }

  return items;
}

/** Backend #583: grade / reference / practice on a map with no prompt terms → 400 {code:'NO_PROMPT_TERMS'}. */
export function isNoPromptTerms(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === NO_PROMPT_TERMS_CODE);
}

/**
 * The full AI reference is optional extras: folded by default once her grade is 9+ (out of 10) or
 * nothing on the checklist is left.
 */
export function extrasFolded(grade: { score: number | null; max: number } | null, items: ChecklistItem[]): boolean {
  if (items.length === 0) return true;
  if (!grade || grade.score === null || grade.max <= 0) return false;

  return (grade.score / grade.max) * 10 >= 9;
}
