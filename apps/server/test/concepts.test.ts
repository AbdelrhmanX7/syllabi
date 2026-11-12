/**
 * The class knowledge map (services/study/concepts.ts + GET /study/classes/:id/knowledge): the
 * concept list is rebuilt from the account's own data and merges by norm, evidence moves a
 * concept's strength with time decay, question stats fill in before there is evidence, and the
 * route only answers for the class's owner. Same harness as share.test.ts (throwaway MongoDB
 * database; skipped when no MongoDB answers).
 */
import { after, before, describe, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const storageDir = mkdtempSync(path.join(tmpdir(), "syllabi-concepts-test-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = storageDir;
process.env.JWT_SECRET = process.env.JWT_SECRET || "concepts-test-secret-" + Math.random().toString(36).slice(2);
process.env.APP_URL = "https://app.test";

const dbName = `syllabi_test_concepts_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseUri = (process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017").replace(/\/+$/, "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mongoose: any = require("mongoose");
let mongoUp = false;

/** A test that is skipped (not failed) when no MongoDB answers. */
const test = (name: string, fn: () => Promise<void>) =>
  nodeTest(name, async (t) => {
    if (!mongoUp) return t.skip("MongoDB is not reachable");
    await fn();
  });

const DAY = 86_400_000;
const near = (a: number | null, b: number, eps = 0.002) => assert.ok(a !== null && Math.abs(a - b) <= eps, `${a} is not ≈ ${b}`);

describe("class knowledge map", () => {
  let server: Server;
  let base = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: Record<string, any> = {};
  const users: Record<string, { id: string; token: string }> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let owner: any;
  let n = 0;

  async function call(who: string | null, url: string) {
    const res = await fetch(`${base}${url}`, { headers: who ? { Authorization: `Bearer ${users[who].token}` } : {} });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const question = (topic: string, subtopic: string | null, stats: any = {}, extra: any = {}) => {
    const stem = `Question ${++n}`;
    return { userId: owner, classId: m.cls._id, topic, subtopic, stem, answer: "A", stemHash: stem, stats: { attempts: 0, correct: 0, lastResult: null, mastery: 0, ...stats }, ...extra };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byLabel = (k: any, label: string) => k.concepts.find((c: any) => c.label === label);

  before(async () => {
    mongoose.set("strictQuery", true);
    try {
      await mongoose.connect(`${baseUri}/${dbName}`, { serverSelectionTimeoutMS: 1500 });
      mongoUp = true;
    } catch {
      return;
    }
    const { createApp } = await import("../src/app");
    const { signSessionToken } = await import("../src/compat/auth");
    m.Admin = (await import("../src/models/admin")).Admin;
    Object.assign(m, await import("../src/models/study"));
    m.StudyClassGuide = (await import("../src/models/study/library")).StudyClassGuide;
    Object.assign(m, await import("../src/services/study/concepts"));
    m.recordAttempt = (await import("../src/services/study/questions")).recordAttempt;
    for (const key of ["owner", "stranger"]) {
      const admin = await m.Admin.create({ name: key, email: `${key}@example.test`, role: "user", isVerified: true });
      users[key] = { id: String(admin._id), token: signSessionToken(String(admin._id)) };
    }
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    owner = new mongoose.Types.ObjectId(users.owner.id);
    m.cls = await m.StudyClass.create({ userId: owner, source: "manual", canvasCourseId: -424242, name: "Calculus I", code: "" });
    m.other = await m.StudyClass.create({ userId: owner, source: "manual", canvasCourseId: -424243, name: "Physics I", code: "" });
    await m.StudyQuestion.insertMany([
      question("derivatives", "Chain rule", { attempts: 4, correct: 1, mastery: 0.3 }),
      question("Derivatives", "chain rules", { attempts: 2, correct: 1, mastery: 0.5 }),
      question("Derivatives", "Product rule"),
      question("Limits", null, { attempts: 5, correct: 5, mastery: 0.9 }),
      question("General", null, { attempts: 3, correct: 3, mastery: 0.9 }),
      question("Integrals", null),
    ]);
    // A question of ANOTHER class must never leak in.
    await m.StudyQuestion.create({ ...question("Kinematics", null), classId: m.other._id });
    m.map = await m.StudyConceptMap.create({ userId: owner, canvasCourseId: -424242, source: "practice", promptTerms: ["limits", "Continuity", "Tangent line"] });
    await m.StudyClassGuide.create({ userId: owner, canvasCourseId: -424242, markdown: "", examsSchedule: [{ name: "Midterm", topics: ["Integrals", "Series"], chapters: ["Ch 5"] }] });
  });

  after(async () => {
    server?.closeAllConnections();
    server?.close();
    (await import("../src/middleware/rate-limit")).closeRateLimitRedis();
    (await import("../src/services/study/page-live")).closePageLive();
    if (!mongoUp) return rmSync(storageDir, { recursive: true, force: true });
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
    rmSync(storageDir, { recursive: true, force: true });
  });

  test("sync builds the list from topics, subtopics, map terms and exam topics, merged by norm", async () => {
    const rows = await m.syncClassConcepts(owner, m.cls._id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const by = new Map<string, any>(rows.map((c: any) => [c.norm, c]));
    assert.deepEqual([...by.keys()].sort(), ["chain rule", "continuity", "derivative", "integral", "limit", "product rule", "serie", "tangent line"].sort());
    // "derivatives" was seen first, but the spelling with a capital letter wins; the other one is kept as an alias.
    assert.equal(by.get("derivative").label, "Derivatives");
    assert.deepEqual(by.get("derivative").aliases, ["derivatives"]);
    assert.equal(by.get("chain rule").label, "Chain rule");
    assert.deepEqual([...by.get("limit").sources].sort(), ["map-term", "topic"]);
    assert.deepEqual([...by.get("integral").sources].sort(), ["exam-topic", "topic"]);
    assert.deepEqual(by.get("serie").sources, ["exam-topic"]);
    assert.equal(String(by.get("chain rule").parentId), String(by.get("derivative")._id));
    assert.equal(String(by.get("product rule").parentId), String(by.get("derivative")._id));
    assert.equal(by.get("derivative").parentId, null);
    assert.equal(by.get("continuity").parentId, null);
  });

  test("sync is idempotent: a second run changes nothing", async () => {
    const snap = async () => (await m.StudyConcept.find({ userId: owner, classId: m.cls._id }).sort({ _id: 1 }).lean()).map((c: any) => JSON.stringify(c));
    const first = await snap();
    await m.syncClassConcepts(owner, m.cls._id);
    await m.syncClassConcepts(owner, m.cls._id);
    assert.deepEqual(await snap(), first);
    // Two at once still leave one row per norm.
    await Promise.all([m.syncClassConcepts(owner, m.cls._id), m.syncClassConcepts(owner, m.cls._id)]);
    assert.deepEqual(await snap(), first);
  });

  test("with no evidence, strength and tries come from the questions' own stats", async () => {
    const k = await m.classKnowledge(owner, m.cls._id);
    // Derivatives: mean mastery of its two tried questions; the untried one does not pull it down.
    near(byLabel(k, "Derivatives").strength, 0.4);
    assert.equal(byLabel(k, "Derivatives").attempts, 6);
    near(byLabel(k, "Chain rule").strength, 0.4);
    assert.equal(byLabel(k, "Chain rule").attempts, 6);
    near(byLabel(k, "Limits").strength, 0.9);
    // Not tried yet: a topic with untouched questions, a subtopic, a map term, an exam topic.
    for (const label of ["Integrals", "Product rule", "Continuity", "Series"]) {
      assert.equal(byLabel(k, label).strength, null, label);
      assert.equal(byLabel(k, label).attempts, 0, label);
      assert.equal(byLabel(k, label).lastAt, null, label);
    }
    assert.equal(byLabel(k, "General"), undefined);
    assert.equal(byLabel(k, "Kinematics"), undefined);
  });

  test("evidence sets the strength, and older evidence counts for less (half-life 21 days)", async () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    // Continuity has no questions, so this is the pure time-decayed mean.
    assert.equal(await m.recordConceptEvidence({ userId: owner, classId: m.cls._id, labels: ["continuity"], kind: "map", result: 1, at: ago(21) }), 1);
    await m.recordConceptEvidence({ userId: owner, classId: m.cls._id, labels: ["Continuity"], kind: "map", result: 0, at: now });
    let c = byLabel(await m.classKnowledge(owner, m.cls._id, now), "Continuity");
    near(c.strength, 0.5 / 1.5); // weights: 0.5 (21 days old, right) and 1 (today, wrong)
    assert.equal(c.attempts, 2);
    assert.equal(c.lastAt, now.toISOString());
    // The same two results the other way round: the recent right answer weighs more.
    await m.StudyConceptEvidence.deleteMany({ conceptId: c.id });
    await m.recordConceptEvidence({ userId: owner, classId: m.cls._id, conceptIds: [c.id], kind: "buddy", result: 0, at: ago(21) });
    await m.recordConceptEvidence({ userId: owner, classId: m.cls._id, conceptIds: [c.id], kind: "buddy", result: 1, at: now });
    c = byLabel(await m.classKnowledge(owner, m.cls._id, now), "Continuity");
    near(c.strength, 1 / 1.5);
    // 42 days later with nothing new, both have decayed alike: the mean stays, it does not drift.
    near(byLabel(await m.classKnowledge(owner, m.cls._id, new Date(now.getTime() + 42 * DAY)), "Continuity").strength, 1 / 1.5);
    // A partial result is 0.5; results are clamped to 0..1.
    await m.recordConceptEvidence({ userId: owner, classId: m.cls._id, labels: ["Series"], kind: "exam", result: 7, at: now });
    await m.recordConceptEvidence({ userId: owner, classId: m.cls._id, labels: ["Series"], kind: "exam", result: 0.5, at: now });
    near(byLabel(await m.classKnowledge(owner, m.cls._id, now), "Series").strength, 0.75);
  });

  test("evidence never throws, skips empty and General, creates unknown concepts and refuses another class's ids", async () => {
    const before = await m.StudyConcept.countDocuments({ userId: owner, classId: m.cls._id });
    assert.equal(await m.recordConceptEvidence({ userId: owner, classId: m.cls._id, labels: ["", null, "General", "  "], kind: "question", result: 1 }), 0);
    assert.equal(await m.recordConceptEvidence({ userId: owner, classId: "not-an-id", labels: ["Limits"], kind: "question", result: 1 }), 0);
    assert.equal(await m.recordConceptEvidence({ userId: owner, classId: m.cls._id, labels: ["Limits"], kind: "question", result: Number.NaN }), 0);
    const foreign = await m.StudyConcept.create({ userId: owner, classId: m.other._id, label: "Kinematics", norm: "kinematic" });
    assert.equal(await m.recordConceptEvidence({ userId: owner, classId: m.cls._id, conceptIds: [String(foreign._id), "nope"], kind: "buddy", result: 1 }), 0);
    assert.equal(await m.StudyConcept.countDocuments({ userId: owner, classId: m.cls._id }), before);
    // An unknown name becomes a concept, and survives the next sync because it has evidence.
    assert.equal(await m.recordConceptEvidence({ userId: owner, classId: m.cls._id, labels: ["Squeeze theorem", "squeeze theorems"], kind: "exam", result: 0 }), 1);
    const k = await m.classKnowledge(owner, m.cls._id);
    assert.equal(byLabel(k, "Squeeze theorem").strength, 0);
    assert.deepEqual(byLabel(k, "Squeeze theorem").sources, []);
  });

  test("answering a question records evidence against its topic and subtopic", async () => {
    const q = await m.StudyQuestion.findOne({ userId: owner, classId: m.cls._id, subtopic: "Product rule" }).lean();
    await m.recordAttempt(q, "right", {});
    // The hook is fire-and-forget: wait for its two rows.
    const product = await m.StudyConcept.findOne({ userId: owner, classId: m.cls._id, norm: "product rule" }).lean();
    for (let i = 0; i < 100 && !(await m.StudyConceptEvidence.exists({ conceptId: product._id })); i++) await new Promise((r) => setTimeout(r, 20));
    const rows = await m.StudyConceptEvidence.find({ refId: String(q._id) }).lean();
    assert.equal(rows.length, 2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.ok(rows.every((r: any) => r.kind === "question" && r.result === 1));
    const k = await m.classKnowledge(owner, m.cls._id);
    // Product rule: one right answer on a question with no earlier tries.
    assert.ok(byLabel(k, "Product rule").strength > 0.6);
    assert.equal(byLabel(k, "Product rule").attempts, 1);
    // Derivatives had a long, weak history: one right answer lifts it, it does not jump to 100 %.
    const d = byLabel(k, "Derivatives").strength;
    assert.ok(d > 0.4 && d < 0.7, `Derivatives ${d}`);
  });

  test("a concept nobody names any more goes away, unless it has evidence", async () => {
    await m.StudyClassGuide.updateOne({ userId: owner, canvasCourseId: -424242 }, { $set: { examsSchedule: [] } });
    await m.StudyConceptMap.updateOne({ _id: m.map._id }, { $set: { promptTerms: ["limits", "Continuity"] } });
    const k = await m.classKnowledge(owner, m.cls._id);
    assert.equal(byLabel(k, "Tangent line"), undefined); // no evidence → removed
    assert.deepEqual(byLabel(k, "Series").sources, []); // has evidence → kept
    assert.deepEqual(byLabel(k, "Integrals").sources, ["topic"]);
  });

  test("edges: a subtopic is part of its topic; graded map links join concepts of the class", async () => {
    await m.StudyConceptMapAttempt.create({
      userId: owner,
      mapId: m.map._id,
      promptTerms: ["limits", "Continuity"],
      reading: {
        nodes: [
          { id: "a", label: "Limit" },
          { id: "b", label: "continuity of a function" },
          { id: "c", label: "Something else" },
          { id: "d", label: "The chain rule" },
        ],
        edges: [
          { from: "a", to: "b", label: "defines" },
          { from: "b", to: "a", label: "needs" }, // the same pair again
          { from: "a", to: "c", label: "?" }, // one end is not a concept
          { from: "a", to: "a", label: "self" },
          { from: "d", to: "a", label: "uses" },
        ],
      },
      verdict: { score: 5, max: 10, missingTerms: [], unlabeledArrows: 0, wrongLinks: [], suggestions: [] },
    });
    const k = await m.classKnowledge(owner, m.cls._id);
    const id = (label: string) => byLabel(k, label).id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const has = (a: string, b: string, kind: string) => k.edges.some((e: any) => e.kind === kind && ((e.from === id(a) && e.to === id(b)) || (e.from === id(b) && e.to === id(a))));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const partOf = k.edges.filter((e: any) => e.kind === "part-of");
    assert.equal(partOf.length, 2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.ok(partOf.some((e: any) => e.from === id("Chain rule") && e.to === id("Derivatives")));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.ok(partOf.some((e: any) => e.from === id("Product rule") && e.to === id("Derivatives")));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(k.edges.filter((e: any) => e.kind === "linked").length, 2);
    assert.ok(has("Limits", "Continuity", "linked"));
    assert.ok(has("Chain rule", "Limits", "linked"));
  });

  test("the route answers the owner and refuses everyone else", async () => {
    const url = `/study/classes/${m.cls._id}/knowledge`;
    assert.equal((await call(null, url)).status, 401);
    const denied = await call("stranger", url);
    assert.equal(denied.status, 404);
    assert.equal(denied.body.code, "NOT_FOUND");
    assert.equal((await call("owner", "/study/classes/nope/knowledge")).status, 400);
    const res = await call("owner", url);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ["concepts", "edges"]);
    const limits = byLabel(res.body, "Limits");
    assert.deepEqual(Object.keys(limits).sort(), ["attempts", "id", "label", "lastAt", "parentId", "sources", "strength"]);
    assert.equal(typeof limits.strength, "number");
    // The stranger's own (empty) account has nothing, and reading it built nothing in the owner's class.
    assert.equal(await m.StudyConcept.countDocuments({ userId: new mongoose.Types.ObjectId(users.stranger.id) }), 0);
  });
});
