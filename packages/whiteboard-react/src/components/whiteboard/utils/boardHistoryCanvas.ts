import type { Canvas, FabricObject, StaticCanvas } from 'fabric';

import { compactCanvasJson } from './canvasJson';

import type { PageState } from './boardHistory';

/**
 * The Fabric side of the undo model (utils/boardHistory): turning live objects into the per-object
 * strings a page state is made of — cheaply, once per object version — and turning a live page back
 * into a recorded state with the fewest canvas writes.
 */

type AnyCanvas = Canvas | StaticCanvas;

type CanvasWithObjectSerializer = AnyCanvas & {
  _toObject?: (instance: FabricObject, methodName: 'toObject', propertiesToInclude?: string[]) => Record<string, unknown>;
};

/**
 * One object exactly as `canvas.toJSON()` writes it into `objects` (Fabric's own per-object path,
 * which also realizes an active multi-selection's transform onto its members), plus the size pass.
 */
export function canvasObjectJson(canvas: AnyCanvas, object: FabricObject): Record<string, unknown> {
  const serializer = (canvas as CanvasWithObjectSerializer)._toObject;
  const json = typeof serializer === 'function' ? serializer.call(canvas, object, 'toObject') : (object.toObject() as Record<string, unknown>);

  return json;
}

/** `JSON.stringify` of one object with the same coordinate rounding the page JSON gets. */
export function stringifyHistoryObject(json: Record<string, unknown>): string {
  return JSON.stringify(compactCanvasJson({ objects: [json] }).objects[0]);
}

type FingerprintedObject = FabricObject & {
  path?: unknown;
  points?: unknown;
  text?: unknown;
  clipPath?: unknown;
  src?: unknown;
  getSrc?: () => string;
  _objects?: unknown;
};

function customPropsOf(object: FabricObject): string {
  const klass = object.constructor as { customProperties?: string[] };
  const names = klass.customProperties;

  if (!names || names.length === 0) return '';

  return names.map((name) => String((object as unknown as Record<string, unknown>)[name])).join(',');
}

/**
 * Everything about an object that a user action changes without replacing an array: transforms, style,
 * text, the pin and AI markers (registered custom properties). Arrays and nested objects (a path's
 * points, a clip path, a group's children) are compared by reference in {@link HistoryObjectCache}.
 */
export function historyFingerprint(object: FabricObject): string {
  const o = object as FingerprintedObject;

  return [
    o.type,
    o.left,
    o.top,
    o.width,
    o.height,
    o.scaleX,
    o.scaleY,
    o.angle,
    o.skewX,
    o.skewY,
    o.flipX,
    o.flipY,
    // A crop changes what an image draws without always moving its box (a frame slid inside the picture).
    (o as { cropX?: number }).cropX ?? '',
    (o as { cropY?: number }).cropY ?? '',
    o.opacity,
    o.visible,
    typeof o.stroke === 'string' ? o.stroke : '',
    o.strokeWidth,
    typeof o.fill === 'string' ? o.fill : '',
    o.globalCompositeOperation,
    typeof o.text === 'string' ? o.text : '',
    customPropsOf(o),
  ].join('|');
}

interface CacheRecord {
  key: string;
  fingerprint: string;
  path: unknown;
  points: unknown;
  clipPath: unknown;
  children: unknown;
  version: number;
  value: string;
}

/**
 * Per-object serialized strings, reused while the object is unchanged. A stroke is serialized ONCE (at
 * the end of the gesture that drew it) instead of on every checkpoint of its page, which is what lets
 * the board take a checkpoint per stroke. `key` names the frame the string was written in (the page and
 * its page→scene map); a different key re-serializes.
 */
export class HistoryObjectCache {
  private readonly records = new WeakMap<FabricObject, CacheRecord>();
  private readonly versions = new WeakMap<FabricObject, number>();

  /** Force the next {@link get} to re-serialize (an event said the object changed). */
  touch(object: FabricObject): void {
    this.versions.set(object, (this.versions.get(object) ?? 0) + 1);
  }

  private snapshot(object: FabricObject, key: string, value: string): CacheRecord {
    const o = object as FingerprintedObject;

    return {
      children: o._objects,
      clipPath: o.clipPath,
      fingerprint: historyFingerprint(object),
      key,
      path: o.path,
      points: o.points,
      value,
      version: this.versions.get(object) ?? 0,
    };
  }

  /** Remember `value` as the object's string in frame `key` (a hydration / load / restore that knows it). */
  seed(object: FabricObject, key: string, value: string): void {
    this.records.set(object, this.snapshot(object, key, value));
  }

  get(object: FabricObject, key: string, serialize: () => string): string {
    const o = object as FingerprintedObject;
    const record = this.records.get(object);

    if (
      record &&
      record.key === key &&
      record.version === (this.versions.get(object) ?? 0) &&
      record.path === o.path &&
      record.points === o.points &&
      record.clipPath === o.clipPath &&
      record.children === o._objects &&
      // An object inside an active multi-selection is stored relative to it: its own props say nothing.
      !object.group &&
      record.fingerprint === historyFingerprint(object)
    ) {
      return record.value;
    }

    const value = serialize();

    this.records.set(object, this.snapshot(object, key, value));

    return value;
  }
}

export interface RestorePageArgs {
  canvas: AnyCanvas;
  /** The page's live objects in canvas z-order, and their current strings (same order). */
  live: readonly FabricObject[];
  liveState: PageState;
  target: PageState;
  /** Revive the target strings that have no live object; same order as given. */
  enliven: (values: string[]) => Promise<FabricObject[]>;
  /** Checked after the async enliven: false → nothing is written and the restore reports failure. */
  isCurrent?: () => boolean;
}

export interface RestorePageResult {
  ok: boolean;
  added: FabricObject[];
  removed: FabricObject[];
  /** Each target string's object, in target order. */
  objects: FabricObject[];
}

/**
 * Make a page's live objects equal `target`: objects whose string is still wanted stay (no re-enliven,
 * no flicker), the rest leave, missing ones are revived and slotted in at their z-position. Undoing one
 * stroke on a page of a thousand is one `canvas.remove`, not a page reload.
 */
export async function restorePageObjects({
  canvas,
  enliven,
  isCurrent,
  live,
  liveState,
  target,
}: RestorePageArgs): Promise<RestorePageResult> {
  const pool = new Map<string, FabricObject[]>();

  live.forEach((object, index) => {
    const value = liveState[index];

    if (value === undefined) return;

    const bucket = pool.get(value);

    if (bucket) bucket.push(object);
    else pool.set(value, [object]);
  });

  const slots: Array<FabricObject | null> = target.map((value) => pool.get(value)?.shift() ?? null);
  const kept = new Set(slots.filter((object): object is FabricObject => object !== null));
  const removed = live.filter((object) => !kept.has(object));
  const missing: string[] = [];

  slots.forEach((object, index) => {
    if (!object) missing.push(target[index] as string);
  });

  let revived: FabricObject[] = [];

  if (missing.length > 0) {
    revived = await enliven(missing);

    if (revived.length !== missing.length) return { added: [], objects: [], ok: false, removed: [] };
  }

  if (isCurrent && !isCurrent()) return { added: [], objects: [], ok: false, removed: [] };

  let revivedIndex = 0;
  const objects = slots.map((object) => object ?? (revived[revivedIndex++] as FabricObject));

  // A selection around restored objects would hold them in its frame (and a removed one in a ghost box).
  const selectable = canvas as Partial<Pick<Canvas, 'discardActiveObject' | 'getActiveObject'>>;

  if (selectable.getActiveObject?.()) selectable.discardActiveObject?.();

  if (removed.length > 0) canvas.remove(...removed);

  // Slot every object at its z-position: the first one goes where the page's lowest kept object is
  // (or on top when none is kept), each next one right above the previous.
  const all = canvas.getObjects();
  let cursor = all.length;

  kept.forEach((object) => {
    const index = all.indexOf(object);

    if (index >= 0 && index < cursor) cursor = index;
  });

  for (const object of objects) {
    const index = canvas.getObjects().indexOf(object);

    if (index < 0) {
      canvas.insertAt(cursor, object);
      cursor += 1;
    } else if (index >= cursor) {
      cursor = index + 1;
    } else {
      canvas.moveObjectTo(object, cursor - 1);
    }
  }

  return { added: revived, objects, ok: true, removed };
}
