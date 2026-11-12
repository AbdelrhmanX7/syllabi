import assert from "node:assert/strict";
import { test } from "node:test";
import { BUDDY_EXPERTS, buildBrief, expertById, pickerTurn } from "../src/services/study/buddy/experts";
import { BUDDY_EVAL_CASES, renderCase } from "../src/services/study/buddy/evals/cases";

test("every expert has a job, and the picker lists them all", () => {
  assert.deepEqual(BUDDY_EXPERTS.map((e) => e.id), ["check", "hint", "explain", "solve", "similar", "quiz"]);
  const turn = pickerTurn("test me");
  for (const e of BUDDY_EXPERTS) {
    assert.ok(e.job.length > 0 && e.when.length > 20);
    assert.ok(turn.includes(`- ${e.id}: `));
  }
  assert.equal(expertById("nope"), null);
});

test("the brief carries the job, and memory / weak topics only when there are some", () => {
  const quiz = expertById("quiz")!;
  const bare = buildBrief(quiz, { memory: [], weakTopics: [] });
  assert.match(bare, /THIS TURN YOU ARE THE QUICK CHECK/);
  assert.doesNotMatch(bare, /WHAT YOU REMEMBER|WEAKEST TOPICS/);
  const full = buildBrief(quiz, { memory: ["Drops minus signs."], weakTopics: ["Chain rule (40%)"] });
  assert.match(full, /- Drops minus signs\./);
  assert.match(full, /Chain rule \(40%\)/);
});

test("every eval case names a real expert (or leaves the choice to the picker) and renders one region per line", () => {
  for (const c of BUDDY_EVAL_CASES) {
    if (c.skill) assert.ok(expertById(c.skill), c.id);
    const { svg, clusters } = renderCase(c.lines);
    assert.equal(clusters.length, c.lines.length);
    assert.ok(svg.startsWith("<svg") && clusters.every((k) => k.box.x >= 0 && k.box.x + k.box.w <= 1 && k.box.y + k.box.h <= 1), c.id);
  }
});
