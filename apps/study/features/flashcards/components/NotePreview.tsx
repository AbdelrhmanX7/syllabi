import type { QuestionNote } from '@/lib/api/types';

import { useEffect, useMemo, useRef, useState } from 'react';

import { decodeNote } from '../lib/note';

import { isDarkMode, resolveColor } from '@/features/bank/components/InkCanvas';
import { drawStroke, inkBounds } from '@/features/bank/lib/ink';

/**
 * A card's handwritten note, read-only: cropped to the ink top-to-bottom, shrunk to the box width
 * (never enlarged), in the page's ink colours (light ink on a dark page).
 */
export function NotePreview({ note, className }: { note: QuestionNote; className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const strokes = useMemo(() => decodeNote(note), [note]);
  const bounds = useMemo(() => inkBounds(strokes, 6), [strokes]);
  const scale = width && bounds ? Math.min(1, width / Math.max(note.w, bounds.x + bounds.w)) : 1;
  const top = bounds ? Math.max(0, bounds.y) : 0;
  const height = bounds ? Math.ceil((bounds.y + bounds.h - top) * scale) : 0;

  useEffect(() => {
    const wrap = wrapRef.current;

    if (!wrap) return;
    const observer = new ResizeObserver(() => setWidth(wrap.clientWidth));

    observer.observe(wrap);
    setWidth(wrap.clientWidth);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');

    if (!canvas || !ctx || !width || !height) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const dark = isDarkMode();

      for (const stroke of strokes) {
        drawStroke(ctx, { ...stroke, color: resolveColor(stroke.color, dark) }, 0, (x, y) => [x * scale, (y - top) * scale], scale);
      }
    };

    draw();
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const classWatch = new MutationObserver(draw);

    media?.addEventListener?.('change', draw);
    classWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      media?.removeEventListener?.('change', draw);
      classWatch.disconnect();
    };
  }, [height, scale, strokes, top, width]);

  return (
    <div ref={wrapRef} className={className}>
      <canvas ref={canvasRef} aria-label='Your handwritten note' className='block' role='img' style={{ width, height }} />
    </div>
  );
}
