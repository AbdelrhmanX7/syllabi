/**
 * «AI Dissolve» — the Figma WGSL effect (shader bf2160cf…, colour flow from «AI Glow
 * Edge» d1dc1eb3…) ported to WebGL1 / GLSL ES 1.00 for the Android WebView (no WebGPU there).
 *
 * Faithful to the source: a domain-warped fBM field, a dissolve threshold driven by eased progress,
 * a burn edge made of a crisp core + soft bloom (stronger on the unrevealed side) in the flowing brand
 * gradient mixed in OKLab, rare citrine sparks, paper with faint purple grain where nothing is revealed
 * yet, a soft border glow, and triangular dithering at the final quantisation step.
 *
 * Additions for the page flow: the revealed content is a texture placed in a sub-rectangle (the page
 * as it sits on screen; paper outside it), and a SECOND front (`uFinal`) that reveals the real new
 * page behind the first one when the result lands, plus a border pulse at the end.
 */

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAGMENT = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec4 uStops[8];
uniform float uStopCount;
uniform vec3 uPaper;
uniform vec3 uHi;
uniform vec2 uRes;
uniform float uTime;
uniform float uE;
uniform float uRawP;
uniform float uEdge;
uniform float uInten;
uniform float uSpeed;
uniform float uBorder;
uniform float uPulse;
uniform float uDerivatives;
uniform sampler2D uContent;
uniform vec4 uContentRect;
uniform float uHasContent;
uniform sampler2D uNew;
uniform vec4 uNewRect;
uniform float uHasNew;
uniform float uFinalE;
uniform float uFinalP;

float hash21(vec2 p) {
  vec2 q = fract(p * vec2(123.34, 456.21));
  q = q + dot(q, q + 45.32);
  return fract(q.x * q.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  vec2 q = p;
  for (int k = 0; k < 4; k++) {
    v += amp * vnoise(q);
    q = vec2(1.6 * q.x - 1.2 * q.y, 1.2 * q.x + 1.6 * q.y) + vec2(1.7, 9.2);
    amp *= 0.5;
  }
  return v / 0.9375;
}

vec3 toLin(vec3 c) {
  vec3 cc = clamp(c, 0.0, 1.0);
  vec3 lo = cc / 12.92;
  vec3 hi = pow((cc + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, step(cc, vec3(0.04045)));
}

vec3 toSrgb(vec3 c) {
  vec3 cc = clamp(c, 0.0, 1.0);
  vec3 lo = cc * 12.92;
  vec3 hi = 1.055 * pow(cc, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(cc, vec3(0.0031308)));
}

vec3 oklabToLin(vec3 lab) {
  float l1 = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m1 = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s1 = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  float l = l1 * l1 * l1;
  float m = m1 * m1 * m1;
  float s = s1 * s1 * s1;
  return max(vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s), vec3(0.0));
}

vec3 gradLab(float t) {
  vec3 col = uStops[0].xyz;
  for (int i = 1; i < 8; i++) {
    if (float(i) < uStopCount) {
      vec4 a = uStops[i - 1];
      vec4 b = uStops[i];
      float k = clamp((t - a.w) / max(b.w - a.w, 0.0001), 0.0, 1.0);
      float ks = k * k * (3.0 - 2.0 * k);
      if (t >= a.w) col = mix(a.xyz, b.xyz, ks);
    }
  }
  return col;
}

vec3 blendGlow(vec3 base, vec3 g, float amt, float light) {
  vec3 addv = base + g * amt;
  vec3 mixv = mix(base, g, amt);
  return mix(addv, mixv, light);
}

// The page texture where it sits, paper around it (both linear).
vec3 pageAt(sampler2D tex, vec4 rect, vec2 uv, vec3 paperLin) {
  vec2 size = max(rect.zw - rect.xy, vec2(1e-4));
  vec2 t = (uv - rect.xy) / size;
  float inside = step(0.0, t.x) * step(0.0, t.y) * step(t.x, 1.0) * step(t.y, 1.0);
  vec3 c = toLin(texture2D(tex, clamp(t, 0.0, 1.0)).rgb);
  return mix(paperLin, c, inside);
}

void main() {
  vec2 res = max(uRes, vec2(1.0));
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = vec2(fc.x / res.x, 1.0 - fc.y / res.y);
  float e = uE;
  float t = uTime;
  float rawP = uRawP;
  float minDim = min(res.x, res.y);
  float ew = max(uEdge * minDim, 1.0);
  float inten = uInten;
  float ts = t * uSpeed;
  float aspect = res.x / res.y;
  vec2 q = vec2(uv.x * aspect, uv.y);
  vec2 pix = uv * res;

  vec2 wq = q * 1.8;
  vec2 wv = vec2(fbm(wq + vec2(0.0, ts * 0.02)), fbm(wq + vec2(5.2, 1.3) - vec2(ts * 0.018)));
  float nr = fbm(q * 2.2 + 1.4 * wv + vec2(ts * 0.012, -ts * 0.01));
  float n = (nr - 0.22) / 0.56;
  float thr = e * 1.3 - 0.15;
  float slope = 1.6 / minDim;
#ifdef GL_OES_standard_derivatives
  slope = max(length(vec2(dFdx(n), dFdy(n))), 1.6 / minDim);
#endif
  // Without derivatives: the field's typical slope at this scale (n spans ~1 over ~0.45 of minDim).
  slope = mix(2.2 / minDim, slope, uDerivatives);
  float dpx = (n - thr) / slope;
  float adx = abs(dpx);
  float band = 1.0 - smoothstep(0.06, 0.16, abs(n - thr));
  float reveal = 1.0 - smoothstep(-0.8, 0.8, dpx);

  float live = smoothstep(0.0, 0.03, rawP) * (1.0 - smoothstep(0.93, 1.0, rawP));
  float breathe = 1.0 + 0.12 * sin(ts * 1.05) + 0.05 * sin(ts * 2.3 + 0.7);
  float widthMod = 0.6 + 0.8 * fbm(q * 3.0 + vec2(3.1 - ts * 0.07, 7.4 + ts * 0.05));
  float w = ew * breathe * widthMod;
  float coreW = max(1.2, ew * 0.08);
  float core = 1.0 - smoothstep(coreW * 0.5, coreW * 1.7, adx);
  float sideK = (dpx < 0.0 ? 0.55 : 1.0) * band;
  float inner = exp(-adx / (w * 0.28)) * sideK;
  float bloom = exp(-adx / w) * sideK;

  // The second front: the real new page, chasing the first once the result exists.
  float thr2 = uFinalE * 1.3 - 0.15;
  float dpx2 = (n - thr2) / slope;
  float adx2 = abs(dpx2);
  float band2 = (1.0 - smoothstep(0.06, 0.16, abs(n - thr2))) * uHasNew;
  float reveal2 = (1.0 - smoothstep(-0.8, 0.8, dpx2)) * uHasNew;
  float live2 = smoothstep(0.0, 0.03, uFinalP) * (1.0 - smoothstep(0.93, 1.0, uFinalP)) * uHasNew;
  float core2 = 1.0 - smoothstep(coreW * 0.5, coreW * 1.7, adx2);
  float sideK2 = (dpx2 < 0.0 ? 0.55 : 1.0) * band2;
  float inner2 = exp(-adx2 / (w * 0.28)) * sideK2;
  float bloom2 = exp(-adx2 / w) * sideK2;

  float phase = ts * 0.05 + 0.06 * sin(ts * 0.31) + 0.035 * sin(ts * 0.73 + 1.3);
  float fl = fbm(q * 1.6 + 2.0 * wv + vec2(ts * 0.03, -ts * 0.025));
  float tri = abs(fract(fl * 1.6 + phase) * 2.0 - 1.0);
  float gt = pow(clamp(tri * 0.95 + 0.02, 0.0, 1.0), 1.25);
  vec3 lab = gradLab(gt);
  vec3 rimCol = oklabToLin(vec3(clamp(lab.x + 0.1, 0.0, 0.9), lab.y * 1.12, lab.z * 1.12));
  vec3 glowCol = oklabToLin(vec3(clamp(lab.x + 0.04, 0.0, 0.86), lab.y, lab.z));

  vec3 paperLin = toLin(uPaper);
  vec3 paper2 = toLin(vec3(0.9608, 0.9451, 0.902));
  float mist = smoothstep(0.25, 0.85, fbm(q * 1.1 - vec2(ts * 0.015, ts * 0.01)));
  vec3 purpleTint = oklabToLin(vec3(0.94, 0.03, -0.045));
  vec3 paperCol = mix(paperLin, paper2, 0.55 * mist);
  paperCol = mix(paperCol, purpleTint, 0.18 * mist);
  float tf = floor(t * 24.0);
  float gr = hash21(floor(fc) + vec2(tf * 7.13, tf * 3.71)) - 0.5;
  paperCol = mix(paperCol, purpleTint, clamp(gr * 0.5 + 0.1, 0.0, 0.3));

  vec3 srcLin = uHasContent > 0.5 ? pageAt(uContent, uContentRect, uv, paperLin) : paperLin;
  vec3 col = mix(paperCol, srcLin, reveal);
  if (uHasNew > 0.5) col = mix(col, pageAt(uNew, uNewRect, uv, paperLin), reveal2);
  float isLight = smoothstep(0.08, 0.35, dot(col, vec3(0.2126, 0.7152, 0.0722)));

  float I = inten * live;
  float I2 = inten * live2;
  float softAmt = clamp((inner * 0.6 + bloom * 0.38) * I + (inner2 * 0.6 + bloom2 * 0.38) * I2, 0.0, 1.0);
  float rimAmt = clamp(core * band * 0.95 * I + core2 * band2 * 0.95 * I2, 0.0, 1.0);
  col = blendGlow(col, glowCol, softAmt, isLight);
  col = blendGlow(col, rimCol, rimAmt, isLight);

  // Border glow (Glow Edge's angular flow), breathing on the same clock, pulsing at the end.
  float kS = max(minDim * 0.012, 2.0);
  float dsum = exp(-pix.x / kS) + exp(-(res.x - pix.x) / kS) + exp(-pix.y / kS) + exp(-(res.y - pix.y) / kS);
  float dsoft = max(-kS * log(max(dsum, 1e-20)), 0.0);
  vec2 nrm = (pix - res * 0.5) / (res * 0.5);
  float ang = atan(nrm.y, nrm.x) / 6.2831853 + 0.5;
  float btri = abs(fract(ang + phase) * 2.0 - 1.0);
  vec3 blab = gradLab(clamp(btri * 0.85 + 0.05, 0.0, 1.0));
  vec3 bCol = oklabToLin(vec3(clamp(blab.x + 0.06, 0.0, 0.88), blab.y, blab.z));
  float bw = minDim * 0.03 * breathe * (1.0 + 0.8 * uPulse);
  float bEnv = max(live, live2) + uPulse;
  float bAmt = clamp((exp(-dsoft / (bw * 0.35)) * 0.45 + exp(-dsoft / bw) * 0.2) * uBorder * inten * bEnv * 0.8, 0.0, 1.0);
  col = blendGlow(col, bCol, bAmt, isLight);

  // Rare citrine sparks riding the fronts.
  float cs = max(ew * 0.9, 6.0);
  vec2 cell = floor(pix / cs);
  float rnd = hash21(cell);
  vec2 cpos = (cell + vec2(hash21(cell + vec2(3.1, 1.7)), hash21(cell + vec2(7.7, 5.3)))) * cs;
  float tw = pow(max(sin(ts * 2.2 + rnd * 40.0), 0.0), 10.0);
  float near = (inner + core * band) * I + (inner2 + core2 * band2) * I2;
  float spk = (1.0 - smoothstep(0.0, max(1.3, ew * 0.07), length(pix - cpos))) * step(0.94, rnd) * tw * near;
  col = blendGlow(col, toLin(uHi), clamp(spk, 0.0, 1.0), isLight);

  vec3 s = toSrgb(col);
  float dith = (hash21(fc + vec2(0.31, 0.71)) + hash21(fc + vec2(13.7, 47.1)) - 1.0) / 255.0;
  gl_FragColor = vec4(clamp(s + vec3(dith), 0.0, 1.0), 1.0);
}
`;

/** Brand gradient (OKLab-mixed in the shader): #2f5bea → #6e8cff → #ec4899 → #006fee. */
const STOPS: Array<{ position: number; rgb: [number, number, number] }> = [
  { position: 0, rgb: [0x78, 0x28, 0xc8] },
  { position: 0.3, rgb: [0x93, 0x53, 0xd3] },
  { position: 0.62, rgb: [0xec, 0x48, 0x99] },
  { position: 1, rgb: [0x00, 0x6f, 0xee] },
];
const PAPER: [number, number, number] = [0xfe / 255, 0xfd / 255, 0xf8 / 255];
const CITRINE: [number, number, number] = [0xfd / 255, 0xe0 / 255, 0x47 / 255];

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** sRGB 0..255 → OKLab, exactly as the Figma effect's `render()` does on the CPU. */
export function srgbToOklab([r8, g8, b8]: [number, number, number]): [number, number, number] {
  const r = srgbToLinear(r8 / 255);
  const g = srgbToLinear(g8 / 255);
  const b = srgbToLinear(b8 / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Content placement in the overlay, uv with a top-left origin: [x0, y0, x1, y1]. */
export type UvRect = [number, number, number, number];

export interface DissolveFrame {
  /** Seconds — the animation clock (wrapped by the caller to keep float precision). */
  time: number;
  /** Raw progress of the first front, 0..1. */
  progress: number;
  /** Raw progress of the second (new page) front, 0..1; 0 until the result exists. */
  finalProgress: number;
  /** Border pulse, 0..1. */
  pulse: number;
}

export const easeInOutCubicGl = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

type Source = TexImageSource;

/** One WebGL1 context on one canvas. `create` returns null when WebGL is unavailable. */
export class DissolveRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private content: WebGLTexture | null = null;
  private next: WebGLTexture | null = null;
  private contentRect: UvRect = [0, 0, 1, 1];
  private nextRect: UvRect = [0, 0, 1, 1];
  private hasDerivatives: boolean;

  static create(canvas: HTMLCanvasElement): DissolveRenderer | null {
    try {
      const options: WebGLContextAttributes = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power' };
      const gl = (canvas.getContext('webgl', options) ?? canvas.getContext('experimental-webgl', options)) as WebGLRenderingContext | null;

      if (!gl) return null;

      return new DissolveRenderer(gl);
    } catch {
      return null;
    }
  }

  private constructor(gl: WebGLRenderingContext) {
    this.gl = gl;
    this.hasDerivatives = Boolean(gl.getExtension('OES_standard_derivatives'));

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;

      gl.shaderSource(shader, source);
      gl.compileShader(shader);

      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);

        gl.deleteShader(shader);
        throw new Error(`dissolve shader: ${log}`);
      }

      return shader;
    };

    const program = gl.createProgram()!;

    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`dissolve link: ${gl.getProgramInfoLog(program)}`);

    this.program = program;
    gl.useProgram(program);

    const buffer = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    const position = gl.getAttribLocation(program, 'aPos');

    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const stops = new Float32Array(32);

    for (let i = 0; i < 8; i += 1) {
      const stop = STOPS[Math.min(i, STOPS.length - 1)]!;
      const lab = srgbToOklab(stop.rgb);

      stops.set([lab[0], lab[1], lab[2], stop.position], i * 4);
    }

    gl.uniform4fv(this.u('uStops[0]') ?? this.u('uStops'), stops);
    gl.uniform1f(this.u('uStopCount'), STOPS.length);
    gl.uniform3fv(this.u('uPaper'), PAPER);
    gl.uniform3fv(this.u('uHi'), CITRINE);
    gl.uniform1f(this.u('uEdge'), 0.025);
    gl.uniform1f(this.u('uInten'), 1);
    gl.uniform1f(this.u('uSpeed'), 1);
    gl.uniform1f(this.u('uBorder'), 1);
    gl.uniform1f(this.u('uDerivatives'), this.hasDerivatives ? 1 : 0);
    gl.uniform1i(this.u('uContent'), 0);
    gl.uniform1i(this.u('uNew'), 1);
  }

  private u(name: string) {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));

    return this.uniforms.get(name) ?? null;
  }

  private upload(unit: number, current: WebGLTexture | null, source: Source): WebGLTexture | null {
    const gl = this.gl;
    const texture = current ?? gl.createTexture();

    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
    } catch {
      return texture;
    }

    return texture;
  }

  /** What the first front reveals (the blurred original while generating). */
  setContent(source: Source | null, rect: UvRect) {
    this.content = source ? this.upload(0, this.content, source) : null;
    this.contentRect = rect;
  }

  /** What the second front reveals (the real new page). */
  setNext(source: Source | null, rect: UvRect) {
    this.next = source ? this.upload(1, this.next, source) : null;
    this.nextRect = rect;
  }

  render(width: number, height: number, frame: DissolveFrame) {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.uniform2f(this.u('uRes'), width, height);
    gl.uniform1f(this.u('uTime'), frame.time);
    gl.uniform1f(this.u('uRawP'), frame.progress);
    gl.uniform1f(this.u('uE'), easeInOutCubicGl(Math.min(1, Math.max(0, frame.progress))));
    gl.uniform1f(this.u('uFinalP'), frame.finalProgress);
    gl.uniform1f(this.u('uFinalE'), easeInOutCubicGl(Math.min(1, Math.max(0, frame.finalProgress))));
    gl.uniform1f(this.u('uPulse'), frame.pulse);
    gl.uniform1f(this.u('uHasContent'), this.content ? 1 : 0);
    gl.uniform4fv(this.u('uContentRect'), this.contentRect);
    gl.uniform1f(this.u('uHasNew'), this.next ? 1 : 0);
    gl.uniform4fv(this.u('uNewRect'), this.nextRect);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.content);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.next);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  isLost() {
    return this.gl.isContextLost();
  }

  dispose() {
    const gl = this.gl;

    if (this.content) gl.deleteTexture(this.content);
    if (this.next) gl.deleteTexture(this.next);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
