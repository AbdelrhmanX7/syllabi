import React from 'react';

import { cn } from '../../cn';
import type { HeroUIColor } from '../tokens';
import type { ThinkingVariant } from './frames';
import { THINKING_FRAME_WIDTH, THINKING_FRAMES } from './frames';

/**
 * da-v2 Thinking — a character-cell "agent is working" indicator.
 *
 * Unlike <Spinner/> (a drawn arc) this is plain TEXT: a 9-cell strip of braille
 * or block-shading glyphs that cycles through a canned frame list. It reads as
 * a terminal/notebook artefact, which is the register we want next to a
 * streaming answer.
 *
 * Two things about the implementation are deliberate:
 *
 * 1. It NEVER re-renders. A `setState` per frame at ~11fps would re-render this
 *    component (and anything memo-less under its parent) continuously while a
 *    long answer streams in beside it. Instead a single `requestAnimationFrame`
 *    loop writes `node.textContent` directly. React renders once, on mount, and
 *    then never again. rAF also stops firing when the tab is hidden, which is
 *    exactly the behaviour a loading indicator wants.
 * 2. It respects `prefers-reduced-motion` by not starting the loop at all —
 *    a representative mid-cycle frame is rendered statically. The media query is
 *    read AFTER mount, never in a lazy `useState` initializer: this package is
 *    consumed by SSR apps, and touching `matchMedia` during the first render
 *    would make the client's first paint disagree with the server HTML.
 */

export type { ThinkingVariant } from './frames';

/**
 * Semantic colour -> TEXT colour. The glyphs are characters, so colour is just
 * `color:` — no fill/stroke plumbing.
 *
 * Every entry is a theme-aware scrapbook token (the same values as
 * HEROUI_COLOR_TEXT in ../tokens), NOT a raw HeroUI semantic scale. That matters
 * because the dark theme in `../../theme.ts` INVERTS every semantic ramp — dark
 * `50` is the DARKEST and `900` the LIGHTEST, the reverse of light, for primary,
 * secondary, success, warning and danger alike. A bare `text-primary` (#2f5bea)
 * therefore measures 2.73:1 on the dark page and 2.49:1 on a dark card, both
 * under the 3:1 WCAG floor for graphical objects; going "lighter" in dark means
 * a HIGHER index there, not a lower one. These tokens flip in CSS instead, so
 * there is no `dark:` variant to forget. Both sides measured:
 *
 *   key        light: value on --paper #fbfaf6   dark: value on page #0f1430 / card #141a3b
 *   default    --ink        #18204a  18.65:1     --ink        #f1eee4  17.33 / 15.76
 *   primary    --p-text     #2f5bea   7.02:1     --p-text     #c3d0fb   8.29 /  7.54
 *   secondary  --s-text     #006fee   4.57:1     --s-text     #59a1f4   7.29 /  6.63
 *   success    --g-text     #047857   5.38:1     --g-text     #34d399  10.17 /  9.25
 *   warning    --amber-text #b45309   4.93:1     --amber-text #fdba74  11.59 / 10.54
 *   danger     --red-text   #e11d48   4.61:1     --red-text   #ff8494   8.36 /  7.60
 *
 * Written as ONE arbitrary `text-` colour utility per key so tailwind-merge
 * files it under text-color and a caller's own `text-…` in `className` still
 * wins. (Never split a width token from a colour token in `cn()` — twMerge
 * cannot tell them apart and silently drops one.)
 */
const COLOR_CLASS: Record<HeroUIColor, string> = {
  default: 'text-[color:var(--ink)]',
  primary: 'text-[color:var(--p-text)]',
  // --s-text, NOT --b-text. They are the same value at :root, which is why this
  // read as correct for so long, but --b is the LITERAL blue that also paints
  // `sk-blue` decoration while --s is the SEMANTIC secondary. An alternate
  // palette splits them: a warm palette sets --s-text while --b-text stays
  // #006fee, so this strip was the one brand-blue survivor on a warm page
  // (measured #006fee, and 4.39:1 on that paper — under AA as well as off-hue).
  secondary: 'text-[color:var(--s-text)]',
  success: 'text-[color:var(--g-text)]',
  warning: 'text-[color:var(--amber-text)]',
  danger: 'text-[color:var(--red-text)]',
};

/**
 * The frame shown when motion is off (and as the SSR/first-paint frame).
 * Hand-picked per variant to read as "work in progress": mid-cycle, never the
 * near-empty frames (`shade-scanner` index 12 is nine light shades — it looks
 * like the process died).
 */
const STATIC_FRAME_INDEX: Record<ThinkingVariant, number> = {
  'braille-spin': 5, // ⠋⠀⠋⠀⠋⠀⠋⠀⠋
  'braille-wave': 0, // ⠄⡀⡀⠄⠂⠁⠁⠂⠄
  'braille-breathe': 2, // ⠏⠿⠿⠏⠇⠏⠿⠿⠏ — dense, no gap in the middle
  'shade-wave': 0, // ░░▒▓███▓▒
  'shade-ripple': 6, // ▒▒░░█░░▒▒
  'shade-scanner': 4, // ▒▒▓▓▓██░░
};

/**
 * These glyphs live outside the app's UI face: IBM Plex Sans carries neither
 * Braille Patterns (U+2800–U+28FF) nor Block Elements (U+2591–U+2593, U+2588),
 * so the strip needs its own stack.
 *
 * THIS IS THE COMPONENT'S REAL PORTABILITY RISK. Font fallback is per-glyph, so
 * a missing cell does not fall back gracefully — it renders as tofu (▯) and the
 * "loading" indicator becomes a row of empty boxes. The stack below leads with
 * the faces most likely to carry both families per platform (Cascadia on
 * Windows 11, DejaVu/Noto on Linux + Android, Menlo on macOS/iOS) and ends at
 * the generic `ui-monospace, monospace`. Worth eyeballing on a real handset
 * before shipping a new variant, not just in desktop Chrome.
 *
 * `Noto Sans Symbols2` is listed twice, deliberately. The CSS spelling of that
 * face is «Noto Sans Symbols 2», but the family fontconfig actually registers on
 * Debian/Ubuntu (and on Android) has NO space before the digit. Only the second
 * spelling matches there, and it is the one face on a stock Linux box that
 * carries Braille Patterns at all.
 */
const GLYPH_FONT_STACK = [
  '"Cascadia Mono"',
  '"Cascadia Code"',
  '"DejaVu Sans Mono"',
  '"Noto Sans Mono"',
  '"Noto Sans Symbols 2"',
  '"Noto Sans Symbols2"',
  'Menlo',
  '"Segoe UI Symbol"',
  '"Fira Code"',
  '"Liberation Mono"',
  '"Courier New"',
  'ui-monospace',
  'monospace',
].join(', ');

/**
 * The stack above is handed over as a CUSTOM PROPERTY, and applied by the
 * `![font-family:var(--sk-thinking-font)]` utility on the span rather than by
 * this object.
 *
 * It has to be, because `packages/ui/fonts/plex-sans-arabic.css` ends with a
 * repo-wide
 *
 *     * { font-family: 'IBM Plex Sans Arabic', sans-serif !important; }
 *
 * and an `!important` declaration in a stylesheet outranks a plain inline style.
 * A `style={{ fontFamily }}` here is therefore INERT in every app that imports
 * those fonts — measured: the span computed to «"IBM Plex Sans Arabic", sans-serif»
 * and Chrome resolved the glyphs off DejaVu Sans by per-glyph fallback. A class
 * selector carrying its own `!important` outranks `*` on specificity, so the
 * stack lands. Custom properties are not touched by that rule, which is why the
 * value can still live here in readable form.
 */
const GLYPH_FONT_VAR = '--sk-thinking-font';

const GLYPH_STYLE: React.CSSProperties = {
  // `width` RESERVES the strip before first paint; `minWidth: max-content` is
  // what guarantees it always CONTAINS the glyphs. Both are needed, because the
  // `ch` unit is only honest when every cell is painted by the declared face —
  // and braille never is on a stock Linux/Android box, where no installed
  // monospace family carries U+2800–U+28FF and each cell falls back on its own.
  // Measured at 16.8px with the stack applied: the block-shading cycles do come
  // from a real monospace face (painted 90.94px against a 90.92px `9ch` box, and
  // constant across every frame), but braille resolves to a symbols face and
  // paints 105.73px — 14.8px past the same box. With `max-content` the used
  // width is the larger of the two, so the strip never spills into the gutter,
  // and it is still a FIXED box per variant: every frame of a cycle measured
  // byte-identical, so the label beside it cannot be nudged by a frame swap.
  width: `${THINKING_FRAME_WIDTH}ch`,
  minWidth: 'max-content',
  [GLYPH_FONT_VAR]: GLYPH_FONT_STACK,
  // `dir='ltr'` sets the base direction; `isolate` keeps the strip out of the
  // surrounding bidi run so neighbouring text cannot reorder it.
  unicodeBidi: 'isolate',
  // Fira Code and friends ligate runs of identical glyphs; that would change the
  // cell count mid-animation.
  fontVariantLigatures: 'none',
  letterSpacing: 0,
  whiteSpace: 'pre',
} as React.CSSProperties;

export interface ThinkingProps {
  /** Which animation. Default 'braille-spin'. */
  variant?: ThinkingVariant;
  /** Semantic colour, same key set as every other @repo/ui component. Default 'default' (ink). */
  color?: HeroUIColor;
  /** Optional text rendered beside the glyphs; also becomes the accessible name. */
  label?: React.ReactNode;
  /** ms per frame. Default 90. */
  speedMs?: number;
  className?: string;
  'aria-label'?: string;
}

/** Fallback accessible name when the caller gives neither `label` nor `aria-label`. */
const DEFAULT_A11Y_LABEL = 'Thinking…';

export const Thinking: React.FC<ThinkingProps> = ({
  variant = 'braille-spin',
  color = 'default',
  label,
  speedMs = 90,
  className,
  'aria-label': ariaLabel,
}) => {
  const glyphRef = React.useRef<HTMLSpanElement>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(false);

  const frames = THINKING_FRAMES[variant];
  const staticFrame = frames[STATIC_FRAME_INDEX[variant]];

  // Read the setting after mount so SSR output and the first client paint agree,
  // and keep following it if the user flips it mid-session. When the query does
  // not match, `setPrefersReducedMotion(false)` is a no-op state write and React
  // bails out — so the common path really is zero renders after mount.
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setPrefersReducedMotion(query.matches);

    sync();
    query.addEventListener('change', sync);

    return () => query.removeEventListener('change', sync);
  }, []);

  React.useEffect(() => {
    const node = glyphRef.current;

    if (!node) return;

    // The loop mutates textContent behind React's back, so React's own text
    // reconciliation cannot be trusted to restore a known cell on a re-run
    // (variant change, or motion being switched off mid-animation). Seed it.
    node.textContent = staticFrame;

    if (prefersReducedMotion) return;

    // Guard against a 0/negative speed turning this into a per-frame repaint.
    const period = Math.max(16, speedMs);
    let index = STATIC_FRAME_INDEX[variant];
    let last = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      raf = window.requestAnimationFrame(tick);

      if (now - last < period) return;

      // Resync rather than fast-forwarding: after a hidden tab or a long task we
      // want the next frame, not a burst of catch-up frames.
      last = now;
      index = (index + 1) % frames.length;
      node.textContent = frames[index];
    };

    raf = window.requestAnimationFrame(tick);

    return () => window.cancelAnimationFrame(raf);
  }, [frames, prefersReducedMotion, speedMs, staticFrame, variant]);

  // role='status' takes its accessible NAME from aria-label, not from content,
  // so pass the label through when it is plain text. The glyphs are aria-hidden
  // and the live region's text never changes, so a screen reader is told once —
  // not eleven times a second.
  const accessibleName = ariaLabel ?? (typeof label === 'string' ? label : undefined) ?? DEFAULT_A11Y_LABEL;

  return (
    <span
      aria-busy='true'
      aria-label={accessibleName}
      // `text-[14px]` is the DEFAULT size, not a lock: it and COLOR_CLASS are
      // both single utilities, so a caller's own `text-…` in `className` beats
      // whichever it collides with and leaves the other alone. The glyph sizes
      // itself in `em` off this, so scaling the wrapper scales the strip too —
      // and the `9ch` box scales with it, keeping the no-reflow guarantee.
      className={cn('inline-flex items-center gap-2 align-middle text-[14px]', COLOR_CLASS[color], className)}
      role='status'
    >
      <span
        aria-hidden='true'
        // The `!` is load-bearing — see GLYPH_FONT_VAR. Without it the repo-wide
        // `* { font-family: … !important }` in the shared font stylesheet wins
        // and the strip silently renders in the UI face.
        className='inline-block shrink-0 text-[1.05em] leading-none ![font-family:var(--sk-thinking-font)]'
        dir='ltr'
        ref={glyphRef}
        style={GLYPH_STYLE}
      >
        {staticFrame}
      </span>
      {label ? <span className='font-bold'>{label}</span> : null}
    </span>
  );
};

Thinking.displayName = 'Thinking';
