// SSE frame reducers for grade / predict / reference streams. Pure, so the component only ever
// does `setState((s) => reduceGradeFrame(s, frame))`. Unit-tested.
import type {
  Criterion,
  GradeVerdict,
  MapReading,
  PredictedPrompt,
  PredictedTerm,
  Prediction,
  ReadEdge,
  ReadNode,
  ReferenceEdge,
  ReferenceMap,
  ReferenceNode,
} from '../types';
import type { Provenance } from './provenance';

import { NO_PROVENANCE, parseProvenance, parseSources } from './provenance';

export interface Frame {
  event: string;
  data: unknown;
}

export type GradePhase = 'idle' | 'sending' | 'reading' | 'grading' | 'done' | 'error';

export interface GradeState {
  phase: GradePhase;
  reading: MapReading | null;
  criteria: Criterion[];
  verdict: GradeVerdict | null;
  /** From `done`: the saved attempt (null when graded without a map, e.g. a scratch run). */
  attemptId: string | null;
  error: string | null;
  /** From `done {model, sources}` (or the saved attempt); empty on old attempts. */
  provenance: Provenance;
}

export const INITIAL_GRADE: GradeState = {
  phase: 'idle',
  reading: null,
  criteria: [],
  verdict: null,
  attemptId: null,
  error: null,
  provenance: NO_PROVENANCE,
};

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
const num = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function parseReading(data: unknown): MapReading {
  const body = record(data) ?? {};
  const nodes: ReadNode[] = [];
  const seen = new Set<string>();

  list(body.nodes).forEach((raw, index) => {
    const node = record(raw);
    const label = str(node?.label ?? node?.text ?? node?.name).trim();

    if (!label) return;
    let id = str(node?.id) || `n${index + 1}`;

    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    nodes.push({ id, label, kind: node?.kind === 'note' ? 'note' : 'concept' });
  });
  const byText = new Map(nodes.map((node) => [node.label.toLowerCase(), node.id]));
  const resolve = (ref: unknown): string | null => {
    const key = str(ref).trim();

    if (!key) return null;
    if (seen.has(key)) return key;

    return byText.get(key.toLowerCase()) ?? null;
  };
  const edges: ReadEdge[] = [];

  for (const raw of list(body.edges ?? body.links)) {
    const edge = record(raw);
    const from = resolve(edge?.from ?? edge?.source);
    const to = resolve(edge?.to ?? edge?.target);

    if (!from || !to || from === to) continue;
    const label = str(edge?.label ?? edge?.text).trim();

    edges.push({ from, to, label: label || null });
  }

  return { nodes, edges };
}

/** A node the grader read as a definition / example (its arrow needs no label). */
export const isNoteNode = (reading: MapReading | null, id: string): boolean =>
  reading?.nodes.find((node) => node.id === id)?.kind === 'note';

/**
 * Arrows between two concepts with no label — the rubric's «Labeled arrows» row. An arrow to (or
 * from) a definition note is not counted, same as the backend.
 */
export const unlabeledConceptLinks = (reading: MapReading): ReadEdge[] =>
  reading.edges.filter((edge) => !edge.label && !isNoteNode(reading, edge.from) && !isNoteNode(reading, edge.to));

export function parseCriterion(data: unknown): Criterion | null {
  const body = record(data);
  const name = str(body?.name).trim();

  if (!name) return null;

  return { name, score: num(body?.score), max: num(body?.max, 2), note: str(body?.note) };
}

export function parseVerdict(data: unknown): GradeVerdict {
  const body = record(data) ?? {};

  const raw = body.rawScore === undefined || body.rawScore === null ? null : num(body.rawScore, NaN);

  return {
    score: num(body.score),
    rawScore: Number.isFinite(raw) ? raw : null,
    max: num(body.max, 10),
    missingTerms: list(body.missingTerms)
      .map((term) => str(term))
      .filter(Boolean),
    unlabeledArrows: num(body.unlabeledArrows),
    wrongLinks: list(body.wrongLinks)
      .map((raw) => record(raw))
      .filter((link): link is Record<string, unknown> => link !== null)
      .map((link) => ({
        from: str(link.from),
        to: str(link.to),
        label: str(link.label) || null,
        why: str(link.why ?? link.reason),
      })),
    suggestions: list(body.suggestions)
      .map((item) => str(item))
      .filter(Boolean),
  };
}

/** Criteria are keyed by name: a repeated frame for the same row replaces it (the backend may re-score). */
export function reduceGradeFrame(state: GradeState, frame: Frame): GradeState {
  switch (frame.event) {
    case 'reading':
      return { ...state, phase: 'grading', reading: parseReading(frame.data) };
    case 'criterion': {
      const criterion = parseCriterion(frame.data);

      if (!criterion) return state;
      const index = state.criteria.findIndex((row) => row.name === criterion.name);
      const criteria =
        index >= 0 ? state.criteria.map((row, i) => (i === index ? criterion : row)) : [...state.criteria, criterion];

      return { ...state, phase: 'grading', criteria };
    }
    case 'verdict':
      return { ...state, phase: 'grading', verdict: parseVerdict(frame.data) };
    case 'done': {
      const attemptId = str(record(frame.data)?.attemptId);
      const provenance = parseProvenance(frame.data);

      return {
        ...state,
        phase: 'done',
        attemptId: attemptId || state.attemptId,
        provenance: provenance.model || provenance.sources.length > 0 ? provenance : state.provenance,
      };
    }
    case 'error':
      return { ...state, phase: 'error', error: str(record(frame.data)?.message, 'Grading failed') };
    default:
      return state;
  }
}

/** `prompt` frames accumulate; anything else is ignored. */
export function reducePredictFrame(prompts: PredictedPrompt[], frame: Frame): PredictedPrompt[] {
  if (frame.event !== 'prompt') return prompts;
  const body = record(frame.data);
  const terms = list(body?.terms)
    .map((term) => str(term).trim())
    .filter(Boolean);

  if (terms.length === 0) return prompts;

  return [...prompts, { terms, lecture: str(body?.lecture), week: num(body?.week), why: str(body?.why) }];
}

const terms = (value: unknown): string[] =>
  list(value)
    .map((term) => str(term).trim())
    .filter(Boolean);

/** The `prediction` frame; null when it carries no prompt and no ranked terms. */
export function parsePrediction(data: unknown): Prediction | null {
  const body = record(data);

  if (!body) return null;
  const lecture = record(body.lecture) ?? {};
  const ranked: PredictedTerm[] = list(body.terms)
    .map((raw) => {
      const row = record(raw);
      const term = str(row?.term ?? raw).trim();
      const p = num(row?.p ?? row?.probability, NaN);

      return { term, p: Number.isFinite(p) ? Math.min(1, Math.max(0, p > 1 ? p / 100 : p)) : 0 };
    })
    .filter((row) => row.term)
    .sort((a, b) => b.p - a.p);
  const prompt = terms(body.prompt);

  if (prompt.length === 0 && ranked.length === 0) return null;
  const positive = (value: unknown) => {
    const n = num(value, NaN);

    return Number.isFinite(n) && n > 0 ? n : null;
  };

  return {
    lecture: {
      number: positive(lecture.number),
      title: str(lecture.title).trim(),
      date: str(lecture.date).trim() || null,
      week: positive(lecture.week),
    },
    terms: ranked,
    prompt,
    modelAnswer: str(body.modelAnswer).trim() || null,
    why: str(body.why).trim(),
    alternatives: list(body.alternatives)
      .map((raw) => record(raw))
      .filter((row): row is Record<string, unknown> => row !== null)
      .map((row) => ({ prompt: terms(row.prompt), why: str(row.why).trim() }))
      .filter((row) => row.prompt.length > 0),
    source: body.source === 'posted' ? 'posted' : 'predicted',
    postedIn: parseSources(body.postedIn),
  };
}

export interface PredictState {
  /** The new `prediction` frame (null from an older backend that only sends `prompt` frames). */
  prediction: Prediction | null;
  /** Legacy `prompt` frames. */
  prompts: PredictedPrompt[];
  provenance: Provenance;
  /** Latest `status` text while it runs. */
  status: string | null;
  done: boolean;
}

export const INITIAL_PREDICT: PredictState = {
  prediction: null,
  prompts: [],
  provenance: NO_PROVENANCE,
  status: null,
  done: false,
};

export function reducePredictState(state: PredictState, frame: Frame): PredictState {
  switch (frame.event) {
    case 'status': {
      const data = frame.data;
      const text = typeof data === 'string' ? data : str(record(data)?.text);

      return text ? { ...state, status: text } : state;
    }
    case 'prediction': {
      const prediction = parsePrediction(frame.data);

      return prediction ? { ...state, prediction } : state;
    }
    case 'prompt':
      return { ...state, prompts: reducePredictFrame(state.prompts, frame) };
    case 'done':
      return { ...state, done: true, status: null, provenance: parseProvenance(frame.data) };
    default:
      return state;
  }
}

/** `[x, y, w, h]` with a positive size, else null. */
function parseBbox(value: unknown): [number, number, number, number] | null {
  const box = list(value).map((part) => (typeof part === 'number' ? part : Number(part)));

  if (box.length !== 4 || !box.every(Number.isFinite) || box[2]! <= 0 || box[3]! <= 0) return null;

  return [box[0]!, box[1]!, box[2]!, box[3]!];
}

/**
 * The whiteboard's `result {graph:{nodes:[{id,text}],edges:[{from,to,label}]}}` frame (also accepts
 * the graph at the top level, and `label` for node text; `partial` / `graph` frames carry a map
 * still being drawn). Null for frames that carry no map.
 */
export function parseReferenceFrame(frame: Frame): ReferenceMap | null {
  if (!['result', 'map', 'reference', 'partial', 'graph'].includes(frame.event)) return null;
  const body = record(frame.data);
  const graph = record(body?.graph) ?? record(body?.map) ?? body;

  if (!graph) return null;
  const nodes: ReferenceNode[] = [];
  const seen = new Set<string>();

  list(graph.nodes).forEach((raw, index) => {
    const node = record(raw);
    const text = str(node?.text ?? node?.label).trim();

    if (!text) return;
    let id = str(node?.id) || `n${index + 1}`;

    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    const level = node?.level === undefined ? undefined : num(node.level);
    const bbox = parseBbox(node?.bbox ?? node?.box);
    const color = str(node?.color).trim();

    nodes.push({
      id,
      text,
      ...(level === undefined ? {} : { level }),
      ...(bbox ? { bbox } : {}),
      ...(color ? { color } : {}),
    });
  });
  if (nodes.length === 0) return null;
  const byText = new Map(nodes.map((node) => [node.text.toLowerCase(), node.id]));
  const resolve = (ref: unknown): string | null => {
    const key = str(ref).trim();

    return seen.has(key) ? key : (byText.get(key.toLowerCase()) ?? null);
  };
  const edges: ReferenceEdge[] = [];

  for (const raw of list(graph.edges ?? graph.links)) {
    const edge = record(raw);
    const from = resolve(edge?.from ?? edge?.source);
    const to = resolve(edge?.to ?? edge?.target);

    if (!from || !to || from === to) continue;
    const label = str(edge?.label ?? edge?.text).trim();

    edges.push(label ? { from, to, label } : { from, to });
  }
  const title = str(graph.title).trim();
  // `result {graph, model, sources}`: what the reference was drawn from rides with the map.
  const provenance = frame.event === 'result' ? parseProvenance(body) : NO_PROVENANCE;

  return {
    ...(title ? { title } : {}),
    nodes,
    edges,
    ...(provenance.model || provenance.sources.length > 0 ? { provenance } : {}),
  };
}
