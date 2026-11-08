import type { Config } from 'tailwindcss';

import study from '../study/tailwind.config';

const tone = (name: string) => `rgb(var(--tone-${name}) / <alpha-value>)`;

// Same tokens as the app (st-* colours, clay lips, fonts, one radius ladder); the site adds its
// secondary `tone-*` hues (styles/globals.css) and scans its own files.
const config: Config = {
  ...study,
  theme: {
    ...study.theme,
    extend: {
      ...study.theme?.extend,
      colors: {
        ...(study.theme?.extend?.colors as Record<string, string>),
        'tone-citrine': tone('citrine-bg'),
        'tone-citrine-fg': tone('citrine-fg'),
        'tone-green': tone('green-bg'),
        'tone-green-fg': tone('green-fg'),
        'tone-coral': tone('coral-bg'),
        'tone-coral-fg': tone('coral-fg'),
        'tone-purple': tone('purple-bg'),
        'tone-purple-fg': tone('purple-fg'),
      },
    },
  },
  content: [
    './pages/**/*.{ts,tsx}',
    './sections/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    '../study/components/ui/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
    '../../node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}',
  ],
};

export default config;
