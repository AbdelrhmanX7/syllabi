import type { WhiteboardPage } from '@repo/whiteboard-core';
import type { Canvas, FabricObject } from 'fabric';

import { useEffect, useMemo, useRef, useState } from 'react';

import { isRevealed, pageAtTime, pageStrokeTimes, revealedCount, seekTargetMs, sortedTimes } from '../lib/timeline';

interface InkPlayerProps {
  pages: WhiteboardPage[];
  /** Audio position. `null` = no audio: everything is shown. */
  currentMs: number | null;
  /** Follow the page being written on as playback moves. */
  follow: boolean;
  onSeekMs: (ms: number) => void;
}

const DIM_OPACITY = 0.12;

/**
 * Read-only replay of the lecture notebook: ink written after the playhead is dimmed, and tapping a
 * stroke seeks the audio to just before it was written.
 */
export function InkPlayer({ pages, currentMs, follow, onSeekMs }: InkPlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<Canvas | null>(null);
  const timesRef = useRef(new WeakMap<FabricObject, number | null>());
  const baseOpacityRef = useRef(new WeakMap<FabricObject, number>());
  const lastRevealRef = useRef<number>(-1);
  const seekRef = useRef(onSeekMs);
  const [ready, setReady] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [width, setWidth] = useState(0);

  seekRef.current = onSeekMs;

  const pageTimes = useMemo(() => pages.map((page) => pageStrokeTimes(page.canvasJSON)), [pages]);
  const pageSorted = useMemo(() => pageTimes.map(sortedTimes), [pageTimes]);

  useEffect(() => {
    if (follow && currentMs !== null && pages.length > 1) setPageIndex(pageAtTime(pageSorted, currentMs));
  }, [follow, currentMs, pageSorted, pages.length]);

  useEffect(() => {
    const host = hostRef.current;

    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));

    observer.observe(host);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let canvas: Canvas | null = null;

    void import('fabric').then(({ Canvas: FabricCanvas }) => {
      if (disposed || !canvasElRef.current) return;
      canvas = new FabricCanvas(canvasElRef.current, { selection: false, renderOnAddRemove: false });
      canvas.on('mouse:down', (event) => {
        const target = event.target as FabricObject | undefined;
        const t = target ? timesRef.current.get(target) : null;

        if (typeof t === 'number') seekRef.current(seekTargetMs(t));
      });
      canvasRef.current = canvas;
      setReady(true);
    });

    return () => {
      disposed = true;
      canvasRef.current = null;
      void canvas?.dispose();
    };
  }, []);

  const page = pages[Math.min(pageIndex, pages.length - 1)];

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!ready || !canvas || !page || width === 0) return;
    let cancelled = false;
    const times = pageTimes[pages.indexOf(page)] ?? [];

    void (async () => {
      if (page.canvasJSON) await canvas.loadFromJSON(page.canvasJSON);
      else canvas.clear();
      if (cancelled) return;
      const objects = canvas.getObjects();
      let contentWidth = page.canvasWidthPx ?? 0;
      let contentBottom = 0;

      objects.forEach((object, index) => {
        object.set({ selectable: false, evented: true, hoverCursor: 'pointer' });
        timesRef.current.set(object, times[index] ?? null);
        baseOpacityRef.current.set(object, object.opacity ?? 1);
        const box = object.getBoundingRect();

        if (!page.canvasWidthPx) contentWidth = Math.max(contentWidth, box.left + box.width);
        contentBottom = Math.max(contentBottom, box.top + box.height);
      });
      const zoom = contentWidth > 0 ? width / contentWidth : 1;

      canvas.setDimensions({ width, height: Math.max(Math.ceil((contentBottom + 48) * zoom), 480) });
      canvas.setZoom(zoom);
      lastRevealRef.current = -1;
      applyReveal();
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, page, width]);

  const applyReveal = () => {
    const canvas = canvasRef.current;

    if (!canvas || !page) return;
    const sorted = pageSorted[pages.indexOf(page)] ?? [];
    const now = currentMs ?? Number.POSITIVE_INFINITY;
    const count = revealedCount(sorted, now);

    if (count === lastRevealRef.current) return;
    lastRevealRef.current = count;
    for (const object of canvas.getObjects()) {
      const base = baseOpacityRef.current.get(object) ?? 1;

      object.set('opacity', isRevealed(timesRef.current.get(object) ?? null, now) ? base : base * DIM_OPACITY);
    }
    canvas.requestRenderAll();
  };

  useEffect(applyReveal);

  return (
    <div className='flex h-full min-h-0 flex-col'>
      {pages.length > 1 && (
        <div className='flex items-center gap-1 overflow-x-auto border-b border-st-line px-3 py-2'>
          {pages.map((p, index) => (
            <button
              key={p.id}
              className={`h-9 min-w-9 rounded-md px-3 text-sm tabular-nums ${
                index === pageIndex
                  ? 'bg-st-accent text-st-accent-fg'
                  : 'text-st-muted hover:bg-st-raised'
              }`}
              type='button'
              onClick={() => setPageIndex(index)}
            >
              {index + 1}
            </button>
          ))}
        </div>
      )}
      <div ref={hostRef} className='min-h-0 flex-1 overflow-y-auto bg-st-surface'>
        <canvas ref={canvasElRef} />
      </div>
    </div>
  );
}
