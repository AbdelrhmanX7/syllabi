/** The home page `/` — load, then a slow scroll to the bottom. */
const settle = (page, ms) => page.waitForTimeout(ms);

export const phases = [
  {
    name: 'load',
    run: async (page, { base }) => (await page.goto(`${base}/`, { waitUntil: 'load' }), settle(page, 5000)),
  },
  ...Array.from({ length: 8 }, (_, i) => ({
    name: `scroll ${i + 1}/8`,
    run: async (page) => (await page.mouse.wheel(0, 900), settle(page, 1500)),
  })),
];
