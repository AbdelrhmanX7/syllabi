/**
 * Browser launch + context helpers.
 *
 * FOOTGUN: `playwright` is CommonJS. `import { chromium } from 'playwright'`
 * throws in an ESM file — default-import the module object and destructure.
 * The bare specifier resolves because this file lives inside the repo, so Node
 * walks up to the root `node_modules/playwright`.
 *
 * FOOTGUN: there are no downloaded Playwright browsers in this environment.
 * The system Chrome at `/usr/bin/google-chrome` is the only browser, so every
 * launch must pass `executablePath`.
 */
import playwright from 'playwright';

const { chromium } = playwright;

export const CHROME_PATH = process.env.UITEST_CHROME || '/usr/bin/google-chrome';

export const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
export const MOBILE_VIEWPORT = { width: 390, height: 844 };

/*
 * The students' device (owner, 2026-10-11): most of them are on a Samsung Galaxy Tab A7 (10.4", 2000x1200)
 * or Tab A6 (10.1", 1920x1200), both at DPR 1.5. The A6 gives Chrome a 800x1280 / 1280x800 CSS viewport; the
 * A7 is a hair bigger (800x1334), so the A6 size is the one that must fit. Landscape crosses Tailwind `lg`
 * (1024), so it gets the desktop layout at only 800px tall.
 */
export const TABLET_VIEWPORT = { width: 800, height: 1280 };
export const TABLET_LANDSCAPE_VIEWPORT = { width: 1280, height: 800 };

export const isMobile = () => !!process.env.MOBILE;
/** TABLET=1 → portrait, TABLET=land → landscape. */
export const tabletMode = () => (process.env.TABLET ? (process.env.TABLET === 'land' ? 'land' : 'portrait') : null);
export const viewportLabel = () =>
  tabletMode() === 'land'
    ? 'Galaxy Tab landscape 1280x800 (TABLET=land)'
    : tabletMode()
      ? 'Galaxy Tab portrait 800x1280 (TABLET=1)'
      : isMobile()
        ? 'mobile 390x844 (MOBILE=1)'
        : 'desktop 1280x900';
export const viewportSuffix = () => (tabletMode() ? `-tab-${tabletMode()}` : isMobile() ? '-mobile' : '');

const defaultViewport = () =>
  tabletMode() === 'land'
    ? TABLET_LANDSCAPE_VIEWPORT
    : tabletMode()
      ? TABLET_VIEWPORT
      : isMobile()
        ? MOBILE_VIEWPORT
        : DESKTOP_VIEWPORT;
export const isHeadful = () => !!process.env.HEADFUL;
export const isGeom = () => !!process.env.GEOM;

export async function launchBrowser() {
  return chromium.launch({ headless: !isHeadful(), executablePath: CHROME_PATH });
}

/**
 * A context wired for these apps: English locale, the Next dev indicator hidden,
 * and native dialogs auto-dismissed.
 *
 * FOOTGUN: `nextjs-portal` is Next's dev-tools indicator. It is a fixed host
 * element that hit-tests over app UI in headless Chrome — it silently swallows
 * clicks on anything near the bottom of the viewport (the exam player's next
 * button, for one). It is dev chrome, not app UI, so it is hidden by stylesheet
 * from the first script evaluation. It re-mounts itself, which is why a
 * stylesheet (document styles beat the shadow `:host` rule) beats removing it.
 */
export async function newContext(browser, options = {}) {
  const { viewport, deviceScaleFactor = tabletMode() ? 1.5 : 1, locale = 'en-US', ...rest } = options;

  const context = await browser.newContext({
    viewport: viewport ?? defaultViewport(),
    ...(tabletMode() && { hasTouch: true }),
    locale,
    deviceScaleFactor,
    ...rest,
  });

  await context.addInitScript(() => {
    const apply = () => {
      const root = document.head || document.documentElement;

      if (!root || root.querySelector('style[data-uitest-hide-dev-portal]')) return;

      const style = document.createElement('style');

      style.setAttribute('data-uitest-hide-dev-portal', '');
      style.textContent = 'nextjs-portal { display: none !important; }';
      root.appendChild(style);
    };

    apply();
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  });

  context.on('page', (page) => {
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  });

  return context;
}

/** Collect console errors and uncaught page errors for the run report. */
export function watchErrors(page, sink) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') sink.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => sink.push(`pageerror: ${String(err).slice(0, 300)}`));

  return sink;
}
