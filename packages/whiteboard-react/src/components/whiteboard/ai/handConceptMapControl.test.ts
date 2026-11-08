import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Rect } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import { AI_OBJECT_PROP } from './boardObjects';
import { samplePath } from './handConceptMap.fixture';
import { planHandConceptMap } from './handConceptMap';
import { attachHandConceptMapControl, edgeOfPart, expandMapSelection, mapParts, nodeOfPart, nudgeOff, settleMovedNodes, tagOf } from './handConceptMapControl';
import { buildTermsMapObjects } from './termsMapObjects';

import type { ConceptMap, SceneRect } from './types';

const MAP: ConceptMap = {
  title: 'Water cycle',
  nodes: [
    { id: 'sun', text: 'The Sun', level: 0 },
    { id: 'evap', text: 'Evaporation of sea water', level: 1 },
    { id: 'cloud', text: 'Clouds', level: 2 },
    { id: 'rain', text: 'Rain and snow', level: 3 },
  ],
  edges: [
    { from: 'sun', to: 'evap', label: 'drives', arrow: 'end' },
    { from: 'evap', to: 'cloud', label: 'forms', arrow: 'end' },
    { from: 'cloud', to: 'rain', label: 'falls as', arrow: 'end' },
    { from: 'rain', to: 'evap', label: 'feeds back', arrow: 'end' },
  ],
};

const hits = (a: SceneRect, b: SceneRect) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/** The bits of a Fabric canvas the control touches, over a plain array. */
function fakeCanvas(objects: FabricObject[]): Canvas & { emit: (name: string, event: unknown) => void } {
  const handlers = new Map<string, Array<(event: unknown) => void>>();

  return {
    getObjects: () => objects,
    remove: (...gone: FabricObject[]) => {
      for (const object of gone) objects.splice(objects.indexOf(object), 1);
    },
    insertAt: (index: number, ...added: FabricObject[]) => objects.splice(index, 0, ...added),
    getActiveObjects: () => [],
    getActiveObject: () => undefined,
    discardActiveObject: () => undefined,
    requestRenderAll: () => undefined,
    on: (name: string, handler: (event: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    off: (name: string, handler: (event: unknown) => void) => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler)),
    emit: (name: string, event: unknown) => (handlers.get(name) ?? []).forEach((handler) => handler(event)),
  } as unknown as Canvas & { emit: (name: string, event: unknown) => void };
}

/** The map as the board holds it: pen paths, and a tagged box standing in for each written label. */
async function drawnMap() {
  const plan = planHandConceptMap(MAP, { letterHeight: 20 });
  const built = await buildTermsMapObjects(
    { ...plan, primitives: plan.primitives.filter((primitive) => primitive.kind !== 'label') },
    { sources: new Map(), color: '#18204a', strokeWidth: 2, hand: null, zoom: 1, batch: 'ai-map', lh: plan.letterHeight },
  );
  const words = plan.primitives.flatMap((primitive) => {
    if (primitive.kind !== 'label') return [];
    const box = new Rect({ left: primitive.box.left, top: primitive.box.top, width: primitive.box.width, height: primitive.box.height, strokeWidth: 0 });

    (box as unknown as Record<string, unknown>)[AI_OBJECT_PROP] = {
      kind: 'terms-label',
      source: primitive.text,
      batch: 'ai-map',
      lh: plan.letterHeight,
      ...(primitive.nodeId ? { node: primitive.nodeId } : {}),
      ...(primitive.edge ? { edge: primitive.edge } : {}),
    };

    return [box];
  });

  return { plan, objects: [...built.objects, ...words] };
}

const rectOf = (object: FabricObject): SceneRect => {
  object.setCoords();

  return object.getBoundingRect();
};

test('nudgeOff: pushes out along the shorter overlap, keeps the gap, stays put when clear', () => {
  assert.deepEqual(nudgeOff({ left: 0, top: 0, width: 10, height: 10 }, [{ left: 50, top: 0, width: 10, height: 10 }], 2), { dx: 0, dy: 0 });
  const push = nudgeOff({ left: 0, top: 0, width: 100, height: 20 }, [{ left: 10, top: 15, width: 100, height: 20 }], 4);

  assert.deepEqual(push, { dx: 0, dy: -9 });
});

test('a tap on a node selects the whole node; on a link or phrase, the whole map', async () => {
  const { objects } = await drawnMap();
  const canvas = fakeCanvas(objects);
  const word = objects.find((object) => nodeOfPart(tagOf(object)) === 'cloud' && tagOf(object)?.kind === 'terms-label')!;
  const node = expandMapSelection(canvas, [word])!;

  assert.ok(node.length >= 2);
  assert.ok(node.every((object) => nodeOfPart(tagOf(object)) === 'cloud'));

  const stroke = objects.find((object) => edgeOfPart(tagOf(object)) === 'sun->evap')!;

  assert.equal(expandMapSelection(canvas, [stroke])!.length, mapParts(canvas, 'ai-map').length);
  assert.equal(expandMapSelection(canvas, node), null);
});

test('drop a node on another: it is nudged off, its links redrawn to its new place, phrases follow', async () => {
  const { objects } = await drawnMap();
  const canvas = fakeCanvas(objects);
  const cloudParts = objects.filter((object) => nodeOfPart(tagOf(object)) === 'cloud');
  const sunOutline = rectOf(objects.find((object) => tagOf(object)?.kind === 'terms-node' && tagOf(object)?.source === 'sun')!);
  const cloudOutline = rectOf(objects.find((object) => tagOf(object)?.kind === 'terms-node' && tagOf(object)?.source === 'cloud')!);
  // Dropped right on top of the Sun.
  const dx = sunOutline.left - cloudOutline.left;
  const dy = sunOutline.top - cloudOutline.top;

  for (const object of cloudParts) object.set({ left: (object.left ?? 0) + dx, top: (object.top ?? 0) + dy });
  const phraseBefore = rectOf(objects.find((object) => edgeOfPart(tagOf(object)) === 'evap->cloud' && tagOf(object)?.kind === 'terms-label')!);

  assert.ok(settleMovedNodes(canvas, cloudParts));

  const outline = (id: string) =>
    objects
      .filter((object) => tagOf(object)?.kind === 'terms-node' && tagOf(object)?.source === id)
      .map(rectOf)
      .sort((a, b) => a.width * a.height - b.width * b.height)[0]!;
  const cloud = outline('cloud');

  for (const other of ['sun', 'evap', 'rain']) assert.ok(!hits(cloud, outline(other)), `cloud clear of ${other}`);

  // Each link touching the cloud now starts / ends at the cloud's new outline.
  for (const key of ['evap->cloud', 'cloud->rain']) {
    const strokes = objects.filter((object) => tagOf(object)?.kind === 'terms-edge' && tagOf(object)?.source === key);

    assert.ok(strokes.length >= 2, key);
    assert.ok(strokes.every((stroke) => tagOf(stroke)?.lh === 20 && tagOf(stroke)?.arrow === 'end'));
    const points = strokes.flatMap((stroke) => samplePath(((stroke as unknown as { path: unknown[][] }).path ?? []).map((seg) => seg.join(' ')).join(' ')));
    const near = (x: number, y: number) => Math.hypot(x - (cloud.left + cloud.width / 2), y - (cloud.top + cloud.height / 2)) < Math.max(cloud.width, cloud.height);

    assert.ok(points.length > 0 && points.some(([x, y]) => near(x, y)), `${key} reaches the cloud`);
  }

  // The phrase moved with its link and sits on no node.
  const phrase = rectOf(objects.find((object) => edgeOfPart(tagOf(object)) === 'evap->cloud' && tagOf(object)?.kind === 'terms-label')!);

  assert.notDeepEqual(phrase, phraseBefore);
  for (const id of ['sun', 'evap', 'cloud', 'rain']) assert.ok(!hits(phrase, outline(id)), `phrase clear of ${id}`);
  // Links that do not touch the cloud are left exactly as drawn.
  assert.ok(objects.some((object) => tagOf(object)?.source === 'sun->evap'));
});

test('the whole map moved together: nothing is redrawn', async () => {
  const { objects } = await drawnMap();
  const canvas = fakeCanvas(objects);
  const before = [...objects];

  for (const object of objects) object.set({ left: (object.left ?? 0) + 100 });
  assert.equal(settleMovedNodes(canvas, [...objects]), false);
  assert.deepEqual(objects, before);
});

test('canvas wiring: a dragged word pulls its node along live; release settles; a recolour event moves nothing', async () => {
  const { objects } = await drawnMap();
  const canvas = fakeCanvas(objects);
  const detach = attachHandConceptMapControl(canvas);
  const word = objects.find((object) => nodeOfPart(tagOf(object)) === 'rain' && tagOf(object)?.kind === 'terms-label')!;
  const ring = objects.find((object) => tagOf(object)?.kind === 'terms-node' && tagOf(object)?.source === 'rain')!;
  const original = { left: word.left ?? 0, top: word.top ?? 0 };
  const ringStart = { left: ring.left ?? 0, top: ring.top ?? 0 };
  const links = () => objects.filter((object) => tagOf(object)?.kind === 'terms-edge' && tagOf(object)?.source === 'cloud->rain');
  const before = links();

  // A recolour fires object:modified with no transform: nothing is redrawn.
  canvas.emit('object:modified', { target: word });
  assert.deepEqual(links(), before);

  word.set({ left: original.left + 400, top: original.top + 50 });
  canvas.emit('object:moving', { target: word, transform: { original } });
  assert.deepEqual([ring.left, ring.top], [ringStart.left + 400, ringStart.top + 50], 'the outline follows the word live');

  canvas.emit('object:modified', { target: word, transform: { action: 'drag' } });
  assert.ok(links().length > 0 && links().every((stroke) => !before.includes(stroke)), 'its links were redrawn on release');
  detach();
});
