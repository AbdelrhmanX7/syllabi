import type React from 'react';

/**
 * The clay recipe, in one place.
 *
 * Clay replaces the scrapbook language across `@repo/ui` (owner decision,
 * 2026-08-27). Its construction is:
 *   - a 3px edge in a mid-tone OF THE FILL          (not the scrapbook's ink)
 *   - a solid lip `0 6px 0` directly BELOW it       (not a diagonal 4px 4px)
 *   - an ambient glow tinted with the fill
 * It reads as a physical object rather than paper on a desk.
 *
 * WHY THIS IS A HELPER AND NOT COPIED PER COMPONENT: 46 components have to move.
 * Hand-tuning each one is how a design system ends up with 46 slightly different
 * lips. Every value below is derived from a single `fill` argument, so a
 * component only has to say WHICH token it is painting and whether it is
 * pressable.
 *
 * WHY `color-mix` AND NOT THE NUMBERED RAMP: the HeroUI numbered ramps INVERT in
 * dark mode (600 is lighter than 500 there), which would put a lighter lip under
 * a button and destroy the illusion.
 *
 * THE EDGE AND THE LIP MIX TOWARD DIFFERENT THINGS, and the reason matters:
 *
 *   edge -> `hsl(var(--heroui-foreground))`. A rim's job is to separate the
 *     control from what is behind it, so it SHOULD follow the theme: dark rim on
 *     a light page, light rim on a dark one. Inverting is correct here.
 *
 *   lip  -> `var(--shadow-c)`. A shadow's job is to be darker than the thing
 *     casting it, in every theme. An earlier version mixed this toward the
 *     foreground too, with a comment claiming that "cannot invert" — it does.
 *     Measured on the dark primary fill (#2f5bea, L 0.097) the lip came out at
 *     L 0.220, more than twice as LIGHT as the button it sits under. Every clay
 *     component was casting a highlight downward in dark mode.
 *     `--shadow-c` is the scrapbook system's own answer to exactly this, and its
 *     definition already says why: "Hard offset shadow color. Stays dark in BOTH
 *     themes (a shadow is not a light)." Mixing toward plain #000 would also
 *     work numerically but produces a cold grey under a warm fill; --shadow-c
 *     is the palette's dark, not a neutral one.
 *
 * KNOWN LIMIT — a near-black fill has no clay. Both the edge and the lip are
 * derived FROM the fill, so when the fill is already at or below `--shadow-c`'s
 * luminance there is nothing darker to mix toward and `color-mix` returns the
 * fill again. Measured (lip minus fill luminance; ~0 means the lip vanished):
 *     `default` ON knob, light, fill #000        -0.001
 *     `warning` knob, light, fill #0f232e        +0.002
 *     `warning` knob, dark,  fill #18204a        +0.001
 * The same happens to the edge in light mode, for the same reason. Such a
 * surface is a featureless silhouette with no rim and no lip.
 * This is honest behaviour for `color-mix`, not a bug with a fix inside the
 * helper: there is no darker than near-black. It does not matter on a small
 * FACE that reads by contrast against what it sits on (a black knob on a white
 * track is 21:1), and it matters a great deal on a large SURFACE, which loses
 * its clay-ness entirely. So: do not paint a big clay slab with a near-black
 * fill — `CLAY_LABEL.warning` and a `default` fill in dark are the two that
 * will tempt you. Found by the Switch port.
 */

/**
 * How far the edge and lip are darkened from the fill, per surface kind.
 *
 * There are three because the EDGE does a different job in each, and the job
 * decides the contrast floor it owes:
 *   brand    the fill carries the identity; the edge is a highlight on it.
 *   surface  a large near-white panel. Its 8px lip already draws the boundary,
 *            so the edge only has to hint at a bevel.
 *   control  a small near-white control — a checkbox, a radio, a switch track.
 *            Here the RIM IS THE CONTROL: there is no label inside doing the
 *            identifying the way a button has one, so WCAG 1.4.11 puts a 3:1
 *            floor on it. `surface`'s edge measures 1.23:1 against a white card
 *            and is invisible; the scrapbook rim it replaces was near-black ink
 *            at ~15:1, so shipping `surface` on a checkbox is a visible
 *            regression, not merely a technical fail.
 *
 * `control` is 50, not the 55 that first clears the bar: 55 measures 3.05:1,
 * nine hundredths of margin, and thin margins have failed four separate times in
 * this codebase's contrast history. 50 gives 3.60 light / 4.78 dark.
 */
const MIX = {
  /** Saturated brand fills. */
  brand: { edge: 82, drop: 68 },
  /** Large near-white panels: darkened as hard as a brand fill they just turn grey. */
  surface: { edge: 90, drop: 80 },
  /** Small near-white controls whose rim IS the boundary. */
  control: { edge: 50, drop: 80 },
} as const;

export type ClayKind = keyof typeof MIX;

export type ClayOptions = {
  /**
   * Derive the EDGE and LIP from this colour instead of from `fill`.
   *
   * A flat/soft variant paints a pale WASH as its face, and a rim derived from
   * a wash is a paler wash — measured 1.69-2.42:1 against the page for the brand
   * flats, i.e. no boundary at all. The `bordered` variant proves the mechanism
   * is fine when it is fed a real colour (3.09-9.07:1); what was missing was a
   * way to say "the face is pale, but the SHAPE is drawn from the full brand".
   *
   * So: `clayVars(HEROUI_COLOR_SOFT_FILL[color], { shapeFrom: CLAY_FILL[color] })`
   * — the soft ramp lives in `./tokens`, not here. (An earlier version of this
   * line said `CLAY_SOFT`, which does not exist; following the docstring gave
   * you an undefined import.)
   *
   * Use it ONLY where the face genuinely cannot produce its own rim. A
   * `bordered` or `ghost` variant's rim IS the brand, taken directly — 7.02
   * light / 8.29 dark — and routing that through `shapeFrom` would mix it 82%
   * toward the foreground, making a crisp outline muddy to solve a problem it
   * does not have.
   * Found by the Alert/Toast port; scoped by the Button port.
   */
  shapeFrom?: string;
  /**
   * Which edge the lip falls from. Default `'bottom'` — an object resting on a
   * page. A DRAWER does not rest on the page: it is anchored to a viewport edge,
   * and a bottom lip on a right-anchored drawer falls off-screen. Three of the
   * four placements need this. Found by the Modal/Drawer port.
   */
  from?: 'bottom' | 'top' | 'left' | 'right';
  /** Which mix profile — a saturated fill or a near-white surface. */
  kind?: ClayKind;
  /** Lip depth at rest, in px. Buttons 6, larger surfaces 8. */
  depth?: number;
  /** Recessed (tier 3): the lip becomes an INSET. A field is a hole, not a slab. */
  inset?: boolean;
};

/**
 * Returns the `--clay-*` custom properties for a fill. Pair with the `.clay-btn`
 * (pressable) or `.clay-surface` (static) class, which switch between them —
 * hover/active box-shadows cannot be expressed inline.
 *
 * `fill` must be a CSS colour that `color-mix` accepts, normally
 * `hsl(var(--heroui-primary))` or a `var(--…)` token.
 */
export function clayVars(fill: string, opts: ClayOptions = {}): React.CSSProperties {
  const { kind = 'brand', depth = 6, inset = false, from = 'bottom', shapeFrom } = opts;
  const { edge, drop } = MIX[kind];
  // See the header: the rim follows the theme, the shadow must not.
  const rim = 'hsl(var(--heroui-foreground))';
  const dark = 'var(--shadow-c)';
  // The shape may be drawn from a different colour than the face — see `shapeFrom`.
  const shape = shapeFrom ?? fill;
  const edgeC = `color-mix(in srgb, ${shape} ${edge}%, ${rim})`;
  // The groove's bottom highlight. Mixes toward WHITE, not toward the theme
  // foreground: a highlight is light in BOTH themes, exactly as a shadow is dark
  // in both. Mixing toward the foreground darkens it in light mode, making it a
  // second shadow and REDUCING the groove — measured 40 -> 23 luma written that
  // way. Against a near-white surface, white-on-white is harmlessly invisible;
  // against a near-black one it is the only cue with room to move.
  const rimSoft = `color-mix(in srgb, ${fill} 78%, #ffffff)`;
  const dropC = `color-mix(in srgb, ${shape} ${drop}%, ${dark})`;
  const glow = (pct: number) => `color-mix(in srgb, ${fill} ${pct}%, transparent)`;

  if (inset) {
    // Recessed: the same vocabulary pointing the other way. No hover lift — a
    // hole does not rise — so all three states are the one inset, and only the
    // focus ring changes.
    // A physical groove is lit from TWO sides: shadow along the top inner edge,
    // highlight along the bottom. One-sided works in light, where a near-white
    // surface has room to darken — and fails in dark, where `--shadow-c`
    // (#0a0e24) is ALREADY darker than the surface it shades (#141a3b), so the
    // mix barely moves. Measured recess amplitude at 8x, centre column:
    //   light 40 luma   dark 4 luma  <- one-sided: honest, but invisible
    // The bottom highlight is what carries it in dark. It mixes toward WHITE —
    // see `rimSoft` below. A highlight is light in BOTH themes, exactly as a
    // shadow is dark in both; only a RIM follows the theme. Writing this one
    // toward `--heroui-foreground` darkens it in light mode, turning it into a
    // second shadow and cutting the light groove from 40 to 23 luma.
    // Found by the Checkbox/Radio port after it caught itself reading an emboss
    // as a recess.
    const lo = `inset 0 ${depth / 2}px ${depth / 2}px ${dropC}`;
    const hi = `inset 0 -${Math.max(2, depth / 3)}px ${Math.max(3, depth / 2)}px ${rimSoft}`;
    return {
      '--clay-edge': edgeC,
      '--clay-rest': `${lo}, ${hi}`,
      '--clay-hover': `${lo}, ${hi}`,
      '--clay-active': `inset 0 ${depth}px ${depth}px ${dropC}, ${hi}`,
    } as React.CSSProperties;
  }

  // Offsets for the lip and its ambient glow, per anchor edge.
  const dir = { bottom: [0, 1], top: [0, -1], left: [-1, 0], right: [1, 0] }[from] as [number, number];
  const off = (n: number) => `${dir[0] * n}px ${dir[1] * n}px`;

  return {
    '--clay-edge': edgeC,
    '--clay-rest': `${off(depth)} 0 ${dropC}, ${off(depth + 2)} ${depth * 3.3}px ${glow(30)}`,
    '--clay-hover': `${off(depth - 2)} 0 ${dropC}, ${off(depth)} ${depth * 2.6}px ${glow(35)}`,
    '--clay-active': `${off(1)} 0 ${dropC}, ${off(2)} 6px ${glow(25)}`,
  } as React.CSSProperties;
}

/** Fill + label for a HeroUI semantic colour, as CSS colour strings. */
export const CLAY_FILL = {
  default: 'hsl(var(--heroui-content1))',
  primary: 'hsl(var(--heroui-primary))',
  secondary: 'hsl(var(--heroui-secondary))',
  success: 'hsl(var(--heroui-success))',
  warning: 'hsl(var(--heroui-warning))',
  danger: 'hsl(var(--heroui-danger))',
} as const;

export const CLAY_LABEL = {
  default: 'hsl(var(--heroui-foreground))',
  primary: 'hsl(var(--heroui-primary-foreground))',
  secondary: 'hsl(var(--heroui-secondary-foreground))',
  success: 'hsl(var(--heroui-success-foreground))',
  warning: 'hsl(var(--heroui-warning-foreground))',
  danger: 'hsl(var(--heroui-danger-foreground))',
} as const;

export type ClayColor = keyof typeof CLAY_FILL;

/**
 * KNOWN FLAW — this picks a profile by the token's NAME, not by the fill's
 * LUMINANCE, and the two come apart.
 *
 * It assumes "not `default`" implies "saturated and dark enough that an 82% mix
 * reads as a rim". Any light fill breaks that, and the failure lands in LIGHT
 * mode, which is the opposite of where you would look for it. What a rim owes
 * contrast to is the CARD BEHIND IT, not its own fill:
 *
 *   citrine (L 0.746) rim vs page, `brand` profile   1.95:1  FAILS
 *   citrine              same,     `control` profile 4.86:1  passes
 *
 * And it is not only citrine. A flat/soft variant paints a pastel face while
 * still being named `primary`, so it takes `brand` too. Live today: `solid`
 * `warning` in light is #f5a524 (L 0.44) and its rim measures **3.14:1** —
 * over the floor by 0.14. This repo ships palette overrides (a teacher site
 * sets `--surface-1`), and `tokens.ts` already warns that a warm palette turns
 * the brand amber. One palette change puts a brand-profile rim under 3:1 with
 * no code change anywhere.
 *
 * The rule the code cannot yet express: **a fill at luminance >= ~0.5 wants
 * `control`, whatever it is named.** CSS cannot branch on a `var()`'s luminance
 * and the fills arrive here as var() strings, so until that is solved, pass the
 * profile explicitly — `clayVars(fill, { kind: 'control' })` — for citrine, for
 * flat/soft faces, and for any brand fill you can see is light. Found by the
 * Chip port, which measured it rather than assuming the name was reliable.
 *
 * THE RULE, named precisely after three independent ports converged on it:
 *
 *     The mix profile follows the SHAPE'S LUMINANCE — not the face's, and not
 *     the `color` prop.
 *
 * `clayKindFor` cannot be asked that, because it selects a profile by asking
 * about a colour NAME. The three ports each hit a different face of it:
 *   - a Chip needs `control` for its SIZE, at any hue
 *   - a dialog needs `control` for its GROUND (a scrim, not a card)
 *   - a flat Input needs `brand` for its SHAPE'S luminance while the face stays
 *     pale — `control` over-darkens a saturated `shapeFrom`, turning an invalid
 *     rim into a near-black maroon instead of a red
 *
 * `shapeFrom` removed the first of the three from the pile. Until the helper can
 * be asked the real question, **pass `kind` explicitly** whenever the fill is
 * light, the ground is unusual, the object is small, or `shapeFrom` is set —
 * i.e. any time you can see the answer and the function cannot. The idiom the
 * Input port used is a good one:
 *
 *     kind: shape ? 'brand' : 'control'
 *
 * SECOND TERM — the profile also depends on the GROUND, not only the fill.
 * "Large panel => `surface`" is sound for a card on a page and wrong for a
 * dialog on a dark scrim, where the same near-white fill needs a much stronger
 * rim to separate from what is behind it. `clayKindFor` sees neither the
 * ground nor the luminance, so for anything that floats above a scrim, pass
 * `kind` explicitly and measure against the scrim rather than the page.
 * Found by the Modal/Drawer port.
 *
 * `default` paints a near-white surface; every other colour is a brand fill.
 *
 * `small` is for controls whose RIM is the boundary — checkbox, radio, switch
 * track, a small default chip. Pass it and a `default`-coloured control gets the
 * `control` profile (3:1 rim) instead of `surface` (1.23:1, invisible at that
 * size). A brand-filled control does not need it: its fill already separates it
 * from the card.
 */
export const clayKindFor = (color: ClayColor, small = false): ClayKind =>
  color === 'default' ? (small ? 'control' : 'surface') : 'brand';

/**
 * The rim a component draws when it FRAMES ARBITRARY CONTENT — a photograph, an
 * uploaded image, a user's initials on a computed gradient.
 *
 * Such a component cannot derive its edge from its fill the way a button can,
 * because it does not control its fill: an avatar's fill is whatever the user
 * uploaded, and nothing about it can be relied on to differ from the card
 * behind it. So the rim is a fixed neutral, taken from the `control` profile
 * because — like a checkbox's — this rim IS the boundary.
 *
 * It also does separator duty: `AvatarGroup` overlaps by -12px, and the rim is
 * what stops a stack fusing into one blob. Measured in both roles:
 *     rim vs card                3.88:1 light / 5.27:1 dark
 *     rim vs the avatar it laps  3.95:1 light / 4.79:1 dark
 *
 * Extracted after Avatar and Image computed the identical expression
 * independently. Every tier-4 component that frames content wants this one.
 */
export const CLAY_RIM = (clayVars(CLAY_FILL.default, { kind: 'control' }) as Record<string, string>)[
  '--clay-edge'
] as string;

/** Clay's radius ladder. Chunkier than the scrapbook's 4/6/8. */
// Mirrors the --radius-* ladder in scrapbook.css (sm 8 / md 12 / lg 16); xl kept as an alias of lg.
export const CLAY_RADIUS = { sm: 8, md: 12, lg: 16, xl: 16 } as const;
