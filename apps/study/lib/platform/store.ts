/**
 * Which store this build is for, baked at build time.
 *
 * `NEXT_PUBLIC_STORE=play` (set by scripts/build-play.mjs) marks the Google Play build. Play allows no
 * self-update outside Play, so that build has no update check, no update banner, no "Check for updates"
 * button and never reads the release feed. Every other build (sideloaded APK, web) keeps self-update.
 *
 * Read as the literal `process.env.NEXT_PUBLIC_STORE`: Next inlines only that exact form, which lets the
 * minifier drop the update UI from the Play bundle.
 */
export const STORE = process.env.NEXT_PUBLIC_STORE ?? '';

export const IS_PLAY_BUILD = STORE === 'play';

/** False in the Play build: updates come from Google Play only. */
export const SELF_UPDATE_ENABLED = !IS_PLAY_BUILD;
