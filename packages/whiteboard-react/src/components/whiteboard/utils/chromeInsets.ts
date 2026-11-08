import { useCallback, useRef } from 'react';

/**
 * Reserve the width of a piece of top chrome as a CSS variable, so the toolbar row lays itself out in
 * the gap between the chrome at each edge instead of across it.
 *
 * The board's top edge holds three things that do not know about each other: the title bar at the
 * START edge (drawn by the editor), the record/bell/QR cluster at the END edge (drawn by the host
 * app), and the drawing toolbar in the middle. The toolbar used to centre itself in the full width
 * with a fixed `calc(100vw - 19rem)` cap — a guess at how wide the other two are — and on a tablet
 * (~1138 CSS px) the expanded toolbar ran under both and clipped its first three buttons off-screen.
 *
 * Each piece of chrome now publishes its own measured width as `--wb-chrome-inset-start` or
 * `--wb-chrome-inset-end` on the shared positioned container, and the toolbar wrapper pads itself by
 * those. The toolbar never sees the chrome; it just gets a narrower box and wraps into rows.
 */
export type ChromeInsetSide = 'start' | 'end';

export const CHROME_INSET_VAR: Record<ChromeInsetSide, string> = {
  start: '--wb-chrome-inset-start',
  end: '--wb-chrome-inset-end',
};

/**
 * Marks an element as board chrome (toolbar, title bar, host cluster) so content placed on the board
 * can keep clear of it — {@link measureChromeInsets}. Every element passed to {@link observeChromeInset}
 * gets it; the toolbar sets it directly.
 */
export const CHROME_ATTR = 'data-wb-chrome';

/** Keep `host`'s inset variable for `side` equal to `element`'s live width. Returns the teardown. */
export function observeChromeInset(element: HTMLElement, side: ChromeInsetSide, host: HTMLElement): () => void {
  const name = CHROME_INSET_VAR[side];

  element.setAttribute(CHROME_ATTR, side);
  const apply = () => {
    host.style.setProperty(name, `${Math.ceil(element.getBoundingClientRect().width)}px`);
  };

  apply();

  if (typeof ResizeObserver === 'undefined') {
    return () => {
      host.style.removeProperty(name);
      element.removeAttribute(CHROME_ATTR);
    };
  }

  const observer = new ResizeObserver(apply);

  observer.observe(element);

  return () => {
    observer.disconnect();
    host.style.removeProperty(name);
    element.removeAttribute(CHROME_ATTR);
  };
}

export type ChromeInsets = { top: number; right: number; bottom: number; left: number };

type Box = { left: number; top: number; width: number; height: number };

/**
 * How far chrome reaches into `area` from each edge, in px. Each chrome box counts against the edge
 * it sits nearest (a top-docked toolbar → top, a left dock → left); boxes outside `area` or with no
 * size (hidden chrome) count for nothing.
 */
export function chromeInsetsFromRects(area: Box, chrome: Box[]): ChromeInsets {
  const insets: ChromeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  const right = area.left + area.width;
  const bottom = area.top + area.height;

  for (const box of chrome) {
    if (box.width <= 0 || box.height <= 0) continue;
    if (box.left >= right || box.left + box.width <= area.left || box.top >= bottom || box.top + box.height <= area.top) continue;

    const distance = {
      top: box.top - area.top,
      bottom: bottom - (box.top + box.height),
      left: box.left - area.left,
      right: right - (box.left + box.width),
    };
    const edge = (Object.keys(distance) as Array<keyof ChromeInsets>).reduce((best, key) => (distance[key] < distance[best] ? key : best), 'top');
    const reach = {
      top: box.top + box.height - area.top,
      bottom: bottom - box.top,
      left: box.left + box.width - area.left,
      right: right - box.left,
    }[edge];

    insets[edge] = Math.max(insets[edge], Math.min(reach, edge === 'top' || edge === 'bottom' ? area.height : area.width));
  }

  return insets;
}

/** {@link chromeInsetsFromRects} for the live chrome in `doc` over the on-screen box `area`. */
export function measureChromeInsets(area: Box, doc: Document = document): ChromeInsets {
  const boxes = Array.from(doc.querySelectorAll<HTMLElement>(`[${CHROME_ATTR}]`), (element) => element.getBoundingClientRect());

  return chromeInsetsFromRects(area, boxes);
}

/**
 * A callback ref for the chrome element. The variable is written on the element's PARENT — the
 * positioned container the toolbar also hangs from — and removed when the element unmounts, so chrome
 * that hides (recording, focus mode) gives its space back. A callback ref rather than an effect on a
 * ref object: the host page renders this chrome only after its loading/error branches, and an effect
 * keyed on a ref object would not re-run when the element finally appears.
 */
export function useChromeInset(side: ChromeInsetSide): (element: HTMLElement | null) => void {
  const teardownRef = useRef<(() => void) | null>(null);

  return useCallback(
    (element: HTMLElement | null) => {
      teardownRef.current?.();
      teardownRef.current = null;

      if (!element?.parentElement) {
        return;
      }

      teardownRef.current = observeChromeInset(element, side, element.parentElement);
    },
    [side],
  );
}
