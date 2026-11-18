import assert from "node:assert/strict";
import { test } from "node:test";
import { Types } from "mongoose";

import { fitDraftToTypes, parseQuestionTypes, typeFor } from "../src/services/study/question-types";

const base = {
  classId: new Types.ObjectId(),
  topic: "Rocks",
  subtopic: null,
  difficulty: 2,
  source: { kind: "manual" as const, itemId: null, pageId: null, lectureId: null, ref: null },
  imageUrl: null,
  solutionSteps: [],
  tags: [],
};

test("a switched-off multiple choice question is saved as a written one", () => {
  const out = fitDraftToTypes({ ...base, type: "mcq", stem: "Which rock is igneous?", choices: ["Basalt", "Shale"], pairs: [], answer: "Basalt" }, new Set(["free"]));
  assert.equal(out.type, "free");
  assert.deepEqual(out.choices, []);
  assert.equal(out.answer, "Basalt");
});

test("allowed types and the default pass through untouched", () => {
  const d = { ...base, type: "mcq" as const, stem: "Q", choices: ["a", "b"], pairs: [], answer: "a" };
  assert.equal(fitDraftToTypes(d, null), d);
  assert.equal(fitDraftToTypes(d, new Set(["mcq"])), d);
});

test("matching and fill-in keep their content as written questions", () => {
  const m = fitDraftToTypes({ ...base, type: "matching", stem: "Match", choices: [], pairs: [{ left: "Quartz", right: "Silicate" }], answer: "" }, new Set(["free"]));
  assert.match(m.stem, /Quartz/);
  assert.equal(m.answer, "Quartz → Silicate");
  const f = fitDraftToTypes({ ...base, type: "fill_blank", stem: "Magma cools to ___", choices: [], pairs: [], answer: '["igneous|igneous rock"]' }, new Set(["free"]));
  assert.equal(f.answer, "igneous");
});

test("settings input", () => {
  assert.deepEqual(parseQuestionTypes(["free", "free"]), { value: ["free"] });
  assert.deepEqual(parseQuestionTypes(null), { value: null });
  assert.ok("error" in parseQuestionTypes([]));
  assert.ok("error" in parseQuestionTypes(["essay"]));
  assert.equal(typeFor(new Set(["free"]), "mcq"), "free");
  assert.equal(typeFor(null, "mcq"), "mcq");
});
