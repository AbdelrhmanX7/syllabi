import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parsePagePoint,
  MARK_INK,
  parsePenPlan,
  PEN_MAX_ACTIONS,
  PEN_MAX_STROKE_POINTS,
  PEN_MAX_TEXT,
  placeNote,
  planPenActions,
  thinPoints,
  wrapHandText,
} from './penActions';

import type { PenPlanContext } from './penActions';
import type { SceneRect } from './types';

const r = (left: number, top: number, width: number, height: number): SceneRect => ({ left, top, width, height });

const page = r(0, 0, 1000, 1400);
const clusters = new Map<string, SceneRect>([
  ['c1', r(100, 200, 300, 40)],
  ['c2', r(100, 400, 200, 40)],
]);
const ctx: PenPlanContext = { page, clusters, occupied: Array.from(clusters.values()), letterHeight: 30, strokeWidth: 3, seed: 7 };

// --- parsing -----------------------------------------------------------------------------------

test('parsePenPlan: every contract action type survives, in order, with `say`', () => {
  const result = parsePenPlan(
    {
      actions: [
        { type: 'point_at', at: { x: 0.2, y: 0.1 }, note: 'Look here' },
        { type: 'circle', target: { clusterId: 'c1' } },
        { type: 'underline', target: { box: { x: 0.1, y: 0.5, w: 0.3, h: 0.05 } } },
        { type: 'arrow', from: { clusterId: 'c1' }, to: { x: 0.8, y: 0.8 }, label: 'leads to' },
        { type: 'write', text: 'A note', at: { x: 0.5, y: 0.6 }, size: 0.03 },
        { type: 'pen_stroke', points: [[0.1, 0.1], [0.2, 0.2], [0.3, 0.1]], tool: 'marker' },
      ],
      say: 'The short answer.',
    },
    ['c1', 'c2'],
  );

  assert.ok(result);
  assert.deepEqual(
    result.actions.map((action) => action.type),
    ['point_at', 'circle', 'underline', 'arrow', 'write', 'pen_stroke'],
  );
  assert.equal(result.say, 'The short answer.');
  assert.deepEqual(result.actions[5], { type: 'pen_stroke', points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.1 }], tool: 'marker' });
  assert.deepEqual(result.actions[4], { type: 'write', text: 'A note', at: { x: 0.5, y: 0.6 }, size: 0.03 });
});

test('parsePenPlan: unknown types, unknown cluster ids without a box, and empty writes are dropped', () => {
  const result = parsePenPlan(
    {
      actions: [
        { type: 'erase', ids: ['x'] },
        { type: 'circle', target: { clusterId: 'nope' } },
        // An unknown id WITH a box falls back to the box.
        { type: 'circle', target: { clusterId: 'nope', box: [0.1, 0.1, 0.2, 0.1] } },
        { type: 'write', text: '   ', at: { x: 0.5, y: 0.5 } },
        { type: 'write', text: 'No position' },
        { type: 'pen_stroke', points: [[0.1, 0.1]] },
        { type: 'arrow', from: { clusterId: 'c1' } },
        { type: 'underline', target: 'c2' },
      ],
    },
    ['c1', 'c2'],
  )!;

  assert.deepEqual(result.actions, [
    { type: 'circle', target: { box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } } },
    { type: 'underline', target: { clusterId: 'c2' } },
  ]);
  assert.equal(result.say, undefined);
});

test('parsePenPlan: caps — 12 actions, 120 characters per note, 64 points per stroke, coordinates clamped', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ type: 'point_at', at: { x: index / 20, y: 0.5 } }));
  const longText = 'x'.repeat(500);
  const longStroke = Array.from({ length: 300 }, (_, index) => [index / 300, 0.5]);
  const result = parsePenPlan(
    { actions: [{ type: 'write', text: longText, at: { x: 2, y: -1 }, size: 9 }, { type: 'pen_stroke', points: longStroke }, ...many] },
    [],
  )!;

  assert.equal(result.actions.length, PEN_MAX_ACTIONS);

  const write = result.actions[0] as Extract<(typeof result.actions)[number], { type: 'write' }>;
  const stroke = result.actions[1] as Extract<(typeof result.actions)[number], { type: 'pen_stroke' }>;

  assert.equal(write.text.length, PEN_MAX_TEXT);
  assert.deepEqual(write.at, { x: 1, y: 0 });
  assert.equal(write.size, 0.05);
  assert.equal(stroke.points.length, PEN_MAX_STROKE_POINTS);
  assert.deepEqual(stroke.points[0], { x: 0, y: 0.5 });
  assert.equal(stroke.points[PEN_MAX_STROKE_POINTS - 1]!.x, 299 / 300);
});

test('parsePenPlan: a JSON string answer and a wrapped envelope are read; junk is null', () => {
  const parsed = parsePenPlan('Here you go:\n```json\n{"plan":{"actions":[{"type":"point","point":[0.5,0.5]}],"answer":"ok"}}\n```', []);

  assert.ok(parsed);
  assert.deepEqual(parsed.actions, [{ type: 'point_at', at: { x: 0.5, y: 0.5 } }]);
  assert.equal(parsed.say, 'ok');
  assert.equal(parsePenPlan(42, []), null);
  assert.equal(parsePenPlan(null, []), null);
  assert.deepEqual(parsePenPlan({}, []), { actions: [] });
});

test('parsePagePoint and thinPoints', () => {
  assert.deepEqual(parsePagePoint([0.5, 1.5]), { x: 0.5, y: 1 });
  assert.deepEqual(parsePagePoint({ x: '0.25', y: 0.75 }), { x: 0.25, y: 0.75 });
  assert.equal(parsePagePoint({ x: NaN, y: 1 }), null);
  assert.equal(parsePagePoint('0.5'), null);
  assert.deepEqual(thinPoints([1, 2, 3, 4, 5, 6, 7, 8, 9], 5), [1, 3, 5, 7, 9]);
  assert.deepEqual(thinPoints([1, 2], 5), [1, 2]);
});

// --- planning ----------------------------------------------------------------------------------

test('planPenActions: a circle hugs its cluster, an underline runs under it, both snapped to the real box', () => {
  const plan = planPenActions(
    { actions: [{ type: 'circle', target: { clusterId: 'c1' } }, { type: 'underline', target: { clusterId: 'c2' } }] },
    ctx,
  );

  assert.equal(plan.primitives.length, 2);

  const [circle, underline] = plan.primitives;

  assert.equal(circle!.kind, 'stroke');
  assert.equal((circle as { role: string }).role, 'circle');

  const xs = (circle as { points: Array<{ x: number; y: number }> }).points.map((p) => p.x);
  const ys = (circle as { points: Array<{ x: number; y: number }> }).points.map((p) => p.y);

  // Around c1 (100..400 × 200..240), outside the ink, not far from it.
  assert.ok(Math.min(...xs) < 100 && Math.min(...xs) > 40);
  assert.ok(Math.max(...xs) > 400 && Math.max(...xs) < 460);
  assert.ok(Math.min(...ys) < 200 && Math.max(...ys) > 240);

  const line = (underline as { points: Array<{ x: number; y: number }> }).points;

  assert.equal(line[0]!.x < line[line.length - 1]!.x, true, 'LTR underline runs left → right');
  assert.ok(line.every((p) => p.y > 440 && p.y < 460), 'just under c2');
  assert.ok(plan.bounds && plan.bounds.top < 200 && plan.bounds.top + plan.bounds.height > 440);
});

test('planPenActions: a box target and page points convert through the sheet', () => {
  const plan = planPenActions(
    {
      actions: [
        { type: 'point_at', at: { x: 0.5, y: 0.25 }, note: 'hi' },
        { type: 'pen_stroke', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], tool: 'highlighter' },
      ],
    },
    ctx,
  );
  const [pointer, stroke] = plan.primitives;

  assert.deepEqual(pointer, { kind: 'pointer', at: { x: 500, y: 350 }, note: 'hi' });
  assert.deepEqual((stroke as { points: unknown }).points, [{ x: 0, y: 0 }, { x: 1000, y: 1400 }]);
  assert.equal((stroke as { tool: string }).tool, 'highlighter');
  assert.equal((stroke as { width: number }).width, 27);
});

test('planPenActions: an arrow between two clusters leaves one box edge for the other, with a head and a label', () => {
  const plan = planPenActions({ actions: [{ type: 'arrow', from: { clusterId: 'c1' }, to: { clusterId: 'c2' }, label: 'leads to' }] }, ctx);
  const kinds = plan.primitives.map((primitive) => (primitive.kind === 'stroke' ? primitive.role : primitive.kind));

  assert.deepEqual(kinds, ['arrow', 'arrow-head', 'write']);

  const shaft = plan.primitives[0] as { points: Array<{ x: number; y: number }> };
  const start = shaft.points[0]!;
  const end = shaft.points[shaft.points.length - 1]!;

  // Starts under c1 (bottom 240), ends above c2 (top 400), never inside either box.
  assert.ok(start.y > 240 && start.y < 300, `start ${start.y}`);
  assert.ok(end.y < 400 && end.y > 340, `end ${end.y}`);

  const label = plan.primitives[2] as { role: string; box: SceneRect; letterHeight: number };

  assert.equal(label.role, 'label');
  assert.equal(label.letterHeight, 24);
  // Beside the shaft, not on the ink.
  assert.ok(label.box.top > 240 && label.box.top + label.box.height < 400);
});

test('planPenActions: an arrow with an unknown cluster, or too short to draw, is skipped', () => {
  const plan = planPenActions(
    {
      actions: [
        { type: 'arrow', from: { clusterId: 'zz' }, to: { x: 0.5, y: 0.5 } },
        { type: 'arrow', from: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 } },
      ],
    },
    ctx,
  );

  assert.deepEqual(plan.primitives, []);
  assert.equal(plan.bounds, null);
});

test('planPenActions: a note lands where asked when the spot is free, sized by the page height', () => {
  const plan = planPenActions({ actions: [{ type: 'write', text: 'short note', at: { x: 0.5, y: 0.6 }, size: 0.02 }] }, ctx);
  const note = plan.primitives[0] as { kind: string; box: SceneRect; letterHeight: number; lines: string[] };

  assert.equal(note.kind, 'write');
  assert.equal(note.letterHeight, 28);
  assert.deepEqual(note.lines, ['short note']);
  assert.equal(note.box.left, 500);
  assert.equal(note.box.top, 840);
  assert.equal(note.box.height, 42);
});

test('planPenActions: a note that would cover ink is nudged below it, and two notes never overlap', () => {
  // Asked for right on top of c1 (100..400 × 200..240).
  const plan = planPenActions(
    {
      actions: [
        { type: 'write', text: 'first', at: { x: 0.12, y: 0.15 } },
        { type: 'write', text: 'second', at: { x: 0.12, y: 0.15 } },
      ],
    },
    ctx,
  );
  const [first, second] = plan.primitives as Array<{ box: SceneRect }>;
  const overlaps = (a: SceneRect, b: SceneRect) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

  assert.ok(first!.box.top >= 240, `below c1, got ${first!.box.top}`);
  assert.ok(!overlaps(first!.box, clusters.get('c1')!));
  assert.ok(!overlaps(second!.box, first!.box), 'the second note moved past the first');
  assert.ok(!overlaps(second!.box, clusters.get('c1')!));
  // Still on the sheet.
  assert.ok(second!.box.left >= 0 && second!.box.left + second!.box.width <= page.width);
});

test('planPenActions: a long note wraps to at most ~40% of the sheet', () => {
  const text = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
  const plan = planPenActions({ actions: [{ type: 'write', text, at: { x: 0.05, y: 0.9 } }] }, ctx);
  const note = plan.primitives[0] as { box: SceneRect; lines: string[] };

  assert.ok(note.lines.length > 1);
  assert.ok(note.box.width <= page.width * 0.42 + 0.001);
  assert.equal(note.lines.join(' '), text);
  // Pinned to the sheet bottom rather than hanging off it.
  assert.ok(note.box.top + note.box.height <= page.height);
});

test('placeNote keeps the asked spot when it is free and grows `occupied`', () => {
  const occupied: SceneRect[] = [];
  const placed = placeNote(r(10, 10, 50, 20), occupied, { page, gap: 5 });

  assert.deepEqual(placed, r(10, 10, 50, 20));
  assert.equal(occupied.length, 1);
});

test('wrapHandText: greedy by estimated width, never an empty result', () => {
  assert.deepEqual(wrapHandText('a b c', 10, 1000), ['a b c']);
  assert.deepEqual(wrapHandText('aaaa bbbb cccc', 10, 40), ['aaaa', 'bbbb', 'cccc']);
  assert.deepEqual(wrapHandText('aaaa bbbb cccc', 10, 60), ['aaaa bbbb', 'cccc']);
  assert.deepEqual(wrapHandText('', 10, 60), ['']);
});

test('planPenActions is deterministic for the same input and seed', () => {
  const input = { actions: [{ type: 'circle' as const, target: { clusterId: 'c1' } }] };

  assert.deepEqual(planPenActions(input, ctx), planPenActions(input, ctx));
});

test('v2: a mark parses with its verdict and label; a note may name a region instead of a point; the page verdict is kept', () => {
  const plan = parsePenPlan(
    {
      verdict: 'partly',
      actions: [
        { type: 'mark', target: { clusterId: 'c1' }, verdict: 'wrong', label: 'should be 2x' },
        { type: 'mark', target: { clusterId: 'c1' }, verdict: 'nonsense' },
        { type: 'write', text: 'check the sign', near: { clusterId: 'c1' } },
      ],
    },
    ['c1'],
  );

  assert.equal(plan?.verdict, 'partly');
  assert.deepEqual(plan?.actions, [
    { type: 'mark', target: { clusterId: 'c1' }, verdict: 'wrong', label: 'should be 2x' },
    { type: 'write', text: 'check the sign', near: { clusterId: 'c1' } },
  ]);
});

test('v2: a wrong mark is a red badge at the end of the line with the fix on a card, and a wavy line under the step', () => {
  const page = { left: 0, top: 0, width: 1000, height: 1400 };
  const rect = { left: 100, top: 200, width: 200, height: 30 };
  // A second group on the same handwritten line: the badge goes after IT, not into the middle.
  const next = { left: 320, top: 202, width: 80, height: 28 };
  const asked: Array<{ wanted: SceneRect; alt?: SceneRect; home?: SceneRect }> = [];
  const plan = planPenActions(
    { actions: [{ type: 'mark', target: { clusterId: 'c1' }, verdict: 'wrong', label: 'should be 2x' }, { type: 'write', text: 'same thing again', near: { clusterId: 'c1' } }] },
    {
      page,
      clusters: new Map([
        ['c1', rect],
        ['c2', next],
      ]),
      occupied: [],
      letterHeight: 24,
      strokeWidth: 2,
      clean: true,
      place: (wanted, alt, home) => {
        asked.push({ wanted, alt, home });

        return { ...wanted, left: 420, top: 190 };
      },
    },
  );
  const kinds = plan.primitives.map((primitive) => primitive.kind);
  const badge = plan.primitives.find((primitive) => primitive.kind === 'badge');
  const chip = plan.primitives.find((primitive) => primitive.kind === 'chip');
  const wavy = plan.primitives.find((primitive) => primitive.kind === 'stroke');

  assert.deepEqual(kinds, ['stroke', 'badge', 'chip'], 'the note that repeats a labelled mark is dropped');
  assert.equal(asked.length, 1, 'the badge and its card are placed as one box');
  assert.ok(asked[0]!.wanted.left > next.left + next.width, 'wanted after the END of the line');
  assert.ok(asked[0]!.alt && asked[0]!.alt.top > rect.top + rect.height, 'second choice: right under the line');
  assert.deepEqual(asked[0]!.home, rect, 'placed inside the question of the region it is about');
  assert.ok(badge && badge.kind === 'badge' && badge.color === MARK_INK.wrong && badge.size <= page.height * 0.022);
  assert.ok(chip && chip.kind === 'chip' && chip.rim === MARK_INK.wrong && chip.box.left > 420 && chip.lines.length <= 2);
  assert.ok(wavy && wavy.kind === 'stroke' && wavy.role === 'underline' && wavy.color === MARK_INK.wrong && wavy.points.length > 8);
  assert.deepEqual(plan.overflow, []);
});

test('v2: a label too long for its card goes with the answer; the badge still shows', () => {
  const page = { left: 0, top: 0, width: 1000, height: 1400 };
  const plan = planPenActions(
    { actions: [{ type: 'mark', target: { clusterId: 'c1' }, verdict: 'correct', label: 'word '.repeat(40).trim() }] },
    { page, clusters: new Map([['c1', { left: 100, top: 200, width: 200, height: 30 }]]), occupied: [], letterHeight: 24, strokeWidth: 2, clean: true, place: (wanted) => wanted },
  );

  assert.deepEqual(plan.primitives.map((primitive) => primitive.kind), ['badge']);
  assert.equal(plan.overflow.length, 1);
});

test('v2: with the page full, a note goes to the answer (overflow) instead of covering content', () => {
  const page = { left: 0, top: 0, width: 1000, height: 1400 };
  const plan = planPenActions(
    { actions: [{ type: 'write', text: 'no room for this', near: { clusterId: 'c1' } }] },
    { page, clusters: new Map([['c1', { left: 100, top: 200, width: 200, height: 30 }]]), occupied: [], letterHeight: 24, strokeWidth: 2, clean: true, place: () => null },
  );

  assert.deepEqual(plan.primitives, []);
  assert.deepEqual(plan.overflow, ['no room for this']);
});
