import assert from "node:assert/strict";
import { test } from "node:test";

import {
  advancePhase,
  canvasPixels,
  contrast,
  frameIntervalMs,
  labelAreaGlow,
  over,
  PHASE_PERIOD,
  type Rgb,
  stepEnergy,
} from "./shader-glow";

const hex = (value: string): Rgb =>
  [0, 2, 4].map((i) => parseInt(value.slice(1 + i, 3 + i), 16) / 255) as Rgb;

// The «Redo with AI» button: secondary face (rest + hover) and its label colour, in both themes.
const CASES = [
  { name: "light rest", face: "#FFFFFF", text: "#18204A" },
  { name: "light hover", face: "#E3E9FD", text: "#18204A" },
  { name: "dark rest", face: "#192148", text: "#EFEBE0" },
  { name: "dark hover", face: "#24316E", text: "#EFEBE0" },
];

test("label stays ≥ 4.5:1 over the glow at every frame, idle and busy, both themes", () => {
  for (const { name, face, text } of CASES) {
    let worst = Infinity;

    for (const energy of [0, 0.5, 1]) {
      for (let phase = 0; phase < PHASE_PERIOD; phase += 0.2) {
        for (let x = 0; x <= 1.0001; x += 0.05) {
          for (let y = 0.25; y <= 0.75001; y += 0.125) {
            const glow = labelAreaGlow(x, y, phase, energy);

            worst = Math.min(
              worst,
              contrast(hex(text), over(hex(face), glow.color, glow.alpha)),
            );
          }
        }
      }
    }
    assert.ok(worst >= 4.5, `${name}: worst ${worst.toFixed(2)}:1`);
  }
});

test("busy is visibly stronger than idle under the label", () => {
  let idle = 0;
  let busy = 0;

  for (let phase = 0; phase < PHASE_PERIOD; phase += 0.5) {
    idle = Math.max(idle, labelAreaGlow(0.5, 0.5, phase, 0).alpha);
    busy = Math.max(busy, labelAreaGlow(0.5, 0.5, phase, 1).alpha);
  }
  assert.ok(busy > idle * 3, `idle ${idle} busy ${busy}`);
});

test("canvas size caps DPR at 2 and never goes to zero", () => {
  assert.deepEqual(canvasPixels(150, 44, 3), {
    width: 300,
    height: 88,
    scale: 2,
  });
  assert.deepEqual(canvasPixels(150, 44, 1.5), {
    width: 225,
    height: 66,
    scale: 1.5,
  });
  assert.deepEqual(canvasPixels(0, 0, Number.NaN), {
    width: 1,
    height: 1,
    scale: 1,
  });
});

test("idle draws at ~20 fps, busy every frame", () => {
  assert.equal(frameIntervalMs(0), 50);
  assert.ok(frameIntervalMs(1) < 17);
});

test("phase wraps and a long stall does not jump the pattern", () => {
  assert.ok(advancePhase(PHASE_PERIOD - 0.01, 0, 0.05) < 0.1);
  assert.ok(advancePhase(0, 1, 30) <= 0.3);
});

test("energy eases toward its target and settles", () => {
  let energy = 0;

  for (let i = 0; i < 60; i += 1) energy = stepEnergy(energy, 1, 1 / 60);
  assert.equal(energy, 1);
  assert.ok(stepEnergy(0, 1, 1 / 60) < 0.2);
});
