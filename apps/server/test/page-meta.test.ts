/**
 * Notebook details helpers (services/study/page-meta.ts): the AI reply is cleaned, tags are
 * normalised, math-ish tags turn the math tools on, and a field the owner edited is never written by AI.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  coverImagePrompt,
  describeIsFresh,
  effectiveEdited,
  hasMathTag,
  isAutoNoteTitle,
  isMathTag,
  mathToolsOn,
  META_DESCRIPTION_MAX,
  normalizeDescription,
  normalizeTag,
  normalizeTags,
  planMetaWrite,
  sanitizeDescribeReply,
} from "../src/services/study/page-meta";

describe("sanitizeDescribeReply", () => {
  test("keeps clean fields", () => {
    const r = sanitizeDescribeReply({ title: "Limits and continuity", description: "Epsilon-delta limits.", tags: ["Calculus", "limits"], icon: "sigma", color: "green" });
    assert.deepEqual(r, { title: "Limits and continuity", description: "Epsilon-delta limits.", tags: ["calculus", "limits"], icon: "sigma", color: "green" });
  });
  test("off-list icon/colour fall back; junk never throws", () => {
    const r = sanitizeDescribeReply({ title: 42, description: ["x"], tags: "math", icon: "skull", color: "#000000" });
    assert.deepEqual(r, { title: null, description: null, tags: [], icon: "notebook-pen", color: "blue" });
    for (const junk of [null, undefined, "text", 5, []]) assert.equal(sanitizeDescribeReply(junk).icon, "notebook-pen");
  });
  test("strips quotes from the title and caps the description", () => {
    const r = sanitizeDescribeReply({ title: '"Vectors"', description: "word ".repeat(200) });
    assert.equal(r.title, "Vectors");
    assert.ok(r.description!.length <= META_DESCRIPTION_MAX);
    assert.ok(r.description!.endsWith("…"));
  });
});

describe("tags", () => {
  test("normalizeTag", () => {
    assert.equal(normalizeTag("  #Linear   Algebra "), "linear algebra");
    assert.equal(normalizeTag(""), "");
    assert.equal(normalizeTag(7), "");
    assert.equal(normalizeTag("a".repeat(40)).length, 24);
  });
  test("normalizeTags dedupes, drops empties, caps at 6", () => {
    assert.deepEqual(normalizeTags(["Math", "math ", "", "  ", "physics", 3, "a", "b", "c", "d", "e"]), ["math", "physics", "a", "b", "c", "d"]);
    assert.deepEqual(normalizeTags("math"), []);
  });
  test("normalizeDescription", () => {
    assert.equal(normalizeDescription("  two\n lines "), "two lines");
    assert.equal(normalizeDescription("   "), null);
  });
});

describe("math tags", () => {
  test("whole tags and words inside tags", () => {
    for (const t of ["math", "Calculus", "linear algebra", "statistics", "physics", "quantum mechanics", "discrete math"]) assert.ok(isMathTag(t), t);
    for (const t of ["history", "biology", "software engineering", "poetry", ""]) assert.ok(!isMathTag(t), t);
  });
  test("mathToolsOn: on/off win, auto follows tags", () => {
    assert.equal(mathToolsOn("on", []), true);
    assert.equal(mathToolsOn("off", ["calculus"]), false);
    assert.equal(mathToolsOn("auto", ["history", "calculus"]), true);
    assert.equal(mathToolsOn("auto", ["history"]), false);
    assert.equal(mathToolsOn(undefined, null), false);
    assert.equal(hasMathTag(["algebra"]), true);
  });
});

describe("user edits are never overwritten", () => {
  const reply = sanitizeDescribeReply({ title: "AI title", description: "AI words.", tags: ["ai"], icon: "atom", color: "red" });

  test("auto titles are AI's, typed titles are the owner's", () => {
    assert.ok(isAutoNoteTitle("Untitled"));
    assert.ok(isAutoNoteTitle("MATH-192 — Week 8 · Sun Oct 18"));
    assert.ok(isAutoNoteTitle("Lecture 8 — Earthquakes"));
    assert.ok(!isAutoNoteTitle("My exam notes"));
  });

  test("fresh notebook: AI writes every field", () => {
    const plan = planMetaWrite({ title: "Untitled" }, reply);
    assert.deepEqual(plan.set, { title: "AI title", description: "AI words.", tags: ["ai"] });
    assert.equal(plan.cover, true);
  });

  test("a typed title (no flags yet) counts as the owner's", () => {
    const plan = planMetaWrite({ title: "My exam notes" }, reply);
    assert.equal(plan.set.title, undefined);
    assert.equal(plan.set.description, "AI words.");
  });

  test("flags block each field; a cover the owner picked is kept", () => {
    const plan = planMetaWrite(
      { title: "Untitled", metaEdited: { title: true, description: true, tags: true, cover: true } },
      reply
    );
    assert.deepEqual(plan.set, {});
    assert.equal(plan.cover, false);
    assert.equal(planMetaWrite({ title: "x", cover: { by: "user" } }, reply).cover, false);
  });

  test("an explicit false flag hands even a non-auto title back to AI", () => {
    const plan = planMetaWrite({ title: "Old AI title", metaEdited: { title: false } }, reply);
    assert.equal(plan.set.title, "AI title");
  });

  test("cover-only run leaves the text alone; empty AI fields never blank stored ones", () => {
    assert.deepEqual(planMetaWrite({ title: "Untitled" }, reply, { only: "cover" }).set, {});
    const empty = sanitizeDescribeReply({});
    assert.deepEqual(planMetaWrite({ title: "Untitled", description: "kept" }, empty).set, {});
  });

  test("effectiveEdited reads missing flags from the data", () => {
    assert.deepEqual(effectiveEdited({ title: "Notebook" }), { title: false, description: false, tags: false, cover: false });
    assert.deepEqual(effectiveEdited({ title: "Mine", cover: { by: "user" } }), { title: true, description: false, tags: false, cover: true });
  });
});

describe("describe bookkeeping", () => {
  test("skips when nothing moved, unless forced", () => {
    assert.equal(describeIsFresh({ version: 10, metaAiVersion: 10 }, false), true);
    assert.equal(describeIsFresh({ version: 11, metaAiVersion: 10 }, false), false);
    assert.equal(describeIsFresh({ version: 10, metaAiVersion: 10 }, true), false);
    assert.equal(describeIsFresh({ version: 3, metaAiVersion: null }, false), false);
  });
  test("cover prompt forbids text in the picture", () => {
    assert.match(coverImagePrompt(reply()), /no text, letters, numbers/i);
    function reply() {
      return sanitizeDescribeReply({ title: "Vectors", tags: ["physics"] });
    }
  });
});
