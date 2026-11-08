import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Bounds, Point, Size } from '../utils/quickGestureMenuLayout';

import {
  getQuickPenTriggerStorageKey,
  getVisibleBounds,
  QUICK_MENU_DRAG_THRESHOLD,
  readStoredAnchor,
  writeStoredAnchor,
} from '../utils/quickGestureMenuLayout';

export interface ViewportBox {
  viewport: Size;
  bounds: Bounds;
  isRtl: boolean;
}

function measureBox(element: HTMLElement): ViewportBox | null {
  const width = element.clientWidth;
  const height = element.clientHeight;
  if (width <= 0 || height <= 0) return null;
  const rect = element.getBoundingClientRect();
  const windowSize = {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };

  return {
    viewport: { width, height },
    bounds: getVisibleBounds({ left: rect.left, top: rect.top, width, height }, windowSize),
    isRtl: getComputedStyle(element).direction === 'rtl',
  };
}

function sameBox(a: ViewportBox | null, b: ViewportBox | null) {
  if (!a || !b) return a === b;

  return (
    a.isRtl === b.isRtl &&
    a.viewport.width === b.viewport.width &&
    a.viewport.height === b.viewport.height &&
    a.bounds.left === b.bounds.left &&
    a.bounds.top === b.bounds.top &&
    a.bounds.right === b.bounds.right &&
    a.bounds.bottom === b.bounds.bottom
  );
}

/**
 * Size + on-screen part of `ref`'s element (an `absolute inset-0` layer over the board), measured
 * before first paint and again on resize / rotation / visual-viewport changes.
 */
export function useViewportBox(ref: React.RefObject<HTMLElement | null>): ViewportBox | null {
  const [box, setBox] = useState<ViewportBox | null>(null);

  const remeasure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const next = measureBox(element);
    setBox((current) => (sameBox(current, next) ? current : next));
  }, [ref]);

  useLayoutEffect(remeasure, [remeasure]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(remeasure) : null;
    observer?.observe(element);
    window.addEventListener('resize', remeasure);
    window.addEventListener('orientationchange', remeasure);
    window.visualViewport?.addEventListener('resize', remeasure);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('orientationchange', remeasure);
      window.visualViewport?.removeEventListener('resize', remeasure);
    };
  }, [ref, remeasure]);

  return box;
}

interface DragHandleOptions {
  /** Called on every move past the threshold with the pointer travel since press. */
  onDragMove: (delta: Point) => void;
  /** Called once when a drag (not a tap) ends. */
  onDragEnd: () => void;
  /** Called for a tap (press + release under the threshold), incl. keyboard activation. */
  onTap: () => void;
  /** Captures whatever the drag should start from (e.g. the current centre); runs on press. */
  onDragStart?: () => void;
}

/**
 * Pointer handlers for a button that is both tappable and draggable — pen, finger and mouse.
 * Pointer events never propagate to the canvas underneath; a drag never reads as a tap.
 */
export function useDragHandle({ onDragMove, onDragEnd, onTap, onDragStart }: DragHandleOptions) {
  const dragRef = useRef<{ pointerId: number; start: Point; dragging: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const callbacksRef = useRef({ onDragMove, onDragEnd, onTap, onDragStart });
  callbacksRef.current = { onDragMove, onDragEnd, onTap, onDragStart };

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    // No focus-steal / text-selection / native touch scroll; the click still fires for taps.
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // capture can fail for a pointer that already lifted — the drag just ends early.
    }
    suppressClickRef.current = false;
    dragRef.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, dragging: false };
    callbacksRef.current.onDragStart?.();
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = { x: event.clientX - drag.start.x, y: event.clientY - drag.start.y };
    if (!drag.dragging && Math.hypot(delta.x, delta.y) < QUICK_MENU_DRAG_THRESHOLD) return;
    drag.dragging = true;
    event.preventDefault();
    callbacksRef.current.onDragMove(delta);
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    if (!drag.dragging) return;
    suppressClickRef.current = true;
    callbacksRef.current.onDragEnd();
  }, []);

  const onClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;

      return;
    }
    callbacksRef.current.onTap();
  }, []);

  return {
    onClick,
    onLostPointerCapture: endDrag,
    onPointerCancel: endDrag,
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
  };
}

/**
 * The quick pen trigger + menu's shared position for one board, as a viewport fraction
 * (null = never moved). `commit` persists it; intermediate drag frames only update state.
 */
export function useQuickPenAnchor(boardId?: string | null) {
  const storageKey = getQuickPenTriggerStorageKey(boardId);
  const [anchor, setAnchorState] = useState<Point | null>(() => readStoredAnchor(storageKey));

  useEffect(() => {
    setAnchorState(readStoredAnchor(storageKey));
  }, [storageKey]);

  const setAnchor = useCallback(
    (next: Point, commit: boolean) => {
      setAnchorState(next);
      if (commit) writeStoredAnchor(storageKey, next);
    },
    [storageKey],
  );

  return { anchor, setAnchor };
}
