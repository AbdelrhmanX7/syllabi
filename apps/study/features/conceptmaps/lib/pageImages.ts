// «Map the photo»: what a concept map is built from when the notebook page carries pictures — above
// all the ones sent from the phone. Pure: the board document, the device's phone marks and the page's
// lecture record go in; the ordered image list, the downscale plan and the lecture scope come out.
import type { KeyValueStore } from '../notes/links';
import type { ReferenceRequest } from '../types';
import type { Provenance, SourceRef } from './provenance';

import { normalizeTerm } from './terms';

/** At most this many pictures per request (the backend body cap is ~4 MB; 4 × ≤1600 px JPEG fits). */
export const MAX_MAP_IMAGES = 4;
/** Long edge sent to the model. */
export const MAP_IMAGE_MAX_EDGE = 1600;
/** Smaller than this on both sides is an icon / sticker, not something with terms on it. */
const MIN_IMAGE_EDGE = 64;
/** The backend's cap on a concept list (`MAX_TERMS`). */
export const MAX_MAP_TERMS = 15;

export type PageImageOrigin = 'phone' | 'page';

export interface PageImage {
  /** `data:` URL (what the editor stores) or an http(s) URL. */
  src: string;
  /** The pixel size shown on the board (the crop's size when cropped; before any on-board scaling). */
  width: number;
  height: number;
  /** The board's non-destructive crop: the region of `src` it shows (absent = the whole picture). */
  crop?: { x: number; y: number };
  origin: PageImageOrigin;
  /** The phone-inbox item it came from, when known. */
  inboxItemId?: string;
}

/* ------------------------------------------------------------------ phone marks (device) */

/**
 * A photo placed from the phone inbox. The board stores the picture as a `data:` URL of the file, so
 * the file's byte count identifies it again in the saved scene (base64 length = 4·⌈bytes/3⌉).
 */
export interface PhoneImageMark {
  bytes: number;
  inboxItemId?: string | null;
  at: number;
}

export const PHONE_MARKS_KEY = 'study_cm_phone_images';
const MARKS_PER_PAGE = 12;
const MARK_TTL_MS = 90 * 24 * 60 * 60 * 1000;

type MarkTable = Record<string, PhoneImageMark[]>;

function readTable(store: KeyValueStore | null): MarkTable {
  if (!store) return {};
  try {
    const raw = JSON.parse(store.getItem(PHONE_MARKS_KEY) ?? '{}') as unknown;

    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as MarkTable) : {};
  } catch {
    return {};
  }
}

export function readPhoneMarks(store: KeyValueStore | null, pageId: string): PhoneImageMark[] {
  const rows = readTable(store)[pageId];

  return Array.isArray(rows) ? rows.filter((row) => row && Number.isFinite(row.bytes) && row.bytes > 0) : [];
}

/** Records a phone photo placed on `pageId` (newest last, capped, stale pages dropped). */
export function rememberPhoneImage(
  store: KeyValueStore | null,
  pageId: string,
  mark: { bytes: number; inboxItemId?: string | null },
  now = Date.now(),
): void {
  if (!store || !pageId || !(mark.bytes > 0)) return;
  const table = readTable(store);
  const next: MarkTable = {};

  for (const [id, rows] of Object.entries(table)) {
    const kept = (Array.isArray(rows) ? rows : []).filter((row) => now - (row?.at ?? 0) < MARK_TTL_MS);

    if (kept.length > 0) next[id] = kept;
  }
  const rows = (next[pageId] ?? []).filter((row) => row.bytes !== mark.bytes);

  next[pageId] = [
    ...rows,
    { bytes: mark.bytes, ...(mark.inboxItemId ? { inboxItemId: mark.inboxItemId } : {}), at: now },
  ].slice(-MARKS_PER_PAGE);
  try {
    store.setItem(PHONE_MARKS_KEY, JSON.stringify(next));
  } catch {
    // quota — the photo still maps, only as a page picture
  }
}

/**
 * The insert sites' one call: remember the photo on the page (device store) and tell an open «Map the
 * photo» button there is a picture now (the board saves it a moment later).
 */
export function recordPhoneImage(pageId: string, file: { size: number }, inboxItemId?: string | null): void {
  if (typeof window === 'undefined' || !pageId) return;
  let store: KeyValueStore | null = null;

  try {
    store = window.localStorage;
  } catch {
    store = null;
  }
  rememberPhoneImage(store, pageId, { bytes: file.size, inboxItemId });
  window.dispatchEvent(new CustomEvent(PHONE_IMAGE_EVENT, { detail: { pageId } }));
}

/** base64 characters a file of `bytes` becomes (padding included). */
export const b64LengthForBytes = (bytes: number) => 4 * Math.ceil(bytes / 3);

/* ------------------------------------------------------------------ collecting */

interface SceneObject {
  type?: unknown;
  src?: unknown;
  cropX?: unknown;
  cropY?: unknown;
  width?: unknown;
  height?: unknown;
  visible?: unknown;
  objects?: unknown;
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

type SceneImage = { src: string; width: number; height: number; crop?: { x: number; y: number } };

function sceneImages(canvasJSON: string | undefined | null): SceneImage[] {
  if (!canvasJSON) return [];
  let scene: { objects?: unknown };

  try {
    scene = JSON.parse(canvasJSON) as { objects?: unknown };
  } catch {
    return [];
  }
  const out: SceneImage[] = [];
  const walk = (objects: unknown) => {
    if (!Array.isArray(objects)) return;
    for (const raw of objects as SceneObject[]) {
      if (!raw || typeof raw !== 'object' || raw.visible === false) continue;
      if (String(raw.type).toLowerCase() === 'image' && typeof raw.src === 'string' && raw.src) {
        const x = num(raw.cropX);
        const y = num(raw.cropY);

        out.push({
          src: raw.src,
          width: num(raw.width),
          height: num(raw.height),
          ...(x > 0 || y > 0 ? { crop: { x, y } } : {}),
        });
      }
      walk(raw.objects);
    }
  };

  walk(scene.objects);

  return out;
}

/**
 * Whether a saved board has a picture at all — a string test on each page's raw scene, no parse (the
 * scenes carry multi-MB data URLs; this runs while she writes). Fabric 6 writes `"type":"Image"`.
 */
export function docHasImages(
  doc: { pages?: ReadonlyArray<{ canvasJSON?: string | null }> } | null | undefined,
): boolean {
  return (doc?.pages ?? []).some(
    (page) => typeof page?.canvasJSON === 'string' && /"type"\s*:\s*"image"/i.test(page.canvasJSON),
  );
}

/** Fired on `window` when a phone photo is placed on a page (`detail.pageId`): the photo actions show at once. */
export const PHONE_IMAGE_EVENT = 'study:phone-image';

/** The base64 payload length of a `data:` URL; null for any other URL. */
function dataUrlPayloadLength(src: string): number | null {
  if (!src.startsWith('data:')) return null;
  const comma = src.indexOf(',');

  return comma < 0 ? null : src.length - comma - 1;
}

/**
 * The pictures on a notebook document, phone photos first (newest first), then the others in page
 * order. Deduped by source, tiny ones dropped, at most {@link MAX_MAP_IMAGES}. Ink and PDF page
 * backgrounds are not pictures here (the PDF page is the page, not a photo she sent).
 */
export function collectPageImages(
  doc: { pages?: ReadonlyArray<{ canvasJSON?: string | null }> } | null | undefined,
  marks: readonly PhoneImageMark[] = [],
  max = MAX_MAP_IMAGES,
): PageImage[] {
  const seen = new Set<string>();
  const phone: Array<PageImage & { at: number }> = [];
  const page: PageImage[] = [];

  for (const sheet of doc?.pages ?? []) {
    for (const image of sceneImages(sheet?.canvasJSON)) {
      if (seen.has(image.src)) continue;
      if (Math.max(image.width, image.height) < MIN_IMAGE_EDGE && image.width > 0 && image.height > 0) continue;
      seen.add(image.src);
      const length = dataUrlPayloadLength(image.src);
      const mark = length === null ? undefined : marks.find((row) => b64LengthForBytes(row.bytes) === length);

      if (mark) {
        phone.push({
          ...image,
          origin: 'phone',
          ...(mark.inboxItemId ? { inboxItemId: mark.inboxItemId } : {}),
          at: mark.at,
        });
      } else page.push({ ...image, origin: 'page' });
    }
  }

  const newestPhoneFirst = phone.sort((a, b) => b.at - a.at).map(({ at: _at, ...image }) => image);

  return [...newestPhoneFirst, ...page].slice(0, Math.max(0, max));
}

/* ------------------------------------------------------------------ downscaling */

export interface DownscalePlan {
  width: number;
  height: number;
  /** Re-encode at that size (always JPEG on the wire: a photo, and the body cap). */
  resize: boolean;
}

/** Long edge over `maxEdge` → scaled to it (aspect kept, whole pixels, ≥ 1); otherwise as is. */
export function planImageDownscale(
  size: { width: number; height: number },
  maxEdge = MAP_IMAGE_MAX_EDGE,
): DownscalePlan {
  const width = Math.max(0, Math.round(size.width));
  const height = Math.max(0, Math.round(size.height));
  const long = Math.max(width, height);

  if (long <= maxEdge || long === 0) return { width, height, resize: false };
  const scale = maxEdge / long;

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resize: true,
  };
}

/* ------------------------------------------------------------------ terms */

/** Terms read off several pictures → one concept list (first wording wins, capped). */
export function mergeImageTerms(lists: ReadonlyArray<readonly string[]>, max = MAX_MAP_TERMS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const list of lists) {
    for (const raw of list) {
      const term = raw.trim().replace(/\s+/g, ' ');
      const key = normalizeTerm(term);

      if (!term || !key || seen.has(key)) continue;
      seen.add(key);
      out.push(term);
      if (out.length >= max) return out;
    }
  }

  return out;
}

/* ------------------------------------------------------------------ lecture scope */

/** The page's lecture-note record as the hosts pass it (`usePageLecture` / the lecture screen). */
export interface PageLectureInput {
  week?: number | null;
  lecture?: number | null;
  mapId?: string | null;
  key?: string | null;
  date?: string | null;
}

/** What grounds the map: this page, its lecture, and the concept map of that lecture. */
export interface MapLectureContext {
  pageId: string;
  mapId: string | null;
  week: number | null;
  lecture: { number: number | null; key: string | null; date: string | null } | null;
}

const intOrNull = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : null);
const textOrNull = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * The lecture scope for a page: the lecture note's own map wins, then a map linked to the page (newest
 * first, as given). No lecture record and no map → the page alone (the backend reads its notes).
 */
export function lectureContextFor(
  pageId: string,
  lecture: PageLectureInput | null | undefined,
  linkedMapIds: readonly string[] = [],
): MapLectureContext {
  const number = intOrNull(lecture?.lecture);
  const key = textOrNull(lecture?.key) ?? (number !== null ? `L${number}` : null);
  const date = textOrNull(lecture?.date);

  return {
    pageId,
    mapId: textOrNull(lecture?.mapId) ?? linkedMapIds.find((id) => !!id) ?? null,
    week: intOrNull(lecture?.week),
    lecture: number !== null || key || date ? { number, key, date } : null,
  };
}

/* ------------------------------------------------------------------ provenance */

export const IMAGE_SOURCE_TITLE: Record<PageImageOrigin, string> = {
  phone: 'Photo from your phone',
  page: 'Picture on this page',
};

/** The pictures the terms were read from, ahead of what the backend reported (once per picture). */
export function withImageSources(
  provenance: Provenance | null | undefined,
  images: ReadonlyArray<Pick<PageImage, 'origin'>>,
): Provenance {
  const base = provenance ?? { model: null, sources: [] };
  const already = base.sources.filter((source) => source.kind === 'image').length;
  const added: SourceRef[] = images
    .slice(already)
    .map((image) => ({ kind: 'image', title: IMAGE_SOURCE_TITLE[image.origin] }));

  return { model: base.model, sources: [...added, ...base.sources] };
}

/* ------------------------------------------------------------------ the wire */

/**
 * The backend reads `images` on `/concept-maps/reference` itself (BE #634): it pulls the terms off the
 * pictures and grounds them in the page's lecture notes. Keep `promptTerms` off such a body — with both
 * present the server skips the pictures.
 */
export const REFERENCE_READS_IMAGES = true;

/** `images` only where they are read (mock, or a backend that ships them); every other field as given. */
export function referenceWireBody(
  body: ReferenceRequest,
  live: boolean,
  readsImages = REFERENCE_READS_IMAGES,
): ReferenceRequest {
  if (!live || readsImages || !body.images) return body;
  const { images: _images, ...rest } = body;

  return rest;
}
