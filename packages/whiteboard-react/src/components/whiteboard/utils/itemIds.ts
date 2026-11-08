import { FabricObject as BaseFabricObject } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

/**
 * Stable item ids for live co-editing (a notebook page several people edit at once).
 *
 * Every object on the board carries `oid`, saved in the page JSON. A new object gets a random one when
 * it is added. A copy (paste, duplicate, a split eraser piece) arrives carrying its source's id while the
 * source is still on the board, so it gets a fresh one too. Undo puts an object back with the id it had.
 * Boards saved before ids existed get theirs from the host before they load (derived from the item's
 * JSON, so every device names an old item the same way).
 *
 * The helpers below put another person's item changes (`put` whole items, `del` ids) into a page's
 * per-object strings or its stored JSON, matching items by id.
 */

export const ITEM_ID_PROP = 'oid';

export function registerItemIdPersistence(): void {
  const base = BaseFabricObject as unknown as { customProperties?: string[] };

  if (!base.customProperties?.includes(ITEM_ID_PROP)) {
    base.customProperties = [...(base.customProperties ?? []), ITEM_ID_PROP];
  }
}

const randomItemId = (): string => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

type WithItemId = FabricObject & { oid?: unknown; excludeFromExport?: boolean };

/** Give every object added to `canvas` a unique id. Returns the uninstall. */
export function installItemIds(canvas: Canvas): () => void {
  registerItemIdPersistence();

  const holders = new Map<string, FabricObject>();
  const onAdded = ({ target }: { target?: FabricObject }) => {
    const object = target as WithItemId | undefined;

    if (!object || object.excludeFromExport) return;

    let id = typeof object.oid === 'string' && object.oid ? object.oid : '';
    const holder = id ? holders.get(id) : undefined;

    if (!id || (holder && holder !== object && holder.canvas === canvas)) {
      id = randomItemId();
      object.oid = id;
    }

    holders.set(id, object);
  };
  const onRemoved = ({ target }: { target?: FabricObject }) => {
    const id = (target as WithItemId | undefined)?.oid;

    if (typeof id === 'string' && holders.get(id) === target) holders.delete(id);
  };
  const onCleared = () => holders.clear();

  canvas.on('object:added', onAdded as never);
  canvas.on('object:removed', onRemoved as never);
  canvas.on('canvas:cleared', onCleared as never);

  return () => {
    canvas.off('object:added', onAdded as never);
    canvas.off('object:removed', onRemoved as never);
    canvas.off('canvas:cleared', onCleared as never);
  };
}

/** One page's changes from someone else. */
export interface RemoteItemOps {
  page: string;
  put?: Record<string, unknown>[];
  del?: string[];
}

const ID_IN_STRING = /"oid":"([^"\\]{1,64})"/;

/**
 * The id of one serialized object. Fabric writes custom properties before `type`, so the first match
 * before `"type":` is the object's own (a group's children come later, under `objects`).
 */
export function itemIdOfString(value: string): string | null {
  const typeAt = value.indexOf('"type":');
  const head = typeAt > 0 ? value.slice(0, typeAt) : value;

  return ID_IN_STRING.exec(head)?.[1] ?? (typeAt > 0 ? null : (ID_IN_STRING.exec(value)?.[1] ?? null));
}

const itemIdOf = (item: unknown): string | null => {
  const id = item && typeof item === 'object' ? (item as Record<string, unknown>)[ITEM_ID_PROP] : null;

  return typeof id === 'string' && id ? id : null;
};

/** `state` (a page's per-object strings, in z-order) with the ops in: changed items keep their place, new ones go on top. */
export function applyItemOpsToState(state: readonly string[], op: RemoteItemOps): string[] {
  const dels = new Set(op.del ?? []);
  const puts = new Map<string, string>();

  for (const item of op.put ?? []) {
    const id = itemIdOf(item);

    if (id) puts.set(id, JSON.stringify(item));
  }

  const out: string[] = [];

  for (const value of state) {
    const id = itemIdOfString(value);

    if (id && dels.has(id)) continue;

    if (id && puts.has(id)) {
      out.push(puts.get(id) as string);
      puts.delete(id);
    } else {
      out.push(value);
    }
  }

  puts.forEach((value) => out.push(value));

  return out;
}

/** A page's stored `canvasJSON` with the ops in; unreadable JSON is returned unchanged. */
export function applyItemOpsToCanvasJson(canvasJSON: string, op: RemoteItemOps): string {
  let parsed: Record<string, unknown>;

  try {
    parsed = canvasJSON ? (JSON.parse(canvasJSON) as Record<string, unknown>) : { objects: [] };
  } catch {
    return canvasJSON;
  }

  if (!parsed || typeof parsed !== 'object') return canvasJSON;

  const objects = Array.isArray(parsed.objects) ? (parsed.objects as unknown[]) : [];
  const state = applyItemOpsToState(
    objects.map((object) => JSON.stringify(object)),
    op,
  );

  return JSON.stringify({ ...parsed, objects: state.map((value) => JSON.parse(value) as unknown) });
}
