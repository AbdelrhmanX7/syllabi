import type { InkCanvasHandle } from '@/features/bank';
import type { InkStroke } from '@/features/bank/lib/ink';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { InkCanvas } from '@/features/bank';

/**
 * Right side of the workspace: the same pen canvas Practice draws on, filling the pane. The ink is
 * kept on this device per map (or per in-class draft) so a reload in the middle of class loses nothing.
 */
const INK_PREFIX = 'study_cm_ink:';
const SAVE_DEBOUNCE_MS = 800;

function readInk(key: string): InkStroke[] | undefined {
  try {
    const raw = window.localStorage.getItem(INK_PREFIX + key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;

    return Array.isArray(parsed) ? (parsed as InkStroke[]) : undefined;
  } catch {
    return undefined;
  }
}

function writeInk(key: string, strokes: InkStroke[]): void {
  try {
    if (strokes.length === 0) window.localStorage.removeItem(INK_PREFIX + key);
    else window.localStorage.setItem(INK_PREFIX + key, JSON.stringify(strokes));
  } catch {
    // quota: the ink stays on screen, only a reload would lose it
  }
}

/** Moves a draft's saved ink onto the real map id once the in-class map exists. */
export function moveInk(fromKey: string, toKey: string): void {
  const strokes = readInk(fromKey);

  if (strokes) {
    writeInk(toKey, strokes);
    writeInk(fromKey, []);
  }
}

export interface MapPaneProps {
  inkKey: string;
  disabled?: boolean;
  onEmptyChange: (empty: boolean) => void;
}

export const MapPane = forwardRef<InkCanvasHandle, MapPaneProps>(function MapPane(
  { inkKey, disabled = false, onEmptyChange },
  ref,
) {
  const inkRef = useRef<InkCanvasHandle>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | null>(null);
  const keyRef = useRef(inkKey);
  // The canvas takes its height once, at mount: measure the pane first so it fills it.
  const [height, setHeight] = useState<number | null>(null);
  const [initial] = useState(() => (typeof window === 'undefined' ? undefined : readInk(inkKey)));

  keyRef.current = inkKey;
  // The canvas mounts after the first measure, so the handle forwards instead of capturing it.
  useImperativeHandle(
    ref,
    () => ({
      getStrokes: () => inkRef.current?.getStrokes() ?? [],
      setStrokes: (strokes) => inkRef.current?.setStrokes(strokes),
      clear: () => inkRef.current?.clear(),
      undo: () => inkRef.current?.undo(),
      redo: () => inkRef.current?.redo(),
      isEmpty: () => inkRef.current?.isEmpty() ?? true,
      rasterize: () => inkRef.current?.rasterize() ?? null,
    }),
    [],
  );

  useEffect(() => {
    const node = wrapRef.current;

    if (!node) return;
    // The canvas's own toolbar sits above the drawing area; leave room for it.
    const observer = new ResizeObserver(([entry]) =>
      // A hidden pane (the Map side of the narrow toggle) measures 0 — wait until it is shown.
      setHeight((current) => {
        const box = Math.floor(entry!.contentRect.height);

        return current ?? (box > 0 ? Math.max(360, box - 64) : null);
      }),
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  // Restored ink counts as a drawn map (the canvas only reports changes after mount).
  useEffect(() => {
    if (height !== null && initial && initial.length > 0) onEmptyChange(false);
  }, [height !== null]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        writeInk(keyRef.current, inkRef.current?.getStrokes() ?? []);
      }
    },
    [],
  );

  const handleChange = useCallback(
    (empty: boolean) => {
      onEmptyChange(empty);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        writeInk(keyRef.current, inkRef.current?.getStrokes() ?? []);
      }, SAVE_DEBOUNCE_MS);
    },
    [onEmptyChange],
  );

  return (
    <div ref={wrapRef} className='h-full min-h-0 overflow-y-auto p-3'>
      {height !== null && (
        <InkCanvas
          ref={inkRef}
          disabled={disabled}
          initialStrokes={initial}
          minHeight={height}
          onChange={handleChange}
        />
      )}
    </div>
  );
});
