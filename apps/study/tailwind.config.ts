import type { Config } from 'tailwindcss';

import { heroui } from '@heroui/theme';
import scrapbookPreset from '@repo/ui/tailwind.preset';
import { heroUIThemeConfig } from '@repo/ui/theme';

const config: Config = {
  // The shared preset carries the tokens `@repo/ui` components and the board engine are styled with.
  presets: [scrapbookPreset],
  // Tablet: `:hover` sticks to whatever was last tapped, so hover styles only apply with a real pointer.
  future: { hoverOnlyWhenSupported: true },
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './features/**/*.{js,ts,jsx,tsx,mdx}',
    './node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}',
    '../../node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/whiteboard-react/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      // Study's own calm palette (styles/globals.css). `st-*` so it never collides with the preset.
      colors: {
        'st-bg': 'rgb(var(--st-bg) / <alpha-value>)',
        'st-surface': 'rgb(var(--st-surface) / <alpha-value>)',
        'st-raised': 'rgb(var(--st-raised) / <alpha-value>)',
        'st-fg': 'rgb(var(--st-fg) / <alpha-value>)',
        'st-muted': 'rgb(var(--st-muted) / <alpha-value>)',
        'st-line': 'rgb(var(--st-line) / <alpha-value>)',
        'st-accent': 'rgb(var(--st-accent) / <alpha-value>)',
        'st-accent-fg': 'rgb(var(--st-accent-fg) / <alpha-value>)',
        'st-accent-soft': 'rgb(var(--st-accent-soft) / <alpha-value>)',
        'st-star': 'rgb(var(--st-star) / <alpha-value>)',
        'st-accent-lip': 'rgb(var(--st-accent-lip) / <alpha-value>)',
        'st-star-lip': 'rgb(var(--st-star-lip) / <alpha-value>)',
        'st-danger-lip': 'rgb(var(--st-danger-lip) / <alpha-value>)',
        'st-clay-edge': 'rgb(var(--st-clay-edge) / <alpha-value>)',
        'st-control-edge': 'rgb(var(--st-control-edge) / <alpha-value>)',
        'st-star-soft': 'rgb(var(--st-star-soft) / <alpha-value>)',
        'st-star-fg': 'rgb(var(--st-star-fg) / <alpha-value>)',
        'st-ink': 'rgb(var(--st-ink) / <alpha-value>)',
        'st-shadow': 'rgb(var(--st-shadow) / <alpha-value>)',
        'st-danger': 'rgb(var(--st-danger) / <alpha-value>)',
        'st-danger-fg': 'rgb(var(--st-danger-fg) / <alpha-value>)',
        'st-warn': 'rgb(var(--st-warn) / <alpha-value>)',
        'st-ok': 'rgb(var(--st-ok) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['Bricolage Grotesque', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      // ONE radius ladder (@repo/ui scrapbook.css --radius-*: sm 8 / md 12 / lg 16). Tailwind's own steps and
      // the st aliases all resolve onto it (rounded/xl → sm/md, 2xl/3xl → lg); see the ui-rules skill.
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-md)',
        '2xl': 'var(--radius-lg)',
        '3xl': 'var(--radius-lg)',
        st: 'var(--radius-md)',
        'st-lg': 'var(--radius-lg)',
      },
      boxShadow: {
        // Clay lip: a solid ink step straight DOWN, no blur (matches the @repo/ui clay components).
        st: '0 4px 0 0 rgb(var(--st-clay-edge))',
        'lip-sm': '0 3px 0 0 rgb(var(--st-clay-edge))',
        'lip-md': '0 4px 0 0 rgb(var(--st-clay-edge))',
        'lip-lg': '0 6px 0 0 rgb(var(--st-clay-edge))',
        // Clay buttons (the @repo/ui look): a solid lip straight DOWN in the edge colour.
        clay: '0 4px 0 0 rgb(var(--st-clay-edge))',
        'clay-accent': '0 4px 0 0 rgb(var(--st-accent-lip))',
        'clay-star': '0 4px 0 0 rgb(var(--st-star-lip))',
        'clay-danger': '0 4px 0 0 rgb(var(--st-danger-lip))',
      },
    },
  },
  darkMode: 'class',
  plugins: [heroui(heroUIThemeConfig)],
};

export default config;
