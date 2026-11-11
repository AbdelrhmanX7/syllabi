// A card's handwritten note: pad strokes ⇄ the compact shape the server stores (QuestionNote).
import type { InkStroke } from '@/features/bank/lib/ink';
import type { QuestionNote } from '@/lib/api/types';

/** Same cap as the server; past it the save is refused, so the pad says so first. */
export const NOTE_MAX_BYTES = 64 * 1024;
const COLORS = ['ink', 'blue', 'red', 'green'] as const;

type NoteColor = QuestionNote['strokes'][number]['c'];

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const colorOf = (token: string): NoteColor => ((COLORS as readonly string[]).includes(token) ? (token as NoteColor) : 'ink');

/** Pad strokes (CSS px on a `w` × `h` pad) → the stored note; null when nothing is drawn. */
export function encodeNote(strokes: InkStroke[], w: number, h: number): QuestionNote | null {
  const out: QuestionNote['strokes'] = [];

  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    const pts: number[] = [];

    for (const point of stroke.points) pts.push(round1(point.x), round1(point.y), round2(Math.min(1, Math.max(0, point.p))));
    out.push({ c: colorOf(stroke.color), w: round1(stroke.width), pts });
  }

  return out.length ? { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), strokes: out } : null;
}

/**
 * The stored note → pad strokes for a pad `width` px wide. A note written on a wider pad shrinks to
 * fit; a narrower one keeps its size.
 */
export function decodeNote(note: QuestionNote | null | undefined, width = note?.w ?? 1): InkStroke[] {
  if (!note) return [];
  const scale = Math.min(1, width / Math.max(1, note.w));
  const strokes: InkStroke[] = [];

  for (const stroke of note.strokes) {
    const points = [];

    for (let i = 0; i + 2 < stroke.pts.length; i += 3) {
      points.push({ x: stroke.pts[i]! * scale, y: stroke.pts[i + 1]! * scale, p: stroke.pts[i + 2]! });
    }
    if (points.length) strokes.push({ points, color: stroke.c, width: stroke.w * scale });
  }

  return strokes;
}

export const noteBytes = (note: QuestionNote | null) => (note ? new Blob([JSON.stringify(note)]).size : 0);

export const noteTooBig = (note: QuestionNote | null) => noteBytes(note) > NOTE_MAX_BYTES;

/** Same strokes (a closed pad with no change saves nothing). */
export const sameNote = (a: QuestionNote | null | undefined, b: QuestionNote | null | undefined) =>
  JSON.stringify(a?.strokes ?? null) === JSON.stringify(b?.strokes ?? null);
