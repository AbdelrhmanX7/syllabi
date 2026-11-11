import { useEffect, useRef, useState } from "react";

import {
  advancePhase,
  canvasPixels,
  frameIntervalMs,
  GLOW_FRAG,
  GLOW_VERT,
  RIM_CSS_PX,
  stepEnergy,
} from "@/lib/shader-glow";

/**
 * A soft living glow for AI buttons: a flowing blue/yellow rim inside the button, calm when idle,
 * stronger (wider rim, faint wash, a light sweep, faster flow) while `busy`.
 *
 * Drop it as the FIRST child of a button that has `relative isolate` (and keeps its own background):
 * it sits at z -1 inside the button's stacking context, so it paints over the face but under the label,
 * spinner and icon, and never touches the button's border, lip or size.
 *
 * Budget: one canvas sized to the button (DPR ≤ 2), WebGL1, ~20 fps idle / every frame busy. The loop
 * stops when the button is off-screen, the tab is hidden, or `active` is false, and everything is
 * released on unmount. No WebGL, a software renderer, or reduced motion → renders nothing, so the
 * button keeps its plain designed look.
 */
export function ShaderGlow({
  busy = false,
  active = true,
}: {
  busy?: boolean;
  active?: boolean;
}) {
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const busyRef = useRef(busy);
  const activeRef = useRef(active);
  const kickRef = useRef<() => void>(() => undefined);
  const [enabled, setEnabled] = useState(false);

  busyRef.current = busy;
  activeRef.current = active;

  // Reduced motion decides whether there is a canvas at all; follow the setting live.
  useEffect(() => {
    const query =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const sync = () => setEnabled(!query?.matches);

    sync();
    if (!query) return;
    // addEventListener on MediaQueryList is Chrome 45+; addListener is the older spelling.
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", sync);

      return () => query.removeEventListener("change", sync);
    }
    query.addListener(sync);

    return () => query.removeListener(sync);
  }, []);

  useEffect(() => {
    kickRef.current();
  }, [busy, active]);

  useEffect(() => {
    const box = boxRef.current;

    if (!enabled || !box) return;

    // Made here, not in JSX: a released (lost) context sticks to its canvas, so every run of this effect
    // (StrictMode runs it twice) needs a fresh one.
    const canvas = document.createElement("canvas");

    canvas.className = "block h-full w-full";
    box.appendChild(canvas);

    const host = box.parentElement;
    let gl: WebGLRenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    let uniforms: Record<
      "res" | "phase" | "energy" | "rim" | "radius",
      WebGLUniformLocation | null
    > | null = null;
    let raf = 0;
    let lost = false;
    let inView = true;
    let pageVisible = typeof document === "undefined" || !document.hidden;
    let energy = busyRef.current ? 1 : 0;
    let phase = 0;
    let lastTick = 0;
    let lastDraw = 0;
    let scale = 1;
    let radiusCss = 10;
    let disposed = false;

    const fail = () => {
      if (!disposed) setEnabled(false);
    };

    const init = (): boolean => {
      try {
        gl = canvas.getContext("webgl", {
          alpha: true,
          premultipliedAlpha: true,
          antialias: false,
          depth: false,
          stencil: false,
          preserveDrawingBuffer: false,
          powerPreference: "low-power",
          // Software-rendered WebViews get the static button instead of a slow canvas.
          failIfMajorPerformanceCaveat: true,
        }) as WebGLRenderingContext | null;
      } catch {
        gl = null;
      }
      if (!gl) return false;

      const compile = (type: number, source: string) => {
        const shader = gl!.createShader(type);

        if (!shader) return null;
        gl!.shaderSource(shader, source);
        gl!.compileShader(shader);
        if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
          gl!.deleteShader(shader);

          return null;
        }

        return shader;
      };
      const vs = compile(gl.VERTEX_SHADER, GLOW_VERT);
      const fs = compile(gl.FRAGMENT_SHADER, GLOW_FRAG);

      program = gl.createProgram();
      if (!vs || !fs || !program) return false;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
      gl.useProgram(program);

      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      // One big triangle covers the viewport (cheaper than a quad: no diagonal seam).
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]),
        gl.STATIC_DRAW,
      );
      const pos = gl.getAttribLocation(program, "a_pos");

      gl.enableVertexAttribArray(pos);
      gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
      uniforms = {
        res: gl.getUniformLocation(program, "u_res"),
        phase: gl.getUniformLocation(program, "u_phase"),
        energy: gl.getUniformLocation(program, "u_energy"),
        rim: gl.getUniformLocation(program, "u_rim"),
        radius: gl.getUniformLocation(program, "u_radius"),
      };
      gl.clearColor(0, 0, 0, 0);

      return true;
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const size = canvasPixels(
        rect.width,
        rect.height,
        window.devicePixelRatio || 1,
      );

      scale = size.scale;
      // Attributes, not CSS: the canvas's CSS box is the button's padding box and never changes layout.
      if (canvas.width !== size.width) canvas.width = size.width;
      if (canvas.height !== size.height) canvas.height = size.height;
      if (host) {
        const style = window.getComputedStyle(host);

        radiusCss = Math.max(
          0,
          (parseFloat(style.borderTopLeftRadius) || 0) -
            (parseFloat(style.borderTopWidth) || 0),
        );
      }
      gl?.viewport(0, 0, canvas.width, canvas.height);
      lastDraw = 0;
      kick();
    };

    const draw = () => {
      if (!gl || !uniforms) return;
      gl.uniform2f(uniforms.res, canvas.width, canvas.height);
      gl.uniform1f(uniforms.phase, phase);
      gl.uniform1f(uniforms.energy, energy);
      gl.uniform1f(uniforms.rim, RIM_CSS_PX * scale);
      gl.uniform1f(uniforms.radius, radiusCss * scale);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const running = () =>
      !disposed && !lost && activeRef.current && inView && pageVisible;

    const tick = (now: number) => {
      raf = 0;
      if (!running()) return;
      const dt = lastTick ? (now - lastTick) / 1000 : 0;

      lastTick = now;
      energy = stepEnergy(energy, busyRef.current ? 1 : 0, dt);
      phase = advancePhase(phase, energy, dt);
      if (now - lastDraw >= frameIntervalMs(energy) - 1) {
        lastDraw = now;
        draw();
      }
      raf = window.requestAnimationFrame(tick);
    };

    function kick() {
      if (raf || !running()) return;
      lastTick = 0;
      raf = window.requestAnimationFrame(tick);
    }

    const stop = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
    };

    const onLost = (event: Event) => {
      event.preventDefault(); // lets the browser restore the context later
      lost = true;
      stop();
    };
    const onRestored = () => {
      lost = false;
      if (!init()) return fail();
      resize();
    };
    const onVisibility = () => {
      pageVisible = !document.hidden;
      if (pageVisible) kick();
      else stop();
    };

    if (!init()) {
      canvas.remove();
      fail();

      return;
    }

    canvas.addEventListener("webglcontextlost", onLost, false);
    canvas.addEventListener("webglcontextrestored", onRestored, false);
    document.addEventListener("visibilitychange", onVisibility);

    // Both observers are old (Chrome 51 / 64) but guarded anyway: without them we just keep running
    // (still paused by tab visibility and `active`) and size once + on window resize.
    let io: IntersectionObserver | null = null;
    let ro: ResizeObserver | null = null;

    if (typeof IntersectionObserver === "function") {
      io = new IntersectionObserver((entries) => {
        inView = entries.some((entry) => entry.isIntersecting);
        if (inView) kick();
        else stop();
      });
      io.observe(canvas);
    }
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(resize);
      ro.observe(canvas);
    } else {
      window.addEventListener("resize", resize);
    }
    resize();
    kickRef.current = () => {
      if (activeRef.current) kick();
      else stop();
    };

    return () => {
      disposed = true;
      stop();
      kickRef.current = () => undefined;
      io?.disconnect();
      ro?.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost, false);
      canvas.removeEventListener("webglcontextrestored", onRestored, false);
      if (gl) {
        if (buffer) gl.deleteBuffer(buffer);
        if (program) gl.deleteProgram(program);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
      gl = null;
      canvas.remove();
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <span
      ref={boxRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]"
    />
  );
}
