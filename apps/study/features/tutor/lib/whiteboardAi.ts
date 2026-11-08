import type {
  BoardAiAnalyzeRequest,
  BoardAiAskRequest,
  BoardAiBlock,
  BoardAiClassification,
  BoardAiClassifyContext,
  BoardAiRegionKind,
  BoardAiSuggestedAction,
  BoardAiGenerateRequest,
  BoardAiImageLabel,
  BoardAiImageRequest,
  BoardAiStreamEvent,
  ConceptMapAnalyzeRequest,
  ConceptMapGenerateRequest,
  RemakeImageResult,
  RemakePartialPicture,
  RemakePartialQuestions,
  RemakeOverlayBlock,
  RemakePageRequest,
} from '@repo/whiteboard-react';

import { readSseFrames } from './whiteboardSse';

import { AI_QUOTA_CODE, AI_QUOTA_MESSAGE, SERVER_RESTARTING_CODE, SERVER_RESTARTING_MESSAGE } from '@/lib/api/errors';

/**
 * Study's transport for the backend's `/whiteboard/ai/*` endpoints — a port of
 * apps/whiteboard/lib/board-ai/teacher.ts (BE #554 contract, bridge thread m_mut5tocj5704b8), minus
 * the guest fallback: these routes accept the Study full-admin JWT as-is (no teacher header), so
 * every call is `Authorization: Bearer <study token>` against the Study backend base URL, in English
 * (BE #577): `lang: 'en'` on every body (JSON field / multipart field) AND `?lang=en` on every URL —
 * the query is all the auth / quota / upload-size checks see, since they answer before multer parses
 * a multipart body. Every server-written status, transcript and error then comes back in English.
 *
 *   POST /whiteboard/ai/ask       multipart {image (png|jpeg|webp ≤4 MB, REQUIRED), action, prompt?,
 *                                 subject?, grade?, boardId?, pageIndex?, lang}
 *                                 → SSE status* · transcript (once) · text… · done{usageId, content, transcript}
 *   POST /whiteboard/ai/generate  JSON {prompt, kind, subject?, grade?, lang}
 *                                 → SSE status* · text (ONE markdown preview) · result{blocks} · done
 *   POST /whiteboard/ai/analyze-page, /concept-map/analyze (multipart image), /concept-map/generate
 *   (JSON), /classify (multipart image → JSON {kind, confidence}), /image (JSON → SSE result {url}),
 *   /remake-page (multipart, image edit).
 *   Before the stream: 429 {code:'WB_AI_QUOTA', retryAfterSec} (+Retry-After), 413
 *   WB_AI_IMAGE_TOO_LARGE, 400 WB_AI_BAD_IMAGE / WB_AI_BAD_KIND.
 */

export const FALLBACK = {
  network: 'No internet connection — the board AI needs one.',
  rateLimited: 'Too many requests in a short time — wait a moment and try again.',
  server: 'The board AI hit a problem. Try again.',
  tooLarge: 'That picture is too large.',
  signedOut: 'Sign in to use the board AI.',
  sessionExpired: 'Session expired — sign in again',
  missing: 'This board tool is not available on the server yet.',
} as const;

/**
 * An `error` frame's text. A string is shown as is; a deploy's `{code:'SERVER_RESTARTING', message}`
 * object reads «Server restarted — try again» (the board's Retry reruns it).
 */
export function boardErrorText(data: unknown): string {
  if (typeof data === 'string' && data) return data;
  if (data && typeof data === 'object' && (data as { code?: unknown }).code === SERVER_RESTARTING_CODE) {
    return SERVER_RESTARTING_MESSAGE;
  }

  return FALLBACK.server;
}

export class BoardAiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BoardAiHttpError';
  }
}

export interface WhiteboardAiAccess {
  /** The Study backend origin (no `/study`, no trailing slash). */
  baseUrl: string;
  headers: Record<string, string>;
}

export interface WhiteboardAiOptions {
  /** Null when there is no valid session — every call then fails with {@link FALLBACK.signedOut}. */
  resolveAccess: () => WhiteboardAiAccess | null;
  fetchImpl?: typeof fetch;
  /** Shrinks an image that the server refused as too large (413). Absent = no retry. */
  downscale?: (image: Blob) => Promise<Blob | null>;
  boardContext?: () => { boardId?: string; pageIndex?: number };
}

const LANG = 'en';

/** Statuses that mean «no such route / not allowed for this session», not a failed answer. */
const UNAVAILABLE = new Set([401, 403, 404, 405, 501]);

/** The board's learned style → the /concept-map/generate `style` {direction, shape, palette}. */
export function conceptStyleWire(
  style: ConceptMapGenerateRequest['style'],
): { direction?: string; shape?: string; palette?: string[] } | undefined {
  if (!style) return undefined;

  const direction = { tb: 'TB', ltr: 'LR', rtl: 'RL', radial: 'radial' }[style.direction];
  const wire = {
    ...(direction ? { direction } : {}),
    ...(style.shape && style.shape !== 'diamond' ? { shape: style.shape } : {}),
    ...(style.nodeColors?.length ? { palette: style.nodeColors } : {}),
  };

  return Object.keys(wire).length ? wire : undefined;
}

/** /classify takes ≤ 2 MB. */
const CLASSIFY_MAX_BYTES = 1.9 * 1024 * 1024;

const REGION_KINDS: BoardAiRegionKind[] = [
  'question',
  'answer_to_check',
  'concept_map',
  'diagram',
  'handwriting_text',
  'table',
  'figure',
  'other',
];
const SUGGESTED_ACTIONS: BoardAiSuggestedAction[] = [
  'solve',
  'explain',
  'check_answer',
  'concept_map_analyze',
  'concept_map_fix',
  'none',
];

/** The /classify body → a classification, or null when it is not one. Unknown kinds become «other». */
export function parseClassification(value: unknown): BoardAiClassification | null {
  if (!value || typeof value !== 'object') return null;

  const body = value as Record<string, unknown>;

  if (typeof body.kind !== 'string') return null;

  const kind = (REGION_KINDS as string[]).includes(body.kind) ? (body.kind as BoardAiRegionKind) : 'other';
  const confidence = Math.max(0, Math.min(1, Number(body.confidence) || 0));
  const result: BoardAiClassification = { kind, confidence };

  if (typeof body.subject === 'string' && body.subject.trim()) result.subject = body.subject.trim();
  if (typeof body.hasHandwriting === 'boolean') result.hasHandwriting = body.hasHandwriting;
  if (typeof body.suggestedAction === 'string' && (SUGGESTED_ACTIONS as string[]).includes(body.suggestedAction)) {
    result.suggestedAction = body.suggestedAction as BoardAiSuggestedAction;
  }

  return result;
}

/** /ask and /analyze-page reject pictures over 4 MB (413). Leave headroom for the multipart body. */
const MAX_IMAGE_BYTES = 3.9 * 1024 * 1024;

export function quotaMessage(retryAfterSec: number | null): string {
  if (!retryAfterSec || retryAfterSec <= 0) return 'You have hit the AI request limit — try again in a little while.';

  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));

  return minutes >= 60
    ? `You have hit today’s AI request limit — try again in ${Math.ceil(minutes / 60)} h.`
    : `You have hit the AI request limit — try again in ${minutes} min.`;
}

/** The /remake-page `result` frame → what the panel shows. Null when it carries no picture. */
type QuestionTypeName = 'written' | 'mcq' | 'true_false' | 'fill_blank';

const TYPE_ALIASES: Record<string, QuestionTypeName> = {
  written: 'written',
  essay: 'written',
  free: 'written',
  open: 'written',
  short: 'written',
  mcq: 'mcq',
  multiple_choice: 'mcq',
  choice: 'mcq',
  choices: 'mcq',
  true_false: 'true_false',
  truefalse: 'true_false',
  tf: 'true_false',
  boolean: 'true_false',
  fill_blank: 'fill_blank',
  fill: 'fill_blank',
  blank: 'fill_blank',
  cloze: 'fill_blank',
};
const TYPE_LABELS: Record<QuestionTypeName, string> = {
  written: 'written',
  mcq: 'multiple choice',
  true_false: 'true/false',
  fill_blank: 'fill in the blank',
};

export const questionTypeOf = (value: unknown): QuestionTypeName | undefined =>
  typeof value === 'string'
    ? TYPE_ALIASES[
        value
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_')
      ]
    : undefined;

/** A `type_changed` mismatch (owner rule: a remade question keeps its original's type). */
function typeChangedLine(where: string, record: Record<string, unknown>): string | null {
  const nested = (record.typeChanged ?? record.type_changed) as Record<string, unknown> | undefined;
  const isTypeChange =
    record.kind === 'type_changed' ||
    record.type === 'type_changed' ||
    record.issue === 'type_changed' ||
    Boolean(nested && typeof nested === 'object');

  if (!isTypeChange) return null;

  const source = nested && typeof nested === 'object' ? nested : record;
  const expected = questionTypeOf(source.expectedType ?? source.from ?? source.expected);
  const got = questionTypeOf(source.gotType ?? source.to ?? source.got);
  const expectedChoices = Number(source.expectedChoices);
  const gotChoices = Number(source.gotChoices);

  if (expected === 'written' && (got === 'mcq' || got === 'true_false'))
    return `${where}got answer choices but the original is a written question`;
  if (expected && got && expected === got && Number.isFinite(expectedChoices) && Number.isFinite(gotChoices)) {
    return `${where}has ${gotChoices} choices; the original has ${expectedChoices}`;
  }
  if (expected && got) return `${where}type changed from “${TYPE_LABELS[expected]}” to “${TYPE_LABELS[got]}”`;

  return `${where}the question type changed from the original`;
}

const words = (value: unknown) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);
const quoted = (list: string[]) => list.map((word) => `“${word}”`).join(', ');

/**
 * One verification mismatch → a line the teacher can act on (strings pass through). An item can
 * report several problems at once; each becomes its own clause. `n = 0` is about the whole page
 * (leftover marks, nothing verifiable) and reads «Page: …».
 */
export function mismatchLine(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value ?? '');

  const record = value as {
    n?: unknown;
    expected?: unknown;
    got?: unknown;
    missingWords?: unknown;
    missingMath?: unknown;
    misspelled?: unknown;
    unexpected?: unknown;
  };
  const n = record.n === undefined || record.n === null ? null : String(record.n);
  const pageLevel = n === '0';
  const where = pageLevel ? 'Page: ' : n ? `Q${n}: ` : '';
  const expected = typeof record.expected === 'string' ? record.expected.trim() : '';
  const got = typeof record.got === 'string' ? record.got.trim() : '';
  const typeChange = typeChangedLine(where, record as Record<string, unknown>);

  if (typeChange) return typeChange;

  // Overlay-mode checks (BE #564): geometry, not glyph OCR.
  const kind = (record as Record<string, unknown>).kind;

  if (kind === 'layout_missing') return `${where}this question was left as it was`;
  if (kind === 'erase_leftover') return `${where}leftovers of the old text were not erased — check it`;
  if (kind === 'erase_edge')
    return `${where}the erase touched something next to the question (a frame or drawing) — check it`;

  const misspelled = Array.isArray(record.misspelled)
    ? record.misspelled
        .filter((item): item is { seen?: unknown; intended?: unknown } => Boolean(item) && typeof item === 'object')
        .map((item) => `“${String(item.seen ?? '')}” should be “${String(item.intended ?? '')}”`)
    : [];
  const clauses = [
    ...misspelled,
    ...(words(record.missingWords).length ? [`missing: ${quoted(words(record.missingWords))}`] : []),
    ...(words(record.missingMath).length ? [`missing number/formula: ${quoted(words(record.missingMath))}`] : []),
    ...(words(record.unexpected).length
      ? [
          pageLevel
            ? `still shows ${words(record.unexpected).join(', ')}`
            : `extra: ${quoted(words(record.unexpected))}`,
        ]
      : []),
  ];

  if (clauses.length) return `${where}${clauses.join(' — ')}`;
  if (expected && got && expected !== got) return `${where}expected “${expected}” but got “${got}”`;
  if (pageLevel) return `Page: ${got || expected || 'could not be verified — check it yourself'}`;

  return `${where}${expected || got || 'check this line'}`;
}

/** `newQuestions` of a /remake-page frame → ours (empty-text questions dropped). */
export function parseNewQuestions(value: unknown): RemakeImageResult['newQuestions'] {
  return (Array.isArray(value) ? value : [])
    .filter((q): q is Record<string, unknown> => Boolean(q) && typeof q === 'object')
    .map((q, index) => {
      const choices = Array.isArray(q.choices) ? q.choices.map(String).filter(Boolean) : [];

      const type = questionTypeOf(q.type);

      return {
        n: String(q.n ?? index + 1),
        text: String(q.text ?? ''),
        ...(choices.length ? { choices } : {}),
        ...(type ? { type } : {}),
        ...(q.answer !== undefined && q.answer !== null && String(q.answer) ? { answer: String(q.answer) } : {}),
      };
    })
    .filter((q) => q.text);
}

/**
 * The optional early `questions` frame ({newQuestions, layout}) → ours; null when it carries neither.
 */
export function parseRemakeQuestionsFrame(data: Record<string, unknown>): RemakePartialQuestions | null {
  const newQuestions = parseNewQuestions(data.newQuestions);
  const layout = parseOverlayLayout(data.layout);

  if (!newQuestions.length && !layout) return null;

  return { newQuestions, ...(layout ? { layout } : {}) };
}

/** The optional early `image` frame ({imageUrl | base64, width, height}) → ours; null without a picture. */
export function parseRemakeImageFrame(data: Record<string, unknown>): RemakePartialPicture | null {
  const url = typeof data.imageUrl === 'string' && data.imageUrl ? data.imageUrl : null;
  const base64 = typeof data.base64 === 'string' && data.base64 ? data.base64 : null;
  const src = url ?? (base64 ? (base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`) : null);

  return src ? { src, width: Number(data.width) || 0, height: Number(data.height) || 0 } : null;
}

/**
 * The final `result` frame over what the early frames already said: a result that leaves out the
 * picture or the questions (because they were streamed before it) still parses whole.
 */
export function mergeRemakeFrames(
  result: Record<string, unknown>,
  early: { questions?: Record<string, unknown> | null; image?: Record<string, unknown> | null },
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...result };
  const has = (key: string) => merged[key] !== undefined && merged[key] !== null && merged[key] !== '';

  if (early.image && !has('imageUrl') && !has('base64') && merged.noChanges !== true) {
    for (const key of ['imageUrl', 'base64', 'width', 'height'])
      if (!has(key) && early.image[key] !== undefined) merged[key] = early.image[key];
  }

  if (early.questions) {
    for (const key of ['newQuestions', 'layout'])
      if (!has(key) && early.questions[key] !== undefined) merged[key] = early.questions[key];
  }

  return merged;
}

/**
 * The /remake-page `result` frame (BE #557) → what the panel shows. `{imageUrl:null, noChanges:true}`
 * is a real answer (fix_errors found nothing). Null only when there is neither a picture nor that.
 */
export function parseRemakeImage(data: Record<string, unknown>): RemakeImageResult | null {
  const url = typeof data.imageUrl === 'string' && data.imageUrl ? data.imageUrl : null;
  const base64 = typeof data.base64 === 'string' && data.base64 ? data.base64 : null;
  const src = url ?? (base64 ? (base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`) : null);
  const noChanges = data.noChanges === true;

  if (!src && !noChanges) return null;

  const verification = (data.verification ?? {}) as { ok?: unknown; mismatches?: unknown };

  return {
    src,
    width: Number(data.width) || 0,
    height: Number(data.height) || 0,
    newQuestions: parseNewQuestions(data.newQuestions),
    verification: {
      // Absent verification is not a pass the teacher should trust blindly — but it is not a failure either.
      ok: verification.ok !== false,
      mismatches: Array.isArray(verification.mismatches)
        ? verification.mismatches.map(mismatchLine).filter(Boolean)
        : [],
    },
    ...(noChanges ? { noChanges: true } : {}),
    ...(typeof data.attempts === 'number' ? { attempts: data.attempts } : {}),
    ...(typeof data.model === 'string' ? { model: data.model } : {}),
    ...((layout) => (layout ? { layout } : {}))(parseOverlayLayout(data.layout)),
    ...(data.textMode === 'overlay' || data.textMode === 'baked' ? { textMode: data.textMode } : {}),
    ...(typeof data.eraseMethod === 'string' ? { eraseMethod: data.eraseMethod } : {}),
    ...(data.timings && typeof data.timings === 'object'
      ? {
          timings: Object.fromEntries(
            Object.entries(data.timings as Record<string, unknown>).filter(
              (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
            ),
          ),
        }
      : {}),
  };
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** `[x, y, w, h]` or `{x, y, w, h}`, 0..1 → a box; null when unusable (no area / not numbers). */
export function parseNormalizedBox(value: unknown): { x: number; y: number; w: number; h: number } | null {
  const raw = Array.isArray(value)
    ? value.map(Number)
    : value && typeof value === 'object'
      ? ['x', 'y', 'w', 'h'].map((key) => Number((value as Record<string, unknown>)[key]))
      : null;

  if (!raw || raw.length < 4 || raw.some((n) => !Number.isFinite(n))) return null;

  const [x, y, w, h] = raw as [number, number, number, number];
  const box = { x: clamp01(x), y: clamp01(y), w: clamp01(w), h: clamp01(h) };

  box.w = Math.min(box.w, 1 - box.x);
  box.h = Math.min(box.h, 1 - box.y);

  return box.w > 0.002 && box.h > 0.002 ? box : null;
}

/** `[x, y]` or `{x, y}`, 0..1 → a point; null when unusable. */
export function parseNormalizedPoint(value: unknown): { x: number; y: number } | null {
  const raw = Array.isArray(value)
    ? value.map(Number)
    : value && typeof value === 'object'
      ? [Number((value as Record<string, unknown>).x), Number((value as Record<string, unknown>).y)]
      : null;

  if (!raw || raw.length < 2 || !Number.isFinite(raw[0]) || !Number.isFinite(raw[1])) return null;

  return { x: clamp01(raw[0]!), y: clamp01(raw[1]!) };
}

const OVERLAY_KINDS = new Set<RemakeOverlayBlock['kind']>([
  'question',
  'choice',
  'instruction',
  'header_text',
  'answer_line',
]);
const OVERLAY_WEIGHTS = new Set(['regular', 'medium', 'semibold', 'bold']);
const OVERLAY_ALIGNS = new Set(['right', 'center', 'left']);

/**
 * The overlay remake's `layout` → blocks the board writes. Blocks without a usable bbox are dropped;
 * an unknown kind reads as `question`; style fields are kept only when valid. Empty → undefined, so the
 * result falls back to the picture as it is.
 */
export function parseOverlayLayout(
  value: unknown,
): { blocks: RemakeOverlayBlock[]; width?: number; height?: number } | undefined {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const source = record ? record.blocks : null;

  if (!Array.isArray(source)) return undefined;

  const blocks: RemakeOverlayBlock[] = [];

  for (const item of source) {
    if (!item || typeof item !== 'object') continue;

    const raw = item as Record<string, unknown>;
    const bbox = parseNormalizedBox(raw.bbox);

    if (!bbox) continue;

    const kind = OVERLAY_KINDS.has(raw.kind as RemakeOverlayBlock['kind'])
      ? (raw.kind as RemakeOverlayBlock['kind'])
      : 'question';
    const style = raw.style && typeof raw.style === 'object' ? (raw.style as Record<string, unknown>) : {};
    const fontSizeRel = Number(style.fontSizeRel);
    const choices = Array.isArray(raw.choices)
      ? raw.choices
          .filter((choice): choice is Record<string, unknown> => Boolean(choice) && typeof choice === 'object')
          .map((choice) => ({ label: String(choice.label ?? ''), text: String(choice.text ?? '') }))
          .filter((choice) => choice.text.trim() || choice.label.trim())
      : [];
    const number = typeof raw.number === 'string' && raw.number.trim() ? raw.number.trim() : null;
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : null;
    const block: RemakeOverlayBlock = {
      kind,
      bbox,
      text: typeof raw.text === 'string' ? raw.text : '',
      ...(number ? { number } : {}),
      ...(label ? { label } : {}),
      style: {
        ...(Number.isFinite(fontSizeRel) && fontSizeRel > 0 && fontSizeRel < 0.5 ? { fontSizeRel } : {}),
        ...(OVERLAY_WEIGHTS.has(String(style.weight)) ? { weight: style.weight as 'regular' } : {}),
        ...(OVERLAY_ALIGNS.has(String(style.align)) ? { align: style.align as 'right' } : {}),
        ...(typeof style.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(style.color) ? { color: style.color } : {}),
      },
      ...(raw.n !== undefined && raw.n !== null && String(raw.n).trim() ? { n: String(raw.n).trim() } : {}),
      ...(choices.length ? { choices } : {}),
      ...(raw.choiceLayout === 'inline' || raw.choiceLayout === 'stacked' ? { choiceLayout: raw.choiceLayout } : {}),
    };

    if (block.text.trim() || block.choices?.length || block.kind === 'answer_line') blocks.push(block);
  }

  if (!blocks.length) return undefined;

  const width = Number(record?.width);
  const height = Number(record?.height);

  return { blocks, ...(width > 0 && height > 0 ? { width, height } : {}) };
}

/** /image `labels[]` → board labels; entries without text or an anchor are dropped. */
export function parseImageLabels(value: unknown): BoardAiImageLabel[] {
  if (!Array.isArray(value)) return [];

  const labels: BoardAiImageLabel[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;

    const raw = item as Record<string, unknown>;
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    const anchor = parseNormalizedPoint(raw.anchor);

    if (!text || !anchor) continue;

    const target = parseNormalizedPoint(raw.target);
    const sizeRel = Number(raw.sizeRel);

    labels.push({
      text,
      anchor,
      ...(target ? { target } : {}),
      ...(Number.isFinite(sizeRel) && sizeRel > 0 && sizeRel < 0.3 ? { sizeRel } : {}),
    });
  }

  return labels;
}

/** Our mode / quality names → the #557 contract's. */
export const REMAKE_MODE_WIRE = {
  similar: 'similar_new',
  edit_question: 'edit_question',
  fix_errors: 'fix_errors',
} as const;
export const REMAKE_QUALITY_WIRE = { normal: 'medium', high: 'high' } as const;

const IMAGE_NAME: Record<string, string> = { 'image/jpeg': 'board.jpg', 'image/webp': 'board.webp' };

export function createWhiteboardAi({ resolveAccess, fetchImpl, downscale, boardContext }: WhiteboardAiOptions) {
  const doFetch: typeof fetch = (input, init) => (fetchImpl ?? fetch)(input, init);

  const post = async (
    path: string,
    body: FormData | object,
    signal: AbortSignal,
    accept: string,
  ): Promise<Response> => {
    const access = resolveAccess();

    if (!access) throw new BoardAiHttpError(401, FALLBACK.signedOut);

    const url = `${access.baseUrl.replace(/\/+$/, '').replace(/\/study$/, '')}/whiteboard/ai${path}?lang=${LANG}`;
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;

    // English answers everywhere in Study: the body field too (the query alone would do; both are read).
    if (isForm) {
      (body as FormData).set('lang', LANG);
    } else {
      body = { ...(body as object), lang: LANG };
    }
    let response: Response;

    try {
      response = await doFetch(url, {
        method: 'POST',
        // Multipart: the browser writes Content-Type (with the boundary) itself.
        headers: { ...access.headers, Accept: accept, ...(isForm ? {} : { 'Content-Type': 'application/json' }) },
        body: isForm ? (body as FormData) : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new BoardAiHttpError(0, FALLBACK.network);
    }

    if (UNAVAILABLE.has(response.status)) {
      throw new BoardAiHttpError(
        response.status,
        response.status === 401
          ? FALLBACK.sessionExpired
          : response.status === 403
            ? FALLBACK.signedOut
            : FALLBACK.missing,
      );
    }

    if (!response.ok) {
      let parsed: { message?: unknown; code?: unknown; retryAfterSec?: unknown } = {};

      try {
        parsed = (await response.json()) as typeof parsed;
      } catch {
        /* not JSON */
      }

      // A deploy's drain answered 503 before any byte was sent.
      if (parsed.code === SERVER_RESTARTING_CODE) {
        throw new BoardAiHttpError(response.status, SERVER_RESTARTING_MESSAGE, SERVER_RESTARTING_CODE);
      }
      // The AI provider is out of balance — a persistent notice, not something to retry.
      if (response.status === 402 || parsed.code === AI_QUOTA_CODE) {
        throw new BoardAiHttpError(response.status, AI_QUOTA_MESSAGE, AI_QUOTA_CODE);
      }

      if (response.status === 429) {
        const retryAfter = Number(parsed.retryAfterSec ?? response.headers.get('Retry-After'));

        throw new BoardAiHttpError(429, quotaMessage(Number.isFinite(retryAfter) ? retryAfter : null));
      }

      throw new BoardAiHttpError(
        response.status,
        typeof parsed.message === 'string' && parsed.message.trim()
          ? parsed.message.trim()
          : FALLBACK.server,
        typeof parsed.code === 'string' ? parsed.code : undefined,
      );
    }

    return response;
  };

  /** Multipart with the picture; one retry on 413 with a downscaled copy. */
  const postImage = async (
    path: string,
    image: Blob,
    fields: Record<string, string | number | undefined>,
    signal: AbortSignal,
    accept: string,
    maxBytes = MAX_IMAGE_BYTES,
  ) => {
    const build = (picture: Blob) => {
      const form = new FormData();

      form.append('image', picture, IMAGE_NAME[picture.type] ?? 'board.png');

      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined && value !== '') form.append(key, String(value));
      }

      return form;
    };

    // The server takes ≤ 4 MB; a whole-page PNG can exceed it — shrink BEFORE paying for the upload.
    if (image.size > maxBytes && downscale) image = (await downscale(image)) ?? image;

    try {
      return await post(path, build(image), signal, accept);
    } catch (error) {
      if (!(error instanceof BoardAiHttpError) || error.status !== 413 || !downscale) throw error;

      const smaller = await downscale(image);

      if (!smaller) throw error;

      return post(path, build(smaller), signal, accept);
    }
  };

  async function* stream(
    response: Response,
    signal: AbortSignal,
    resultKind: 'blocks' | 'analysis' | 'concept' | 'conceptGenerate' | 'layout' | 'image' | 'imageBlock',
  ): AsyncGenerator<BoardAiStreamEvent> {
    if (!response.body) throw new BoardAiHttpError(response.status, FALLBACK.server);

    // /remake-page may stream `questions` and `image` before `result` (both optional, either order).
    const early: { questions: Record<string, unknown> | null; image: Record<string, unknown> | null } = {
      questions: null,
      image: null,
    };
    let resultSeen = false;

    for await (const frame of readSseFrames(response.body, signal)) {
      switch (frame.type) {
        case 'questions': {
          if (resultKind !== 'image' || !frame.data || typeof frame.data !== 'object') break;

          const data = frame.data as Record<string, unknown>;
          const questions = parseRemakeQuestionsFrame(data);

          if (questions) {
            early.questions = data;
            yield { type: 'remake_questions', data: questions };
          }

          break;
        }
        case 'image': {
          if (resultKind === 'imageBlock' && frame.data && typeof frame.data === 'object') {
            // /image (#564): the picture as soon as it exists; the labels come in `result`.
            const data = frame.data as Record<string, unknown>;
            const url = typeof data.url === 'string' && data.url ? data.url : null;

            if (url)
              yield {
                type: 'remake_picture',
                data: { src: url, width: Number(data.width) || 0, height: Number(data.height) || 0 },
              };

            break;
          }

          if (resultKind !== 'image' || !frame.data || typeof frame.data !== 'object') break;

          const data = frame.data as Record<string, unknown>;
          const picture = parseRemakeImageFrame(data);

          if (picture) {
            early.image = data;
            yield { type: 'remake_picture', data: picture };
          }

          break;
        }
        case 'status':
          if (typeof frame.data === 'string') yield { type: 'status', data: frame.data };
          break;
        case 'transcript':
          if (typeof frame.data === 'string' && frame.data.trim()) yield { type: 'transcript', data: frame.data };
          break;
        case 'thinking':
          yield { type: 'thinking' };
          break;
        case 'text':
          if (typeof frame.data === 'string') yield { type: 'text', data: frame.data };
          break;
        case 'result': {
          const data = (frame.data ?? {}) as Record<string, unknown>;

          if (resultKind === 'imageBlock') {
            const url = typeof data.url === 'string' && data.url ? data.url : null;

            if (url) {
              const labels = parseImageLabels(data.labels);

              yield {
                type: 'result',
                data: { blocks: [{ type: 'image', src: url, ...(labels.length ? { labels } : {}) }] },
              };
              break;
            }

            yield { type: 'error', data: 'The picture did not arrive — try again.' };

            return;
          }

          if (resultKind === 'image') {
            resultSeen = true;

            const result = parseRemakeImage(mergeRemakeFrames(data, early));

            if (result) yield { type: 'remake_image', data: result };
            else yield { type: 'error', data: 'The new page did not arrive — try again.' };

            return;
          } else if (resultKind === 'layout') {
            yield { type: 'layout', data };
          } else if (resultKind === 'blocks' && Array.isArray(data.blocks)) {
            yield { type: 'result', data: { blocks: data.blocks as BoardAiBlock[] } };
          } else if (resultKind === 'analysis') {
            yield { type: 'analysis', data: data as never };
          } else if (resultKind === 'concept' || resultKind === 'conceptGenerate') {
            // {graph, fixes} goes through as-is — the editor normalises it (direction enum, fixes →
            // suggestions). A generated map's node boxes are a ready layout, so it is flagged.
            yield {
              type: 'concept_map',
              data: (resultKind === 'conceptGenerate' ? { ...data, serverLayout: true } : data) as never,
            };
          }

          break;
        }
        case 'analysis':
          yield { type: 'analysis', data: frame.data as never };
          break;
        case 'done':
          // The picture came early and the stream ended without a `result`: that picture is the answer.
          if (resultKind === 'image' && !resultSeen && early.image) {
            const result = parseRemakeImage(mergeRemakeFrames({}, early));

            if (result) yield { type: 'remake_image', data: result };
          }

          yield { type: 'done' };

          return;
        case 'error':
          yield {
            type: 'error',
            data: boardErrorText(frame.data),
          };

          return;
        default:
          break;
      }
    }
  }

  const context = () => boardContext?.() ?? {};

  return {
    ask: async function* (request: BoardAiAskRequest, signal: AbortSignal) {
      const response = await postImage(
        '/ask',
        request.image,
        {
          action: request.action === 'concept_map' ? 'custom' : request.action,
          prompt: request.prompt,
          subject: request.subject,
          grade: request.grade,
          boardId: context().boardId,
          pageIndex: context().pageIndex,
        },
        signal,
        'text/event-stream',
      );

      yield* stream(response, signal, 'blocks');
    },
    generate: async function* (request: BoardAiGenerateRequest, signal: AbortSignal) {
      // v1 takes page TEXT as context, not a picture — `contextImage` is dropped on this route.
      const response = await post(
        '/generate',
        { prompt: request.prompt, kind: request.kind, subject: request.subject, grade: request.grade },
        signal,
        'text/event-stream',
      );

      yield* stream(response, signal, 'blocks');
    },
    analyzePage: async function* (request: BoardAiAnalyzeRequest, signal: AbortSignal) {
      const response = await postImage(
        '/analyze-page',
        request.image,
        { subject: request.subject, grade: request.grade, ...context() },
        signal,
        'text/event-stream',
      );

      yield* stream(response, signal, 'analysis');
    },
    analyzeConceptMap: async function* (request: ConceptMapAnalyzeRequest, signal: AbortSignal) {
      const response = await postImage(
        '/concept-map/analyze',
        request.image,
        { subject: request.subject, grade: request.grade, ...context() },
        signal,
        'text/event-stream',
      );

      yield* stream(response, signal, 'concept');
    },
    generateConceptMap: async function* (request: ConceptMapGenerateRequest, signal: AbortSignal) {
      const response = await post(
        '/concept-map/generate',
        {
          topic: request.topic,
          style: conceptStyleWire(request.style),
          subject: request.subject,
          grade: request.grade,
        },
        signal,
        'text/event-stream',
      );

      yield* stream(response, signal, 'conceptGenerate');
    },
    /**
     * POST /whiteboard/ai/classify — multipart {image ≤ 2 MB, context?: lasso|selection|page} → plain
     * JSON {kind, confidence, subject?, hasHandwriting, suggestedAction, usageId}.
     */
    classify: async (
      image: Blob,
      signal: AbortSignal,
      context?: BoardAiClassifyContext,
    ): Promise<BoardAiClassification | null> => {
      const response = await postImage('/classify', image, { context }, signal, 'application/json', CLASSIFY_MAX_BYTES);

      return parseClassification(await response.json());
    },
    /**
     * POST /whiteboard/ai/image (#561) — JSON {prompt ≤ 1000, style?, size?, quality?, subject?,
     * grade?} → SSE status* · result {url, width, height, model} · done | error (a safety refusal is
     * an error frame — English under `lang=en`). The picture carries no text by design.
     */
    generateImage: async function* (
      request: BoardAiImageRequest,
      signal: AbortSignal,
    ): AsyncGenerator<BoardAiStreamEvent> {
      const response = await post(
        '/image',
        {
          prompt: request.prompt.slice(0, 1000),
          style: request.style,
          size: request.size,
          quality: request.quality,
          subject: request.subject,
          grade: request.grade,
          // The picture stays text-free; label positions come back for the board to write.
          labels: request.labels ?? (request.style === 'diagram' || request.style === 'map' ? true : undefined),
        },
        signal,
        'text/event-stream',
      );

      const wantsLabels = request.labels ?? (request.style === 'diagram' || request.style === 'map');

      for await (const event of stream(response, signal, 'imageBlock')) {
        if (event.type === 'remake_picture') {
          // The picture alone, shown at once; the labels step (~10–15 s) is still running.
          yield { type: 'result', data: { blocks: [{ type: 'image', src: event.data.src, alt: request.prompt }] } };

          if (wantsLabels) yield { type: 'status', data: 'Writing the labels…' };

          continue;
        }

        yield event.type === 'result' && event.data.blocks[0]?.type === 'image'
          ? { type: 'result', data: { blocks: [{ ...event.data.blocks[0], alt: request.prompt }] } }
          : event;
      }
    },
    /**
     * Does `path` exist? An empty POST: the route answers 400 (validation) when it is there and 404
     * when it is not — no model call, no quota.
     */
    /** The editable (layout) remake has no server route — /remake-page is the image-edit one. */
    remakePage: async function* (
      _request: RemakePageRequest,
      _signal: AbortSignal,
    ): AsyncGenerator<BoardAiStreamEvent> {
      throw new BoardAiHttpError(501, 'The editable copy is not available here — use «same look» remake.');
    },
    /**
     * POST /whiteboard/ai/remake-page (requested on m_mut5tocj5704b8) — multipart {image (full-res
     * PNG), mode: similar|edit_question|fix_errors, target?, instruction?, subject?, grade?, quality?:
     * normal|high, boardId?} → SSE status* · result {imageUrl | base64, width, height,
     * newQuestions: [{n, text, answer?}], verification: {ok, mismatches[]}} · done. 30–90 s.
     */
    remakePageImage: async function* (
      request: RemakePageRequest,
      signal: AbortSignal,
    ): AsyncGenerator<BoardAiStreamEvent> {
      const response = await postImage(
        '/remake-page',
        request.image,
        {
          mode: REMAKE_MODE_WIRE[request.mode],
          target: request.target,
          instruction: request.instruction,
          subject: request.subject,
          grade: request.grade,
          quality: REMAKE_QUALITY_WIRE[request.quality ?? 'normal'],
          // Text is written by the board (its own font + KaTeX) unless the caller asks for `baked`.
          textMode: request.textMode ?? 'overlay',
          ...context(),
        },
        signal,
        'text/event-stream',
      );

      yield* stream(response, signal, 'image');
    },
    /** Does `path` exist? An empty POST answers 400 (validation) when it does, 404 when not — no model call. */
    probe: async (path: '/classify' | '/image' | '/remake-page'): Promise<boolean> => {
      try {
        await post(path, {}, new AbortController().signal, 'application/json');

        return true;
      } catch (error) {
        return error instanceof BoardAiHttpError && error.status === 400;
      }
    },
  };
}

export type WhiteboardAi = ReturnType<typeof createWhiteboardAi>;
