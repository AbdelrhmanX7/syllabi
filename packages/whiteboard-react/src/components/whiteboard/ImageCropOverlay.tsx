import React, { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';

import { Check, X } from 'lucide-react';

import {
  clampCropRect,
  CROP_HANDLES,
  cropRectOf,
  dragCropRect,
  elementToScreenMatrix,
  matrixAxisScales,
  minCropSize,
  screenBoxOf,
  screenDeltaToElement,
} from './utils/imageCrop';
import { MODERN_TOUCH_CORNER_SIZE, SELECTION_ACCENT } from './utils/selectionChrome';
import { placeSelectionBar } from './utils/selectionClipboard';
import { useWbStrings } from '../../i18n/context';

import type { CropHandle, CropRect } from './utils/imageCrop';
import type { Canvas, FabricImage } from 'fabric';

/**
 * Crop mode for one picture. Nothing on the board changes while it is open: the full picture is drawn
 * here, in the picture's own plane (a CSS transform of viewport ∘ object), dimmed outside the frame, with
 * four corner and four edge grips. «Done» hands the frame (element px) back; the editor applies it as ONE
 * change — one undo step. «Cancel» changes nothing.
 *
 * The layer covers the whole board so a press never reaches the canvas (no ink, no pan) while cropping.
 */

interface ImageCropOverlayProps {
  canvas: Canvas;
  image: FabricImage;
  /** Room the top chrome takes; the buttons never hide under it. */
  topInset?: number;
  onDone: (rect: CropRect) => void;
  onCancel: () => void;
}

/** Where each grip sits on the frame, as fractions of its width / height. */
const GRIP_SPOTS: Record<Exclude<CropHandle, 'move'>, [number, number]> = {
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  e: [1, 0.5],
  se: [1, 1],
  s: [0.5, 1],
  sw: [0, 1],
  w: [0, 0.5],
};

/** Visible grip: a corner is an L-ish square, an edge a short bar — drawn at this many screen px. */
const GRIP_DOT_PX = 14;
const FRAME_LINE_PX = 2;

const BUTTON_CLASS =
  'flex min-h-11 min-w-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-sm font-semibold transition-colors';

const stop = (event: React.SyntheticEvent) => event.stopPropagation();

export function ImageCropOverlay({ canvas, image, topInset, onDone, onCancel }: ImageCropOverlayProps) {
  const { t, dir } = useWbStrings();
  const source = useMemo(() => {
    const size = image.getOriginalSize();

    return { width: size.width || image.width, height: size.height || image.height };
  }, [image]);
  const src = useMemo(() => {
    try {
      return image.getSrc();
    } catch {
      return '';
    }
  }, [image]);
  // The crop the picture has NOW — the overlay's plane is built from it until «Done».
  const current = useMemo(() => ({ cropX: image.cropX, cropY: image.cropY, width: image.width, height: image.height }), [image]);
  const [rect, setRect] = useState<CropRect>(() => cropRectOf(current));
  // The viewport can still change under the overlay (a resize, a scroll session settling): follow it.
  const [, repaint] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    const onRender = () => repaint();

    canvas.on('after:render', onRender);

    return () => {
      canvas.off('after:render', onRender);
    };
  }, [canvas]);

  const matrix = elementToScreenMatrix(canvas.viewportTransform, image.calcTransformMatrix(), current);
  const scales = matrixAxisScales(matrix);
  const min = minCropSize(Math.min(scales.x, scales.y), source);
  const drag = useRef<{ pointerId: number; handle: CropHandle; start: CropRect; x: number; y: number } | null>(null);

  const startDrag = (handle: CropHandle) => (event: React.PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    event.preventDefault();

    if (drag.current) return;

    drag.current = { pointerId: event.pointerId, handle, start: rect, x: event.clientX, y: event.clientY };

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort.
    }
  };

  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    event.stopPropagation();

    const active = drag.current;

    if (!active || active.pointerId !== event.pointerId) return;

    const delta = screenDeltaToElement(matrix, event.clientX - active.x, event.clientY - active.y);

    setRect(dragCropRect(active.start, active.handle, delta.x, delta.y, source, min));
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    event.stopPropagation();

    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  // A frame from before a zoom-out can be under the new minimum: keep it valid.
  const frame = clampCropRect(rect, source, min);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barSize, setBarSize] = useState({ width: 200, height: 52 });

  useLayoutEffect(() => {
    const element = barRef.current;

    if (!element) return;

    const next = { width: element.offsetWidth, height: element.offsetHeight };

    setBarSize((size) => (size.width === next.width && size.height === next.height ? size : next));
  });

  const container = { width: canvas.getWidth(), height: canvas.getHeight() };
  const spot = placeSelectionBar(screenBoxOf(matrix, frame), barSize, container, {
    topInset,
    prefer: 'below',
    gap: MODERN_TOUCH_CORNER_SIZE / 2 + 12,
  });
  // Grips and lines are sized in SCREEN px; the layer is in element px, so divide by its scale.
  const sx = scales.x || 1;
  const sy = scales.y || 1;
  const gripHitX = MODERN_TOUCH_CORNER_SIZE / sx;
  const gripHitY = MODERN_TOUCH_CORNER_SIZE / sy;

  return (
    <div
      className='absolute inset-0 z-[35]'
      data-testid='wb-crop-overlay'
      style={{ touchAction: 'none' }}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
    >
      <div
        className='absolute left-0 top-0'
        style={{
          width: source.width,
          height: source.height,
          transform: `matrix(${matrix.join(',')})`,
          transformOrigin: '0 0',
        }}
      >
        {/* The whole picture, dimmed everywhere the frame does not keep. */}
        <div className='absolute inset-0 overflow-hidden'>
          {src ? <img alt='' className='pointer-events-none absolute inset-0 h-full w-full max-w-none select-none' draggable={false} src={src} /> : null}
          <div
            className='pointer-events-none absolute'
            style={{
              left: frame.x,
              top: frame.y,
              width: frame.width,
              height: frame.height,
              boxShadow: `0 0 0 ${Math.max(source.width, source.height) * 2}px rgba(15, 23, 42, 0.6)`,
            }}
          />
        </div>
        <div
          aria-label={t('crop.frame')}
          className='absolute cursor-move'
          data-testid='wb-crop-frame'
          style={{
            left: frame.x,
            top: frame.y,
            width: frame.width,
            height: frame.height,
            outline: `${FRAME_LINE_PX / sx}px solid ${SELECTION_ACCENT}`,
          }}
          onLostPointerCapture={endDrag}
          onPointerCancel={endDrag}
          onPointerDown={startDrag('move')}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
        >
          {CROP_HANDLES.map((handle) => {
            const [fx, fy] = GRIP_SPOTS[handle];

            return (
              <div
                key={handle}
                className='absolute flex items-center justify-center'
                data-crop-handle={handle}
                style={{
                  left: fx * frame.width - gripHitX / 2,
                  top: fy * frame.height - gripHitY / 2,
                  width: gripHitX,
                  height: gripHitY,
                  cursor: handle === 'n' || handle === 's' ? 'ns-resize' : handle === 'e' || handle === 'w' ? 'ew-resize' : handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize',
                }}
                onLostPointerCapture={endDrag}
                onPointerCancel={endDrag}
                onPointerDown={startDrag(handle)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
              >
                <span
                  className='block rounded-[3px] bg-white'
                  style={{
                    width: GRIP_DOT_PX / sx,
                    height: GRIP_DOT_PX / sy,
                    outline: `${FRAME_LINE_PX / sx}px solid ${SELECTION_ACCENT}`,
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div
        ref={barRef}
        className='bg-paper text-ink border-ink/10 absolute flex gap-1 rounded-2xl border p-1.5 shadow-[0_12px_32px_-10px_rgba(15,23,42,0.35),0_2px_6px_rgba(15,23,42,0.08)]'
        data-testid='wb-crop-bar'
        dir={dir}
        role='toolbar'
        style={{ left: spot.left, top: spot.top }}
      >
        <button className={`${BUTTON_CLASS} hover:bg-ink/5 active:bg-ink/10`} data-action='crop-cancel' type='button' onClick={onCancel}>
          <X aria-hidden className='h-5 w-5' />
          {t('crop.cancel')}
        </button>
        <button
          className={`${BUTTON_CLASS} text-white`}
          data-action='crop-done'
          style={{ background: SELECTION_ACCENT }}
          type='button'
          onClick={() => onDone(frame)}
        >
          <Check aria-hidden className='h-5 w-5' />
          {t('crop.done')}
        </button>
      </div>
    </div>
  );
}
