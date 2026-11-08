// Synthetic concept-map data + an in-memory handler for every `/concept-maps…` route, for the
// shell's mock transport (`lib/api/mock`) to delegate to. Everything here is made up — per-subject
// demo maps (`./mock-fixtures`), invented transcriptions, comments and scores. Nothing is the owner's.
// Practice maps and attempts persist in localStorage so a reload keeps them.
import type {
  ConceptMapRecord,
  Criterion,
  GradeVerdict,
  MapAttempt,
  MapReading,
  ReferenceMap,
} from './types';
import type { SseFrame } from '@/lib/api/http';
import type { Question } from '@/lib/api/types';

import { SUBJECTS, subjectOf, type SubjectData } from './mock-fixtures';
import { PLATE_TECTONICS_REFERENCE } from './lib/diagram.fixture';
import { unlabeledConceptLinks } from './lib/frames';
import { layoutConceptGraph } from './lib/layout';
import { parseTranscription } from './lib/mapDiff';
import { CRITERIA, isValidHerScore } from './lib/score';
import { matchTerms } from './lib/terms';

import { toFixtureClassId } from '@/lib/api/mock/class-map';
import { seedClassById } from '@/lib/api/mock/seed';

type Body = Record<string, unknown> | undefined;

const STATE_KEY = 'study_mock_conceptmaps';
const DAY = 86_400_000;
const nowIso = () => new Date().toISOString();
const uid = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;

/* ------------------------------------------------------------------ fixtures */

/** The demo subject of a class (by its code / name in the mock seed); unknown classes get the general set. */
export function subjectFor(classId: string): SubjectData {
  return SUBJECTS[subjectOf(seedClassById(toFixtureClassId(classId)) ?? seedClassById(classId))];
}

/** Concept labels of a transcription (the map's own boxes), notes left out. */
const transcriptionConcepts = (text: string | null | undefined): string[] =>
  text
    ? parseTranscription(text)
        .nodes.filter((node) => node.kind === 'concept')
        .map((node) => node.label)
        .slice(0, 6)
    : [];

/**
 * What the AI works from when a map has no term list: the boxes of its own transcription, else the
 * subject's generic concepts headed by the topic.
 */
export function freeConcepts(map: Pick<ConceptMapRecord, 'classId' | 'lecture' | 'submission'> | undefined): string[] {
  const own = transcriptionConcepts(map?.submission?.transcription);

  if (own.length >= 2) return own;
  const topic = (map?.lecture ?? '').replace(/^(Practice · )?(L\d+\s+)?/, '').trim();
  const generic = subjectFor(map?.classId ?? '').topicConcepts;

  return topic ? [topic, ...generic.slice(0, 4)] : generic;
}

const EDGE_LABELS = [
  'leads to',
  'is part of',
  'produces',
  'controls',
  'is measured by',
  'forms',
  'causes',
  'is made of',
];

/* ------------------------------------------------------------------ thumbnails */

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A small SVG drawing of the terms as a map — stands in for the submission photo. */
export function thumbnailSvg(terms: string[], { dark = true }: { dark?: boolean } = {}): string {
  const nodes = terms.map((term, index) => ({ id: `n${index}`, text: term }));
  const edges = nodes.slice(1).map((node, index) => ({
    from: `n${Math.floor(index / 2)}`,
    to: node.id,
    label: EDGE_LABELS[index % EDGE_LABELS.length],
  }));
  const layout = layoutConceptGraph(nodes, edges, { vGap: 64, charWidth: 6.5, minNodeWidth: 80 });
  const ink = ['#f97316', '#a78bfa', '#facc15', '#34d399', '#60a5fa'];
  const bg = dark ? '#111113' : '#ffffff';
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}">`,
    `<rect width="100%" height="100%" fill="${bg}"/>`,
    `<defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${dark ? '#e4e4e7' : '#18181b'}"/></marker></defs>`,
  ];

  for (const edge of layout.edges) {
    parts.push(
      `<line x1="${edge.x1}" y1="${edge.y1}" x2="${edge.x2}" y2="${edge.y2}" stroke="${dark ? '#e4e4e7' : '#18181b'}" stroke-width="1.6" marker-end="url(#a)"/>`,
    );
    if (edge.label) {
      parts.push(
        `<text x="${edge.lx}" y="${edge.ly - 4}" fill="${dark ? '#a1a1aa' : '#52525b'}" font-size="9" font-family="ui-sans-serif, system-ui" text-anchor="middle">${escapeXml(edge.label)}</text>`,
      );
    }
  }
  layout.nodes.forEach((node, index) => {
    const color = ink[index % ink.length]!;

    parts.push(
      `<ellipse cx="${node.x + node.w / 2}" cy="${node.y + node.h / 2}" rx="${node.w / 2}" ry="${node.h / 2}" fill="none" stroke="${color}" stroke-width="2"/>`,
      `<text x="${node.x + node.w / 2}" y="${node.y + node.h / 2 + 4}" fill="${color}" font-size="11" font-family="ui-sans-serif, system-ui" text-anchor="middle">${escapeXml(node.label)}</text>`,
    );
  });
  parts.push('</svg>');

  return `data:image/svg+xml;utf8,${encodeURIComponent(parts.join(''))}`;
}

/* ------------------------------------------------------------------ persisted state */

interface PersistedState {
  /** mapId → her score entered by hand (`PATCH /concept-maps/:id`). */
  scores?: Record<string, number | null>;
  /** mapId → what `PATCH {notesPageIds, promptTerms}` set (the backend's #583 fields). */
  edits?: Record<string, { notesPageIds?: string[]; promptTerms?: string[] }>;
  practice: ConceptMapRecord[];
  attempts: Record<string, MapAttempt[]>;
  createdQuestions: Question[];
}

let state: PersistedState | null = null;

function loadState(): PersistedState {
  if (state) return state;
  state = { practice: [], attempts: {}, createdQuestions: [] };
  if (typeof window === 'undefined') return state;
  try {
    const raw = window.localStorage.getItem(STATE_KEY);

    if (raw) state = { ...state, ...(JSON.parse(raw) as Partial<PersistedState>) };
  } catch {
    // corrupt entry — start clean
  }

  return state;
}

function persist(): void {
  if (typeof window === 'undefined' || !state) return;
  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // quota — memory copy still serves this session
  }
}

/** Test/dev hook: forget practice maps and attempts. */
export function resetConceptMapMock(): void {
  state = null;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STATE_KEY);
    } catch {
      // ignore
    }
  }
}

/* ------------------------------------------------------------------ data */

export function buildMockMaps(classId: string): ConceptMapRecord[] {
  return subjectFor(classId).fixtures.map((fixture) => ({
    id: `cm_${classId}_${fixture.number}`,
    classId,
    number: fixture.number,
    week: fixture.week,
    lecture: fixture.lecture,
    dueAt: new Date(Date.now() - fixture.dueDaysAgo * DAY).toISOString(),
    promptTerms: fixture.terms,
    submission: fixture.transcription
      ? {
          imageUrl: thumbnailSvg(fixture.terms.length > 0 ? fixture.terms : transcriptionConcepts(fixture.transcription)),
          transcription: fixture.transcription,
        }
      : null,
    instructor:
      fixture.comment || fixture.modelAnswer
        ? { comment: fixture.comment ?? null, modelAnswer: fixture.modelAnswer ?? null }
        : null,
    score: fixture.score,
    maxScore: 10,
    scoreSource: fixture.score === null ? null : ('canvas' as const),
    canvasScore: fixture.score,
    manualScore: null,
    scoreNote: null,
    canvasItemId: `canvas_cm_${fixture.number}`,
    source: 'import',
    examReview: fixture.examReview === true,
  }));
}

const findMap = (classId: string | null, mapId: string): ConceptMapRecord | undefined => {
  const practice = loadState().practice.find((map) => map.id === mapId);

  if (practice) return practice;
  const classFromId = classId ?? /^cm_(.+)_\d+$/.exec(mapId)?.[1] ?? null;

  return classFromId ? buildMockMaps(classFromId).find((map) => map.id === mapId) : undefined;
};

/** Deterministic "AI reading" of a picture: drops a term and leaves an arrow unlabeled on some inputs. */
export function mockReading(terms: string[], seed: number): MapReading {
  const dropIndex = terms.length > 3 && seed % 3 === 0 ? terms.length - 1 : -1;
  const nodes = terms
    .map((term, index) => ({
      id: `n${index + 1}`,
      label: index === 1 && seed % 2 === 0 ? `${term} theory` : term,
      kind: 'concept',
    }))
    .filter((_, index) => index !== dropIndex) as MapReading['nodes'];
  const edges = nodes.slice(1).map((node, index) => ({
    from: nodes[Math.floor(index / 2)]!.id,
    to: node.id,
    label: index === 2 && seed % 4 !== 1 ? null : EDGE_LABELS[(index + seed) % EDGE_LABELS.length]!,
  }));
  const root = nodes[0];

  // A definition under the first term, read as a `note` on an unlabeled arrow.
  if (root) {
    nodes.push({ id: 'd1', label: `${root.label}: a short definition`, kind: 'note' });
    edges.push({ from: root.id, to: 'd1', label: null });
  }

  return { nodes, edges };
}

/** With no term list (`terms` empty) the key-terms row judges the map's own concepts instead. */
export function mockCriteria(terms: string[], reading: MapReading): Criterion[] {
  const missing = matchTerms(terms, reading.nodes).filter((row) => !row.node).length;
  const unlabeled = unlabeledConceptLinks(reading).length;
  const concepts = reading.nodes.filter((node) => node.kind !== 'note').length;

  return [
    {
      name: CRITERIA[0],
      score: terms.length === 0 ? (concepts >= 4 ? 2 : 1.5) : Math.max(0, 2 - missing),
      max: 2,
      note:
        terms.length === 0
          ? concepts >= 4
            ? 'No term list — the key ideas of the topic are there.'
            : 'No term list — add one or two more key ideas.'
          : missing
            ? `${missing} prompt term${missing > 1 ? 's' : ''} not found on the map.`
            : 'Every prompt term is on the map.',
    },
    {
      name: CRITERIA[1],
      score: Math.max(0, 2 - unlabeled * 0.5),
      max: 2,
      note: unlabeled
        ? `${unlabeled} arrow${unlabeled > 1 ? 's have' : ' has'} no label.`
        : 'Every arrow says what the link means.',
    },
    {
      name: CRITERIA[2],
      score: concepts >= 5 ? 1.5 : 2,
      max: 2,
      note: concepts >= 5 ? 'One link reverses cause and effect.' : 'Relationships read correctly.',
    },
    { name: CRITERIA[3], score: 2, max: 2, note: 'Top-down flow, related terms near each other.' },
    {
      name: CRITERIA[4],
      score: reading.nodes.length > Math.max(terms.length, concepts) ? 2 : 1.5,
      max: 2,
      note:
        reading.nodes.length > Math.max(terms.length, concepts)
          ? 'Extra terms and examples add depth.'
          : 'Add a definition or example per term to go deeper.',
    },
  ];
}

export function mockVerdict(terms: string[], reading: MapReading, criteria: Criterion[]): GradeVerdict {
  const missingTerms = matchTerms(terms, reading.nodes)
    .filter((row) => !row.node)
    .map((row) => row.term);
  const score = Math.round(criteria.reduce((sum, row) => sum + row.score, 0) * 10) / 10;
  const labelOf = (id: string) => reading.nodes.find((node) => node.id === id)?.label ?? id;
  const concepts = reading.nodes.filter((node) => node.kind !== 'note').length;
  const wrongLinks =
    concepts >= 5 && reading.edges.length >= 3
      ? [
          {
            from: labelOf(reading.edges[2]!.from),
            to: labelOf(reading.edges[2]!.to),
            label: reading.edges[2]!.label,
            why: `The direction is backwards — ${labelOf(reading.edges[2]!.to)} is the cause here, not the result.`,
          },
        ]
      : [];

  return {
    // Mirrors the backend's calibration: a small lift for maps that are already good.
    score: Math.min(10, Math.round((score + (score > 6 ? ((score - 6) * (10 - score)) / 8 : 0)) * 2) / 2),
    rawScore: score,
    max: 10,
    missingTerms,
    unlabeledArrows: unlabeledConceptLinks(reading).length,
    wrongLinks,
    suggestions: [
      'Write one short definition under each term so the grader sees you know it, not only where it sits.',
      missingTerms.length
        ? `Add ${missingTerms.join(', ')} and link it to at least two other terms.`
        : 'Add one concrete example per link for the depth point.',
    ],
  };
}

export function mockReference(terms: string[], topic?: string | null): ReferenceMap {
  // Plate-tectonics terms get the full 15-node sample, so the drawing is exercised at a real size.
  if (terms.some((term) => /subduction|seafloor|plate|drift|lithosphere/i.test(term))) return PLATE_TECTONICS_REFERENCE;
  if (terms.length === 0) terms = [topic?.trim() || 'Main idea', 'Definition', 'Example', 'Cause', 'Effect'];
  const nodes = terms.map((term, index) => ({
    id: `r${index + 1}`,
    text: term,
    level: index === 0 ? 0 : index <= 2 ? 1 : 2,
  }));
  const edges = nodes.slice(1).map((node, index) => ({
    from: index < 2 ? nodes[0]!.id : nodes[1 + (index % 2)]!.id,
    to: node.id,
    label: EDGE_LABELS[index % EDGE_LABELS.length]!,
  }));

  if (nodes.length >= 3) edges.push({ from: nodes[nodes.length - 1]!.id, to: nodes[0]!.id, label: 'feeds back into' });

  return { title: `Reference: ${terms[0]}`, nodes, edges };
}

function mockQuestions(map: ConceptMapRecord): Question[] {
  const terms = map.promptTerms.length >= 2 ? map.promptTerms : freeConcepts(map);
  const [a, b, c] = terms;
  const stems = [
    `Explain how ${a} relates to ${b}. Name the process that links them.`,
    `Define ${c ?? b} and give one example from lecture.`,
    `In two sentences, describe the flow from ${a} to ${terms[terms.length - 1]}.`,
  ];

  return stems.map((stem, index) => ({
    id: uid('q'),
    classId: map.classId,
    topic: map.lecture ?? `Concept map ${map.number ?? ''}`.trim(),
    subtopic: null,
    difficulty: (index + 2) as 2 | 3 | 4,
    source: {
      kind: 'manual',
      itemId: map.canvasItemId,
      pageId: null,
      lectureId: null,
      ref: `concept-map:${map.number}`,
    },
    type: 'free',
    stem,
    imageUrl: null,
    answer: map.instructor?.modelAnswer ?? `Relate ${a} to ${b} with a labeled arrow and define both.`,
    solutionSteps: [],
    tags: ['concept-map', `week-${map.week}`],
    stats: { attempts: 0, correct: 0, lastResult: null, mastery: 0 },
    srs: { dueAt: nowIso(), stability: 1, difficulty: 5, reps: 0, lapses: 0 },
    createdAt: nowIso(),
  }));
}

/* ------------------------------------------------------------------ routing */

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));

      return;
    }
    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

function parse(path: string): { segments: string[]; query: URLSearchParams } {
  const [pathname, search = ''] = path.split('?');
  const segments = pathname!.split('/').filter(Boolean).map(decodeURIComponent);

  return { segments, query: new URLSearchParams(search) };
}

/** The body's terms, else the map's own (after a PATCH); none = an empty list (terms are optional). */
const termsOf = (body: Body): { terms: string[]; map: ConceptMapRecord | undefined } => {
  const sent = Array.isArray(body?.promptTerms) ? (body!.promptTerms as string[]) : [];
  const map = typeof body?.mapId === 'string' ? findMap(null, body.mapId) : undefined;

  return { terms: sent.length > 0 ? sent : map ? withMockEdits(map).promptTerms : [], map };
};

const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { status: 404, code: 'NOT_FOUND' });

/** The backend's manualScoreUpdate: a number is his override; null falls back to the Canvas grade. */
function mockManualScore(map: ConceptMapRecord, score: number | null): ConceptMapRecord {
  if (score !== null) return { ...map, score, scoreSource: 'manual', manualScore: score, scoreNote: null };
  const canvas = map.canvasScore ?? null;

  return { ...map, score: canvas, scoreSource: canvas === null ? null : 'canvas', manualScore: null, scoreNote: null };
}

function withMockEdits(map: ConceptMapRecord): ConceptMapRecord {
  const edit = loadState().edits?.[map.id];

  if (!edit) return map;

  return {
    ...map,
    ...(edit.promptTerms ? { promptTerms: edit.promptTerms, promptTermsSource: 'manual' } : {}),
    notesPageIds: edit.notesPageIds ?? [],
  } as ConceptMapRecord;
}

async function json(method: string, path: string, body: Body): Promise<unknown> {
  await delay(80 + Math.random() * 120);
  const { segments, query } = parse(path);
  const [, a, b] = segments;

  if (method === 'GET' && !a) {
    const classId = query.get('classId') ?? '';
    const practice = loadState().practice.filter((map) => map.classId === classId);

    const scores = loadState().scores ?? {};

    return [...buildMockMaps(classId), ...practice].map((map) =>
      withMockEdits(map.id in scores ? mockManualScore(map, scores[map.id] ?? null) : map),
    );
  }
  if (method === 'PATCH' && a && !b) {
    const map = findMap(null, a) ?? loadState().practice.find((item) => item.id === a);
    if (!map) throw notFound('Concept map');
    if (body && ('notesPageIds' in body || 'promptTerms' in body) && !('score' in body)) {
      const edit = { ...(loadState().edits?.[a] ?? {}) };

      if (Array.isArray(body.notesPageIds))
        edit.notesPageIds = [...new Set(body.notesPageIds as string[])].slice(0, 20);
      if (Array.isArray(body.promptTerms)) edit.promptTerms = body.promptTerms as string[];
      loadState().edits = { ...(loadState().edits ?? {}), [a]: edit };
      persist();

      return withMockEdits(map);
    }
    const score = body?.score === null ? null : Number(body?.score);

    if (score !== null && !isValidHerScore(score, map.maxScore))
      throw Object.assign(new Error(`score must be a number 0–${map.maxScore} in steps of 0.5, or null`), {
        status: 400,
      });
    loadState().scores = { ...(loadState().scores ?? {}), [a]: score };
    persist();

    return mockManualScore(map, score);
  }
  if (method === 'POST' && a === 'practice') {
    const classId = String(body?.classId ?? '');
    const from = typeof body?.mapId === 'string' ? findMap(classId, body.mapId) : undefined;
    const terms = from?.promptTerms ?? (Array.isArray(body?.promptTerms) ? (body.promptTerms as string[]) : []);
    const topic = typeof body?.lecture === 'string' ? body.lecture.trim() : '';

    // Terms are optional: a topic alone (or an assigned map) is enough.
    if (!classId || (!from && terms.length === 0 && !topic))
      throw Object.assign(new Error('classId and a topic, promptTerms or mapId are required'), { status: 400 });
    const practice = loadState().practice.filter((map) => map.classId === classId);
    const record: ConceptMapRecord = {
      id: uid('cmp'),
      classId,
      number: 100 + practice.length + 1,
      week: from?.week ?? (typeof body?.week === 'number' ? body.week : 0),
      lecture: from
        ? `Practice · ${from.lecture}`
        : topic || 'Practice · custom terms',
      dueAt: null,
      promptTerms: terms,
      submission: null,
      instructor: from?.instructor ?? null,
      score: null,
      maxScore: 10,
      scoreSource: null,
      canvasScore: null,
      manualScore: null,
      scoreNote: null,
      canvasItemId: null,
      source: 'practice',
      examReview: false,
    };

    loadState().practice.push(record);
    persist();

    return record;
  }
  if (method === 'GET' && a && b === 'attempts') return loadState().attempts[a] ?? [];
  if (method === 'POST' && a && b === 'short-answers') {
    const map = findMap(null, a);

    if (!map) throw notFound('Concept map');
    const questions = mockQuestions(map);

    loadState().createdQuestions.push(...questions);
    persist();

    return questions;
  }

  throw notFound(`Mock concept-map route ${method} /${segments.join('/')}`);
}

const MOCK_MODEL = 'openrouter/openai/gpt-6.1-sol';

const mockSources = (subject: SubjectData) => [
  { kind: 'model_answer', title: 'Model answer' },
  { kind: 'slides', title: 'Lecture slides' },
  { kind: 'textbook', title: subject.textbook },
  { kind: 'past_maps', title: 'Concept Map 1' },
  { kind: 'past_maps', title: 'Concept Map 2' },
];

const classOf = (body: Body, map: ConceptMapRecord | undefined) =>
  map?.classId ?? (typeof body?.classId === 'string' ? body.classId : '');

async function sse(path: string, body: Body, onFrame: (frame: SseFrame) => void, signal?: AbortSignal): Promise<void> {
  const { segments } = parse(path);
  const [, a] = segments;
  const emit = async (frame: SseFrame, gap = 220) => {
    await delay(gap, signal);
    onFrame(frame);
  };

  if (a === 'grade') {
    const { terms, map } = termsOf(body);
    const subject = subjectFor(classOf(body, map));
    const image = String(body?.imagePngB64 ?? '');
    const seed = image.length;
    // No term list: the AI reads the map's own concepts and grades links and depth.
    const free = terms.length > 0 ? terms : freeConcepts(map ?? { classId: classOf(body, map), lecture: null, submission: null });
    const reading = mockReading(free, seed);
    const criteria = mockCriteria(terms, reading);
    const verdict = mockVerdict(terms, reading, criteria);

    await emit({ event: 'reading', data: reading }, 900);
    for (const criterion of criteria) await emit({ event: 'criterion', data: criterion }, 420);
    await emit({ event: 'verdict', data: verdict }, 300);
    const mapId = typeof body?.mapId === 'string' ? body.mapId : '';

    if (mapId) {
      const attempt: MapAttempt = {
        id: uid('att'),
        createdAt: nowIso(),
        imageUrl: image && image.length < 400_000 ? `data:image/png;base64,${image}` : null,
        verdict,
        reading,
        criteria,
      };
      const store = loadState();

      store.attempts[mapId] = [attempt, ...(store.attempts[mapId] ?? [])].slice(0, 20);
      const practice = store.practice.find((map) => map.id === mapId);

      if (practice) practice.score = verdict.score;
      persist();
    }
    await emit(
      {
        event: 'done',
        data: {
          attemptId: mapId ? loadState().attempts[mapId]?.[0]?.id : null,
          model: MOCK_MODEL,
          sources: mockSources(subject),
        },
      },
      100,
    );

    return;
  }
  if (a === 'predict') {
    const week = typeof body?.week === 'number' ? body.week : 6;

    const lecture = typeof body?.lecture === 'number' ? body.lecture : 12;
    const subject = subjectFor(classOf(body, undefined));
    const predictions = subject.predictions;
    const [first, ...rest] = predictions;

    await emit({ event: 'status', data: { text: 'Reading the syllabus and the last maps…' } }, 400);
    if (first)
      await emit(
        {
          event: 'prediction',
          data: {
            lecture: { number: lecture, title: first.lecture, date: null, week },
            terms: first.terms.map((term, index) => ({ term, p: Math.max(0.15, 0.85 - index * 0.12) })),
            prompt: first.terms,
            modelAnswer: null,
            why: first.why,
            alternatives: rest.map((alt) => ({ prompt: alt.terms, why: alt.why })),
            source: 'predicted',
            postedIn: [],
          },
        },
        900,
      );
    for (const [index, prompt] of predictions.entries())
      await emit({ event: 'prompt', data: { ...prompt, week: week + index } }, 200);
    await emit({ event: 'done', data: { usageId: null, model: MOCK_MODEL, sources: mockSources(subject).slice(1) } }, 100);

    return;
  }
  if (a === 'reference') {
    // The spec'd extension (be-conceptmap-image-notes): pictures to read the terms from, and the
    // notebook page / lecture whose notes ground the map.
    const images = Array.isArray(body?.images) ? (body!.images as Array<{ origin?: unknown }>).slice(0, 4) : [];
    const sent = Array.isArray(body?.promptTerms) ? (body!.promptTerms as string[]) : [];
    const own = termsOf(body);
    const subject = subjectFor(classOf(body, own.map));
    let terms: string[];

    if (sent.length === 0 && images.length > 0) {
      await emit({ event: 'status', data: { text: 'Reading the terms off your photo…' } }, 400);
      terms = subject.photoTerms;
      await emit({ event: 'terms', data: { terms, from: 'image' } }, 300);
    } else terms = own.terms.length > 0 ? own.terms : freeConcepts(own.map ?? { classId: classOf(body, undefined), lecture: null, submission: null });
    const lecture = body?.lecture && typeof body.lecture === 'object' ? (body.lecture as { number?: unknown; key?: unknown }) : null;
    const lectureName =
      typeof lecture?.number === 'number' ? `Lecture ${lecture.number}` : typeof lecture?.key === 'string' ? lecture.key : 'this lecture';
    const grounded = typeof body?.pageId === 'string' || lecture !== null;
    const sources = [
      ...images.map((image) => ({
        kind: 'image',
        title: image?.origin === 'phone' ? 'Photo from your phone' : 'Picture on this page',
      })),
      ...(grounded ? [{ kind: 'notes', title: `Your notes — ${lectureName}` }] : []),
      ...mockSources(subject),
    ];

    if (grounded) await emit({ event: 'status', data: { text: 'Reading your lecture notes…' } }, 300);
    await emit({ event: 'status', data: { text: 'Drafting a reference map…' } }, 400);
    await emit(
      {
        event: 'result',
        data: {
          graph: mockReference(terms, own.map?.lecture),
          fixes: [],
          serverLayout: false,
          model: MOCK_MODEL,
          sources,
        },
      },
      900,
    );
    await emit({ event: 'done', data: null }, 100);

    return;
  }

  throw notFound(`Mock concept-map SSE route POST /${segments.join('/')}`);
}

/**
 * Handlers for the shell's mock transport: both return `undefined` for paths outside
 * `/concept-maps…` so the shell can try them first and fall through.
 */
export const conceptMapMockRoutes = {
  json(method: string, path: string, body: Body): Promise<unknown> | undefined {
    return parse(path).segments[0] === 'concept-maps' ? json(method, path, body) : undefined;
  },
  sse(path: string, body: Body, onFrame: (frame: SseFrame) => void, signal?: AbortSignal): Promise<void> | undefined {
    return parse(path).segments[0] === 'concept-maps' ? sse(path, body, onFrame, signal) : undefined;
  },
};
