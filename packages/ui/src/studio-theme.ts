export const heroUIStudioAppThemeConfig = {
  themes: {
    light: {
      colors: {
        default: {
          50: '#fafafa',
          100: '#f2f2f3',
          200: '#ebebec',
          300: '#e3e3e6',
          400: '#dcdcdf',
          500: '#d4d4d8',
          600: '#afafb2',
          700: '#8a8a8c',
          800: '#656567',
          900: '#404041',
          foreground: '#000',
          DEFAULT: '#d4d4d8',
        },
        primary: {
          50: '#ffeadf',
          100: '#ffcdb3',
          200: '#ffb086',
          300: '#fe9259',
          400: '#fe752d',
          500: '#fe5800',
          600: '#d24900',
          700: '#a53900',
          800: '#792a00',
          900: '#4c1a00',
          foreground: '#000',
          DEFAULT: '#fe5800',
        },
        secondary: {
          50: '#ece4f8',
          100: '#d2bfee',
          200: '#b799e4',
          300: '#9d73db',
          400: '#824ed1',
          500: '#6828c7',
          600: '#5621a4',
          700: '#441a81',
          800: '#31135f',
          900: '#1f0c3c',
          foreground: '#fff',
          DEFAULT: '#6828c7',
        },
        success: {
          50: '#e2f8ec',
          100: '#b9efd1',
          200: '#91e5b5',
          300: '#68dc9a',
          400: '#40d27f',
          500: '#17c964',
          600: '#13a653',
          700: '#0f8341',
          800: '#0b5f30',
          900: '#073c1e',
          foreground: '#000',
          DEFAULT: '#17c964',
        },
        warning: {
          50: '#fef7e4',
          100: '#fcecbe',
          200: '#fae297',
          300: '#f9d771',
          400: '#f7cc4b',
          500: '#f5c125',
          600: '#ca9f1f',
          700: '#9f7d18',
          800: '#745c12',
          900: '#4a3a0b',
          foreground: '#000',
          DEFAULT: '#f5c125',
        },
        danger: {
          50: '#fde1e9',
          100: '#fbb8cb',
          200: '#f98eac',
          300: '#f7648d',
          400: '#f43b6f',
          500: '#f21150',
          600: '#c80e42',
          700: '#9d0b34',
          800: '#730826',
          900: '#490518',
          foreground: '#000',
          DEFAULT: '#f21150',
        },
        background: '#f8f8f9',
        foreground: '#111113',
        content1: {
          DEFAULT: '#ffffff',
          foreground: '#111113',
        },
        content2: {
          DEFAULT: '#f2f2f4',
          foreground: '#111113',
        },
        content3: {
          DEFAULT: '#e8e8eb',
          foreground: '#111113',
        },
        content4: {
          DEFAULT: '#dddde1',
          foreground: '#111113',
        },
        // Was #006FEE — HeroUI's STOCK BLUE, in an orange/purple-branded app.
        // A focus ring is a non-text UI element: WCAG 1.4.11 wants 3:1 against the
        // adjacent surface. Brand orange at full strength (#fe5800) only manages
        // 2.99:1 on the light page and 3.18:1 on a white card — it FAILS — so light
        // takes a darkened step of the same hue instead of reusing the dark value.
        //   #e14e00: 3.74:1 page / 3.97:1 card — PASS
        focus: '#e14e00',
        overlay: '#111113',
      },
    },
    dark: {
      colors: {
        // Neutrals are tinted toward the brand indigo, not zinc — this ramp was
        // pure gray (#3f3f46 is literally zinc-700), so every neutral chip read as
        // a gray blob on the navy page. 50-300 are SURFACES (bg-default-100 hover
        // states) and stay dark; 400+ are TEXT (400 is HeroUI's muted/placeholder,
        // 500 its secondary copy) and so must clear 4.5:1 against the page:
        //   400 #8388b5 = 5.73:1   500 #a2a7cd = 8.33:1
        default: {
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
          foreground: '#fff',
          DEFAULT: '#2d376e',
        },
        primary: {
          50: '#4c1a00',
          100: '#792a00',
          200: '#a53900',
          300: '#d24900',
          400: '#fe5800',
          500: '#fe752d',
          600: '#fe9259',
          700: '#ffb086',
          800: '#ffcdb3',
          900: '#ffeadf',
          foreground: '#000',
          DEFAULT: '#fe5800',
        },
        // DEFAULT is a FILL color, and in dark it is fill-only. Do NOT "fix" it by
        // lightening it to match the other ramps — that has been tried twice and
        // it cannot work, because the two roles pull in opposite directions:
        //
        //   as TEXT on the dark page      as FILL under white
        //   #6828c7 (today)   2.42:1 ✗          7.73:1 ✓
        //   #824ed1 (d-500)   3.53:1 ✗          5.30:1 ✓   <- still fails as text
        //   #9d73db (d-600)   5.26:1 ✓          3.55:1 ✗   <- breaks every button
        //
        // A purple dark enough to carry white as a fill is too dark to BE text on
        // a dark page. There is no single value that satisfies both. So DEFAULT
        // stays the true brand (correct as a fill), and any TEXT/icon use of
        // secondary in dark must take `text-secondary-700` (#b799e4 = 7.36:1).
        // Same doctrine as --p-text in scrapbook.css.
        secondary: {
          50: '#1f0c3c',
          100: '#31135f',
          200: '#441a81',
          300: '#5621a4',
          400: '#6828c7',
          500: '#824ed1',
          600: '#9d73db',
          700: '#b799e4', // <- the readable label step in dark
          800: '#d2bfee',
          900: '#ece4f8',
          foreground: '#fff',
          DEFAULT: '#6828c7', // fill-only in dark; see above
        },
        success: {
          50: '#073c1e',
          100: '#0b5f30',
          200: '#0f8341',
          300: '#13a653',
          400: '#17c964',
          500: '#40d27f',
          600: '#68dc9a',
          700: '#91e5b5',
          800: '#b9efd1',
          900: '#e2f8ec',
          foreground: '#000',
          DEFAULT: '#17c964',
        },
        warning: {
          50: '#4a3a0b',
          100: '#745c12',
          200: '#9f7d18',
          300: '#ca9f1f',
          400: '#f5c125',
          500: '#f7cc4b',
          600: '#f9d771',
          700: '#fae297',
          800: '#fcecbe',
          900: '#fef7e4',
          foreground: '#000',
          DEFAULT: '#f5c125',
        },
        // Lifted one step for dark (light keeps #f21150). Unlike `secondary` above,
        // this is safe precisely BECAUSE danger's foreground is #000, not #fff —
        // so lightening the fill helps both roles instead of trading them off:
        //   as TEXT on page:        #f21150 4.43:1 ✗  ->  #f43b6f 5.08:1 ✓
        //   as FILL under its #000: #f21150 4.97:1 ✓  ->  #f43b6f 5.70:1 ✓
        danger: {
          50: '#490518',
          100: '#730826',
          200: '#9d0b34',
          300: '#c80e42',
          400: '#f21150',
          500: '#f43b6f',
          600: '#f7648d',
          700: '#f98eac',
          800: '#fbb8cb',
          900: '#fde1e9',
          foreground: '#000',
          DEFAULT: '#f43b6f',
        },
        // Dark surfaces are the scrapbook navy ladder (--surface-0..3 in
        // scrapbook.css), NOT a neutral gray.
        //
        // They used to be #121214/#1a1a1d/#232326/#2c2c30 — a near-zinc gray. But
        // studio renders @repo/ui components (71 of its 78 @repo/ui files use
        // Card/Modal/Chip/Input), and those paint the scrapbook ladder, so every
        // card was a NAVY slab floating on a GRAY page: #141a3b vs #121214 is a
        // 1.05 luminance ratio with a hue clash, which reads as a faint blue haze
        // rather than a raised surface. The gray was a leftover neutral that never
        // got re-based when studio adopted the component library — same class of
        // stock-neutral leak as a bare heroui() call, just hand-rolled.
        //
        // Studio's identity is its brand ORANGE (primary #fe5800), not its gray.
        // Orange still clears 6.15:1 on the navy page. Light mode is untouched.
        background: '#0f1430', // --surface-0
        foreground: '#ececef', // studio keeps its cooler white (16.58:1 on page)
        content1: {
          DEFAULT: '#141a3b', // --surface-1 — matches what @repo/ui Card paints
          foreground: '#ececef',
        },
        content2: {
          DEFAULT: '#222b5c', // --surface-2
          foreground: '#ececef',
        },
        content3: {
          DEFAULT: '#2d376e', // --surface-3
          foreground: '#ececef',
        },
        content4: {
          DEFAULT: '#31355e',
          foreground: '#ececef',
        },
        // Was #006FEE — HeroUI's STOCK BLUE, in an orange/purple-branded app.
        // Brand orange at full strength (#fe5800) is only 2.99:1 on the LIGHT page,
        // which fails WCAG 1.4.11 (3:1 for a non-text UI element), so the focus ring
        // is tuned per theme rather than reused: see `focus` in the light block.
        //   dark #fe5800: 5.89:1 page / 5.47:1 card — PASS
        focus: '#fe5800',
        overlay: '#000000',
      },
    },
  },
  layout: {
    disabledOpacity: '0.5',
  },
};
