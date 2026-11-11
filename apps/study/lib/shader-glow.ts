/**
 * The «AI is here» glow: a small WebGL1 fragment shader that paints a soft flowing rim (and, while busy,
 * a faint wash + a light sweep) inside a button, in brand colours. Pure parts live here so they can be
 * unit-tested and so the contrast maths below mirrors the exact shader formula.
 *
 * Device budget (Galaxy Tab A7-class, old WebView): one tiny canvas, DPR capped at 2, WebGL1 only,
 * ~20 fps when idle and full rate only while busy. See components/ui/ShaderGlow.tsx for the loop.
 */

/** Notebook Blue, star yellow, warm paper — never black. sRGB channels 0..1, as the shader uses them. */
export const GLOW_BLUE: Rgb = [47 / 255, 91 / 255, 234 / 255];
export const GLOW_STAR: Rgb = [255 / 255, 201 / 255, 60 / 255];
export const GLOW_PAPER: Rgb = [255 / 255, 246 / 255, 220 / 255];

export type Rgb = [number, number, number];

/**
 * Every animated term in the shader is `sin(k · W · phase)` or `fract(k · phase / 40)` with an integer
 * k, so the whole pattern repeats exactly every 40 phase units. Wrapping the phase there on the CPU is
 * seamless and keeps the number small (mediump floats are fp16 on many phone GPUs; a raw clock would
 * start to stutter within minutes).
 */
export const PHASE_PERIOD = 40;
const W = (2 * Math.PI) / PHASE_PERIOD;

/** Idle draws ~20 fps; busy draws every frame. */
export const IDLE_FPS = 20;
export const BUSY_FPS = 60;
/** How fast the pattern flows (phase units per second): calm idle, livelier busy. */
const IDLE_SPEED = 1;
const BUSY_SPEED = 2.6;

/** Rim band, in CSS px (it widens by half while busy). Must stay clear of the label's line box. */
export const RIM_CSS_PX = 4;
export const MAX_DPR = 2;

/** Canvas backing-store size for a CSS box: DPR capped at 2, at least 1px. */
export function canvasPixels(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): { width: number; height: number; scale: number } {
  const scale = Math.min(MAX_DPR, Math.max(1, Number.isFinite(dpr) ? dpr : 1));

  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
    scale,
  };
}

/** Minimum ms between drawn frames for the current energy (0 = idle … 1 = busy). */
export function frameIntervalMs(energy: number): number {
  return 1000 / (energy > 0.05 ? BUSY_FPS : IDLE_FPS);
}

/** Eases energy toward its target (~0.35 s to settle) so busy fades in and out instead of snapping. */
export function stepEnergy(
  energy: number,
  target: number,
  dtSeconds: number,
): number {
  const next =
    energy + (target - energy) * Math.min(1, Math.max(0, dtSeconds) * 6);

  return Math.abs(next - target) < 0.002 ? target : next;
}

/** Advances the flow phase by dt at the energy's speed, wrapped into [0, PHASE_PERIOD). */
export function advancePhase(
  phase: number,
  energy: number,
  dtSeconds: number,
): number {
  const speed = IDLE_SPEED + (BUSY_SPEED - IDLE_SPEED) * energy;
  // A long stall (tab hidden, observer paused) must not jump the pattern: clamp dt.
  const next = phase + speed * Math.min(Math.max(dtSeconds, 0), 0.1);

  return next % PHASE_PERIOD;
}

export const GLOW_VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/** WebGL1 / GLSL ES 1.00 only. Output is premultiplied alpha over the button's own face. */
export const GLOW_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
uniform float u_phase;
uniform float u_energy;
uniform float u_rim;
uniform float u_radius;
const vec3 BLUE = vec3(${GLOW_BLUE.map((v) => v.toFixed(4)).join(", ")});
const vec3 STAR = vec3(${GLOW_STAR.map((v) => v.toFixed(4)).join(", ")});
const vec3 PAPER = vec3(${GLOW_PAPER.map((v) => v.toFixed(4)).join(", ")});
const float W = ${W.toFixed(8)};

float insideDist(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return -(length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float d = insideDist(gl_FragCoord.xy - 0.5 * u_res, 0.5 * u_res, u_radius);
  float t = u_phase;
  float e = u_energy;

  float n = 0.5 + 0.5 * sin(uv.x * 5.0 + sin(uv.y * 3.0 + t * W * 4.0) * 1.2 - t * W * 7.0);
  float n2 = 0.5 + 0.5 * sin(uv.x * 3.0 - uv.y * 2.0 + t * W * 3.0);
  vec3 c = mix(BLUE, STAR, smoothstep(0.25, 0.75, n));

  float rim = 1.0 - smoothstep(0.0, u_rim * (1.0 + 0.5 * e), d);
  float sweepX = fract(t / 5.0) * 1.8 - 0.4;
  float sx = (uv.x - sweepX + (uv.y - 0.5) * 0.3) * 4.0;
  float sweep = exp(-sx * sx);

  float rimA = rim * (0.45 + 0.4 * n) * (0.7 + 0.3 * e);
  float fillA = (0.04 + 0.12 * e) * n2 + sweep * 0.14 * e;
  vec3 col = mix(c, PAPER, sweep * 0.5 * e * (1.0 - rim));
  float a = clamp(rimA + fillA * (1.0 - rim), 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}
`;

/**
 * The shader's colour + alpha at one point where the rim is 0 (i.e. under the label), mirrored in JS.
 * Used by the contrast test to check every animation frame, not a guess.
 */
export function labelAreaGlow(
  uvX: number,
  uvY: number,
  phase: number,
  energy: number,
): { color: Rgb; alpha: number } {
  const smooth = (a: number, b: number, x: number) => {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));

    return k * k * (3 - 2 * k);
  };
  const mix = (a: Rgb, b: Rgb, k: number): Rgb => [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
  const t = phase;
  const e = energy;
  const n =
    0.5 +
    0.5 * Math.sin(uvX * 5 + Math.sin(uvY * 3 + t * W * 4) * 1.2 - t * W * 7);
  const n2 = 0.5 + 0.5 * Math.sin(uvX * 3 - uvY * 2 + t * W * 3);
  const c = mix(GLOW_BLUE, GLOW_STAR, smooth(0.25, 0.75, n));
  const sweepX = ((((t / 5) % 1) + 1) % 1) * 1.8 - 0.4;
  const sx = (uvX - sweepX + (uvY - 0.5) * 0.3) * 4;
  const sweep = Math.exp(-sx * sx);
  const fillA = (0.04 + 0.12 * e) * n2 + sweep * 0.14 * e;

  return {
    color: mix(c, GLOW_PAPER, sweep * 0.5 * e),
    alpha: Math.min(1, Math.max(0, fillA)),
  };
}

/** WCAG relative luminance of an sRGB colour (0..1 channels). */
export function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);

  return (hi + 0.05) / (lo + 0.05);
}

/** `over` composited (straight alpha) on an opaque `base`. */
export function over(base: Rgb, color: Rgb, alpha: number): Rgb {
  return [
    base[0] + (color[0] - base[0]) * alpha,
    base[1] + (color[1] - base[1]) * alpha,
    base[2] + (color[2] - base[2]) * alpha,
  ];
}
