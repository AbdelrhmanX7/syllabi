import type { GlyphSample } from '@repo/whiteboard-react';

import { cn } from '@repo/ui';

import { renderGlyphLine } from '../lib/render';

/**
 * Bank samples on one line, right to left, in the current text colour. Until compose lands this is
 * single glyphs side by side — a test of the ink itself, not of the joins.
 */
export function GlyphPreview({
  samples,
  xHeightPx = 28,
  className,
}: {
  samples: readonly GlyphSample[];
  xHeightPx?: number;
  className?: string;
}) {
  const line = renderGlyphLine(samples, { xHeightPx });

  return (
    <svg
      aria-hidden
      className={cn('text-st-fg block max-w-full', className)}
      data-glyph-preview={samples.length}
      height={line.height}
      viewBox={`0 0 ${line.width} ${line.height}`}
      width={line.width}
    >
      <line
        stroke='currentColor'
        strokeOpacity={0.18}
        strokeWidth={1}
        x1={0}
        x2={line.width}
        y1={line.baselineY + 0.5}
        y2={line.baselineY + 0.5}
      />
      {line.glyphs.map((glyph, index) => (
        <g key={index}>
          {glyph.paths.map((d, strokeIndex) => (
            <path
              key={strokeIndex}
              d={d}
              fill='none'
              stroke='currentColor'
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth={line.strokeWidth}
            />
          ))}
        </g>
      ))}
    </svg>
  );
}
