/**
 * Sharing, phase 2 part A: the "editor" role. Editors change the ORIGINAL through the normal study
 * write routes; viewers, strangers and link holders get 404; progress / score never move.
 * Same harness as share.test.ts (throwaway MongoDB database, local storage driver; skipped when no
 * MongoDB answers), with its own fixtures.
 */
import { after, before, describe, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const storageDir = mkdtempSync(path.join(tmpdir(), "syllabi-share-edit-test-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = storageDir;
process.env.JWT_SECRET = process.env.JWT_SECRET || "share-edit-test-secret-" + Math.random().toString(36).slice(2);
process.env.APP_URL = "https://app.test";

const dbName = `syllabi_test_share_edit_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseUri = (process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017").replace(/\/+$/, "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mongoose: any = require("mongoose");
let mongoUp = false;

const test = (name: string, fn: () => Promise<void>) =>
  nodeTest(name, async (t) => {
    if (!mongoUp) return t.skip("MongoDB is not reachable");
    await fn();
  });

describe("sharing: editors", () => {
  let server: Server;
  let base = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: Record<string, any> = {};
  const users: Record<string, { id: string; token: string; email: string }> = {};
  const shares: Record<string, string> = {};
  let linkToken = "";

  async function call(who: string | null, method: string, url: string, body?: unknown, raw?: string) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer ${users[who].token}` } : {}) },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  const board = (marker: string) => JSON.stringify({ id: "b", pages: [{ canvasJSON: JSON.stringify({ objects: [marker] }) }] });

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
    m.storage = await import("../src/services/study/storage");
    for (const key of ["owner", "maya", "viewer", "stranger"]) {
      const email = `${key}@example.test`;
      const admin = await m.Admin.create({ name: key[0].toUpperCase() + key.slice(1), email, role: "user", isVerified: true });
      users[key] = { id: String(admin._id), token: signSessionToken(String(admin._id)), email };
    }
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const owner = oid(users.owner.id);
    m.clsA = await m.StudyClass.create({ userId: owner, source: "manual", canvasCourseId: -777001, name: "Biology 101", code: "" });
    m.clsB = await m.StudyClass.create({ userId: owner, source: "manual", canvasCourseId: -777002, name: "Chemistry", code: "" });
    const page = async (title: string) => {
      const id = new mongoose.Types.ObjectId();
      const key = m.storage.pageContentKey(users.owner.id, String(id), 1);
      await m.storage.putStudyObject(key, Buffer.from(board(`${title} v1`)), "application/json");
      return m.StudyPage.create({ _id: id, userId: owner, classId: m.clsA._id, title, kind: "note", version: 1, contentKey: key, week: 3 });
    };
    m.pageA = await page("Cell notes");
    m.pageB = await page("Private diary");
    const due = new Date("2030-01-01T00:00:00Z");
    const q = (stem: string, tags: string[], topic: string, classId = m.clsA._id) => ({
      userId: owner,
      classId,
      topic,
      stem,
      answer: "A",
      tags,
      stemHash: stem,
      stats: { attempts: 4, correct: 3, mastery: 0.8, lastResult: "right" },
      srs: { dueAt: due, stability: 12, difficulty: 4, reps: 5, lapses: 1, lastReviewAt: due },
    });
    const rows = await m.StudyQuestion.insertMany([
      q("What is a cell?", ["flashcard"], "Cells"),
      q("Mitochondria?", ["flashcard"], "Cells"),
      q("Explain osmosis", [], "Cells"),
      q("DNA?", ["flashcard"], "Genes"),
      q("Alkane?", ["flashcard"], "Organic", m.clsB._id),
    ]);
    [m.card1, m.card2, m.question, m.genesCard, m.chemCard] = rows;
    m.map = await m.StudyConceptMap.create({ userId: owner, canvasCourseId: -777001, source: "practice", lecture: "Lecture 4", promptTerms: ["lipid", "protein"], manualScore: 7, score: 7, scoreSource: "manual" });
    m.mapB = await m.StudyConceptMap.create({ userId: owner, canvasCourseId: -777001, source: "practice", lecture: "Lecture 5", promptTerms: ["x"] });
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

  test("roles: per person on create, the link stays view-only, shared-with-me and the view say the role", async () => {
    const res = await call("owner", "POST", "/share", {
      resourceType: "notebook",
      resourceId: String(m.pageA._id),
      emails: [{ email: "maya@example.test", role: "editor" }, "viewer@example.test"],
      link: true,
    });
    assert.equal(res.status, 201);
    const roles = Object.fromEntries(res.body.share.people.map((p: any) => [p.email, p.role]));
    assert.deepEqual(roles, { "maya@example.test": "editor", "viewer@example.test": "viewer" });
    assert.equal(res.body.share.link.role, "viewer");
    shares.notebook = res.body.share.id;
    linkToken = res.body.share.link.token;
    assert.equal((await call("owner", "POST", "/share", { resourceType: "notebook", resourceId: String(m.pageA._id), role: "boss" })).status, 400);

    const list = await call("maya", "GET", "/share/with-me");
    assert.equal(list.body.items[0].role, "editor");
    assert.equal((await call("viewer", "GET", "/share/with-me")).body.items[0].role, "viewer");
    const view = await call("maya", "GET", `/share/view/${shares.notebook}`);
    assert.equal(view.body.share.role, "editor");
    assert.equal(view.body.share.resourceId, String(m.pageA._id));
    const vview = await call("viewer", "GET", `/share/view/${shares.notebook}`);
    assert.equal(vview.body.share.role, "viewer");
    assert.equal("resourceId" in vview.body.share, false);

    const deck = await call("owner", "POST", "/share", { resourceType: "deck", resourceId: String(m.clsA._id), topic: "Cells", emails: ["maya@example.test", "viewer@example.test"], role: "editor" });
    shares.deck = deck.body.share.id;
    // Change a role with PATCH.
    const patched = await call("owner", "PATCH", `/share/${shares.deck}`, { roles: [{ email: "viewer@example.test", role: "viewer" }] });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.share.people.find((p: any) => p.email === "viewer@example.test").role, "viewer");
    assert.equal((await call("owner", "PATCH", `/share/${shares.deck}`, { roles: [{ email: "viewer@example.test", role: "admin" }] })).status, 400);
    const map = await call("owner", "POST", "/share", { resourceType: "conceptMap", resourceId: String(m.map._id), emails: [{ email: "maya@example.test", role: "editor" }, "viewer@example.test"] });
    shares.map = map.body.share.id;
  });

  test("notebook: an editor reads and saves the original; the version lands under the owner and records her", async () => {
    const page = await call("maya", "GET", `/study/pages/${m.pageA._id}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.shared.role, "editor");
    assert.equal(page.body.shared.ownerName, "Owner");
    assert.equal(page.body.classId, null);
    const content = await call("maya", "GET", `/study/pages/${m.pageA._id}/content`);
    assert.equal(content.body.version, 1);
    const saved = await call("maya", "PUT", `/study/pages/${m.pageA._id}/content/blob?baseVersion=1`, undefined, board("maya v2"));
    assert.equal(saved.status, 200);
    assert.equal(saved.body.version, 2);
    const row = await m.StudyPage.findById(m.pageA._id).lean();
    assert.equal(String(row.userId), users.owner.id);
    assert.ok(row.contentKey.startsWith(`study/${users.owner.id}/pages/${m.pageA._id}/`));
    assert.equal(JSON.parse((await m.storage.getStudyObject(row.contentKey)).toString()).pages.length, 1);
    assert.equal(row.editedBy.name, "Maya");
    assert.equal(row.versionLog.at(-1).version, 2);
    assert.equal(String(row.versionLog.at(-1).userId), users.maya.id);
    // The owner sees who changed it.
    assert.equal((await call("owner", "GET", `/study/pages/${m.pageA._id}`)).body.editedBy.name, "Maya");
    // A stale base is a conflict, not an overwrite.
    assert.equal((await call("maya", "PUT", `/study/pages/${m.pageA._id}/content/blob?baseVersion=1`, undefined, board("late"))).status, 409);
    // OCR text is content too.
    assert.equal((await call("maya", "PUT", `/study/pages/${m.pageA._id}/ocr`, { text: "membranes" })).status, 204);
  });

  test("notebook: an editor cannot rename, move, delete, nor reach the owner's other pages", async () => {
    assert.equal((await call("maya", "PATCH", `/study/pages/${m.pageA._id}`, { title: "Mine now" })).status, 404);
    assert.equal((await call("maya", "PATCH", `/study/pages/${m.pageA._id}`, { week: 9 })).status, 404);
    assert.equal((await call("maya", "DELETE", `/study/pages/${m.pageA._id}`)).status, 404);
    assert.equal((await call("maya", "GET", `/study/pages/${m.pageA._id}/versions`)).status, 404);
    const row = await m.StudyPage.findById(m.pageA._id).lean();
    assert.equal(row.title, "Cell notes");
    assert.equal(row.week, 3);
    assert.equal(row.deletedAt, null);
    for (const [method, url] of [
      ["GET", `/study/pages/${m.pageB._id}`],
      ["GET", `/study/pages/${m.pageB._id}/content`],
      ["PUT", `/study/pages/${m.pageB._id}/content/blob?baseVersion=1`],
    ] as const) {
      assert.equal((await call("maya", method, url, undefined, method === "PUT" ? board("x") : undefined)).status, 404, url);
    }
    // Her own page list never shows the owner's pages.
    assert.equal((await call("maya", "GET", "/study/pages")).body.length, 0);
    assert.equal((await m.StudyPage.findById(m.pageB._id).lean()).version, 1);
  });

  test("notebook: viewers, strangers and link holders get 404 on reads and writes", async () => {
    for (const who of ["viewer", "stranger"]) {
      assert.equal((await call(who, "GET", `/study/pages/${m.pageA._id}`)).status, 404, who);
      assert.equal((await call(who, "PUT", `/study/pages/${m.pageA._id}/content/blob?baseVersion=2`, undefined, board(who))).status, 404, who);
      assert.equal((await call(who, "PUT", `/study/pages/${m.pageA._id}/content`, { baseVersion: 2 })).status, 404, who);
      assert.equal((await call(who, "POST", `/study/pages/${m.pageA._id}/content/commit`, { version: 3 })).status, 404, who);
    }
    // The stranger opened the link: still view-only.
    assert.equal((await call("stranger", "GET", `/share/view/${linkToken}`)).body.share.role, "viewer");
    assert.equal((await call("stranger", "PUT", `/study/pages/${m.pageA._id}/content/blob?baseVersion=2`, undefined, board("s"))).status, 404);
    assert.equal((await m.StudyPage.findById(m.pageA._id).lean()).version, 2);
  });

  test("earlier versions: the owner sees authors and restores one as a new version", async () => {
    const list = await call("owner", "GET", `/study/pages/${m.pageA._id}/versions`);
    assert.equal(list.status, 200);
    assert.equal(list.body.current, 2);
    assert.deepEqual(list.body.items.map((i: any) => i.version), [2, 1]);
    assert.equal(list.body.items[0].by.name, "Maya");
    assert.equal(list.body.items[1].by, null);
    assert.equal((await call("owner", "POST", `/study/pages/${m.pageA._id}/versions/1/restore`, { baseVersion: 1 })).status, 409);
    const restored = await call("owner", "POST", `/study/pages/${m.pageA._id}/versions/1/restore`, { baseVersion: 2 });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.version, 3);
    assert.equal(restored.body.editedBy, null); // the owner made the last change
    const row = await m.StudyPage.findById(m.pageA._id).lean();
    const body = JSON.parse((await m.storage.getStudyObject(row.contentKey)).toString());
    assert.equal(JSON.parse(body.pages[0].canvasJSON).objects[0], "Cell notes v1");
    assert.equal(row.versionLog.at(-1).restoredFrom, 1);
    assert.equal((await call("maya", "POST", `/study/pages/${m.pageA._id}/versions/1/restore`, { baseVersion: 3 })).status, 404);
  });

  test("cards: an editor edits text and answers; progress, class and topic never move", async () => {
    const res = await call("maya", "PATCH", `/study/questions/${m.card1._id}`, { stem: "What is a living cell?", answer: "The unit of life", stats: { attempts: 0 }, srs: { reps: 0 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.stem, "What is a living cell?");
    assert.equal(res.body.stats.attempts, 0); // the shared shape: no progress in the answer
    const row = await m.StudyQuestion.findById(m.card1._id).lean();
    assert.equal(row.answer, "The unit of life");
    assert.equal(String(row.userId), users.owner.id);
    assert.equal(row.stats.attempts, 4);
    assert.equal(row.stats.mastery, 0.8);
    assert.equal(row.srs.reps, 5);
    assert.equal(row.srs.stability, 12);
    assert.equal(new Date(row.srs.dueAt).toISOString(), "2030-01-01T00:00:00.000Z");
    assert.equal(row.editedBy.name, "Maya");
    // Locked fields.
    assert.equal((await call("maya", "PATCH", `/study/questions/${m.card1._id}`, { classId: String(m.clsB._id) })).status, 403);
    assert.equal((await call("maya", "PATCH", `/study/questions/${m.card1._id}`, { topic: "Genes" })).status, 403);
    assert.equal((await call("maya", "PATCH", `/study/questions/${m.card1._id}`, { tags: [] })).status, 403);
    // Answering a card (progress) stays owner-only.
    assert.equal((await call("maya", "POST", `/study/questions/${m.card1._id}/attempt`, { reveal: true })).status, 404);
    const after = await m.StudyQuestion.findById(m.card1._id).lean();
    assert.equal(String(after.classId), String(m.clsA._id));
    assert.equal(after.topic, "Cells");
    assert.equal(after.stats.attempts, 4);
  });

  test("cards: an editor cannot touch anything outside the shared deck", async () => {
    for (const q of [m.question, m.genesCard, m.chemCard]) {
      assert.equal((await call("maya", "PATCH", `/study/questions/${q._id}`, { stem: "hacked" })).status, 404);
      assert.equal((await call("maya", "DELETE", `/study/questions/${q._id}`)).status, 404);
    }
    assert.equal((await m.StudyQuestion.findById(m.chemCard._id).lean()).stem, "Alkane?");
    assert.equal((await call("maya", "GET", `/study/questions?classId=${m.clsA._id}`)).body.items.length, 0);
  });

  test("cards: an editor adds to the deck (owner's row, fresh progress) and deletes from it", async () => {
    const add = await call("maya", "POST", "/study/questions", {
      questions: [{ classId: String(m.clsA._id), topic: "Cells", stem: "Ribosome?", answer: "Makes proteins", tags: ["flashcard"], source: { kind: "pdf", itemId: String(m.pageB._id) } }],
    });
    assert.equal(add.status, 200);
    const row = await m.StudyQuestion.findById(add.body[0].id).lean();
    assert.equal(String(row.userId), users.owner.id);
    assert.equal(row.stats.attempts, 0);
    assert.equal(row.source.itemId, null);
    assert.equal(row.editedBy.name, "Maya");
    // Not a card, another topic, another class: outside the share.
    const outside = [
      { classId: String(m.clsA._id), topic: "Cells", stem: "Q1", tags: [] },
      { classId: String(m.clsA._id), topic: "Genes", stem: "Q2", tags: ["flashcard"] },
      { classId: String(m.clsB._id), topic: "Organic", stem: "Q3", tags: ["flashcard"] },
    ];
    for (const q of outside) assert.equal((await call("maya", "POST", "/study/questions", { questions: [q] })).status, 404, q.stem);
    assert.equal(await m.StudyQuestion.countDocuments({ stem: { $in: ["Q1", "Q2", "Q3"] } }), 0);
    assert.equal((await call("maya", "DELETE", `/study/questions/${m.card2._id}`)).status, 204);
    assert.equal(await m.StudyQuestion.countDocuments({ _id: m.card2._id }), 0);
  });

  test("cards: viewers and strangers get 404 on every write", async () => {
    for (const who of ["viewer", "stranger"]) {
      assert.equal((await call(who, "PATCH", `/study/questions/${m.card1._id}`, { stem: "x" })).status, 404, who);
      assert.equal((await call(who, "DELETE", `/study/questions/${m.card1._id}`)).status, 404, who);
      assert.equal((await call(who, "POST", "/study/questions", { questions: [{ classId: String(m.clsA._id), topic: "Cells", stem: "x", tags: ["flashcard"] }] })).status, 404, who);
    }
    assert.equal((await m.StudyQuestion.findById(m.card1._id).lean()).stem, "What is a living cell?");
  });

  test("concept map: an editor changes the terms only; the score never moves", async () => {
    const res = await call("maya", "PATCH", `/study/concept-maps/${m.map._id}`, { promptTerms: ["lipid", "protein", "cholesterol"] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.promptTerms, ["lipid", "protein", "cholesterol"]);
    assert.equal("score" in res.body, false);
    assert.equal(res.body.editedBy.name, "Maya");
    assert.equal((await call("maya", "PATCH", `/study/concept-maps/${m.map._id}`, { score: 10 })).status, 403);
    assert.equal((await call("maya", "PATCH", `/study/concept-maps/${m.map._id}`, { promptTerms: ["a"], notesPageIds: [] })).status, 403);
    const row = await m.StudyConceptMap.findById(m.map._id).lean();
    assert.equal(row.score, 7);
    assert.equal(row.manualScore, 7);
    assert.equal(row.editedBy.name, "Maya");
    assert.equal((await call("maya", "PATCH", `/study/concept-maps/${m.mapB._id}`, { promptTerms: ["y"] })).status, 404);
    for (const who of ["viewer", "stranger"]) assert.equal((await call(who, "PATCH", `/study/concept-maps/${m.map._id}`, { promptTerms: ["z"] })).status, 404, who);
    // The share view shows who changed it.
    assert.equal((await call("viewer", "GET", `/share/view/${shares.map}`)).body.share.editedBy.name, "Maya");
  });

  test("lowering to viewer or removing someone stops their writes at once", async () => {
    await call("owner", "PATCH", `/share/${shares.notebook}`, { roles: [{ email: "maya@example.test", role: "viewer" }] });
    assert.equal((await call("maya", "PUT", `/study/pages/${m.pageA._id}/content/blob?baseVersion=3`, undefined, board("m"))).status, 404);
    assert.equal((await call("maya", "GET", `/share/view/${shares.notebook}`)).status, 200); // can still view
    await call("owner", "PATCH", `/share/${shares.notebook}`, { roles: [{ email: "maya@example.test", role: "editor" }] });
    assert.equal((await call("maya", "PUT", `/study/pages/${m.pageA._id}/content/blob?baseVersion=3`, undefined, board("m"))).status, 200);

    await call("owner", "PATCH", `/share/${shares.deck}`, { removeEmails: ["maya@example.test"] });
    assert.equal((await call("maya", "PATCH", `/study/questions/${m.card1._id}`, { stem: "after removal" })).status, 404);
    assert.equal((await call("owner", "DELETE", `/share/${shares.map}`)).status, 204);
    assert.equal((await call("maya", "PATCH", `/study/concept-maps/${m.map._id}`, { promptTerms: ["gone"] })).status, 404);
    // The owner's own writes are unaffected and clear "edited by".
    const own = await call("owner", "PATCH", `/study/questions/${m.card1._id}`, { stem: "Owner wording" });
    assert.equal(own.status, 200);
    assert.equal(own.body.editedBy, null);
    assert.equal(own.body.stats.attempts, 4);
  });
});
