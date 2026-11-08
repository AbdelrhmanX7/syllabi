// The demo concept maps: per-subject fixtures and the optional term list (grade / reference / practice
// work from a topic alone).
import type { ConceptMapRecord, GradeVerdict, ReferenceMap } from '../types';
import type { SseFrame } from '@/lib/api/http';

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMockMaps, conceptMapMockRoutes, freeConcepts, subjectFor } from '../mock';
import { SUBJECTS, subjectOf } from '../mock-fixtures';

test('subjectOf: picks the subject from the class code / name, general otherwise', () => {
  assert.equal(subjectOf({ code: 'CS 101', name: 'Intro to Programming (C++)' }), 'programming');
  assert.equal(subjectOf({ code: 'MATH 101', name: 'Calculus I' }), 'calculus');
  assert.equal(subjectOf({ code: 'EAS 102', name: 'Earth Science Lab' }), 'geology');
  assert.equal(subjectOf({ code: 'HIST 101', name: 'World History' }), 'general');
  assert.equal(subjectOf(undefined), 'general');
});

test('buildMockMaps: each demo class gets its own subject, unknown classes the general set', () => {
  const titles = (classId: string) => buildMockMaps(classId).map((map) => map.lecture);

  assert.ok(titles('cls_demo_cs').includes('L3 Recursion'));
  assert.ok(titles('cls_demo_math').includes('L4 The Derivative'));
  assert.ok(titles('cls_demo_earth').includes('L3 The Rock Cycle'));
  assert.deepEqual(titles('cls_unknown'), SUBJECTS.general.fixtures.map((fixture) => fixture.lecture));
  assert.equal(subjectFor('cls_demo_cs'), SUBJECTS.programming);
});

test('fixtures: valid fields, ids round-trip, and every subject has a map without terms', () => {
  for (const [subject, data] of Object.entries(SUBJECTS)) {
    assert.ok(data.fixtures.length >= 3, subject);
    assert.ok(
      data.fixtures.some((fixture) => fixture.terms.length === 0),
      `${subject} has a term-less map`,
    );
    for (const fixture of data.fixtures) {
      if (fixture.score !== null) assert.ok(fixture.score >= 0 && fixture.score <= 10 && fixture.score * 2 === Math.round(fixture.score * 2));
      if (fixture.transcription) assert.match(fixture.transcription, /→/);
    }
  }
  const maps = buildMockMaps('cls_demo_math');

  assert.equal(new Set(maps.map((map) => map.id)).size, maps.length);
  for (const map of maps) assert.match(map.id, /^cm_cls_demo_math_\d+$/);
});

test('freeConcepts: a term-less map uses its own boxes, else the topic + generic ideas', () => {
  const chain = buildMockMaps('cls_demo_math').find((map) => map.lecture === 'L6 The Chain Rule')!;

  assert.deepEqual(chain.promptTerms, []);
  assert.ok(freeConcepts(chain).includes('Chain rule'));
  const bare = { classId: 'cls_x', lecture: 'Practice · Photosynthesis', submission: null };

  assert.equal(freeConcepts(bare)[0], 'Photosynthesis');
});

const collect = async (path: string, body: Record<string, unknown>) => {
  const frames: SseFrame[] = [];

  await conceptMapMockRoutes.sse(path, body, (frame) => frames.push(frame));

  return frames;
};

test('grade: a map with no term list is graded from its topic (no 400, no missing terms)', async () => {
  const map = buildMockMaps('cls_demo_cs').find((row) => row.promptTerms.length === 0)!;
  const frames = await collect('/concept-maps/grade', { classId: map.classId, imagePngB64: 'abc', mapId: map.id });
  const verdict = frames.find((frame) => frame.event === 'verdict')?.data as GradeVerdict;

  assert.ok(verdict);
  assert.deepEqual(verdict.missingTerms, []);
  assert.ok(verdict.score > 0);
});

test('reference: drafts a map from the topic when there are no terms', async () => {
  const frames = await collect('/concept-maps/reference', { classId: 'cls_unknown', mapId: 'cm_cls_unknown_2' });
  const graph = (frames.find((frame) => frame.event === 'result')?.data as { graph: ReferenceMap }).graph;

  assert.ok(graph.nodes.length >= 3);
  assert.ok(!graph.title?.includes('undefined'));
});

test('practice: a topic alone starts a map; nothing at all is a 400', async () => {
  const record = (await conceptMapMockRoutes.json('POST', '/concept-maps/practice', {
    classId: 'cls_unknown',
    lecture: 'Photosynthesis',
  })) as ConceptMapRecord;

  assert.equal(record.lecture, 'Photosynthesis');
  assert.deepEqual(record.promptTerms, []);
  await assert.rejects(
    async () => conceptMapMockRoutes.json('POST', '/concept-maps/practice', { classId: 'cls_unknown' }),
    /topic/,
  );
});
