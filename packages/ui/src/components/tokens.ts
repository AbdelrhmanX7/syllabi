// da-v2 design tokens — Scrapbook (Direction B). TypeScript constants paired
// with the CSS custom properties in `../styles/scrapbook.css`. Importing apps
// can use these from `@repo/ui` for inline styles or computed values.
//
// THESE MUST STAY CSS VARS, NOT HEX. Components feed them into inline
// `style={{ ... }}` (usually as `--sk-bd` / `--sk-bg` / `--sk-fg` / `--sk-sh`),
// so a literal hex here is frozen at authoring time and cannot follow the
// theme. When these were hex, dark mode inherited light-mode ink for every
// border and shadow (invisible against a dark page) and light-mode paper for
// every surface (a blinding white slab).
//
// Pick by ROLE, not by appearance:
//   INK        text / foreground          (flips: navy -> cream)
//   LINE       borders, drawn outlines    (flips: ink -> dimmed lavender)
//   SHADOW_C   hard offset shadows        (stays DARK in both themes)
//   INK_ON_BRAND  text on a brand-constant fill (citrine, purple) — never flips
//   SURFACE_*  the elevation ladder
// A shadow drawn with INK becomes a cream light-leak in dark mode; a border
// drawn with INK becomes a neon wireframe. Use LINE and SHADOW_C.

export const INK = 'var(--ink)';
export const PAPER = 'var(--paper)';
export const PAPER_DARK = 'var(--paper-2)';

/** Border / outline color. */
export const LINE = 'var(--line)';
export const LINE_STRONG = 'var(--line-strong)';
export const LINE_SOFT = 'var(--line-soft)';

/**
 * Outline drawn AROUND a brand-CONSTANT fill (solid purple/orange/red button,
 * citrine chip). Twin of INK_ON_BRAND: the fill doesn't flip, so neither its
 * label nor its outline may. Drawing one with the themed LINE is what ringed the
 * purple button in dim lavender (#4a4f7d) in dark — 1.09:1 against its own fill.
 * Pick by what's UNDER the border, not by what's around the component.
 */
export const LINE_ON_BRAND = 'var(--line-on-brand)';

/** Hard offset shadow color — dark in BOTH themes (a shadow is not a light). */
export const SHADOW_C = 'var(--shadow-c)';

/** Foreground for text/marks on brand-constant fills (citrine, solid brand). */
export const INK_ON_BRAND = 'var(--ink-const)';

/** Muted / secondary text. */
export const INK_MUTED = 'var(--ink-muted)';

/** Elevation ladder. 0 = page, 1 = card, 2 = popover/menu, 3 = hover/highest. */
export const SURFACE_0 = 'var(--surface-0)';
export const SURFACE_1 = 'var(--surface-1)';
export const SURFACE_2 = 'var(--surface-2)';
export const SURFACE_3 = 'var(--surface-3)';

/**
 * Translucent tint of a token color. Use instead of hex-alpha concatenation
 * (`${INK}55`), which silently produces invalid CSS now that the tokens are
 * `var(--…)` rather than 6-digit hex.
 */
export function tint(color: string, percent: number): string {
  return `color-mix(in oklch, ${color} ${percent}%, transparent)`;
}

// Brand colors — constant across LIGHT and DARK, so these stay literal hex.
// "Constant across light and dark" is not the same as "not themeable": an
// alternate palette can re-base the brand entirely, and a literal here
// cannot follow it. Same split the accents already use — literal for charts,
// `*_UI` var alias for anything that paints a surface. See AMBER_UI/RED_UI.
// Primary (purple in the default palette) palette
export const PRIMARY = '#2f5bea';
export const PRIMARY_LIGHT = '#6e8cff';
export const PRIMARY_DARK = '#2349c9';

/**
 * Brand as a UI FILL — theme-aware, CSS-only. Use these, NOT the literals,
 * anywhere the brand paints a surface, border or hard shadow.
 *
 * Why this exists: the HEROUI_COLOR_* maps below used the literals, so every
 * scrapbook component (Button, Card, Chip, …) painted a fixed purple no matter
 * what the active theme said. Under a warm palette that produced a page with a
 * warm ink outline wrapped around a purple button — two palettes in one view.
 *
 * `--s` is the SEMANTIC secondary, deliberately separate from `--b` (literal
 * blue). They are the same color in the default palette, but `--b` also paints
 * `sk-blue` decoration, which must stay blue when the brand is not.
 */
export const PRIMARY_UI = 'var(--p)';
export const PRIMARY_LIGHT_UI = 'var(--p-light)';
export const PRIMARY_DARK_UI = 'var(--p-dark)';
export const SECONDARY_UI = 'var(--s)';
export const SECONDARY_SOFT = 'var(--s-soft)';

// Accents.
// NOTE: these stay LITERAL HEX on purpose — apps feed them straight into
// Recharts (`<Bar fill={RED} />`), which writes an SVG presentation attribute,
// and a `var()` there is not reliably resolved. Anything that PAINTS a themed
// UI surface must use the *_UI aliases below instead.
export const CITRINE = '#ffc93c';
export const PINK = '#ec4899';
export const BLUE = '#006fee';
export const GREEN = '#22c55e';
export const AMBER = '#f59e0b';
export const RED = '#e11d48';

/**
 * Warning/danger as a UI FILL — theme-aware, CSS-only.
 *
 * The warning family rotates amber -> orange in dark: amber is a yellow, and a
 * yellow can only survive on a dark page by going dark itself, at which point
 * it is olive. Orange keeps its identity at low lightness. Light mode is
 * unchanged (--amber is still #f59e0b there).
 *
 * Use these — NOT the AMBER/RED literals — anywhere the color paints a surface,
 * border or shadow. Use the literals only for charts/canvas.
 */
export const AMBER_UI = 'var(--amber)';
export const RED_UI = 'var(--red)';

/** Danger's soft/flat fill. Split from PINK_SOFT (which it used to borrow) —
 *  pink and red are different families, and sharing forced danger into a
 *  desaturated maroon in dark. Light value is identical to the old PINK_SOFT. */
export const RED_SOFT = 'var(--red-soft)';

// Soft sticker fills. Theme-aware: light pastel in light mode, dim tinted dark
// in dark mode. Anything sitting ON one of these takes the flipping INK, since
// fill and foreground move together.
export const PINK_SOFT = 'var(--pink-soft)';
export const BLUE_SOFT = 'var(--blue-soft)';
export const GREEN_SOFT = 'var(--green-soft)';
export const AMBER_SOFT = 'var(--amber-soft)';
export const PRIMARY_SOFT = 'var(--primary-soft)';
export const DEFAULT_SOFT = 'var(--default-soft)';

// Tape colors (translucent washi)
export const TAPE_YELLOW = 'rgba(255,235,120,0.85)';
export const TAPE_PINK = 'rgba(252,165,165,0.85)';
export const TAPE_BLUE = 'rgba(147,197,253,0.85)';
export const TAPE_GREEN = 'rgba(134,239,172,0.85)';

// Hard offset shadows — never blurred, and never drawn with INK (see header).
export const SHADOW_INK = `4px 4px 0 ${SHADOW_C}`;
export const SHADOW_INK_LG = `6px 6px 0 ${SHADOW_C}`;
export const SHADOW_PRIMARY = `4px 4px 0 ${PRIMARY_UI}`;
export const SHADOW_PRIMARY_LG = `6px 6px 0 ${PRIMARY_UI}`;

export const BORDER_INK = `2.5px solid ${LINE}`;
export const BORDER_INK_THIN = `2px solid ${LINE}`;

export const RADIUS_SM = 4;
export const RADIUS_MD = 6;
export const RADIUS_LG = 8;

// Per-shadow-color map used by primitives. `ink` is the neutral/default shadow
// and resolves to the dark shadow color, not to the (flipping) text ink.
export const SHADOW_COLOR_MAP = {
  ink: SHADOW_C,
  primary: PRIMARY_UI,
  pink: PINK,
  blue: BLUE,
  green: GREEN,
  amber: AMBER_UI,
  red: RED_UI,
} as const;

export type ShadowColor = keyof typeof SHADOW_COLOR_MAP;

// HeroUI semantic color → scrapbook hard-shadow tint.
export const HEROUI_COLOR_SHADOW: Record<HeroUIColor, string> = {
  default: SHADOW_C,
  primary: PRIMARY_UI,
  secondary: SECONDARY_UI,
  success: GREEN,
  warning: AMBER_UI,
  danger: RED_UI,
};

// HeroUI semantic color → border/outline color.
export const HEROUI_COLOR_BORDER: Record<HeroUIColor, string> = {
  default: LINE,
  primary: PRIMARY_UI,
  secondary: SECONDARY_UI,
  success: GREEN,
  warning: AMBER_UI,
  danger: RED_UI,
};

/**
 * HeroUI semantic color → the outline drawn around its SOLID fill.
 *
 * `default` fills with a themed surface (SURFACE_1), so it takes the themed
 * LINE — a constant near-black outline would vanish on the dark card. Every
 * other color fills with a brand CONSTANT, so it takes the constant outline.
 * Get this backwards and dark mode either loses the border entirely or rings
 * the sticker in dim lavender. See LINE_ON_BRAND.
 */
export const HEROUI_COLOR_OUTLINE: Record<HeroUIColor, string> = {
  default: LINE,
  primary: LINE_ON_BRAND,
  secondary: LINE_ON_BRAND,
  success: LINE_ON_BRAND,
  warning: LINE_ON_BRAND,
  danger: LINE_ON_BRAND,
};

// HeroUI semantic color → brand-as-TEXT color, for when the brand tints a
// label rather than filling a surface (ghost/bordered/light buttons, colored
// links, icons). Same as the brand in light mode; lightened in dark, where the
// true brand is too dark to read as text. Do NOT use these as fills.
export const HEROUI_COLOR_TEXT: Record<HeroUIColor, string> = {
  default: INK,
  primary: 'var(--p-text)',
  secondary: 'var(--s-text)',
  success: 'var(--g-text)',
  warning: 'var(--amber-text)',
  danger: 'var(--red-text)',
};

// HeroUI semantic color → solid background fill (sticker face).
// `default` is the card surface, so it rises with the theme instead of being a
// fixed sheet of paper.
export const HEROUI_COLOR_FILL: Record<HeroUIColor, string> = {
  default: SURFACE_1,
  primary: PRIMARY_UI,
  secondary: SECONDARY_UI,
  success: GREEN,
  warning: AMBER_UI,
  danger: RED_UI,
};

// Foreground for the solid fills above. The brand fills are constant, so their
// foregrounds are literal; `default` sits on a themed surface, so it flips.
// WCAG (dark-mode fills; light is unchanged and was already passing):
//   primary #2f5bea + #fff        = 7.15:1
//   warning #fb923c + INK_ON_BRAND = 8.39:1  (white on it would be 2.26:1)
//   danger  #e11d48 + #fff        = 4.70:1  — this is why the danger fill is
//     NOT brightened to #f43f5e, which drops white to 3.67:1 and fails AA.
// `primary`/`secondary` are var-backed because the fill they sit on is now
// var-backed too. White is correct on the default purple (7.15:1) and wrong on
// a light amber brand (1.99:1 — fails AA outright), so the label moves with the
// fill rather than being pinned to one palette's answer.
export const HEROUI_COLOR_FOREGROUND: Record<HeroUIColor, string> = {
  default: INK,
  primary: 'var(--p-fg)',
  secondary: 'var(--s-fg)',
  // White, by explicit owner decision, on a fill that does not support it.
  // #ffffff on #22c55e measures 2.28:1 — below AA (4.5), below the 3:1 non-text
  // floor, and worse than the 2.54:1 this file previously flagged as a defect.
  // Ink on the same fill is 8.34:1.
  // This is recorded rather than silently "fixed": the owner chose a bright
  // green and a white label after the trade was stated, and a later reader
  // finding 2.28:1 should know it is a decision, not an oversight. White needs a
  // fill at luminance <= 0.183; #22c55e sits at 0.446.
  success: '#ffffff',
  warning: INK_ON_BRAND,
  danger: '#ffffff',
};

// Soft fill for flat/bordered/faded variants. Every entry is theme-aware, so
// the paired foreground is always the flipping INK — they move together.
// Dark-mode label contrast (all pair with the flipping INK = #f1eee4):
//   warning #6b2f0d = 9.13:1   (was #4a3815, 56% sat — olive mud)
//   danger  #701528 = 10.19:1  (was PINK_SOFT #4a1f2c, 41% sat — maroon mud)
export const HEROUI_COLOR_SOFT_FILL: Record<HeroUIColor, string> = {
  default: DEFAULT_SOFT,
  primary: PRIMARY_SOFT,
  secondary: SECONDARY_SOFT,
  success: GREEN_SOFT,
  warning: AMBER_SOFT,
  danger: RED_SOFT,
};

export type HeroUIColor = 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
export type HeroUIVariant = 'solid' | 'flat' | 'bordered' | 'light' | 'ghost' | 'shadow';
export type HeroUISize = 'sm' | 'md' | 'lg';
export type HeroUIRadius = 'none' | 'sm' | 'md' | 'lg' | 'full';

// Deterministic rotation ladder. Use a stable seeded pick instead of Math.random
// so SSR / hydration / re-renders stay consistent.
const ROTATIONS = [-0.6, 0.4, -0.4, 0.8, -0.5, 0.6, -0.3, 0.5];

/**
 * Default rotation for inline controls (Button, Input, Chip, etc.) — disabled.
 * Density of rotated controls on a real page is overwhelming; keep them flat.
 * Surfaces that should still rotate (Card, Alert, Accordion) use
 * `pickSurfaceRotation` instead.
 */
export function pickRotation(_seed: number): number {
  return 0;
}

/**
 * Slight seeded rotation for "paper" surfaces — cards, callouts, accordion
 * panels, toasts. Reads as scrapbook character without overwhelming the page.
 */
export function pickSurfaceRotation(seed: number): number {
  return ROTATIONS[Math.abs(seed) % ROTATIONS.length];
}

export const TOKENS = {
  INK,
  PAPER,
  PRIMARY,
  CITRINE,
  PINK,
  BLUE,
  GREEN,
  AMBER,
  RED,
} as const;
