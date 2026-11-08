/*
 * Frame data for <Thinking/>.
 *
 * Captured from the reference implementation at
 * https://agents-are-thinking.kiyo-n-zane.com (MIT, Copyright (c) 2026 Zane Chen —
 * https://github.com/czl9707/agents-are-thinking), then reduced to each
 * animation's minimal repeating cycle.
 *
 * We bake the frames instead of taking the npm package, which ships the
 * generator as Rust compiled to WASM. A WASM payload to draw a LOADING
 * indicator inverts the point of one — it has to paint before anything else is
 * ready. These are deterministic character sequences; the frames are the whole
 * artefact, and they cost about a kilobyte.
 *
 * Every cycle is 9 characters wide. Only the braille and block-shading families
 * are included: per the author's own font research those two render in either
 * Cascadia Code or Fira Code, whereas the dot family needs Fira specifically and
 * the vertical-block family needs Cascadia. On a platform whose users are on
 * arbitrary Android handsets, a glyph that resolves to tofu is worse than a
 * slightly less interesting animation.
 */

export const THINKING_FRAMES = {
  'braille-spin': [
    '⣄⠀⣄⠀⣄⠀⣄⠀⣄',
    '⣠⠀⣠⠀⣠⠀⣠⠀⣠',
    '⢰⠀⢰⠀⢰⠀⢰⠀⢰',
    '⠸⠀⠸⠀⠸⠀⠸⠀⠸',
    '⠙⠀⠙⠀⠙⠀⠙⠀⠙',
    '⠋⠀⠋⠀⠋⠀⠋⠀⠋',
    '⠇⠀⠇⠀⠇⠀⠇⠀⠇',
    '⡆⠀⡆⠀⡆⠀⡆⠀⡆',
  ],
  'braille-wave': [
    '⠄⡀⡀⠄⠂⠁⠁⠂⠄',
    '⡀⡀⠄⠂⠁⠁⠂⠄⡀',
    '⡀⠄⠂⠁⠁⠂⠄⡀⡀',
    '⠄⠂⠁⠁⠂⠄⡀⡀⠄',
    '⠂⠁⠁⠂⠄⡀⡀⠄⠂',
    '⠁⠁⠂⠄⡀⡀⠄⠂⠁',
    '⠁⠂⠄⡀⡀⠄⠂⠁⠁',
    '⠂⠄⡀⡀⠄⠂⠁⠁⠂',
  ],
  'braille-breathe': [
    '⠿⠏⠇⠁⠀⠁⠇⠏⠿',
    '⠿⠿⠏⠇⠁⠇⠏⠿⠿',
    '⠏⠿⠿⠏⠇⠏⠿⠿⠏',
    '⠇⠏⠿⠿⠏⠿⠿⠏⠇',
    '⠁⠇⠏⠿⠿⠿⠏⠇⠁',
    '⠀⠁⠇⠏⠿⠏⠇⠁⠀',
    '⠁⠀⠁⠇⠏⠇⠁⠀⠁',
    '⠇⠁⠀⠁⠇⠁⠀⠁⠇',
    '⠏⠇⠁⠀⠁⠀⠁⠇⠏',
  ],
  'shade-wave': [
    '░░▒▓███▓▒',
    '░▒▓███▓▒░',
    '▓▓███▓▒░░',
    '▓███▓▒░░░',
    '███▓▒░░░▒',
    '██▓▒░░░▒▓',
    '█▓▒░░░▒▓█',
    '▓▒░░░▒▓██',
    '▒░░░▒▓███',
    '░░░▒▓███▓',
  ],
  'shade-ripple': [
    '░░▓▓░▓▓░░',
    '░▒▓▒░▒▓▒░',
    '░▒▓░░░▓▒░',
    '░▓▓░░░▓▓░',
    '░▓▒░▒░▒▓░',
    '▒▓░░▓░░▓▒',
    '▒▒░░█░░▒▒',
    '▒▒░▒█▒░▒▒',
    '▒░░▒█▒░░▒',
    '▒░░▓█▓░░▒',
    '▒░░▓▓▓░░▒',
    '░░▒█▓█▒░░',
    '░░▓▓▒▓▓░░',
  ],
  'shade-scanner': [
    '▓██░░░░░░',
    '▓▓██░░░░░',
    '▓▓▓██░░░░',
    '▒▓▓▓██░░░',
    '▒▒▓▓▓██░░',
    '░▒▒▓▓▓██░',
    '░░▒▒▓▓▓██',
    '░░░▒▒▓▓▓█',
    '░░░░▒▒▓▓▓',
    '░░░░░▒▒▓▓',
    '░░░░░░▒▒▓',
    '░░░░░░░▒▒',
    '░░░░░░░░░',
    '█░░░░░░░░',
    '██░░░░░░░',
  ],
} as const;

export type ThinkingVariant = keyof typeof THINKING_FRAMES;

export const THINKING_VARIANTS = Object.keys(THINKING_FRAMES) as ThinkingVariant[];

/** Every cycle is this wide; the box is sized in `ch` so a frame swap never reflows. */
export const THINKING_FRAME_WIDTH = 9;
