// A transcript source chip seeks the player that is already open on that video / lecture (the Ask
// sheet sits on top of VideoStudy and LecturePlayback); with no such player on screen the chip
// navigates instead. A synchronous window event: the player marks the request handled.
import { useEffect, useRef } from 'react';

const SEEK_EVENT = 'study:tutor-seek';

interface SeekDetail {
  /** Item id (a Canvas video) or lecture id — a transcript source's `id`. */
  id: string;
  t: number;
  handled: boolean;
}

/** True when an open player took it (and seeked). */
export function requestSeek(id: string, t: number): boolean {
  if (typeof window === 'undefined') return false;
  const detail: SeekDetail = { id, t: Math.max(0, t), handled: false };

  window.dispatchEvent(new CustomEvent<SeekDetail>(SEEK_EVENT, { detail }));

  return detail.handled;
}

/** A player answers seek requests for `id` (seconds). */
export function useSeekTarget(id: string | null | undefined, seek: (sec: number) => void): void {
  const seekRef = useRef(seek);

  seekRef.current = seek;

  useEffect(() => {
    if (!id) return;
    const onSeek = (event: Event) => {
      const detail = (event as CustomEvent<SeekDetail>).detail;

      if (!detail || detail.id !== id || detail.handled) return;
      detail.handled = true;
      seekRef.current(detail.t);
    };

    window.addEventListener(SEEK_EVENT, onSeek);

    return () => window.removeEventListener(SEEK_EVENT, onSeek);
  }, [id]);
}
