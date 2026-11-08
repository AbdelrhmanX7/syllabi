import type { TranscriptSegment } from '@/lib/api/types';
import type { PlaybackClock } from '../lib/playbackClock';

import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { centeredScrollTop, followReducer, initialFollow, mayAutoScroll, PEN_SETTLE_MS } from '../lib/follow';
import { usePlaybackValue } from '../lib/playbackClock';
import { activeSegmentIndex, formatClock, searchSegments } from '../lib/transcript';

interface TranscriptPanelProps {
  segments: TranscriptSegment[];
  /** The playing second — or `clock`, which re-renders only this panel, and only when the cue changes. */
  currentSec?: number;
  clock?: PlaybackClock | null;
  onSeek: (sec: number) => void;
}

export function TranscriptPanel({ segments, currentSec = 0, clock, onSeek }: TranscriptPanelProps) {
  const [query, setQuery] = useState('');
  const [follow, dispatch] = useReducer(followReducer, initialFollow);
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(follow);
  const selectActive = useCallback((sec: number) => activeSegmentIndex(segments, sec), [segments]);
  const active = usePlaybackValue(clock, selectActive, currentSec);
  const hits = useMemo(() => searchSegments(segments, query), [segments, query]);
  const searching = query.trim().length > 0;
  const indices = useMemo(() => (searching ? hits : segments.map((_, index) => index)), [searching, hits, segments]);

  followRef.current = follow;

  // Scroll the LIST to the playing cue — never `scrollIntoView`, which also scrolls every ancestor (the
  // page, and with it the notes board under the pen).
  const scrollToActive = useCallback(() => {
    const list = listRef.current;

    // Hidden (a narrow screen's other tab): nothing to measure; the resize observer catches up on show.
    if (!list || !list.clientHeight || searching || active < 0 || !mayAutoScroll(followRef.current, Date.now())) return;
    const row = list.querySelector<HTMLElement>(`[data-seg="${active}"]`);

    if (!row) return;
    const top = centeredScrollTop(
      row.offsetTop,
      row.offsetHeight,
      list.clientHeight,
      list.scrollHeight,
      list.scrollTop,
    );

    if (top !== null) list.scrollTo({ top, behavior: 'smooth' });
  }, [active, searching]);
  const scrollRef = useRef(scrollToActive);

  scrollRef.current = scrollToActive;
  useEffect(scrollToActive, [scrollToActive, follow.mode]);

  // Shown again (tab switch, divider drag, rotation): bring the playing cue back into view.
  useEffect(() => {
    const list = listRef.current;

    if (!list) return;
    let height = list.clientHeight;
    const observer = new ResizeObserver(() => {
      if (list.clientHeight === height) return;
      height = list.clientHeight;
      scrollRef.current();
    });

    observer.observe(list);

    return () => observer.disconnect();
  }, [segments.length]);

  // A pen down anywhere holds the list still; once it has been up a moment, catch up.
  useEffect(() => {
    let timer: number | undefined;
    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== 'pen') return;
      window.clearTimeout(timer);
      dispatch({ type: 'pen-down' });
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerType !== 'pen') return;
      dispatch({ type: 'pen-up', now: Date.now() });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => scrollRef.current(), PEN_SETTLE_MS + 50);
    };

    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    };
  }, []);

  // The student's own hand on the list (touch, wheel, scrollbar, keys) pauses follow-along.
  const pause = useCallback(() => dispatch({ type: 'user-scroll' }), []);
  const seek = useCallback(
    (sec: number) => {
      dispatch({ type: 'seek' });
      onSeek(sec);
    },
    [onSeek],
  );

  if (segments.length === 0) {
    return <p className='p-4 text-sm text-st-muted'>No transcript yet.</p>;
  }

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='flex items-center gap-2 border-b border-st-line p-3'>
        <input
          aria-label='Search transcript'
          className='h-10 w-full rounded-st border-2 border-st-control-edge bg-st-surface px-3 text-sm outline-none focus:border-st-accent'
          placeholder='Search transcript'
          type='search'
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {searching && (
          <span className='shrink-0 text-xs tabular-nums text-st-muted'>
            {hits.length} {hits.length === 1 ? 'match' : 'matches'}
          </span>
        )}
      </div>
      <div className='relative flex min-h-0 flex-1 flex-col'>
        {/* Listens only to notice the student's own hand on the list; the rows are the controls. */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div
          ref={listRef}
          className='relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-2'
          onKeyDown={pause}
          onPointerDown={pause}
          onTouchStart={pause}
          onWheel={pause}
        >
          {indices.map((index) => (
            <TranscriptRow
              key={index}
              active={index === active}
              index={index}
              segment={segments[index]}
              onSeek={seek}
            />
          ))}
          {searching && hits.length === 0 && <p className='p-3 text-sm text-st-muted'>Nothing matches “{query}”.</p>}
        </div>
        {/* Over the list, not in the flow: showing it never shifts a line. */}
        {follow.mode === 'paused' && !searching && (
          <button
            className='absolute bottom-3 left-1/2 h-9 -translate-x-1/2 rounded-md border-2 border-st-accent-lip bg-st-accent px-4 text-sm font-medium text-st-accent-fg hover:bg-st-accent/90 shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
            type='button'
            onClick={() => dispatch({ type: 'resume' })}
          >
            Follow
          </button>
        )}
      </div>
    </div>
  );
}

interface TranscriptRowProps {
  index: number;
  segment: TranscriptSegment;
  active: boolean;
  onSeek: (sec: number) => void;
}

// Memo: a cue change re-renders two rows, not the whole list. `content-visibility` skips layout and
// paint of rows off screen, so a long lecture's list costs about what the visible rows do.
const TranscriptRow = memo(function TranscriptRow({ index, segment, active, onSeek }: TranscriptRowProps) {
  return (
    <button
      className={`flex w-full gap-3 rounded-md px-3 py-2 text-left text-base leading-relaxed transition-colors [contain-intrinsic-size:auto_64px] [content-visibility:auto] ${
        active
          ? 'bg-st-warn/10 text-st-fg'
          : 'text-st-fg hover:bg-st-raised'
      }`}
      data-active={active}
      data-seg={index}
      type='button'
      onClick={() => onSeek(segment.start)}
    >
      <span
        className={`w-12 shrink-0 pt-0.5 text-xs tabular-nums ${active ? 'text-st-warn' : 'text-st-muted'}`}
      >
        {formatClock(segment.start)}
      </span>
      <span>{segment.text}</span>
    </button>
  );
});

export function SummaryCard({ summary, keyPoints }: { summary: string | null; keyPoints: string[] }) {
  if (!summary && keyPoints.length === 0) {
    return <p className='p-4 text-sm text-st-muted'>No summary yet.</p>;
  }

  return (
    <div className='space-y-4 p-4 text-base leading-relaxed text-st-fg'>
      {summary && <p className='whitespace-pre-line'>{summary}</p>}
      {keyPoints.length > 0 && (
        <div>
          <h3 className='mb-2 text-xs font-semibold uppercase tracking-wide text-st-muted'>Key points</h3>
          <ul className='list-disc space-y-1.5 pl-5'>
            {keyPoints.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
