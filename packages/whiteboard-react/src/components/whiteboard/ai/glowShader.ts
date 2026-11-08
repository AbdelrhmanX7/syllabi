import { srgbToOklab } from './dissolveShader';

/**
 * The full-board «AI glow» while a draft page is generating: the brand gradient hugging the edges of
 * the board viewport and flowing around its perimeter, breathing — the same palette and OKLab mixing
 * as the dissolve (dissolveShader.ts), Apple-Intelligence style.
 *
 * Android budget: the glow is soft by nature, so it renders at a fraction of the CSS size (the browser
 * upscales the canvas bilinearly, which only softens it further) and at ~30 fps. No CSS filters, one
 * transparent quad; the canvas layer itself is only ever animated by opacity.
 */

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAGMENT = `
precision mediump float;

uniform vec4 uStops[4];
uniform vec3 uHi;
uniform vec2 uRes;
uniform float uTime;
uniform float uPulse;
uniform float uScale;

vec3 oklabToLin(vec3 lab) {
  float l1 = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m1 = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s1 = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  return max(vec3(
    4.0767416621 * l1 * l1 * l1 - 3.3077115913 * m1 * m1 * m1 + 0.2309699292 * s1 * s1 * s1,
    -1.2684380046 * l1 * l1 * l1 + 2.6097574011 * m1 * m1 * m1 - 0.3413193965 * s1 * s1 * s1,
    -0.0041960863 * l1 * l1 * l1 - 0.7034186147 * m1 * m1 * m1 + 1.7076147010 * s1 * s1 * s1), vec3(0.0));
}

vec3 toSrgb(vec3 c) {
  vec3 cc = clamp(c, 0.0, 1.0);
  return mix(1.055 * pow(cc, vec3(1.0 / 2.4)) - 0.055, cc * 12.92, step(cc, vec3(0.0031308)));
}

vec3 gradLab(float t) {
  vec3 col = uStops[0].xyz;
  for (int i = 1; i < 4; i++) {
    vec4 a = uStops[i - 1];
    vec4 b = uStops[i];
    float k = clamp((t - a.w) / max(b.w - a.w, 0.0001), 0.0, 1.0);
    if (t >= a.w) col = mix(a.xyz, b.xyz, k * k * (3.0 - 2.0 * k));
  }
  return col;
}

float hash11(float p) {
  return fract(sin(p * 127.1) * 43758.5453);
}

void main() {
  vec2 pix = gl_FragCoord.xy;
  vec2 res = uRes;
  float t = uTime;
  // Distance to the nearest edge, in CSS px (uScale = canvas px per CSS px).
  float d = min(min(pix.x, res.x - pix.x), min(pix.y, res.y - pix.y)) / uScale;

  // Where along the perimeter this pixel is (0..1), so the gradient flows around the board.
  vec2 nrm = (pix - res * 0.5) / (res * 0.5);
  float ang = atan(nrm.y * res.y, nrm.x * res.x) / 6.2831853 + 0.5;

  float breathe = 0.82 + 0.12 * sin(t * 1.15) + 0.06 * sin(t * 2.6 + 0.9);
  float flow = ang + t * 0.045 + 0.04 * sin(t * 0.37);
  float tri = abs(fract(flow) * 2.0 - 1.0);
  vec3 lab = gradLab(clamp(tri, 0.0, 1.0));
  vec3 col = oklabToLin(vec3(clamp(lab.x + 0.05, 0.0, 0.9), lab.y * 1.08, lab.z * 1.08));

  // A slow swell running around the edge: brighter lobes chase each other.
  float lobes = 0.75 + 0.25 * sin(ang * 6.2831853 * 3.0 - t * 1.4);
  float width = (22.0 + 10.0 * sin(t * 0.8 + ang * 12.566)) * (1.0 + 0.9 * uPulse);
  float core = exp(-d / 3.5);
  float bloom = exp(-d / width);
  float a = clamp((core * 0.55 + bloom * 0.6) * breathe * lobes * (1.0 + 0.6 * uPulse), 0.0, 1.0);

  // Rare citrine glints riding the rim.
  float seg = floor(ang * 64.0);
  float glint = step(0.93, hash11(seg)) * pow(max(sin(t * 1.9 + hash11(seg + 3.0) * 40.0), 0.0), 12.0) * core;
  col = mix(col, uHi, clamp(glint, 0.0, 1.0));
  a = max(a, glint * 0.9);

  // Premultiplied output over the board.
  gl_FragColor = vec4(toSrgb(col) * a, a);
}
`;

const STOPS: Array<{ position: number; rgb: [number, number, number] }> = [
  { position: 0, rgb: [0x78, 0x28, 0xc8] },
  { position: 0.3, rgb: [0x93, 0x53, 0xd3] },
  { position: 0.62, rgb: [0xec, 0x48, 0x99] },
  { position: 1, rgb: [0x00, 0x6f, 0xee] },
];
const CITRINE: [number, number, number] = [0xfd / 255, 0xe0 / 255, 0x47 / 255];

/** Canvas pixels per CSS pixel: the glow is soft, half resolution is indistinguishable. */
export const glowScale = (devicePixelRatio: number): number => Math.min(Math.max(devicePixelRatio || 1, 1), 1.5) * 0.5;

export class GlowRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();

  static create(canvas: HTMLCanvasElement): GlowRenderer | null {
    try {
      const options: WebGLContextAttributes = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' };
      const gl = (canvas.getContext('webgl', options) ?? canvas.getContext('experimental-webgl', options)) as WebGLRenderingContext | null;

      return gl ? new GlowRenderer(gl) : null;
    } catch {
      return null;
    }
  }

  private constructor(gl: WebGLRenderingContext) {
    this.gl = gl;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;

      gl.shaderSource(shader, source);
      gl.compileShader(shader);

      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`glow shader: ${gl.getShaderInfoLog(shader)}`);

      return shader;
    };
    const program = gl.createProgram()!;

    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`glow link: ${gl.getProgramInfoLog(program)}`);

    this.program = program;
    gl.useProgram(program);

    const buffer = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    const position = gl.getAttribLocation(program, 'aPos');

    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const stops = new Float32Array(16);

    STOPS.forEach((stop, i) => {
      const lab = srgbToOklab(stop.rgb);

      stops.set([lab[0], lab[1], lab[2], stop.position], i * 4);
    });
    gl.uniform4fv(this.u('uStops[0]') ?? this.u('uStops'), stops);
    gl.uniform3fv(this.u('uHi'), CITRINE);
    gl.clearColor(0, 0, 0, 0);
  }

  private u(name: string) {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));

    return this.uniforms.get(name) ?? null;
  }

  render(width: number, height: number, scale: number, time: number, pulse: number) {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.u('uRes'), width, height);
    gl.uniform1f(this.u('uTime'), time);
    gl.uniform1f(this.u('uPulse'), pulse);
    gl.uniform1f(this.u('uScale'), scale);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  isLost() {
    return this.gl.isContextLost();
  }

  dispose() {
    this.gl.deleteProgram(this.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
