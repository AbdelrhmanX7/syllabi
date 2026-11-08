import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * In-app colour picker (replaces the browser's native <input type=color> dialog, which looks
 * different on every WebView): a saturation/value square, a hue bar and a hex field.
 * Pointer events only (pen, touch, mouse), transforms for the thumbs.
 */

interface Hsv {
  h: number; // 0–360
  s: number; // 0–1
  v: number; // 0–1
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function hexToHsv(hex: string): Hsv {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const int = m ? parseInt(m[1], 16) : 0;
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;

  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;

    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };

  return `#${[f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function useDrag(onMove: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const handle = useCallback(
    (e: React.PointerEvent) => {
      const rect = ref.current?.getBoundingClientRect();

      if (!rect) return;
      onMove(clamp01((e.clientX - rect.left) / rect.width), clamp01((e.clientY - rect.top) / rect.height));
    },
    [onMove],
  );

  return {
    ref,
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      handle(e);
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) handle(e);
    },
  };
}

export function HsvPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [hexDraft, setHexDraft] = useState(value);
  const last = useRef(value);

  // Follow outside changes (a swatch tap) without losing the hue of a grey we set ourselves.
  useEffect(() => {
    if (value.toLowerCase() !== last.current.toLowerCase()) {
      setHsv(hexToHsv(value));
      last.current = value;
    }
    setHexDraft(value);
  }, [value]);

  const commit = useCallback(
    (next: Hsv) => {
      setHsv(next);
      const hex = hsvToHex(next);

      last.current = hex;
      onChange(hex);
    },
    [onChange],
  );

  const sv = useDrag(useCallback((x, y) => commit({ ...hsv, s: x, v: 1 - y }), [commit, hsv]));
  const hue = useDrag(useCallback((x) => commit({ ...hsv, h: x * 360 }), [commit, hsv]));
  const current = hsvToHex(hsv);

  return (
    <div className='flex flex-col gap-3'>
      <div
        {...sv}
        className='border-ink relative h-32 w-full cursor-crosshair touch-none overflow-hidden rounded-[10px] border-[1.5px]'
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
        }}
      >
        <span
          className='pointer-events-none absolute left-0 top-0 h-4 w-4 rounded-full border-2 border-white'
          style={{
            backgroundColor: current,
            boxShadow: '0 0 0 1.5px #18204a',
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            transform: 'translate(-50%, -50%)',
          }}
        />
      </div>
      <div
        {...hue}
        className='border-ink relative h-4 w-full cursor-pointer touch-none rounded-full border-[1.5px]'
        style={{ background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
      >
        <span
          className='pointer-events-none absolute top-1/2 h-5 w-5 rounded-full border-2 border-white'
          style={{
            left: `${(hsv.h / 360) * 100}%`,
            transform: 'translate(-50%, -50%)',
            backgroundColor: `hsl(${hsv.h} 100% 50%)`,
            boxShadow: '0 0 0 1.5px #18204a',
          }}
        />
      </div>
      <label className='border-ink bg-paper flex h-9 items-center gap-2 rounded-full border-[1.5px] pe-3 ps-1.5'>
        <span aria-hidden='true' className='border-ink h-6 w-6 shrink-0 rounded-full border' style={{ backgroundColor: current }} />
        <span className='text-ink/55 text-xs font-semibold'>HEX</span>
        <input
          aria-label='Hex colour'
          className='text-ink min-w-0 flex-1 bg-transparent font-mono text-sm font-semibold uppercase outline-none'
          maxLength={7}
          spellCheck={false}
          value={hexDraft}
          onChange={(e) => {
            const raw = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;

            setHexDraft(raw);
            if (/^#[0-9a-f]{6}$/i.test(raw)) commit(hexToHsv(raw));
          }}
        />
      </label>
    </div>
  );
}
