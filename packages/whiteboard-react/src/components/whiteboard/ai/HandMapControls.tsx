import { Move, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { Canvas } from 'fabric';

import { useWbStrings } from '../../../i18n/context';

import { attachHandConceptMapControl, mapParts, selectedHandMap, selectWholeMap, tidyHandMap } from './handConceptMapControl';

/**
 * The hand-drawn concept map, easy to handle: while any part of one is selected, a small chip under
 * the selection offers «Move whole map» (select every part — drag it as one) and «Tidy» (lay it out
 * again, nothing overlapping). Mounting it also wires the drag handling (handConceptMapControl.ts):
 * drag a node and the rest of it comes along; on release its arrows are redrawn to it.
 */
export function HandMapControls({ canvas }: { canvas: Canvas }) {
  const { t, dir } = useWbStrings();
  const [state, setState] = useState<{ batch: string; whole: boolean; left: number; top: number } | null>(null);
  const [tidying, setTidying] = useState(false);
  const frame = useRef(0);

  useEffect(() => attachHandConceptMapControl(canvas), [canvas]);

  useEffect(() => {
    const measure = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const batch = selectedHandMap(canvas);
        const active = canvas.getActiveObject();

        if (!batch || !active) {
          setState((current) => (current ? null : current));

          return;
        }
        const rect = active.getBoundingRect();
        const vpt = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
        const zoom = vpt[0] || 1;
        const selected = canvas.getActiveObjects();
        const whole = mapParts(canvas, batch).every((part) => selected.includes(part));
        const width = canvas.getWidth();
        const height = canvas.getHeight();
        const centre = (rect.left + rect.width / 2) * zoom + (vpt[4] ?? 0);
        const below = (rect.top + rect.height) * zoom + (vpt[5] ?? 0) + 12;
        const next = {
          batch,
          whole,
          left: Math.max(8, Math.min(width - 8, centre)),
          top: Math.max(8, Math.min(height - 56, below)),
        };

        setState((current) =>
          current && current.batch === next.batch && current.whole === next.whole && Math.abs(current.left - next.left) < 1 && Math.abs(current.top - next.top) < 1
            ? current
            : next,
        );
      });
    };
    const events = ['selection:created', 'selection:updated', 'selection:cleared', 'object:modified', 'object:moving', 'after:render'] as const;

    for (const name of events) canvas.on(name, measure as never);

    return () => {
      cancelAnimationFrame(frame.current);
      for (const name of events) canvas.off(name, measure as never);
    };
  }, [canvas]);

  if (!state) return null;
  const stop = (event: React.PointerEvent) => event.stopPropagation();
  const button =
    'text-ink hover:bg-ink/5 flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-xl px-2.5 text-xs font-semibold disabled:opacity-50';

  return (
    <div
      aria-label={t('map.controls')}
      className='bg-paper border-ink/10 absolute z-[30] flex -translate-x-1/2 items-center gap-0.5 rounded-2xl border p-1 shadow-[0_12px_32px_-10px_rgba(15,23,42,0.35),0_2px_6px_rgba(15,23,42,0.08)]'
      data-testid='wb-hand-map-controls'
      dir={dir}
      role='toolbar'
      style={{ left: state.left, top: state.top, touchAction: 'none' }}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
    >
      {!state.whole && (
        <button className={button} title={t('map.hint')} type='button' onClick={() => selectWholeMap(canvas, state.batch)}>
          <Move aria-hidden className='h-4 w-4' />
          {t('map.moveWhole')}
        </button>
      )}
      <button
        className={button}
        disabled={tidying}
        type='button'
        onClick={() => {
          setTidying(true);
          const zoom = canvas.viewportTransform?.[0] || 1;

          void tidyHandMap(canvas, state.batch, { zoom })
            .catch(() => false)
            .then((done) => {
              if (done) selectWholeMap(canvas, state.batch);
            })
            .finally(() => setTidying(false));
        }}
      >
        <Sparkles aria-hidden className='h-4 w-4' />
        {tidying ? t('map.tidying') : t('map.tidy')}
      </button>
    </div>
  );
}
