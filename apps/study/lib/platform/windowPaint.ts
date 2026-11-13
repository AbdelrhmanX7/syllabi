// Android only. When a system bar stays on screen the app view is pushed up to clear it, and the
// gap showed the window's launch colour (bright blue) as a strip under the page. The window is
// repainted in the colour of whatever sits at the page's bottom edge, so the gap blends in.
type PaintBridge = { paint?: (hex: string) => void };

/** `rgb(25, 33, 72)` / `rgba(…, 1)` → `#192148`; null for a see-through or unreadable colour. */
export function opaqueHex(css: string): string | null {
  const match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(css.trim());

  if (!match) return null;
  const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]);

  if (!(alpha >= 0.99)) return null;

  return `#${[match[1], match[2], match[3]].map((part) => Math.min(255, Number(part)).toString(16).padStart(2, '0')).join('')}`;
}

function bottomEdgeColour(): string | null {
  let element: Element | null = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 1);

  while (element) {
    const hex = opaqueHex(getComputedStyle(element).backgroundColor);

    if (hex) return hex;
    element = element.parentElement;
  }

  return opaqueHex(getComputedStyle(document.body).backgroundColor);
}

/** Keeps the Android window painted like the page's bottom edge. Returns the cleanup. */
export function installWindowPaint(): () => void {
  const bridge = (window as unknown as { StudyWindow?: PaintBridge }).StudyWindow;

  if (!bridge?.paint) return () => {};
  let last = '';
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const paint = () => {
    const hex = bottomEdgeColour();

    if (!hex || hex === last) return;
    last = hex;
    bridge.paint?.(hex);
  };
  // A screen settles over a moment (bars slide in, the theme lands): look again a little later.
  const soon = () => {
    for (const delay of [50, 600, 2000]) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        paint();
      }, delay);

      timers.add(timer);
    }
  };
  const theme = new MutationObserver(soon);

  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  window.addEventListener('resize', soon);
  window.addEventListener('popstate', soon);
  window.addEventListener('pointerup', soon, { passive: true });
  soon();

  return () => {
    theme.disconnect();
    window.removeEventListener('resize', soon);
    window.removeEventListener('popstate', soon);
    window.removeEventListener('pointerup', soon);
    timers.forEach(clearTimeout);
  };
}
