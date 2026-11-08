import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INITIAL_GRADE,
  INITIAL_PREDICT,
  parsePrediction,
  parseReading,
  parseReferenceFrame,
  reduceGradeFrame,
  reducePredictFrame,
  reducePredictState,
  unlabeledConceptLinks,
} from './frames';

test('parseReading: resolves edges by id or by text, drops dangling ones, blank label → null', () => {
  const reading = parseReading({
    nodes: [{ id: 'a', label: 'Crust' }, { label: 'Mantle' }, { id: 'x', label: '' }],
    edges: [
      { from: 'a', to: 'Mantle', label: 'sits on' },
      { from: 'Crust', to: 'n2', label: '' },
      { from: 'a', to: 'ghost', label: 'x' },
      { from: 'a', to: 'a', label: 'self' },
    ],
  });

  assert.deepEqual(reading.nodes, [
    { id: 'a', label: 'Crust', kind: 'concept' },
    { id: 'n2', label: 'Mantle', kind: 'concept' },
  ]);
  assert.deepEqual(reading.edges, [
    { from: 'a', to: 'n2', label: 'sits on' },
    { from: 'a', to: 'n2', label: null },
  ]);
});

test('reduceGradeFrame walks reading → criteria → verdict → done', () => {
  let state = INITIAL_GRADE;

  state = reduceGradeFrame(state, { event: 'reading', data: { nodes: [{ id: 'a', label: 'Focus' }], edges: [] } });
  assert.equal(state.phase, 'grading');
  assert.equal(state.reading?.nodes.length, 1);

  state = reduceGradeFrame(state, {
    event: 'criterion',
    data: { name: 'Key terms included', score: 1, max: 2, note: 'one missing' },
  });
  state = reduceGradeFrame(state, { event: 'criterion', data: { name: 'Labeled arrows', score: 2, max: 2, note: '' } });
  // A repeat for the same criterion replaces, never duplicates.
  state = reduceGradeFrame(state, {
    event: 'criterion',
    data: { name: 'Key terms included', score: 2, max: 2, note: 'all there' },
  });
  assert.deepEqual(
    state.criteria.map((row) => [row.name, row.score]),
    [
      ['Key terms included', 2],
      ['Labeled arrows', 2],
    ],
  );
  // Junk criterion frames are ignored.
  assert.equal(reduceGradeFrame(state, { event: 'criterion', data: { score: 1 } }), state);

  state = reduceGradeFrame(state, {
    event: 'verdict',
    data: {
      score: '8.5',
      missingTerms: ['Epicenter'],
      unlabeledArrows: 1,
      wrongLinks: [{ from: 'Focus', to: 'Magnitude', label: 'is', reason: 'backwards' }],
      suggestions: ['Define each term', 42],
    },
  });
  assert.equal(state.verdict?.score, 8.5);
  assert.equal(state.verdict?.rawScore, null);
  assert.equal(state.verdict?.max, 10);
  assert.deepEqual(state.verdict?.wrongLinks, [{ from: 'Focus', to: 'Magnitude', label: 'is', why: 'backwards' }]);
  assert.deepEqual(state.verdict?.suggestions, ['Define each term', '42']);

  state = reduceGradeFrame(state, { event: 'done', data: null });
  assert.equal(state.phase, 'done');
  assert.equal(state.attemptId, null);
  assert.equal(reduceGradeFrame(state, { event: 'status', data: {} }), state);
});

test('reduceGradeFrame: the live frames — note-kind nodes, max 2 per criterion, done carries attemptId', () => {
  let state = reduceGradeFrame(INITIAL_GRADE, {
    event: 'reading',
    data: {
      nodes: [
        { id: 'n1', label: 'Magma', kind: 'concept' },
        { id: 'n2', label: 'Molten rock below the surface', kind: 'note' },
        { id: 'n3', label: 'Lava', kind: 'odd' },
      ],
      edges: [{ from: 'n1', to: 'n2', label: '' }],
    },
  });

  assert.deepEqual(
    state.reading?.nodes.map((node) => node.kind),
    ['concept', 'note', 'concept'],
  );
  state = reduceGradeFrame(state, { event: 'criterion', data: { name: 'Key terms', score: 1.5, note: '' } });
  assert.equal(state.criteria[0]?.max, 2);
  state = reduceGradeFrame(state, { event: 'done', data: { attemptId: 'att1', usageId: 'u1' } });
  assert.equal(state.phase, 'done');
  assert.equal(state.attemptId, 'att1');
  // A scratch grade (no map) answers attemptId: null.
  assert.equal(reduceGradeFrame(INITIAL_GRADE, { event: 'done', data: { attemptId: null } }).attemptId, null);
});

test('parseReferenceFrame keeps the backend layout (bbox, colour) of the reference graph', () => {
  const map = parseReferenceFrame({
    event: 'result',
    data: {
      graph: {
        title: 'Rock cycle',
        direction: 'TB',
        nodes: [
          { id: 'n1', text: 'Magma', bbox: [100, 20, 140, 50], shape: 'rect', color: '#2563eb', level: 0 },
          { id: 'n2', text: 'Igneous rock', bbox: [80, 160, 180, 50], shape: 'rect', level: 1 },
          { id: 'n3', text: 'Broken', bbox: [0, 0, 0, 10], level: 1 },
        ],
        edges: [{ from: 'n1', to: 'n2', label: 'cools into', arrow: 'end' }],
        style: { nodeColors: ['#2563eb'], edgeColor: '#111', strokeWidth: 3, font: 'print' },
      },
    },
  });

  assert.deepEqual(map?.nodes[0], { id: 'n1', text: 'Magma', level: 0, bbox: [100, 20, 140, 50], color: '#2563eb' });
  assert.deepEqual(map?.nodes[1]?.bbox, [80, 160, 180, 50]);
  assert.equal(map?.nodes[2]?.bbox, undefined);
  assert.deepEqual(map?.edges, [{ from: 'n1', to: 'n2', label: 'cools into' }]);
});

test('reduceGradeFrame error frame', () => {
  const state = reduceGradeFrame(INITIAL_GRADE, { event: 'error', data: { message: 'AI_EMPTY' } });

  assert.equal(state.phase, 'error');
  assert.equal(state.error, 'AI_EMPTY');
});

test('reducePredictFrame accumulates prompts and skips junk', () => {
  let prompts = reducePredictFrame([], { event: 'status', data: { text: 'thinking' } });

  prompts = reducePredictFrame(prompts, {
    event: 'prompt',
    data: { terms: ['Aquifer', ' Recharge '], lecture: 'L10', week: 6, why: 'next' },
  });
  prompts = reducePredictFrame(prompts, { event: 'prompt', data: { terms: [] } });
  assert.deepEqual(prompts, [{ terms: ['Aquifer', 'Recharge'], lecture: 'L10', week: 6, why: 'next' }]);
});

test('parseReferenceFrame reads the whiteboard result shape and a bare graph', () => {
  const nested = parseReferenceFrame({
    event: 'result',
    data: {
      graph: {
        title: 'T',
        nodes: [
          { id: 'a', text: 'Crust' },
          { id: 'b', text: 'Mantle', level: 1 },
        ],
        edges: [
          { from: 'a', to: 'b', label: 'sits on' },
          { from: 'a', to: 'zz' },
        ],
      },
    },
  });

  assert.deepEqual(nested, {
    title: 'T',
    nodes: [
      { id: 'a', text: 'Crust' },
      { id: 'b', text: 'Mantle', level: 1 },
    ],
    edges: [{ from: 'a', to: 'b', label: 'sits on' }],
  });
  const bare = parseReferenceFrame({ event: 'result', data: { nodes: [{ label: 'Only' }], edges: [] } });

  assert.deepEqual(bare, { nodes: [{ id: 'n1', text: 'Only' }], edges: [] });
  assert.equal(parseReferenceFrame({ event: 'status', data: { text: 'x' } }), null);
  assert.equal(parseReferenceFrame({ event: 'result', data: { graph: { nodes: [] } } }), null);
});

test('unlabeledConceptLinks ignores arrows to a definition note', () => {
  const reading = parseReading({
    nodes: [
      { id: 'a', label: 'Magma', kind: 'concept' },
      { id: 'b', label: 'Lava', kind: 'concept' },
      { id: 'd', label: 'Molten rock underground', kind: 'note' },
    ],
    edges: [
      { from: 'a', to: 'b', label: '' },
      { from: 'a', to: 'd', label: '' },
    ],
  });

  assert.deepEqual(unlabeledConceptLinks(reading), [{ from: 'a', to: 'b', label: null }]);
});

test('parseVerdict keeps the calibrated score and the raw criteria sum apart', () => {
  const state = reduceGradeFrame(INITIAL_GRADE, {
    event: 'verdict',
    data: { score: 9.5, rawScore: 8.5, max: 10, missingTerms: [], unlabeledArrows: 2, wrongLinks: [], suggestions: [] },
  });

  assert.equal(state.verdict?.score, 9.5);
  assert.equal(state.verdict?.rawScore, 8.5);
  assert.equal(state.verdict?.unlabeledArrows, 2);
});

test('parseReferenceFrame: a partial graph sent before the stream ends is kept', () => {
  const partial = parseReferenceFrame({
    event: 'partial',
    data: {
      graph: {
        nodes: [
          { id: 'a', text: 'Crust' },
          { id: 'b', text: 'Mantle' },
        ],
        edges: [{ from: 'a', to: 'b' }],
      },
    },
  });

  assert.equal(partial?.nodes.length, 2);
  assert.equal(partial?.edges.length, 1);
  assert.equal(parseReferenceFrame({ event: 'status', data: { nodes: [{ id: 'a', text: 'x' }] } }), null);
});

test('reduceGradeFrame: done carries model + sources; a bare done keeps none', () => {
  const done = reduceGradeFrame(INITIAL_GRADE, {
    event: 'done',
    data: {
      attemptId: 'a1',
      usageId: 'u1',
      model: 'openrouter/openai/gpt-6.1-sol',
      sources: [{ kind: 'model_answer', title: 'Her answer' }],
    },
  });

  assert.equal(done.attemptId, 'a1');
  assert.deepEqual(done.provenance, {
    model: 'openrouter/openai/gpt-6.1-sol',
    sources: [{ kind: 'model_answer', title: 'Her answer' }],
  });
  assert.deepEqual(reduceGradeFrame(INITIAL_GRADE, { event: 'done', data: { attemptId: 'a2' } }).provenance, {
    model: null,
    sources: [],
  });
});

test('parseReferenceFrame: result {graph, model, sources} keeps the provenance on the map', () => {
  const map = parseReferenceFrame({
    event: 'result',
    data: {
      graph: { nodes: [{ id: 'a', text: 'Aquifer' }], edges: [] },
      model: 'deepseek-chat',
      sources: [{ kind: 'textbook', title: 'Ch 11', itemId: 't1' }],
    },
  });

  assert.deepEqual(map?.provenance, {
    model: 'deepseek-chat',
    sources: [{ kind: 'textbook', title: 'Ch 11', itemId: 't1' }],
  });
  const old = parseReferenceFrame({ event: 'result', data: { graph: { nodes: [{ id: 'a', text: 'A' }], edges: [] } } });

  assert.equal(old?.provenance, undefined);
});

test('parsePrediction: full frame, sorted terms, percent tolerance, posted source', () => {
  const prediction = parsePrediction({
    lecture: { number: 12, title: 'Groundwater', date: '2026-10-08', week: 7 },
    terms: [
      { term: 'Porosity', p: 0.4 },
      { term: 'Aquifer', p: 0.9 },
      { term: 'Recharge', p: 55 },
      { term: '', p: 1 },
    ],
    prompt: ['Aquifer', ' Porosity '],
    modelAnswer: 'An aquifer stores water…',
    why: 'Next on the syllabus',
    alternatives: [{ prompt: ['Spring'], why: 'Lab topic' }, { prompt: [], why: 'empty' }, null],
    source: 'posted',
    postedIn: [{ kind: 'page', title: 'Week 7 page', itemId: 'p7' }],
  });

  assert.ok(prediction);
  assert.deepEqual(prediction.lecture, { number: 12, title: 'Groundwater', date: '2026-10-08', week: 7 });
  assert.deepEqual(
    prediction.terms.map((row) => [row.term, row.p]),
    [
      ['Aquifer', 0.9],
      ['Recharge', 0.55],
      ['Porosity', 0.4],
    ],
  );
  assert.deepEqual(prediction.prompt, ['Aquifer', 'Porosity']);
  assert.deepEqual(prediction.alternatives, [{ prompt: ['Spring'], why: 'Lab topic' }]);
  assert.equal(prediction.source, 'posted');
  assert.deepEqual(prediction.postedIn, [{ kind: 'page', title: 'Week 7 page', itemId: 'p7' }]);
});

test('parsePrediction: missing fields default; nothing to show → null', () => {
  const minimal = parsePrediction({ prompt: ['A', 'B'] });

  assert.deepEqual(minimal, {
    lecture: { number: null, title: '', date: null, week: null },
    terms: [],
    prompt: ['A', 'B'],
    modelAnswer: null,
    why: '',
    alternatives: [],
    source: 'predicted',
    postedIn: [],
  });
  assert.equal(parsePrediction({ lecture: { number: 3 } }), null);
  assert.equal(parsePrediction('nope'), null);
});

test('reducePredictState: status, prediction, legacy prompts and done provenance', () => {
  let state = reducePredictState(INITIAL_PREDICT, { event: 'status', data: { text: 'Reading slides…' } });

  assert.equal(state.status, 'Reading slides…');
  state = reducePredictState(state, { event: 'prediction', data: { prompt: ['Aquifer'], terms: [] } });
  state = reducePredictState(state, {
    event: 'prompt',
    data: { terms: ['Aquifer'], lecture: 'L12', week: 7, why: '' },
  });
  state = reducePredictState(state, { event: 'prediction', data: {} });
  assert.deepEqual(state.prediction?.prompt, ['Aquifer']);
  assert.equal(state.prompts.length, 1);
  state = reducePredictState(state, {
    event: 'done',
    data: { usageId: 'u', model: 'openrouter/openai/gpt-6.1-sol', sources: [{ kind: 'slides', title: 'L12' }] },
  });
  assert.equal(state.done, true);
  assert.equal(state.status, null);
  assert.deepEqual(state.provenance.sources, [{ kind: 'slides', title: 'L12' }]);
});
