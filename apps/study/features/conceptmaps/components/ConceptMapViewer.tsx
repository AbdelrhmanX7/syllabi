import type { Diagram, NodeOffsets, TextMeasure } from '../lib/diagram';
import type { GraphPaint } from './ConceptGraphSvg';
import type { Size, View } from '../lib/viewport';
import type { ReferenceEdge, ReferenceNode } from '../types';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Scan, Sparkles, X, ZoomIn, ZoomOut } from 'lucide-react';

import { layoutDiagram, moveDiagramNodes, settleDroppedNode } from '../lib/diagram';
import { clampView, fitView, focusView, panView, readableView, zoomView } from '../lib/viewport';

import { ConceptGraphSvg } from './ConceptGraphSvg';

/**
 * The reference concept map, fitted to its panel's width (height follows the graph's aspect, up to
 * 70vh; a taller graph scrolls inside, from the top). Pinch, ctrl/⌘+wheel or the buttons zoom; drag
 * (finger, pen or mouse) on the background or the wheel pans; «Fit» resets; «Expand» shows the whole
 * map full screen. Drag a BOX to move that idea: its links follow, on release it is nudged off any
 * box it landed on; «Tidy» puts every idea back where the layout placed it. Boxes are sized from the
 * real font (canvas `measureText`), so long words never spill onto a neighbour.
 */

/** The SVG's text widths, measured in the page's own font; undefined off the browser. */
function useTextMeasure(): TextMeasure | undefined {
  // The web font may land after the first layout: measure again (fresh cache) once it has.
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    let live = true;

    void document.fonts?.ready.then(() => live && setFontsReady(true));

    return () => {
      live = false;
    };
  }, []);

  return useMemo(() => {
    if (typeof document === 'undefined') return undefined;
    const context = document.createElement('canvas').getContext('2d');

    if (!context) return undefined;
    const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
    const cache = new Map<string, number>();

    return (text: string, kind: 'node' | 'label') => {
      const key = `${kind}:${text}`;
      const known = cache.get(key);

      if (known !== undefined) return known;
      // The widest the SVG draws it: nodes up to semibold 15px, phrases italic 14px.
      context.font = kind === 'node' ? `600 15px ${family}` : `italic 400 14px ${family}`;
      const width = Math.ceil(context.measureText(text).width) + 1;

      cache.set(key, width);

      return width;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fontsReady` only re-runs the measure
  }, [fontsReady]);
}
interface PaneShared {
  highlight?: Set<string>;
  paint?: GraphPaint;
  /** Node ids / edge keys drawn as selected. */
  selected?: Set<string>;
  /** A tap (no drag) on a node; null = on empty canvas. */
  onNodeTap?: (id: string | null) => void;
  /** Zoom onto these nodes; a new `nonce` re-focuses the same ids. Null ids / empty = fit. */
  focus?: { ids: string[]; nonce: number; /** Pan only (keep the zoom). */ pan?: boolean } | null;
  /** Smallest starting scale (px per unit): a wider map opens at this size, top-centre, and pans. */
  minScale?: number;
}

export interface ConceptMapViewerProps extends PaneShared {
  nodes: ReferenceNode[];
  edges: ReferenceEdge[];
  title?: string;
}

export function ConceptMapViewer({ nodes, edges, title = 'Concept map', ...shared }: ConceptMapViewerProps) {
  const measure = useTextMeasure();
  const diagram = useMemo(() => layoutDiagram(nodes, edges, { measure }), [nodes, edges, measure]);
  const [offsets, setOffsets] = useState<NodeOffsets>({});
  const shown = useMemo(() => moveDiagramNodes(diagram, offsets), [diagram, offsets]);
  const [expanded, setExpanded] = useState(false);
  const moving = { base: diagram, offsets, setOffsets };

  useEffect(() => setOffsets({}), [diagram]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setExpanded(false);
    const overflow = document.body.style.overflow;

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);

    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [expanded]);

  if (diagram.nodes.length === 0) return null;

  return (
    <>
      <DiagramPane {...shared} diagram={shown} moving={moving} title={title} onExpand={() => setExpanded(true)} />
      {expanded &&
        createPortal(
          <div aria-label={title} aria-modal='true' className='bg-st-bg fixed inset-0 z-50 flex flex-col' role='dialog'>
            <header className='border-st-line flex items-center gap-2 border-b px-4 py-2'>
              <h2 className='text-st-fg min-w-0 flex-1 truncate text-sm font-semibold'>{title}</h2>
              <button
                aria-label='Close'
                className='rounded-st text-st-fg hover:bg-st-raised flex h-10 w-10 items-center justify-center'
                type='button'
                onClick={() => setExpanded(false)}
              >
                <X className='h-5 w-5' />
              </button>
            </header>
            <div className='min-h-0 flex-1'>
              <DiagramPane {...shared} fill diagram={shown} moving={moving} title={title} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

interface DiagramPaneProps extends PaneShared {
  /** The diagram as shown (dragged nodes moved). */
  diagram: Diagram;
  /** The laid-out diagram and the reader's drags on it. */
  moving: { base: Diagram; offsets: NodeOffsets; setOffsets: (next: NodeOffsets) => void };
  title: string;
  /** Fill the parent's height (the full-screen view, fitted whole) instead of sizing to the graph. */
  fill?: boolean;
  onExpand?: () => void;
}

const TOOLBAR = 44;

function DiagramPane({
  diagram,
  moving,
  highlight,
  paint,
  selected,
  onNodeTap,
  focus,
  minScale = 0.75,
  title,
  fill = false,
  onExpand,
}: DiagramPaneProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(0);
  const [port, setPort] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const tap = useRef<{ x: number; y: number } | null>(null);
  // A box being dragged: which, where the pointer started, its offset then, moved past the tap slop yet.
  const drag = useRef<{ id: string; x: number; y: number; start: { dx: number; dy: number }; live: boolean } | null>(null);
  const movingRef = useRef(moving);

  movingRef.current = moving;
  const content = useMemo(() => ({ w: diagram.width, h: diagram.height }), [diagram]);
  const whole = useMemo(() => fitView(content, port, fill ? 'contain' : 'width'), [content, port, fill]);
  // Where a map opens (null view): the whole drawing, or a readable part of a wide one.
  const fit = useMemo(() => readableView(whole, content, port, minScale), [whole, content, port, minScale]);
  const showWhole = useCallback(() => setView(whole === fit ? null : whole), [whole, fit]);
  const shown = view ?? fit;
  const shownRef = useRef(shown);

  shownRef.current = shown;
  useEffect(() => setView(null), [moving.base]);

  // Zoom onto the focused nodes (a grader comment's link, a tapped pair).
  useEffect(() => {
    if (!focus || port.w === 0) return;
    const boxes = diagram.nodes.filter((node) => focus.ids.includes(node.id));

    if (boxes.length === 0) {
      if (!focus.pan) setView(null);

      return;
    }
    const x = Math.min(...boxes.map((node) => node.x));
    const y = Math.min(...boxes.map((node) => node.y));
    const box = {
      x,
      y,
      w: Math.max(...boxes.map((node) => node.x + node.w)) - x,
      h: Math.max(...boxes.map((node) => node.y + node.h)) - y,
    };

    if (focus.pan) {
      const current = shownRef.current;

      setView(
        clampView({ ...current, x: box.x + box.w / 2 - current.w / 2, y: box.y + box.h / 2 - current.h / 2 }, content),
      );

      return;
    }
    setView(focusView(box, whole, content, 40, Math.max(400, whole.w * 0.8)));
  }, [focus, port.w > 0]);

  useEffect(() => {
    const box = boxRef.current;
    const svg = svgRef.current;

    if (!box || !svg) return;
    const observer = new ResizeObserver(() => {
      setWidth(box.clientWidth);
      setPort({ w: svg.clientWidth, h: svg.clientHeight });
    });

    observer.observe(box);
    observer.observe(svg);

    return () => observer.disconnect();
  }, []);

  /** Client px → drawing units. */
  const toDiagram = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const current = shownRef.current;

    if (!rect || rect.width === 0) return null;

    return {
      x: current.x + ((clientX - rect.left) / rect.width) * current.w,
      y: current.y + ((clientY - rect.top) / rect.height) * current.h,
    };
  }, []);

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const at = toDiagram(clientX, clientY);

      if (!at) return;
      const next = zoomView(shownRef.current, at, factor, whole, content);

      if (!next) return showWhole();
      shownRef.current = next;
      setView(next);
    },
    [content, whole, showWhole, toDiagram],
  );

  /** Pans; false when the view could not move (at an edge), so a wheel can scroll the page instead. */
  const panBy = useCallback(
    (dx: number, dy: number) => {
      const current = shownRef.current;
      const next = panView(current, dx, dy, port.w, content);

      if (Math.abs(next.x - current.x) < 0.01 && Math.abs(next.y - current.y) < 0.01) return false;
      shownRef.current = next;
      setView(next);

      return true;
    },
    [content, port.w],
  );

  const zoomCentre = (factor: number) => {
    const rect = svgRef.current?.getBoundingClientRect();

    if (rect) zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  };

  // Wheel: ctrl/⌘ (and trackpad pinch) zooms; a plain wheel moves the map until it hits an edge,
  // then the page scrolls.
  useEffect(() => {
    const svg = svgRef.current;

    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.01));
      } else if (panBy(-event.deltaX, -event.deltaY)) event.preventDefault();
    };

    svg.addEventListener('wheel', onWheel, { passive: false });

    return () => svg.removeEventListener('wheel', onWheel);
  }, [panBy, zoomAt]);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const node = (event.target as Element | null)?.closest?.('[data-node]')?.getAttribute('data-node') ?? null;

    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    tap.current = pointers.current.size === 1 ? { x: event.clientX, y: event.clientY } : null;
    drag.current =
      pointers.current.size === 1 && node
        ? { id: node, x: event.clientX, y: event.clientY, start: moving.offsets[node] ?? { dx: 0, dy: 0 }, live: false }
        : null;
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const map = pointers.current;
    const previous = map.get(event.pointerId);

    if (!previous) return;
    if (tap.current && Math.hypot(event.clientX - tap.current.x, event.clientY - tap.current.y) > 8) tap.current = null;
    const held = drag.current;

    if (held && map.size === 1) {
      const rect = svgRef.current?.getBoundingClientRect();

      map.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!rect || rect.width === 0) return;
      if (!held.live && Math.hypot(event.clientX - held.x, event.clientY - held.y) <= 8) return;
      held.live = true;
      const unit = shownRef.current.w / rect.width;
      const { offsets, setOffsets } = movingRef.current;

      setOffsets({ ...offsets, [held.id]: { dx: held.start.dx + (event.clientX - held.x) * unit, dy: held.start.dy + (event.clientY - held.y) * unit } });

      return;
    }
    if (map.size === 1) {
      map.set(event.pointerId, { x: event.clientX, y: event.clientY });
      panBy(event.clientX - previous.x, event.clientY - previous.y);

      return;
    }
    const [a, b] = Array.from(map.values());
    const before = Math.hypot(a!.x - b!.x, a!.y - b!.y);

    map.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const [c, d] = Array.from(map.values());
    const after = Math.hypot(c!.x - d!.x, c!.y - d!.y);

    if (before > 0 && after > 0) zoomAt((c!.x + d!.x) / 2, (c!.y + d!.y) / 2, after / before);
  };

  const onPointerEnd = (event: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
    const held = drag.current;

    drag.current = null;
    if (held?.live) {
      // Dropped: off any box it landed on.
      const { base, offsets, setOffsets } = movingRef.current;

      setOffsets(settleDroppedNode(base, offsets, held.id));
      tap.current = null;

      return;
    }
    if (event.type !== 'pointerup' || !tap.current || !onNodeTap) return;
    tap.current = null;
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-node]');

    onNodeTap(hit?.getAttribute('data-node') ?? null);
  };

  const fitHeight = width > 0 ? diagram.height * Math.max(width / diagram.width, minScale) : 320;
  const maxHeight = typeof window === 'undefined' ? 600 : window.innerHeight * 0.7;
  const height = fill ? undefined : Math.max(240, Math.min(fitHeight + TOOLBAR, maxHeight));
  const overflows = view !== null || fit.h < content.h - 1 || fit.w < content.w - 1;
  const button =
    'rounded-st text-st-fg hover:bg-st-raised flex h-9 min-w-9 items-center justify-center gap-1 px-2 text-xs font-medium';

  return (
    <div
      ref={boxRef}
      className={`rounded-st border-st-line bg-st-bg flex flex-col overflow-hidden ${fill ? 'h-full' : 'border'}`}
      style={height ? { height } : undefined}
    >
      <div
        className='border-st-line bg-st-surface flex shrink-0 items-center justify-end gap-0.5 border-b px-1.5'
        style={{ height: TOOLBAR }}
      >
        <button aria-label='Zoom out' className={button} type='button' onClick={() => zoomCentre(1 / 1.4)}>
          <ZoomOut className='h-4 w-4' />
        </button>
        <button aria-label='Zoom in' className={button} type='button' onClick={() => zoomCentre(1.4)}>
          <ZoomIn className='h-4 w-4' />
        </button>
        {Object.keys(moving.offsets).length > 0 && (
          <button
            aria-label='Tidy: put every idea back where the layout placed it'
            className={button}
            type='button'
            onClick={() => moving.setOffsets({})}
          >
            <Sparkles className='h-4 w-4' /> Tidy
          </button>
        )}
        <button aria-label='Fit to view' className={button} type='button' onClick={showWhole}>
          <Scan className='h-4 w-4' /> Fit
        </button>
        {onExpand && (
          <button aria-label='Expand to full screen' className={button} type='button' onClick={onExpand}>
            <Maximize2 className='h-4 w-4' /> Expand
          </button>
        )}
      </div>
      <svg
        ref={svgRef}
        aria-label={title}
        className={`block min-h-0 w-full flex-1 select-none [&_[data-node]]:cursor-move ${overflows ? 'cursor-grab active:cursor-grabbing' : ''}`}
        preserveAspectRatio='xMidYMid meet'
        role='img'
        style={{ touchAction: 'none' }}
        viewBox={`${shown.x} ${shown.y} ${shown.w} ${shown.h}`}
        onPointerCancel={onPointerEnd}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
      >
        <title>{title}</title>
        <ConceptGraphSvg diagram={diagram} highlight={highlight} paint={paint} selected={selected} />
      </svg>
    </div>
  );
}
