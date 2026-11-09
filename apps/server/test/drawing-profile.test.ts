import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProfilePatch } from "../src/services/study/drawing-profile";

test("paper ruling: lined and grid mm are saved, rounded to 0.1 mm", () => {
  assert.deepEqual(parseProfilePatch({ paper: { linedMm: 7.94, gridMm: 5 } }), { set: { "paper.linedMm": 7.9, "paper.gridMm": 5 } });
});

test("paper ruling: null clears, one field alone is fine", () => {
  assert.deepEqual(parseProfilePatch({ paper: { gridMm: null } }), { set: { "paper.gridMm": null } });
});

test("paper ruling: out of range, empty or unknown fields are refused", () => {
  assert.ok("error" in parseProfilePatch({ paper: { linedMm: 1 } }));
  assert.ok("error" in parseProfilePatch({ paper: {} }));
  assert.ok("error" in parseProfilePatch({ paper: { dotMm: 5 } }));
});
