import type React from 'react';

/**
 * The toolbar's button states, expressed in the clay Button's OWN vocabulary.
 *
 * The toolbar used to paint its states with Tailwind utilities — `bg-slate-900 text-white` for the
 * active tool, `bg-white/78 text-slate-600 hover:bg-white` for the rest — on top of `@repo/ui`'s
 * Button, which paints its face from `--clay-bg`/`--clay-fg` and ALSO carries its own
 * `hover:bg-[color:var(--clay-wash,var(--clay-bg))]`. Two rules fought for one property and the winner
 * was Tailwind's output order: at rest the utilities won (dark face, white icon); on hover the Button's
 * rule took the FACE back — near-white, its flat-default wash — while the utility kept the ICON white.
 * White on white. On a tablet `:hover` sticks to whatever was last tapped, so the active tool — the one
 * button the teacher had just pressed — was always the invisible one. (Owner's screenshot: Samsung
 * tab, eraser active, an empty white square in the toolbar.)
 *
 * The fix is to stop competing. Each state is a set of `--clay-*` values the Button already reads,
 * passed through `style`, which the Button merges LAST. Face, label, rim and hover wash come from one
 * place, so no state can strand its icon — and the inactive tones no longer need a `hover:` pair at all.
 *
 * These are the toolbar SHELL's tones: the shell is a fixed light glass in both themes, so the fills
 * are literal light-mode colours. Buttons inside a themed popover should take `active`/`brand` only
 * when selected and otherwise leave the Button to paint its own theme-aware flat surface.
 */
export type ToolbarTone = 'active' | 'brand' | 'idle' | 'primary' | 'danger' | 'warning' | 'success' | 'secondary';

type ToneSpec = {
  face: string;
  label: string;
  /** The hover face. Same as `face` where a state must not change under the pointer (the active tool). */
  wash: string;
  /** Rim profile — `brand` for a dark fill, `control` for a pale one whose rim IS its boundary. */
  kind: 'brand' | 'control';
};

// The same ramps the utilities named (slate / sky / rose / amber / emerald / violet), as literals —
// each behind a `--wb-tb-<tone>-<part>` custom property, so a host app can give the shell a dark theme
// from its own stylesheet (Study does, under `.dark`). Unset, every fallback is the literal it always was.
const themed = (tone: string, part: 'face' | 'label' | 'wash', fallback: string) => `var(--wb-tb-${tone}-${part}, ${fallback})`;
const tone = (name: string, face: string, label: string, wash: string): ToneSpec => ({
  face: themed(name, 'face', face),
  label: themed(name, 'label', label),
  wash: themed(name, 'wash', wash),
  kind: 'control',
});

const TONES: Record<ToolbarTone, ToneSpec> = {
  active: {
    face: themed('active', 'face', 'rgb(var(--st-accent, 47 91 234))'),
    label: themed('active', 'label', '#ffffff'),
    wash: themed('active', 'face', 'rgb(var(--st-accent, 47 91 234))'),
    kind: 'brand',
  },
  // The selected nib in the pen popover: the citrine chip. Both tokens are theme-constant by design.
  brand: { face: 'var(--citrine)', label: 'var(--ink-const)', wash: 'var(--citrine)', kind: 'control' },
  idle: tone('idle', '#ffffff', '#18204a', '#f1eee4'),
  primary: tone('primary', 'rgba(240, 249, 255, 0.92)', '#0369a1', '#e0f2fe'),
  danger: tone('danger', 'rgba(255, 241, 242, 0.92)', '#e11d48', '#ffe4e6'),
  warning: tone('warning', 'rgba(255, 251, 235, 0.92)', '#b45309', '#fef3c7'),
  success: tone('success', 'rgba(236, 253, 245, 0.92)', '#047857', '#d1fae5'),
  secondary: tone('secondary', 'rgba(245, 243, 255, 0.92)', '#6d28d9', '#ede9fe'),
};


// Clay keys like the rest of the board chrome: a soft edge and a solid lip straight DOWN in that edge
// colour, no glow. Study's `--st-*` tokens drive the edge; outside Study the light values apply.
const NEUTRAL_EDGE = 'rgb(var(--st-clay-edge, 205 209 224))';
const EDGE: Partial<Record<ToolbarTone, string>> = {
  active: 'rgb(var(--st-accent-lip, 43 76 190))',
  brand: 'rgb(var(--st-star-lip, 214 150 20))',
};

const surfaceFor = (name: ToolbarTone, { face, label, wash }: ToneSpec): React.CSSProperties => {
  const edge = EDGE[name] ?? NEUTRAL_EDGE;

  return {
    '--clay-bd': edge,
    '--clay-bg': face,
    '--clay-fg': label,
    '--clay-focus': label,
    '--clay-wash': wash,
    '--clay-rest': `0 4px 0 ${edge}`,
    '--clay-hover': `0 3px 0 ${edge}`,
    '--clay-active': `0 1px 0 ${edge}`,
  } as React.CSSProperties;
};

/** One frozen style object per tone — stable identities, so memoized buttons do not re-render on them. */
export const TOOLBAR_SURFACE: Record<ToolbarTone, React.CSSProperties> = Object.freeze(
  Object.fromEntries((Object.keys(TONES) as ToolbarTone[]).map((tone) => [tone, surfaceFor(tone, TONES[tone])])),
) as Record<ToolbarTone, React.CSSProperties>;

const penFaceCache = new Map<string, React.CSSProperties>();

/**
 * The active pen key painted in the pen's own colour: a darker rung of it for the edge and lip, and an
 * ink or white glyph by luminance so the icon stays readable on yellow as on navy.
 */
export function penSurface(hex: string): React.CSSProperties {
  const key = hex.toLowerCase();
  const cached = penFaceCache.get(key);

  if (cached) return cached;
  const m = /^#?([0-9a-f]{6})$/i.exec(key);

  if (!m) return TOOLBAR_SURFACE.active;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lin = (c: number) => {
    const s = c / 255;

    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const rung = (c: number) => Math.round(c * 0.72 + 24 * 0.28);
  const edge = lum > 0.85 ? 'rgb(var(--st-clay-edge, 205 209 224))' : `rgb(${rung(r)}, ${rung(g)}, ${rung(b)})`;
  const style = {
    '--clay-bd': edge,
    '--clay-bg': `#${m[1]}`,
    '--clay-fg': lum > 0.4 ? '#18204a' : '#ffffff',
    '--clay-focus': edge,
    '--clay-wash': `#${m[1]}`,
    '--clay-rest': `0 4px 0 ${edge}`,
    '--clay-hover': `0 3px 0 ${edge}`,
    '--clay-active': `0 1px 0 ${edge}`,
  } as React.CSSProperties;

  penFaceCache.set(key, style);

  return style;
}
