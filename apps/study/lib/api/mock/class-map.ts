// Fixture ↔ live class ids. Fixtures name classes `cls_<canvasCourseId>`; the live backend mints its
// own ids. In hybrid mode (classes live, questions/pages/… still mock) the mock must answer in LIVE
// ids, so every live `GET /classes` (and `/today`) refreshes this map and the mock transport rewrites
// `classId` both ways at its edge. Persisted so a cold start on /bank maps before the first live call.
import type { StudyClass } from '../types';

const STORAGE_KEY = 'study_class_id_map';

/** fixture id → live id */
let forward: Record<string, string> | null = null;
/** live id → fixture id */
let reverse: Record<string, string> | null = null;

function load(): void {
  if (forward) return;
  forward = {};
  reverse = {};

  if (typeof window === 'undefined') return;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (raw) forward = JSON.parse(raw) as Record<string, string>;
  } catch {
    forward = {};
  }

  for (const [fixtureId, liveId] of Object.entries(forward)) reverse[liveId] = fixtureId;
}

export function rememberLiveClasses(classes: StudyClass[]): void {
  load();
  let changed = false;

  for (const cls of classes) {
    if (!cls?.id || typeof cls.canvasCourseId !== 'number') continue;
    const fixtureId = `cls_${cls.canvasCourseId}`;

    if (forward![fixtureId] !== cls.id) {
      forward![fixtureId] = cls.id;
      changed = true;
    }
  }

  if (!changed) return;
  reverse = {};
  for (const [fixtureId, liveId] of Object.entries(forward!)) reverse[liveId] = fixtureId;

  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(forward));
  } catch {
    // memory copy still serves this session
  }
}

export function toLiveClassId(id: string): string {
  load();

  return forward![id] ?? id;
}

export function toFixtureClassId(id: string): string {
  load();

  return reverse![id] ?? id;
}

const CLASS_ID_KEYS = new Set(['classId']);
const CLASS_ID_LIST_KEYS = new Set(['classIds']);

/** Deep-rewrite every `classId` (and `classIds[]`) in a JSON value. Arrays and plain objects only. */
export function mapClassIds<T>(value: T, direction: 'toLive' | 'toFixture'): T {
  const map = direction === 'toLive' ? toLiveClassId : toFixtureClassId;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    if (node instanceof Blob || node instanceof ArrayBuffer) return node;
    const out: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (CLASS_ID_KEYS.has(key) && typeof child === 'string') out[key] = map(child);
      else if (CLASS_ID_LIST_KEYS.has(key) && Array.isArray(child))
        out[key] = child.map((item) => (typeof item === 'string' ? map(item) : item));
      else out[key] = walk(child);
    }

    return out;
  };

  return walk(value) as T;
}

/** Rewrite the `classId` query parameter of a `/path?query` string. */
export function mapClassIdInPath(path: string, direction: 'toLive' | 'toFixture'): string {
  const [pathname, search] = path.split('?');

  if (!search) return path;
  const params = new URLSearchParams(search);
  const classId = params.get('classId');

  if (!classId) return path;
  params.set('classId', direction === 'toLive' ? toLiveClassId(classId) : toFixtureClassId(classId));

  return `${pathname}?${params.toString()}`;
}
