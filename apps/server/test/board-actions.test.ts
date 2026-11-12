import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { buildBoardActionsPrompt, parseBoardInput, sanitizeBoardActions, tagBoardImage } from "../src/services/study/board-actions";

const clusters = [
  { id: "c1", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.05 } },
  { id: "p1", box: { x: 0.1, y: 0.3, w: 0.5, h: 0.1 } },
];

test("the contract version: absent = 1, v:2 = 2", () => {
  const json = (extra: object) => JSON.stringify({ question: "is this right?", clusters, ...extra });
  const v1 = parseBoardInput(json({}));
  const v2 = parseBoardInput(json({ v: 2 }));
  assert.ok("input" in v1 && v1.input.v === 1);
  assert.ok("input" in v2 && v2.input.v === 2);
  assert.match(buildBoardActionsPrompt((v2 as any).input), /solve the problem yourself first/);
  assert.doesNotMatch(buildBoardActionsPrompt((v1 as any).input), /solve the problem yourself first/);
});

test("v2 keeps marks, notes beside a region and the verdict; v1 drops them", () => {
  const raw = {
    verdict: "partly",
    say: "Almost: line 2 drops the minus sign.",
    actions: [
      { type: "mark", target: { clusterId: "1" }, verdict: "wrong", label: "should be −3x" },
      { type: "mark", target: { clusterId: "9" }, verdict: "wrong" },
      { type: "mark", target: { clusterId: "2" }, verdict: "maybe" },
      { type: "write", text: "check the sign", near: { clusterId: "2" } },
      { type: "write", text: "old style", at: { x: 0.5, y: 0.5 } },
    ],
  };
  const v2 = sanitizeBoardActions(raw, clusters, 2);
  assert.equal(v2?.verdict, "partly");
  assert.deepEqual(v2?.actions, [
    { type: "mark", target: { clusterId: "c1" }, verdict: "wrong", label: "should be −3x" },
    { type: "write", text: "check the sign", near: { clusterId: "p1" } },
    { type: "write", text: "old style", at: { x: 0.5, y: 0.5 } },
  ]);
  const v1 = sanitizeBoardActions(raw, clusters, 1);
  assert.equal(v1?.verdict, undefined);
  assert.deepEqual(v1?.actions, [{ type: "write", text: "old style", at: { x: 0.5, y: 0.5 } }]);
});

test("the tagged copy is a JPEG of the same size; no regions = no copy", async () => {
  const page = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
  const tagged = await tagBoardImage(page, clusters);
  assert.ok(tagged);
  const meta = await sharp(tagged).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 300);
  // The outline is really drawn: a magenta-ish pixel on the first region's top edge.
  const { data } = await sharp(tagged).raw().toBuffer({ resolveWithObject: true });
  const o = (30 * 400 + 100) * 3;
  assert.ok(data[o] > data[o + 1] + 40, "no outline on the region edge");
  assert.equal(await tagBoardImage(page, []), null);
});

test("«solve it»: v2 keeps the steps (trimmed, bounded); v1 and a reply without them carry none", () => {
  const raw = { say: "Here is question 2.", actions: [], steps: ["  Subtract 3:   2x = 8 ", "", 7, "x = 4", ...Array.from({ length: 20 }, (_, i) => `extra ${i}`)] };
  const v2 = sanitizeBoardActions(raw, clusters, 2);
  assert.equal(v2?.steps?.length, 14);
  assert.deepEqual(v2?.steps?.slice(0, 2), ["Subtract 3: 2x = 8", "x = 4"]);
  assert.equal(sanitizeBoardActions(raw, clusters, 1)?.steps, undefined);
  assert.equal(sanitizeBoardActions({ actions: [] }, clusters, 2)?.steps, undefined);
  assert.match(buildBoardActionsPrompt((parseBoardInput(JSON.stringify({ v: 2, question: "solve", clusters: [] })) as any).input), /`steps`/);
});

test("v3 (the buddy's experts): skill / class / page in; quiz, similar and remember out — and only in v3", () => {
  const input = (parseBoardInput(JSON.stringify({ v: 3, question: "test me", clusters: [], skill: "quiz", classId: "a".repeat(24), pageId: "nope" })) as any).input;
  assert.deepEqual([input.v, input.skill, input.classId, input.pageId], [3, "quiz", "a".repeat(24), undefined]);
  assert.equal((parseBoardInput(JSON.stringify({ v: 2, question: "q", clusters: [], skill: "quiz" })) as any).input.skill, undefined);
  const raw = {
    actions: [],
    say: "Quick one:",
    quiz: { question: "What is $\\frac{d}{dx}x^2$?", choices: ["$2x$", "$x$", "$x^2$", "$2$"], answer: 0, why: "Power rule: bring the 2 down.", topic: "Power rule" },
    similar: { title: "Product rule", markdown: "Find $\\frac{dy}{dx}$ for\n\n$y = x^3\\cos(2x)$." },
    remember: ["Drops the minus sign when moving terms across.", "second", "third"],
  };
  const v3 = sanitizeBoardActions(raw, clusters, 3);
  assert.equal(v3?.quiz?.choices.length, 4);
  assert.equal(v3?.similar?.markdown, "Find $\\frac{dy}{dx}$ for\n\n$y = x^3\\cos(2x)$.");
  assert.equal(v3?.remember?.length, 2);
  const v2 = sanitizeBoardActions(raw, clusters, 2);
  assert.deepEqual([v2?.quiz, v2?.similar, v2?.remember], [undefined, undefined, undefined]);
  // A quick check with the answer out of range, or two equal choices, is dropped.
  assert.equal(sanitizeBoardActions({ actions: [], quiz: { ...raw.quiz, answer: 4 } }, clusters, 3)?.quiz, undefined);
  assert.equal(sanitizeBoardActions({ actions: [], quiz: { ...raw.quiz, choices: ["a", "a", "b", "c"] } }, clusters, 3)?.quiz, undefined);
});
