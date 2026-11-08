import { FabricObject } from 'fabric';

import { darkBoardInkColor } from './inkContrast';

/**
 * Dark board: a VIEW setting. The board's paper turns dark and ink is remapped to the light side of
 * its hue AT PAINT TIME only — every stored colour (the object's `stroke`/`fill`, `toJSON`, autosave,
 * cloud sync, history) stays exactly what was picked, so a page written on a dark board opens
 * unchanged on a light one and vice versa.
 *
 * Only the board's own on-screen surfaces are dark: the editor registers its lower / upper / bake
 * canvases with {@link registerDarkBoardSurface}. A render into any other canvas — `toCanvasElement`,
 * selection copy, AI rasterize, thumbnails, PDF export — starts at a surface that is not registered and
 * paints the stored colours, so every export stays a light page by construction.
 *
 * Object caches: a cached object paints into its own cache canvas, then blits it. The theme a cache was
 * painted for is remembered on the object; drawing it onto a surface of the other theme re-renders it.
 *
 * PDFs and images are drawn untouched (a white sheet on the dark board); only colour strings go
 * through the remap, never bitmaps.
 */

export type BoardTheme = 'light' | 'dark';

/** The board's paper on a dark board — Study's dark surface (`--st-surface`), never pure black. */
export const DARK_BOARD_BASE_COLOR = '#1e1e21';
/** Grid / lines / dots on a dark board. */
export const DARK_BOARD_PATTERN_COLOR = '#3a3a40';
export const LIGHT_BOARD_BASE_COLOR = '#ffffff';
export const LIGHT_BOARD_PATTERN_COLOR = '#e0e0e0';

let theme: BoardTheme = 'light';
const listeners = new Set<() => void>();
const surfaces = new WeakSet<HTMLCanvasElement | OffscreenCanvas>();
const remapCache = new Map<string, string>();

export const isDarkBoard = (): boolean => theme === 'dark';

export const boardBaseColor = (): string => (theme === 'dark' ? DARK_BOARD_BASE_COLOR : LIGHT_BOARD_BASE_COLOR);

export const boardPatternColor = (): string => (theme === 'dark' ? DARK_BOARD_PATTERN_COLOR : LIGHT_BOARD_PATTERN_COLOR);

export function setBoardTheme(next: BoardTheme): void {
  installDarkBoardPaint();
  if (next === theme) return;
  theme = next;
  listeners.forEach((listener) => listener());
}

export function subscribeBoardTheme(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function registerDarkBoardSurface(canvas: HTMLCanvasElement | OffscreenCanvas | null | undefined): void {
  if (canvas) surfaces.add(canvas);
}

/** The colour a stored ink string paints with on a dark board (memoized; strings only). */
export function paintedInkColor(color: string): string {
  let mapped = remapCache.get(color);

  if (mapped === undefined) {
    mapped = darkBoardInkColor(color);
    if (remapCache.size > 512) remapCache.clear();
    remapCache.set(color, mapped);
  }

  return mapped;
}

/** Whether a paint into `ctx` belongs to the dark board (a registered surface while dark). */
export const isDarkBoardContext = (ctx: CanvasRenderingContext2D | null | undefined): boolean =>
  theme === 'dark' && !!ctx && surfaces.has(ctx.canvas as HTMLCanvasElement);

// --- Fabric paint patch -------------------------------------------------------------------------

type PatchedObject = FabricObject & { __wbCacheDark?: boolean };

/** Theme of the render in progress (set by the outermost object render, inherited by nested ones). */
let renderDark = false;
let renderDepth = 0;

/** Whether the object render in progress paints for the dark board (for other paint-time remaps). */
export const isRenderingDarkBoard = (): boolean => renderDark;
let installed = false;

function installDarkBoardPaint(): void {
  if (installed) return;
  installed = true;

  const proto = FabricObject.prototype as unknown as {
    render(this: PatchedObject, ctx: CanvasRenderingContext2D): void;
    _setStrokeStyles(this: PatchedObject, ctx: CanvasRenderingContext2D, decl: { stroke?: unknown }): void;
    _setFillStyles(this: PatchedObject, ctx: CanvasRenderingContext2D, decl: { fill?: unknown }): void;
  };
  const render = proto.render;
  const setStroke = proto._setStrokeStyles;
  const setFill = proto._setFillStyles;

  proto.render = function patchedRender(ctx) {
    const outer = renderDepth === 0;
    const previous = renderDark;

    if (outer) renderDark = isDarkBoardContext(ctx);
    // A cache painted for the other theme is stale for this surface.
    if ((this.__wbCacheDark ?? false) !== renderDark) {
      this.dirty = true;
      this.__wbCacheDark = renderDark;
    }
    renderDepth += 1;
    try {
      render.call(this, ctx);
    } finally {
      renderDepth -= 1;
      if (outer) renderDark = previous;
    }
  };

  proto._setStrokeStyles = function patchedStroke(ctx, decl) {
    setStroke.call(this, ctx, decl);
    if (renderDark && typeof decl.stroke === 'string') ctx.strokeStyle = paintedInkColor(decl.stroke);
  };

  proto._setFillStyles = function patchedFill(ctx, decl) {
    setFill.call(this, ctx, decl);
    if (renderDark && typeof decl.fill === 'string') ctx.fillStyle = paintedInkColor(decl.fill);
  };
}
