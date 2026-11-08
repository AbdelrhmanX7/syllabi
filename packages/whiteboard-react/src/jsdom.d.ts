// Minimal ambient declaration for `jsdom` (used only by tests). `@types/jsdom` is not installed and
// we do not want to add it as a dependency just for the few members the error-boundary test touches.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; pretendToBeVisual?: boolean });
    readonly window: Window & typeof globalThis;
  }
}
