/**
 * Syllabi — Scrapbook design-system Tailwind preset.
 *
 * Centralizes every custom color/shadow/spacing/animation token used by the
 * scrapbook component library in `@repo/ui`. Apps consume this via:
 *
 *   import scrapbook from '@repo/ui/tailwind.preset';
 *   const config: Config = { presets: [scrapbook], ... };
 *
 * All color tokens reference CSS custom properties defined in
 * `packages/ui/src/styles/scrapbook.css`. That means a token can be:
 *   - changed in ONE place (the .css file) and update everywhere, OR
 *   - overridden per-theme via the `.da-dark` / `[data-theme="dark"]` scope.
 *
 * Component code MUST use the named tokens (e.g. `bg-paper`, `text-ink`,
 * `border-citrine`) rather than `bg-[var(--paper)]` arbitrary values. This
 * gives IntelliSense, lets the design system evolve from one preset, and
 * makes it grep-able in code review.
 *
 * If you need a NEW custom color, add it here AND in scrapbook.css.
 * Don't introduce one-off arbitrary `bg-[#hex]` values in components.
 */

/** @type {Partial<import('tailwindcss').Config>} */
const scrapbookPreset = {
  theme: {
    extend: {
      colors: {
        // Core scrapbook palette — bound to RGB-triplet CSS vars (defined in
        // scrapbook.css next to their hex twins) so Tailwind can compile slash
        // opacity modifiers (`text-ink/65`, `border-ink/20`, `text-paper/60`).
        // A plain `var(--ink)` value is unparseable to Tailwind and makes every
        // `/NN` class silently emit NO css — never regress to that form.
        ink: 'rgb(var(--ink-rgb) / <alpha-value>)',
        paper: {
          DEFAULT: 'rgb(var(--paper-rgb) / <alpha-value>)',
          2: 'rgb(var(--paper-2-rgb) / <alpha-value>)',
        },
        citrine: 'rgb(var(--citrine-rgb) / <alpha-value>)',

        // Brand-color hand-keys (do NOT replace HeroUI's `primary`/`secondary`/
        // etc. — those are managed by the heroui plugin and are theme-aware).
        // These are the *literal* scrapbook hex values, used when the design
        // calls for a stable brand color regardless of HeroUI theme state.
        'sk-primary': 'var(--p)',
        'sk-primary-light': 'var(--p-light)',
        'sk-primary-dark': 'var(--p-dark)',
        // Semantic secondary. `sk-blue` is the LITERAL blue decoration and does
        // not re-theme; this one follows the active palette (orange under sugar).
        'sk-secondary': 'var(--s)',
        'sk-blue': 'var(--b)',
        'sk-green': 'var(--g)',
        'sk-pink': 'var(--pink)',
        'sk-amber': 'var(--amber)',
        'sk-red': 'var(--red)',

        // Soft pastel washes — for sticker fills. Theme-aware: light pastel in
        // light mode, dim tinted dark in dark mode.
        'sk-pink-soft': 'var(--pink-soft)',
        'sk-blue-soft': 'var(--blue-soft)',
        'sk-green-soft': 'var(--green-soft)',
        'sk-amber-soft': 'var(--amber-soft)',
        // Danger's soft fill. Split out of `sk-pink-soft`: pink and red are
        // different families, and the shared token forced danger into a
        // desaturated maroon in dark. Light value is unchanged (#fda4af).
        'sk-red-soft': 'var(--red-soft)',
        'sk-primary-soft': 'var(--primary-soft)',

        // Role tokens. `ink` is TEXT. Borders use `line`, hard shadows use the
        // shadow-* utilities below — never `border-ink` / `shadow-[…var(--ink)]`,
        // which turn into a neon outline and a cream light-leak in dark mode.
        line: {
          DEFAULT: 'rgb(var(--line-rgb) / <alpha-value>)',
          strong: 'rgb(var(--line-strong-rgb) / <alpha-value>)',
          soft: 'var(--line-soft)',
          // `border-line-brand` — the outline for a brand-CONSTANT fill (citrine
          // chip, solid purple/orange/red button). Twin of `text-ink-const`:
          // the fill doesn't flip, so its outline must not either. Using the
          // themed `border-line` on such a fill puts a dim lavender halo around
          // it in dark mode.
          brand: 'rgb(var(--line-on-brand-rgb) / <alpha-value>)',
        },
        // Text that sits on a brand-constant fill (citrine, solid brand) and so
        // must NOT flip with the theme.
        'ink-const': 'rgb(var(--ink-const-rgb) / <alpha-value>)',
        'ink-muted': 'var(--ink-muted)',

        // Elevation ladder. 0 = page, 1 = card, 2 = popover, 3 = hover/highest.
        surface: {
          0: 'var(--surface-0)',
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
        },
      },

      // Brand colors as TEXT take the *-text label tokens, not the fills.
      //
      // A brand color has to be dark enough to carry white text when it's a solid
      // fill, which makes it the wrong lightness to BE text: the fills measure
      // green 2.49:1 / amber 2.11:1 / pink 3.46:1 on the cream paper, and are far
      // too dark on the navy page. scrapbook.css already separates these roles
      // (--g vs --g-text), but nothing ever exposed the label tokens to Tailwind,
      // so every component reached for `text-sk-green` — the FILL — and inherited
      // the failure.
      //
      // `textColor` overrides `colors` for `text-*` utilities ONLY, so fills,
      // borders and shadows below keep resolving to the brand tokens. `text-sk-*`
      // is always a text usage, so this is safe by construction and repairs every
      // `text-sk-*` call site in every app at once.
      textColor: ({ theme }) => ({
        ...theme('colors'),
        'sk-primary': 'var(--p-text)',
      'sk-secondary': 'var(--s-text)',
        'sk-blue': 'var(--b-text)',
        'sk-green': 'var(--g-text)',
        'sk-pink': 'var(--pink-text)',
        'sk-amber': 'var(--amber-text)',
        'sk-red': 'var(--red-text)',
      }),

      boxShadow: {
        // Hard offset shadows — the scrapbook's signature. Cast from
        // --shadow-c, which stays DARK in both themes: a shadow is the absence
        // of light, so flipping it to cream reads as a light leak.
        // CLAY ALIASES. These were the scrapbook's DIAGONAL hard shadows
        // (`2px 2px 0`, `4px 4px 0`, `5px 5px 0`). They are now clay lips —
        // straight DOWN — because 55 app files use `shadow-sk*` directly and no
        // component port reaches any of them. Repointing the utility migrates
        // every one of those call sites without editing them; leaving it would
        // render scrapbook geometry inside clay pages, with nothing erroring.
        // A generic utility cannot derive its lip from a fill the way
        // `clayVars` does, so these use the flat `--shadow-c`. Prefer
        // `clayVars` in a component; these exist for app-level markup.
        'sk-sm': '0 4px 0 var(--shadow-c)',
        sk: '0 6px 0 var(--shadow-c)',
        'sk-lg': '0 8px 0 var(--shadow-c)',
        'sk-xl': '0 10px 0 var(--shadow-c)',
        // The COLOURED ramp was missed when the neutral one above was repointed,
        // so half this map was clay and half was still scrapbook — and a diagonal
        // shadow in a clay page is the one thing this migration set out to remove.
        // These keep their hue (that is what a caller asks for by name) and lose
        // the diagonal. A generic utility cannot derive a mid-tone from the fill
        // the way `clayVars` does, so the lip is the brand colour itself; prefer
        // `clayVars` in a component.
        'sk-primary': '0 6px 0 var(--p)',
        'sk-primary-lg': '0 8px 0 var(--p)',
        'sk-blue': '0 6px 0 var(--b)',
        'sk-green': '0 6px 0 var(--g)',
        'sk-amber': '0 6px 0 var(--amber)',
        'sk-red': '0 6px 0 var(--red)',
        'sk-pink': '0 6px 0 var(--pink)',
        // The "pressed key" state — shadow vanishes.
        'sk-pressed': '0 0 0 var(--shadow-c)',
      },
      borderWidth: {
        // The canonical scrapbook border thickness — between 2 and 3.
        sk: '2.5px',
        // Thinner accents — used on inner sub-elements (Switch track, Select chip,
        // Alert icon wrapper, small Avatar, Drawer close button).
        'sk-thin': '2px',
        'sk-hair': '1.5px',
      },
      borderRadius: {
        // Scrapbook keeps corners flat. These are the only sane values.
        // CLAY ALIASES — was the scrapbook's 4/6/8 ladder, now clay's chunkier
        // 14/18/20. 151 app files use `rounded-sk*`; repointing migrates them
        // all without an edit. Matches CLAY_RADIUS in components/clay.ts.
        'sk-sm': '14px',
        sk: '18px',
        'sk-lg': '20px',
      },
      fontFamily: {
        // Body text — IBM Plex Sans (the bundled "IBM Plex Sans Arabic" family,
        // which carries a full Latin set). Fallbacks already loaded.
        sans: ['IBM Plex Sans Arabic', 'Cairo', 'system-ui', 'sans-serif'],
        /* Hand-written accents. Caveat is NOT loaded by default — an app that
         * wants it adds it itself (a Google Fonts @import is render-blocking).
         * The stack ends in the brand face rather than `cursive`, so a missing
         * Caveat falls back to the body font instead of an OS-chosen face. */
        hand: ['Caveat', 'Kalam', 'IBM Plex Sans Arabic', 'sans-serif'],
      },
      keyframes: {
        // Sourced from scrapbook.css — duplicated here so Tailwind can JIT
        // utility classes like `animate-sk-pulse`.
        'sk-pulse': {
          '0%, 100%': { opacity: '0.6', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.04)' },
        },
        'sk-pulse-soft': {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '0.85' },
        },
        'sk-wiggle': {
          '0%, 100%': { transform: 'rotate(var(--sk-rot, 0deg))' },
          '25%': { transform: 'rotate(calc(var(--sk-rot, 0deg) + 1.2deg))' },
          '75%': { transform: 'rotate(calc(var(--sk-rot, 0deg) - 1.2deg))' },
        },
      },
      animation: {
        'sk-pulse': 'sk-pulse 1.4s ease-in-out infinite',
        'sk-pulse-soft': 'sk-pulse-soft 1.6s ease-in-out infinite',
        'sk-wiggle': 'sk-wiggle 0.5s ease-in-out',
      },
    },
  },
};

module.exports = scrapbookPreset;
module.exports.default = scrapbookPreset;
