import { BaseFabricObject, StaticCanvas } from 'fabric';

import { STROKE_TIME_PROP } from './timeline';

/**
 * Stamps every ink object the board adds while a lecture records with `t` (ms of recorded audio at
 * pen-down) — without touching `@repo/whiteboard-react`. It works because the editor and this app
 * share ONE `fabric` module instance:
 *  - `t` joins `BaseFabricObject.customProperties`, so the editor's own `toJSON` (autosave, undo,
 *    sync) keeps it inside the board JSON and `fromObject` revives it;
 *  - `StaticCanvas.prototype._onObjectAdded` (which `Canvas` reaches through `super`) stamps an
 *    object the first time it lands on any canvas — objects revived by `loadFromJSON` (page switch,
 *    undo) are skipped, and anything already carrying `t` keeps it.
 * The time is the last pen-down, not the moment Fabric adds the finished path, so a stroke maps to
 * when the lecturer started writing it.
 */

type Stampable = { [STROKE_TIME_PROP]?: number; __studyRevived?: boolean };
type CanvasProto = {
  _onObjectAdded(object: unknown): void;
  loadFromJSON(json: unknown, reviver?: (serialized: unknown, object: unknown) => void, ...rest: unknown[]): unknown;
};

let clock: (() => number) | null = null;
let lastPenDownMs: number | null = null;
let installed = false;

/** How long a pen-down stays the stamp for objects added after it (a slow stroke, a shape snap). */
const PEN_DOWN_WINDOW_MS = 60_000;

function currentStamp(): number | null {
  if (!clock) return null;
  const now = Math.round(clock());

  return lastPenDownMs !== null && now - lastPenDownMs <= PEN_DOWN_WINDOW_MS ? lastPenDownMs : now;
}

export function installStrokeClock(): void {
  if (installed) return;
  installed = true;

  const base = BaseFabricObject as unknown as { customProperties?: string[] };

  if (!base.customProperties?.includes(STROKE_TIME_PROP)) {
    base.customProperties = [...(base.customProperties ?? []), STROKE_TIME_PROP];
  }

  const proto = StaticCanvas.prototype as unknown as CanvasProto;
  const originalAdded = proto._onObjectAdded;
  const originalLoad = proto.loadFromJSON;

  proto._onObjectAdded = function patchedOnObjectAdded(this: unknown, object: unknown) {
    const target = object as Stampable | null;

    if (target && !target.__studyRevived && typeof target[STROKE_TIME_PROP] !== 'number') {
      const t = currentStamp();

      if (t !== null) target[STROKE_TIME_PROP] = t;
    }
    originalAdded.call(this, object);
  };
  proto.loadFromJSON = function patchedLoadFromJSON(this: unknown, json, reviver, ...rest) {
    const marking = (serialized: unknown, object: unknown) => {
      if (object && typeof object === 'object') (object as Stampable).__studyRevived = true;
      reviver?.(serialized, object);
    };

    return originalLoad.call(this, json, marking, ...rest);
  };

  window.addEventListener(
    'pointerdown',
    (event) => {
      if (clock && (event.pointerType === 'pen' || event.pointerType === 'touch' || event.pointerType === 'mouse')) {
        lastPenDownMs = Math.round(clock());
      }
    },
    { capture: true, passive: true },
  );
}

/** `fn` returns recorded ms; `null` stops stamping (not recording). */
export function setStrokeClock(fn: (() => number) | null): void {
  clock = fn;
  lastPenDownMs = null;
}
