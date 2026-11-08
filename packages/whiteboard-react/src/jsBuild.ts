/**
 * JS-BUNDLE build marker. This is a JS-side constant compiled into the bundle, so wherever it is
 * shown (home-page footer, PDF/input debug overlays), the displayed value identifies the JS that is
 * TRULY running — independent of the native shell's version (the splash version comes from the Tauri
 * app and can read "current" while a stale service worker/HTTP cache/content dir still serves an OLD
 * JS bundle). BUMP this string every release alongside tauri.conf.json.
 */
export const JS_BUNDLE_BUILD = '1.0.1';
