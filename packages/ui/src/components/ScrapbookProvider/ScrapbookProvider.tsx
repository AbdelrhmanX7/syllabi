import React from 'react';

/**
 * da-v2 ScrapbookProvider — app-level defaults for the scrapbook visuals.
 *
 *   <ScrapbookProvider disableTilt>{app}</ScrapbookProvider>
 *
 * Today it carries exactly one setting: `disableTilt`. The seeded surface
 * rotation (Card, Alert, Accordion, Toast) reads as scrapbook character on a
 * student page and as noise on a dense operator console, so the teacher and
 * admin apps switch it off while every other app on this system keeps it.
 *
 * WHY A CONTEXT AND NOT A STYLESHEET: only Card routes its rotation through a
 * custom property (`--sk-rot`). Alert, Accordion and Toast write it as an
 * inline `transform`, which no app-level CSS rule can outrank and which exposes
 * no var to redefine. An opt-out therefore has to reach the components
 * themselves, and a React context is the only channel that does — HeroUIProvider
 * is not ours to extend.
 *
 * The default is CURRENT BEHAVIOUR (tilt on), so an app that never mounts this
 * is untouched, and so is any component rendered with no provider above it.
 * Per-instance controls still win over the provider — `Card`'s `tilted`,
 * `Alert`'s `rotate`, `Accordion`'s `disableTilt` — because an author who wrote
 * `tilted={2}` at a call site meant that number. The provider is the default,
 * not an override.
 *
 * Context-only, like FormProvider: it renders no DOM, so dropping it anywhere
 * in a tree cannot disturb layout, and it reads no browser state, so SSR output
 * and the first client render agree.
 *
 * NOTE: this does not reach the legacy `.sk-card` / `.sk-chip` / `.sk-badge`
 * classes in `styles/scrapbook.css`. Those DO go through custom properties
 * (`--sk-card-rot` etc.), so an app that uses them can flatten them with a
 * scoped CSS rule. Neither teacher nor admin uses them today.
 */

export interface ScrapbookConfig {
  /** Flatten the seeded rotation on scrapbook surfaces. Default `false`. */
  disableTilt: boolean;
}

const DEFAULT_SCRAPBOOK_CONFIG: ScrapbookConfig = { disableTilt: false };

const ScrapbookContext = React.createContext<ScrapbookConfig>(DEFAULT_SCRAPBOOK_CONFIG);

export interface ScrapbookProviderProps extends Partial<ScrapbookConfig> {
  children?: React.ReactNode;
}

export function ScrapbookProvider({ disableTilt = false, children }: ScrapbookProviderProps) {
  // The settings are fixed for an app's lifetime, so memoize: an unmemoized
  // object literal here would be a fresh identity on every render of _app,
  // re-rendering every Card / Alert / Accordion / Toast in the tree with it.
  const value = React.useMemo<ScrapbookConfig>(() => ({ disableTilt }), [disableTilt]);

  return <ScrapbookContext.Provider value={value}>{children}</ScrapbookContext.Provider>;
}

ScrapbookProvider.displayName = 'ScrapbookProvider';

/** Full scrapbook config. Falls back to the defaults with no provider mounted. */
export function useScrapbookConfig(): ScrapbookConfig {
  return React.useContext(ScrapbookContext);
}

/** Convenience for the surfaces that only care about the tilt flag. */
export function useTiltDisabled(): boolean {
  return React.useContext(ScrapbookContext).disableTilt;
}
