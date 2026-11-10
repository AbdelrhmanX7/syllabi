import { createWhiteboardId } from '../id';
import {
  normalizeBoardRuled,
  normalizeCanvasWidthPx,
  normalizePageBookmark,
  normalizePaperSpacingMm,
  normalizePdfPlacement,
  normalizeSheetAspect,
} from '../page-geometry';

import type { BackgroundType, WhiteboardDocument, WhiteboardPage } from '../types';
import { WHITEBOARD_SCHEMA_VERSION } from '../types';

/**
 * Schema-migration layer for persisted whiteboards.
 *
 * Every whiteboard that was ever written to disk (IndexedDB) or to the cloud
 * (gzipped raw-data snapshot / version) flows through {@link migrateWhiteboardDocument}
 * on load. The goal is the "never lose content" guarantee: an old board, a
 * partially-written board, or even junk must still resolve to a valid
 * {@link WhiteboardDocument} at the CURRENT {@link WHITEBOARD_SCHEMA_VERSION} —
 * or, in the irrecoverable case, fail loudly with a typed error rather than
 * silently corrupting data.
 *
 * Design:
 * - A registry of ordered version steps is applied in sequence. Each step takes
 *   a loosely-typed record and returns the same shape one schema version higher.
 * - The `null`/`undefined`/`0` ("pre-versioned") entry point normalizes the raw
 *   blob into a v1-shaped record before the numbered steps run.
 * - Forward-safe: a board whose `schemaVersion` is GREATER than the current build
 *   knows about is returned best-effort (lightly repaired, never downgraded) so an
 *   older client opening a newer board degrades gracefully instead of destroying it.
 */

const VALID_BACKGROUND_TYPES: ReadonlySet<BackgroundType> = new Set<BackgroundType>([
  'blank',
  'grid',
  'lined',
  'dotted',
]);

/** Thrown only when input is irrecoverable garbage that cannot be repaired into a document. */
export class WhiteboardMigrationError extends Error {
  readonly fromVersion: number | null;

  constructor(message: string, fromVersion: number | null = null) {
    super(message);
    this.name = 'WhiteboardMigrationError';
    this.fromVersion = fromVersion;
  }
}

export interface MigrateWhiteboardDocumentResult {
  document: WhiteboardDocument;
  /** The schema version the raw input claimed, or `null` when it had none. */
  fromVersion: number | null;
  /** True when migrating/repairing actually altered the input. */
  changed: boolean;
}

/** A loose, partially-validated record used while stepping a document up through versions. */
type LooseRecord = Record<string, unknown>;

/**
 * One migration step. `from` is the schema version this step consumes; it returns
 * a record that is valid at `from + 1`. Steps must be pure and defensive — they may
 * assume the input passed the previous step but must still tolerate missing keys.
 */
interface MigrationStep {
  from: number;
  describe: string;
  run: (input: LooseRecord) => LooseRecord;
}

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Coerce an id-identity value to a non-empty string WITHOUT regenerating it.
 *
 * The board/page `id` is identity (§2.5): a stringifiable id (e.g. a number written
 * by an older format) is coerced with `String()`, never replaced with a fresh UUID —
 * regenerating it would fork the board from its cloud draft/version history and orphan
 * it. Only a genuinely missing/empty/non-stringifiable id (undefined, null, '', or an
 * object/array) returns `undefined` so the caller generates a fresh id.
 */
function asPreservedId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined;
  }

  if (typeof value === 'bigint') {
    return String(value);
  }

  return undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function coerceBackgroundType(value: unknown): BackgroundType {
  return typeof value === 'string' && VALID_BACKGROUND_TYPES.has(value as BackgroundType)
    ? (value as BackgroundType)
    : 'blank';
}

function coerceSchemaVersion(value: unknown): number | null {
  const parsed = asFiniteNumber(value);

  if (parsed === undefined) {
    return null;
  }

  // Treat a fractional/negative version as "no usable version" — pre-versioned data.
  const floored = Math.floor(parsed);

  return floored >= 1 ? floored : null;
}

/**
 * Repair a single persisted page into a valid {@link WhiteboardPage}.
 * Never throws: missing id is generated, missing canvasJSON becomes an empty
 * canvas, missing backgroundType falls back to 'blank'.
 */
export function migrateWhiteboardPage(raw: unknown): WhiteboardPage {
  const source: LooseRecord = isRecord(raw) ? raw : {};
  const rawZoom = asFiniteNumber(source.viewportZoom);

  // Spread the raw page first so unknown keys (e.g. fields written by a newer build)
  // survive the round-trip, then overlay the validated/repaired known fields on top.
  // This matches the existing load path and the forward-safety guarantee.
  const page: WhiteboardPage = {
    ...(source as Partial<WhiteboardPage>),
    id: asPreservedId(source.id) ?? createWhiteboardId(),
    canvasJSON: asString(source.canvasJSON) ?? '',
    thumbnail: asString(source.thumbnail) ?? '',
    backgroundType: coerceBackgroundType(source.backgroundType),
    viewportOffsetX: asFiniteNumber(source.viewportOffsetX) ?? 0,
    viewportOffsetY: asFiniteNumber(source.viewportOffsetY) ?? 0,
  };

  // Drop the optional pdf/zoom keys that came in malformed so they get re-derived
  // below (a spread may have copied a wrong-typed value through).
  delete page.viewportZoom;
  delete page.pdfAssetId;
  delete page.pdfFingerprint;
  delete page.pdfPageIndex;
  delete page.pdfSourcePageNumber;
  delete page.pdfImageUrl;
  delete page.pdfSourceName;
  delete page.pdfRotation;
  delete page.canvasWidthPx;
  delete page.pdfPlacement;
  delete page.sheetAspect;
  delete page.boardRuled;
  delete page.bookmark;
  delete page.paperSpacingMm;

  const pdfAssetId = asString(source.pdfAssetId);
  const pdfFingerprint = asString(source.pdfFingerprint);
  const pdfPageIndex = asFiniteNumber(source.pdfPageIndex);
  const pdfSourcePageNumber = asFiniteNumber(source.pdfSourcePageNumber);
  const pdfImageUrl = asString(source.pdfImageUrl);
  const pdfSourceName = asString(source.pdfSourceName);

  if (pdfAssetId !== undefined) page.pdfAssetId = pdfAssetId;
  if (pdfFingerprint !== undefined) page.pdfFingerprint = pdfFingerprint;
  if (pdfPageIndex !== undefined) page.pdfPageIndex = pdfPageIndex;
  if (pdfSourcePageNumber !== undefined) page.pdfSourcePageNumber = pdfSourcePageNumber;
  if (pdfImageUrl !== undefined) page.pdfImageUrl = pdfImageUrl;
  if (pdfSourceName !== undefined) page.pdfSourceName = pdfSourceName;

  // Background rotation: normalize into [0, 360) and drop a plain 0 so untouched pages stay
  // byte-identical to what older builds wrote (absent = unrotated).
  const pdfRotation = asFiniteNumber(source.pdfRotation);

  if (pdfRotation !== undefined) {
    const normalized = ((pdfRotation % 360) + 360) % 360;

    if (normalized !== 0) page.pdfRotation = normalized;
  }

  // Capture geometry for the server-side ink renderer: keep it only when it is a real measurement
  // (finite, positive) — a repaired 0 would outrank the backend's heuristics. A placement is only
  // meaningful on a page that has a PDF/image background to place.
  const canvasWidthPx = normalizeCanvasWidthPx(source.canvasWidthPx);
  const pdfPlacement = page.pdfAssetId || page.pdfImageUrl ? normalizePdfPlacement(source.pdfPlacement) : undefined;

  if (canvasWidthPx !== undefined) page.canvasWidthPx = canvasWidthPx;
  if (pdfPlacement !== undefined) page.pdfPlacement = pdfPlacement;

  // An inserted sheet's size. Only a page WITHOUT a background can be one.
  const sheetAspect = page.pdfAssetId || page.pdfImageUrl ? undefined : normalizeSheetAspect(source.sheetAspect);

  if (sheetAspect !== undefined) page.sheetAspect = sheetAspect;

  const boardRuled = normalizeBoardRuled(source.boardRuled, sheetAspect);

  if (boardRuled) page.boardRuled = boardRuled;

  const bookmark = normalizePageBookmark(source.bookmark);

  if (bookmark) page.bookmark = bookmark;

  const paperSpacingMm = normalizePaperSpacingMm(source.paperSpacingMm);

  if (paperSpacingMm !== undefined) page.paperSpacingMm = paperSpacingMm;

  // Keep a page's saved zoom (clamped), but leave it undefined when never zoomed so
  // PDF pages still open fit-and-centered on first view.
  if (rawZoom !== undefined) {
    page.viewportZoom = clamp(rawZoom, 0.25, 4);
  }

  return page;
}

function coercePages(value: unknown): WhiteboardPage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((page) => migrateWhiteboardPage(page));
}

/**
 * Pre-versioned normalize step (v0/undefined -> v1).
 *
 * Brings any historical / partial blob into the v1 page+document shape. This is
 * the only step allowed to assume nothing about its input beyond "it is a record".
 */
function normalizeToV1(input: LooseRecord): LooseRecord {
  return {
    ...input,
    pages: coercePages(input.pages),
    schemaVersion: 1,
  };
}

/**
 * v1 -> v2 step.
 *
 * v2 is the current shape in this codebase; the page/document fields are identical
 * to v1, so this step is structurally a no-op beyond stamping the version. It exists
 * to anchor the registry and prove the ordered-step pipeline, and is the template
 * for the next real transform.
 */
function migrateV1ToV2(input: LooseRecord): LooseRecord {
  return {
    ...input,
    schemaVersion: 2,
  };
}

/**
 * Ordered registry of version steps. To add the next format change, append a step
 * with `from: WHITEBOARD_SCHEMA_VERSION` (the version being left) and bump
 * `WHITEBOARD_SCHEMA_VERSION` in types.ts. Steps run in `from` order.
 */
const MIGRATION_STEPS: readonly MigrationStep[] = [{ from: 1, describe: 'v1 -> v2', run: migrateV1ToV2 }];

/**
 * Final shaping pass: take a record that has been stepped up to the current version
 * and produce a fully-valid {@link WhiteboardDocument}. Always repairs rather than
 * rejects (missing pages -> a single blank page, clamped index, defaulted timestamps).
 */
function finalizeDocument(input: LooseRecord, schemaVersion: number): WhiteboardDocument {
  const pages = coercePages(input.pages);
  const normalizedPages = pages.length > 0 ? pages : [createBlankPage()];
  const maxPageIndex = normalizedPages.length - 1;
  const currentPageIndex = clamp(Math.floor(asFiniteNumber(input.currentPageIndex) ?? 0), 0, maxPageIndex);
  const createdAt = asFiniteNumber(input.createdAt) ?? Date.now();
  const updatedAt = asFiniteNumber(input.updatedAt) ?? createdAt;
  const rawTitle = asString(input.title)?.trim();

  // Spread the input first so unknown top-level keys (e.g. fields written by a newer
  // build) survive — the existing load path keeps them via `{ ...doc }`, and dropping
  // them here would silently destroy data on the next resave. Validated known fields
  // overlay on top.
  const document: WhiteboardDocument = {
    ...(input as Partial<WhiteboardDocument>),
    id: asPreservedId(input.id) ?? createWhiteboardId(),
    title: rawTitle && rawTitle.length > 0 ? rawTitle : 'New board',
    pages: normalizedPages,
    currentPageIndex,
    createdAt,
    updatedAt,
    thumbnail: asString(input.thumbnail) ?? '',
    viewportZoom: clamp(asFiniteNumber(input.viewportZoom) ?? 1, 0.25, 4),
    schemaVersion,
  };

  const sharedBackgroundImageUrl = asString(input.sharedBackgroundImageUrl);
  const sharedBackgroundImageOpacity = asFiniteNumber(input.sharedBackgroundImageOpacity);

  if (sharedBackgroundImageUrl !== undefined) {
    document.sharedBackgroundImageUrl = sharedBackgroundImageUrl;
  } else {
    // A spread may have copied through a malformed (non-string) value; drop it.
    delete document.sharedBackgroundImageUrl;
  }

  // Opacity is only meaningful alongside a shared background; clamp to the editor's range.
  if (sharedBackgroundImageOpacity !== undefined) {
    document.sharedBackgroundImageOpacity = clamp(sharedBackgroundImageOpacity, 0.05, 1);
  } else if (sharedBackgroundImageUrl !== undefined) {
    document.sharedBackgroundImageOpacity = 1;
  } else {
    delete document.sharedBackgroundImageOpacity;
  }

  return document;
}

function createBlankPage(): WhiteboardPage {
  return {
    id: createWhiteboardId(),
    canvasJSON: '',
    thumbnail: '',
    backgroundType: 'blank',
    viewportOffsetX: 0,
    viewportOffsetY: 0,
  };
}

/**
 * Compare two documents structurally to decide whether migration actually changed
 * anything. We compare the serialized form because every field is JSON-safe and the
 * documents are small; this keeps `changed` honest without a hand-written deep-equal.
 * Generated ids make a freshly-built document never equal to its (id-less) source, so
 * the only way `changed` is false is when the input was already a valid current-version
 * document.
 */
function isStructurallyEqual(a: WhiteboardDocument, b: unknown): boolean {
  if (!isRecord(b)) {
    return false;
  }

  try {
    // Canonicalize BOTH sides (recursively key-sorted) so the comparison is insensitive
    // to key order. Unknown/newer-build fields are preserved by the migration now, so a
    // doc that only differs by such fields must still register as unchanged.
    return canonicalStringify(a) === canonicalStringify(b);
  } catch {
    return false;
  }
}

/**
 * Deterministic `JSON.stringify` with recursively sorted object keys, so two values that
 * are deep-equal but differ only in key order serialize identically. Arrays keep order.
 */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  if (isRecord(value)) {
    const sorted: LooseRecord = {};

    for (const key of Object.keys(value).sort()) {
      // Drop explicit `undefined` so it matches a side where the key is absent
      // (JSON.stringify omits undefined-valued keys anyway).
      if (value[key] !== undefined) {
        sorted[key] = sortKeysDeep(value[key]);
      }
    }

    return sorted;
  }

  return value;
}

/**
 * Migrate / repair any persisted whiteboard payload to the current schema version.
 *
 * @param raw Anything that was persisted: the current shape, an older shape, a
 *   partial/missing-field object, or junk.
 * @returns The upgraded document, the version the input claimed (`fromVersion`,
 *   `null` if it had none), and whether migration changed anything.
 * @throws {WhiteboardMigrationError} only when `raw` is irrecoverable (not an object
 *   at all, e.g. a number/string/null) — never for repairable partial documents.
 */
export function migrateWhiteboardDocument(raw: unknown): MigrateWhiteboardDocumentResult {
  if (!isRecord(raw)) {
    throw new WhiteboardMigrationError(
      `Cannot migrate whiteboard document from a non-object value (${describeType(raw)}).`,
    );
  }

  const fromVersion = coerceSchemaVersion(raw.schemaVersion);

  // Forward-safe: a board from a newer build. Do NOT run our steps (they don't exist
  // for that version and would strip unknown fields meaningfully). Repair only enough
  // to make it openable here, preserve everything else, and report changed=false so the
  // caller does not resave a downgraded copy over the cloud original.
  if (fromVersion !== null && fromVersion > WHITEBOARD_SCHEMA_VERSION) {
    const document = finalizeDocument(raw, fromVersion);

    return { document, fromVersion, changed: false };
  }

  // Pre-versioned blob -> v1 baseline, then run each ordered step up to current.
  let working: LooseRecord = normalizeToV1(raw);

  for (const step of MIGRATION_STEPS) {
    if (step.from >= (asFiniteNumber(working.schemaVersion) ?? 1)) {
      working = step.run(working);
    }
  }

  const document = finalizeDocument(working, WHITEBOARD_SCHEMA_VERSION);
  const changed = !(fromVersion === WHITEBOARD_SCHEMA_VERSION && isStructurallyEqual(document, raw));

  return { document, fromVersion, changed };
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  return typeof value;
}
