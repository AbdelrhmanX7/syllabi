import { QuestionInputError } from "./questions";

/**
 * The owner's personal marks on a question (flashcards): a bookmark and a handwritten note. They are
 * the owner's own, like progress: editors of a shared deck can't set them and shared copies never
 * carry them.
 *
 * A note is pen strokes in the pad's CSS px (`w` × `h` is the pad it was written on, so another
 * screen can scale it). Each stroke is `{c, w, pts}`: a colour token, a base width, and a flat
 * `[x, y, pressure, x, y, pressure, …]` list (1 decimal; pressure 2 decimals). Every list / review
 * row carries it, so it is capped hard.
 */

export const NOTE_COLORS = ["ink", "blue", "red", "green"] as const;
export const NOTE_MAX_BYTES = 64 * 1024;
export const NOTE_MAX_STROKES = 400;
const MAX_SIDE = 4000;

export interface QuestionNoteStroke {
  c: (typeof NOTE_COLORS)[number];
  w: number;
  pts: number[];
}

export interface QuestionNote {
  w: number;
  h: number;
  strokes: QuestionNoteStroke[];
}

const num = (v: unknown, min: number, max: number, what: string) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new QuestionInputError(`note: ${what} must be a number ${min}–${max}`);
  return v;
};

/** `null` / an empty note clears it; anything malformed or too big is a 400. */
export function parseQuestionNote(raw: unknown): QuestionNote | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new QuestionInputError("note must be an object or null");
  const r = raw as Record<string, unknown>;
  const w = Math.round(num(r.w, 1, MAX_SIDE, "w"));
  const h = Math.round(num(r.h, 1, MAX_SIDE * 4, "h"));
  if (!Array.isArray(r.strokes)) throw new QuestionInputError("note: strokes must be a list");
  if (r.strokes.length > NOTE_MAX_STROKES) throw new QuestionInputError(`note: at most ${NOTE_MAX_STROKES} strokes`);
  const strokes: QuestionNoteStroke[] = [];
  for (const s of r.strokes) {
    if (!s || typeof s !== "object") throw new QuestionInputError("note: each stroke must be an object");
    const stroke = s as Record<string, unknown>;
    if (!(NOTE_COLORS as readonly unknown[]).includes(stroke.c)) throw new QuestionInputError(`note: colour must be one of ${NOTE_COLORS.join(", ")}`);
    const width = num(stroke.w, 0.5, 20, "stroke width");
    if (!Array.isArray(stroke.pts) || stroke.pts.length % 3 !== 0) throw new QuestionInputError("note: pts must be [x, y, pressure, …]");
    const pts = stroke.pts.map((v, i) => {
      const n = num(v, i % 3 === 2 ? 0 : -50, i % 3 === 2 ? 1 : i % 3 === 0 ? MAX_SIDE : MAX_SIDE * 4, "a point");
      return i % 3 === 2 ? Math.round(n * 100) / 100 : Math.round(n * 10) / 10;
    });
    if (pts.length) strokes.push({ c: stroke.c as QuestionNoteStroke["c"], w: Math.round(width * 10) / 10, pts });
  }
  if (!strokes.length) return null;
  const note = { w, h, strokes };
  if (Buffer.byteLength(JSON.stringify(note)) > NOTE_MAX_BYTES) throw new QuestionInputError("note is too big — clear some of it and try again");
  return note;
}

/** The personal fields in a PATCH body, validated; absent keys stay absent. */
export function personalPatch(body: Record<string, unknown>): { bookmarked?: boolean; note?: QuestionNote | null } {
  const out: { bookmarked?: boolean; note?: QuestionNote | null } = {};
  if (body.bookmarked !== undefined) {
    if (typeof body.bookmarked !== "boolean") throw new QuestionInputError("bookmarked must be true or false");
    out.bookmarked = body.bookmarked;
  }
  if (body.note !== undefined) out.note = parseQuestionNote(body.note);
  return out;
}
