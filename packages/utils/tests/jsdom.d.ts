/**
 * Minimal ambient typing for `jsdom` (the package ships no types and
 * `@types/jsdom` is not a dependency). Only the surface the tests use is typed.
 *
 * Mirrors `packages/analytics/tests/jsdom.d.ts` — same reason, same shape.
 */
declare module 'jsdom' {
  export interface JSDOMOptions {
    url?: string;
    pretendToBeVisual?: boolean;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    // jsdom's window is a full DOM Window; typed loosely here.
    readonly window: Window & typeof globalThis;
  }
}
