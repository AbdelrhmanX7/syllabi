import type { Config } from 'tailwindcss';

import study from '../study/tailwind.config';

// Same tokens as the app (st-* colours, clay lips, fonts); only the scanned files differ.
const config: Config = {
  ...study,
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
