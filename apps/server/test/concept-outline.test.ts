import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanOutline } from "../src/services/study/concept-outline";

test("the outline keeps units and their ideas; a parent that is not a unit makes the idea a unit; repeats go", () => {
  const out = cleanOutline({
    concepts: [
      { label: " Derivatives ", parent: null },
      { label: "Chain rule", parent: "derivatives" },
      { label: "chain rule", parent: "Derivatives" },
      { label: "Optimization", parent: "Applications" },
      { label: "", parent: null },
      { label: "Derivatives", parent: "Derivatives" },
    ],
  });
  assert.deepEqual(out, [
    { label: "Derivatives", parent: null },
    { label: "Chain rule", parent: "derivatives" },
    { label: "Optimization", parent: null },
  ]);
  assert.deepEqual(cleanOutline(null), []);
});
