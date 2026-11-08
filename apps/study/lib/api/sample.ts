// Sample-data marker. Anything the MOCK answers — a whole screen in Force-mock mode, or one
// unshipped route next to real Canvas data in Auto mode — carries `__sample: true`, so the UI can
// say so before the owner acts on a fabricated deadline. Live responses never get the marker.

export const SAMPLE_KEY = '__sample' as const;

export type Sampled<T> = T & { [SAMPLE_KEY]?: true };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return false;

  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

/**
 * Mark a mock response: the object itself, or every element of an array of objects. Nested arrays
 * of objects one level down (`{ items: Question[] }`, `{ topics: [] }`) are marked too, so a page
 * that only keeps the list still sees the flag. Primitives and `undefined` pass through.
 */
export function markSample<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => (isPlainObject(item) ? { ...item, [SAMPLE_KEY]: true } : item)) as T;
  }

  if (!isPlainObject(value)) return value;
  const marked: Record<string, unknown> = { ...value, [SAMPLE_KEY]: true };

  for (const [key, child] of Object.entries(marked)) {
    if (Array.isArray(child) && child.some(isPlainObject)) marked[key] = markSample(child);
  }

  return marked as T;
}

/** True for a marked object, or a non-empty array whose first object element is marked. */
export function isSampleData(value: unknown): boolean {
  if (Array.isArray(value)) {
    const first = value.find(isPlainObject);

    return first !== undefined && first[SAMPLE_KEY] === true;
  }

  return isPlainObject(value) && value[SAMPLE_KEY] === true;
}

/** A copy without the marker — same depth as `markSample` (for bodies sent back to the backend). */
export function stripSample<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripSample) as T;
  if (!isPlainObject(value)) return value;
  const rest: Record<string, unknown> = { ...value };

  delete rest[SAMPLE_KEY];

  for (const [key, child] of Object.entries(rest)) {
    if (Array.isArray(child)) rest[key] = stripSample(child);
  }

  return rest as T;
}
