/**
 * Canvas serialization for persistence: Fabric's `toJSON()` plus a size pass.
 *
 * Fabric writes path coordinates at full double precision — `["Q",832.2411643440477,-262.6933166301327,
 * 833.552534968371,-262.2561930886916]` is one curve segment, ~80 characters. A heavily annotated exam
 * page on the studio board carried 1,152 strokes / 102,300 segments = 3.5 MB of JSON, and the whole
 * 109-page document 48 MB of it (2026-09-13). Two decimals (0.01 canvas px, far below anything a
 * 1080p board can show) cut a segment to ~36 characters, so every autosave, undo snapshot, sync
 * payload and cloud upload carries less than half the bytes. Nothing downstream needs more: Fabric
 * re-parses the numbers as-is, and the server-side ink renderer draws from the same JSON.
 */

/** Digits kept for path/point coordinates. */
export const CANVAS_COORD_DECIMALS = 2;

const SCALE = 10 ** CANVAS_COORD_DECIMALS;

function roundCoord(value: unknown): unknown {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * SCALE) / SCALE : value;
}

/**
 * Round the coordinates of every path segment and polyline point in place. Only the geometry arrays
 * are touched — transform props already go through Fabric's own `NUM_FRACTION_DIGITS`.
 */
export function compactCanvasJson<T extends { objects?: unknown[] }>(json: T): T {
  const objects = Array.isArray(json?.objects) ? json.objects : [];

  for (const object of objects) {
    if (!object || typeof object !== 'object') {
      continue;
    }

    const record = object as { path?: unknown; points?: unknown; objects?: unknown[] };

    if (Array.isArray(record.path)) {
      for (const segment of record.path) {
        if (!Array.isArray(segment)) {
          continue;
        }

        for (let index = 1; index < segment.length; index += 1) {
          segment[index] = roundCoord(segment[index]);
        }
      }
    }

    if (Array.isArray(record.points)) {
      for (const point of record.points) {
        if (point && typeof point === 'object') {
          const xy = point as { x?: unknown; y?: unknown };

          xy.x = roundCoord(xy.x);
          xy.y = roundCoord(xy.y);
        }
      }
    }

    // Groups carry their children under `objects`.
    if (Array.isArray(record.objects)) {
      compactCanvasJson(record as { objects: unknown[] });
    }
  }

  return json;
}

/** `JSON.stringify(canvas.toJSON())` with the size pass — the ONE way the editor serializes a page. */
export function serializeCanvasJson(canvas: { toJSON: () => unknown }): string {
  return JSON.stringify(compactCanvasJson(canvas.toJSON() as { objects?: unknown[] }));
}
