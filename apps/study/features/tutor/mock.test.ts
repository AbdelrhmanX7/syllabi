import type { TutorConversation, TutorConversationDetail } from './types';
import type { SseFrame } from '@/lib/api/http';

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { reduceAskFrames } from './lib/stream';
import { resetTutorMockState, tutorMockRoutes } from './mock';

const collect = async (path: string, body: Record<string, unknown>) => {
  const frames: SseFrame[] = [];
  const run = tutorMockRoutes.sse(path, body, (frame) => frames.push(frame));

  assert.ok(run, `no SSE route for ${path}`);
  await run;

  return frames;
};

beforeEach(() => resetTutorMockState());

test('routes it does not own are undefined', () => {
  assert.equal(tutorMockRoutes.json('GET', '/classes'), undefined);
  assert.equal(
    tutorMockRoutes.sse('/questions/extract', {}, () => undefined),
    undefined,
  );
  assert.ok(tutorMockRoutes.json('GET', '/ai/conversations?classId=cls_demo_math'));
});

test('ask: meta → deltas → sources → done; the thread is listed and readable afterwards', async () => {
  const frames = await collect('/ai/ask', { classId: 'cls_demo_math', mode: 'explain', question: 'Explain this limit' });

  assert.equal(frames[0].event, 'meta');
  assert.equal(frames[frames.length - 1].event, 'done');
  const state = reduceAskFrames(frames);

  assert.ok(state.conversationId);
  assert.match(state.text, /limit/i);
  assert.ok(state.sources.some((source) => source.kind === 'transcript' && typeof source.t === 'number'));

  const list = (await tutorMockRoutes.json('GET', '/ai/conversations?classId=cls_demo_math')) as TutorConversation[];

  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Explain this limit');
  assert.equal(list[0].messageCount, 2);
  assert.deepEqual(await tutorMockRoutes.json('GET', '/ai/conversations?classId=cls_demo_cs'), []);

  const detail = (await tutorMockRoutes.json(
    'GET',
    `/ai/conversations/${state.conversationId}`,
  )) as TutorConversationDetail;

  assert.deepEqual(
    detail.messages.map((message) => message.role),
    ['user', 'assistant'],
  );
  assert.equal(detail.messages[1].sources?.length, 2);
});

test('ask: a second turn appends to the same thread; unknown ids 404', async () => {
  const first = reduceAskFrames(
    await collect('/ai/ask', { classId: 'cls_demo_cs', mode: 'explain', question: 'Trace this' }),
  );
  const second = reduceAskFrames(
    await collect('/ai/ask', {
      classId: 'cls_demo_cs',
      conversationId: first.conversationId,
      mode: 'explain',
      question: 'And the destructor?',
      context: { itemId: 'itm_demo_hw' },
    }),
  );

  assert.equal(second.conversationId, first.conversationId);
  assert.match(second.text, /item you opened/);
  const detail = (await tutorMockRoutes.json(
    'GET',
    `/ai/conversations/${first.conversationId}`,
  )) as TutorConversationDetail;

  assert.equal(detail.messages.length, 4);
  assert.equal(detail.messages[2].context?.itemId, 'itm_demo_hw');
  await assert.rejects(
    collect('/ai/ask', { classId: 'cls_demo_cs', conversationId: 'cv_nope', mode: 'explain', question: 'x' }),
    /not found/i,
  );
});

test('quiz: first turn asks Q1, a typed answer is graded and Q2 follows, ink gets the model answer', async () => {
  const start = reduceAskFrames(await collect('/ai/ask', { classId: 'cls_demo_earth', mode: 'quiz', question: 'Quiz me' }));

  assert.match(start.text, /Question 1\./);
  assert.equal(start.sources.length, 0);
  const graded = reduceAskFrames(
    await collect('/ai/ask', {
      classId: 'cls_demo_earth',
      conversationId: start.conversationId,
      mode: 'quiz',
      question: 'weathering is in place, erosion moves it',
    }),
  );

  assert.match(graded.text, /\*\*Correct\.\*\*/);
  assert.match(graded.text, /Next question\./);
  assert.deepEqual(start.quiz, { asked: 1, right: 0, partial: 0, wrong: 0, questionId: null, questionKind: 'free' });
  assert.equal(graded.quiz?.asked, 2);
  assert.equal(graded.quiz?.right, 1);
  assert.equal(graded.quiz?.graded?.result, 'right');
  const ink = reduceAskFrames(
    await collect('/ai/ask', {
      classId: 'cls_demo_earth',
      conversationId: start.conversationId,
      mode: 'quiz',
      question: '',
      context: { imagePngB64: 'iVBORw0KGgo=' },
    }),
  );

  assert.match(ink.text, /handwritten/);
  assert.match(ink.text, /Model answer/);
  // Ink the sample cannot read is not scored; the thread keeps the running score.
  assert.equal(ink.quiz?.right, 1);
  assert.equal(ink.quiz?.graded, undefined);
});

test('board-ai: generate yields result blocks; analyze-page and concept maps yield results; remake errors', async () => {
  const generate = await collect('/board-ai/generate', { prompt: 'limits', kind: 'questions' });
  const result = generate.find((frame) => frame.event === 'result')?.data as { blocks: { type: string }[] };

  assert.equal(generate[generate.length - 1].event, 'done');
  assert.equal(result.blocks.filter((block) => block.type === 'question').length, 3);

  const analysis = await collect('/board-ai/analyze-page', { imagePngB64: 'x' });

  assert.equal((analysis.find((frame) => frame.event === 'result')?.data as { pageType: string }).pageType, 'solution');

  const map = await collect('/board-ai/concept-map/generate', { topic: 'Plate tectonics' });
  const graph = (map.find((frame) => frame.event === 'result')?.data as { graph: { nodes: unknown[] } }).graph;

  assert.equal(graph.nodes.length, 4);

  const remake = await collect('/board-ai/remake-page', {});

  assert.equal(remake[0].event, 'error');
  await assert.rejects(collect('/board-ai/nope', {}), /no SSE route/);
});

test('board-ai: concept-map/from-terms makes one node per cluster, the first the root (both paths)', async () => {
  for (const path of ['/board-ai/concept-map/from-terms', '/ai/concept-map/from-terms']) {
    const frames = await collect(path, { clusters: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] });
    const map = frames.find((frame) => frame.event === 'result')?.data as {
      nodes: { id: string; clusterIds: string[]; level: number }[];
      edges: { from: string; to: string; label: string }[];
    };

    assert.equal(frames[frames.length - 1].event, 'done');
    assert.deepEqual(map.nodes.map((node) => node.clusterIds[0]), ['c1', 'c2', 'c3']);
    assert.deepEqual(map.nodes.map((node) => node.level), [0, 1, 1]);
    assert.deepEqual(map.edges, [
      { from: 'n1', to: 'n2', label: 'includes' },
      { from: 'n1', to: 'n3', label: 'includes' },
    ]);
  }

  const empty = await collect('/board-ai/concept-map/from-terms', { clusters: [] });

  assert.equal(empty[0].event, 'error');
});

test('board-actions: the canned plan has every action type, names the clusters sent, and is deterministic', async () => {
  const body = {
    question: 'Where is the mistake?',
    lang: 'en',
    clusters: [
      { id: 'c1', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } },
      { id: 'c2', box: { x: 0.1, y: 0.4, w: 0.2, h: 0.05 } },
    ],
  };
  const run = tutorMockRoutes.json('POST', '/board-ai/board-actions', body);

  assert.ok(run, 'no JSON route for board-actions');

  const plan = (await run) as { actions: Array<Record<string, unknown>>; say: string };

  assert.deepEqual(
    plan.actions.map((action) => action.type),
    ['point_at', 'circle', 'underline', 'arrow', 'write', 'mark'],
  );
  assert.deepEqual(plan.actions[1].target, { clusterId: 'c1' });
  assert.deepEqual(plan.actions[2].target, { clusterId: 'c2' });
  assert.deepEqual(plan.actions[3].from, { clusterId: 'c1' });
  assert.deepEqual(plan.actions[3].to, { clusterId: 'c2' }, 'last cluster');
  assert.match(String(plan.actions[4].text), /Where is the mistake\?/);
  assert.ok(String(plan.actions[4].text).length <= 120);
  assert.match(plan.say, /Where is the mistake/);
  assert.deepEqual(await tutorMockRoutes.json('POST', '/board-ai/board-actions', body), plan);
  // The editor's own cluster shape (`bbox`) is read too, and no clusters still yields a plan.
  const loose = (await tutorMockRoutes.json('POST', '/board-ai/board-actions', { clusters: [{ id: 'c9', bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } }] })) as { actions: Array<Record<string, unknown>> };

  assert.deepEqual(loose.actions[1].target, { clusterId: 'c9' });
  assert.equal(((await tutorMockRoutes.json('POST', '/board-ai/board-actions', {})) as { actions: unknown[] }).actions.length, 6);
  await assert.rejects(tutorMockRoutes.json('GET', '/board-ai/board-actions')!, /Method not allowed/);
});
