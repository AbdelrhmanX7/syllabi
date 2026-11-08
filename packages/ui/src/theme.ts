export const heroUIThemeConfig = {
  themes: {
    light: {
      colors: {
        default: {
          50: '#f5f5f5',
          100: '#e8e8e9',
          200: '#d1d1d3',
          300: '#b9b9bd',
          400: '#a2a2a7',
          500: '#8b8b91',
          600: '#6f6f74',
          700: '#535357',
          800: '#37373a',
          900: '#1b1b1d',
          foreground: '#000',
          DEFAULT: '#8b8b91',
        },
        primary: {
          50: '#eef2fe',
          100: '#e3e9fd',
          200: '#c3d0fb',
          300: '#8fa6f5',
          400: '#6e8cff',
          500: '#2f5bea',
          600: '#2349c9',
          700: '#1c3aa3',
          800: '#172e7d',
          900: '#111f52',
          foreground: '#fff',
          DEFAULT: '#2f5bea',
        },
        secondary: {
          50: '#dfedfd',
          100: '#b3d4fa',
          200: '#86bbf7',
          300: '#59a1f4',
          400: '#2d88f1',
          500: '#006fee',
          600: '#005cc4',
          700: '#00489b',
          800: '#003571',
          900: '#002147',
          foreground: '#fff',
          DEFAULT: '#006fee',
        },
        success: {
          50: '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
          800: '#065f46',
          900: '#064e3b',
          foreground: '#fff',
          DEFAULT: '#22c55e',
        },
        warning: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
          900: '#78350f',
          foreground: '#0f232e',
          DEFAULT: '#f59e0b',
        },
        danger: {
          50: '#fff1f2',
          100: '#ffe4e6',
          200: '#fecdd3',
          300: '#fda4af',
          400: '#fb7185',
          500: '#f43f5e',
          600: '#e11d48',
          700: '#be123c',
          800: '#9f1239',
          900: '#881337',
          foreground: '#fff',
          DEFAULT: '#e11d48',
        },
        background: '#ffffff',
        foreground: '#000000',
        content1: {
          DEFAULT: '#ffffff',
          foreground: '#000',
        },
        content2: {
          DEFAULT: '#f4f4f5',
          foreground: '#000',
        },
        content3: {
          DEFAULT: '#e4e4e7',
          foreground: '#000',
        },
        content4: {
          DEFAULT: '#d4d4d8',
          foreground: '#000',
        },
        focus: '#a855f7',
        overlay: '#0f232e',
      },
    },
    dark: {
      colors: {
        // Numeric ramps INVERT in dark (50 = darkest, 900 = lightest) so that a
        // "subtle wash" like `bg-primary-50` / `text-primary-700` keeps meaning
        // the same thing in both themes. success/warning/danger below already
        // did this; default/primary/secondary did not, which is why every
        // primary-50 panel rendered as a light lavender slab on a dark page.
        // DEFAULT and foreground stay put — those are brand identity.
        default: {
          // Tinted toward the brand indigo rather than zinc, so neutral chips
          // don't read as gray blobs floating on a navy page.
          // 50-300 are SURFACES (bg-default-100 hover states) and stay dark.
          // 400+ are TEXT (text-default-400 is HeroUI's muted/placeholder,
          // text-default-500 its secondary copy) and so must clear 4.5:1
          // against the page — they are deliberately brighter than a naive
          // ramp would put them.
          50: '#141a3b',
          100: '#222b5c',
          200: '#2d376e',
          300: '#31355e',
          400: '#8388b5',
          500: '#a2a7cd',
          600: '#bcc0dd',
          700: '#d2d5e8',
          800: '#e6e8f2',
          900: '#f1eee4',
          foreground: '#f1eee4',
          DEFAULT: '#2d376e',
        },
        primary: {
          50: '#111f52',
          100: '#172e7d',
          200: '#1c3aa3',
          300: '#2349c9',
          400: '#2f5bea',
          500: '#6e8cff',
          600: '#8fa6f5',
          700: '#c3d0fb',
          800: '#e3e9fd',
          900: '#eef2fe',
          foreground: '#fff',
          DEFAULT: '#2f5bea',
        },
        secondary: {
          50: '#002147',
          100: '#003571',
          200: '#00489b',
          300: '#005cc4',
          400: '#006fee',
          500: '#2d88f1',
          600: '#59a1f4',
          700: '#86bbf7',
          800: '#b3d4fa',
          900: '#dfedfd',
          foreground: '#fff',
          DEFAULT: '#006fee',
        },
        success: {
          50: '#064e3b',
          100: '#065f46',
          200: '#047857',
          300: '#059669',
          400: '#10b981',
          500: '#34d399',
          600: '#6ee7b7',
          700: '#a7f3d0',
          800: '#d1fae5',
          900: '#ecfdf5',
          foreground: '#fff',
          DEFAULT: '#22c55e',
        },
        // Warning shifts amber -> ORANGE in dark. Amber is a yellow, and a yellow
        // can only survive on a dark page by going dark itself — at which point
        // it is olive (the old `warning-50` #78350f / --amber-soft #4a3815 mud).
        // Orange holds its identity at low lightness. Light mode keeps amber.
        //   DEFAULT #fb923c + foreground #18204a = 8.39:1 (AAA)
        //   (white on #fb923c would be 2.26:1 — never pair them)
        warning: {
          50: '#7c2d12',
          100: '#9a3412',
          200: '#c2410c',
          300: '#ea580c',
          400: '#f97316',
          500: '#fb923c',
          600: '#fdba74',
          700: '#fed7aa',
          800: '#ffedd5',
          900: '#fff7ed',
          foreground: '#18204a', // --ink-const; was #0f232e
          DEFAULT: '#fb923c',
        },
        // Danger gets a cleaner, more saturated red. The rungs that sit ON a dark
        // surface (50-200 fills, 500+ text) carry the extra chroma; DEFAULT stays
        // #e11d48 because that is the brightest red that still carries WHITE at
        // AA — the old #f43f5e + #fff was 3.67:1 and FAILED.
        //   DEFAULT #e11d48 + foreground #fff = 4.70:1 (AA)
        //   50 #b01236 (flat fill) + --ink #f1eee4 = 6.23:1 (AA), 81% sat.
        //     A cream label only needs the fill under luminance 0.154; a darker
        //     red (#701528, lum 0.041) wastes that budget and reads as maroon.
        //   500 #ff8494 (text) on page #0f1430 = 8.36:1 (AAA)
        danger: {
          50: '#b01236',
          100: '#c11540',
          200: '#d11844',
          300: '#d91a46',
          400: '#e11d48',
          500: '#ff8494',
          600: '#ffa0ac',
          700: '#ffbcc5',
          800: '#ffd9de',
          900: '#fff1f2',
          foreground: '#fff',
          DEFAULT: '#e11d48',
        },
        // Surfaces mirror the scrapbook elevation ladder in
        // packages/ui/src/styles/scrapbook.css (--surface-0..3). HeroUI used to
        // sit on #020817 while the scrapbook page was #18204a — two "dark"
        // systems a few percent apart, so cards dissolved into the page instead
        // of reading as raised. One ladder, one source of truth.
        background: '#0f1430', // --surface-0
        foreground: '#f1eee4', // cream, not pure white — avoids halation
        content1: {
          DEFAULT: '#141a3b', // --surface-1 (card)
          foreground: '#f1eee4',
        },
        content2: {
          DEFAULT: '#222b5c', // --surface-2 (popover / menu)
          foreground: '#f1eee4',
        },
        content3: {
          DEFAULT: '#2d376e', // --surface-3 (hover / highest)
          foreground: '#f1eee4',
        },
        content4: {
          DEFAULT: '#31355e',
          foreground: '#f1eee4',
        },
        focus: '#a855f7',
        overlay: '#000000',
      },
    },
  },
  layout: {
    disabledOpacity: '0.4',
    radius: {
      small: '4px',
      medium: '8px',
      large: '12px',
    },
    fontSize: {
      small: '18px',
      medium: '20px',
      large: '22px',
    },
  },
};
