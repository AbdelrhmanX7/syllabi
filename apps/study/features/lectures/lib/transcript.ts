import type { TranscriptSegment } from '@/lib/api/types';

/**
 * Index of the segment playing at `timeSec`: the last one that has started. -1 before the first.
 * Gaps between segments keep the previous line active, so the highlight never flickers off mid-sentence.
 */
export function activeSegmentIndex(segments: readonly TranscriptSegment[], timeSec: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;

    if (segments[mid].start <= timeSec) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return found;
}

/** Indices of segments containing every whitespace-separated term of `query` (case-insensitive). */
export function searchSegments(segments: readonly TranscriptSegment[], query: string): number[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (terms.length === 0) return [];

  const hits: number[] = [];

  segments.forEach((segment, index) => {
    const text = segment.text.toLowerCase();

    if (terms.every((term) => text.includes(term))) hits.push(index);
  });

  return hits;
}

/** `m:ss` or `h:mm:ss`. */
export function formatClock(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');

  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
