/**
 * Sharing (routes/share.ts) end to end against a throwaway MongoDB database on this machine
 * (MONGODB_TEST_URI, default mongodb://127.0.0.1:27017). Skipped when no MongoDB answers.
 * Files go to a temp dir through the local storage driver.
 */
import { after, before, describe, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const storageDir = mkdtempSync(path.join(tmpdir(), "syllabi-share-test-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = storageDir;
process.env.JWT_SECRET = process.env.JWT_SECRET || "share-test-secret-" + Math.random().toString(36).slice(2);
process.env.APP_URL = "https://app.test";

const dbName = `syllabi_test_share_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

describe("sharing", () => {
  let server: Server;
  let base = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: Record<string, any> = {};
  const users: Record<string, { id: string; token: string; email: string }> = {};

  async function call(who: string | null, method: string, url: string, body?: unknown) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer ${users[who].token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
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
    for (const [key, verified] of [["owner", true], ["friend", true], ["stranger", true], ["squatter", false]] as const) {
      const email = `${key}@example.test`;
      // The squatter registered (unverified) with the friend's second address.
      const admin = await m.Admin.create({ name: key[0].toUpperCase() + key.slice(1), email: key === "squatter" ? "later@example.test" : email, role: "user", isVerified: verified });
      users[key] = { id: String(admin._id), token: signSessionToken(String(admin._id)), email: admin.email };
    }
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The owner's material: a class, a notebook page with board JSON in storage, cards + questions, a concept map.
    const owner = new mongoose.Types.ObjectId(users.owner.id);
    m.cls = await m.StudyClass.create({ userId: owner, source: "manual", canvasCourseId: -123456, name: "Biology 101", code: "" });
    const pageId = new mongoose.Types.ObjectId();
    const key = m.storage.pageContentKey(users.owner.id, String(pageId), 3);
    await m.storage.putStudyObject(key, Buffer.from(JSON.stringify({ id: String(pageId), pages: [{ canvasJSON: '{"objects":[1]}' }] })), "application/json");
    m.page = await m.StudyPage.create({ _id: pageId, userId: owner, title: "Cell notes", kind: "note", version: 3, contentKey: key });
    const q = (stem: string, tags: string[], topic = "Cells") => ({ userId: owner, classId: m.cls._id, topic, stem, answer: "A", tags, stemHash: stem, stats: { attempts: 4, correct: 3, mastery: 0.8 } });
    await m.StudyQuestion.insertMany([q("What is a cell?", ["flashcard"]), q("Mitochondria?", ["Flashcard"]), q("Explain osmosis", []), q("DNA?", [], "Genes")]);
    m.map = await m.StudyConceptMap.create({ userId: owner, canvasCourseId: -123456, source: "practice", lecture: "Lecture 4: membranes", promptTerms: ["lipid", "protein"], manualScore: 7, score: 7 });
  });

  after(async () => {
    // fetch keeps connections alive; close them so the process can exit.
    server?.closeAllConnections();
    server?.close();
    (await import("../src/middleware/rate-limit")).closeRateLimitRedis();
    if (!mongoUp) return rmSync(storageDir, { recursive: true, force: true });
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
    rmSync(storageDir, { recursive: true, force: true });
  });

  let notebookShare = "";
  let linkToken = "";

  test("401 without a session, on both mounts", async () => {
    assert.equal((await call(null, "GET", "/share/with-me")).status, 401);
    assert.equal((await call(null, "GET", "/study/share/with-me")).status, 401);
  });

  test("create: owner only; a stranger cannot share someone else's page", async () => {
    const denied = await call("stranger", "POST", "/share", { resourceType: "notebook", resourceId: String(m.page._id), emails: ["x@example.test"] });
    assert.equal(denied.status, 404);
    const bad = await call("owner", "POST", "/share", { resourceType: "notebook", resourceId: "nope" });
    assert.equal(bad.status, 400);
    const res = await call("owner", "POST", "/share", { resourceType: "notebook", resourceId: String(m.page._id), emails: ["friend@example.test", "Later@Example.test", "owner@example.test"] });
    assert.equal(res.status, 201);
    assert.equal(res.body.share.title, "Cell notes");
    assert.deepEqual(res.body.share.people.map((p: any) => p.email).sort(), ["friend@example.test", "later@example.test"]);
    assert.equal(res.body.share.people.find((p: any) => p.email === "friend@example.test").joined, true);
    assert.equal(res.body.share.link, null);
    notebookShare = res.body.share.id;
    // A second POST for the same resource adds to the same share.
    const again = await call("owner", "POST", "/share", { resourceType: "notebook", resourceId: String(m.page._id), link: true });
    assert.equal(again.body.share.id, notebookShare);
    assert.match(again.body.share.link.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(again.body.share.link.url, `https://app.test/shared/?id=${again.body.share.link.token}`);
    linkToken = again.body.share.link.token;
    const mine = await call("owner", "GET", `/share/mine?resourceType=notebook&resourceId=${m.page._id}`);
    assert.equal(mine.body.share.id, notebookShare);
  });

  test("view by grant: shared-with-me lists it, the snapshot has the board url", async () => {
    const list = await call("friend", "GET", "/share/with-me");
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].title, "Cell notes");
    assert.equal(list.body.items[0].ownerName, "Owner");
    const view = await call("friend", "GET", `/share/view/${notebookShare}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.share.isOwner, false);
    assert.equal(view.body.content.kind, "note");
    assert.ok(view.body.content.contentUrl);
  });

  test("an unverified account with a granted address sees nothing", async () => {
    assert.equal((await call("squatter", "GET", "/share/with-me")).body.items.length, 0);
    assert.equal((await call("squatter", "GET", `/share/view/${notebookShare}`)).status, 404);
  });

  test("view by link: any signed-in account with the token", async () => {
    const view = await call("stranger", "GET", `/share/view/${linkToken}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.share.title, "Cell notes");
    // The link does not put it in their list, and the share id alone is not enough.
    assert.equal((await call("stranger", "GET", "/share/with-me")).body.items.length, 0);
  });

  test("strangers are denied: by share id, by a made-up token, and every owner action", async () => {
    assert.equal((await call("stranger", "GET", `/share/view/${notebookShare}`)).status, 404);
    assert.equal((await call("stranger", "GET", `/share/view/${"A".repeat(43)}`)).status, 404);
    assert.equal((await call("stranger", "POST", `/share/fork/${notebookShare}`)).status, 404);
    assert.equal((await call("stranger", "PATCH", `/share/${notebookShare}`, { link: false })).status, 404);
    assert.equal((await call("stranger", "DELETE", `/share/${notebookShare}`)).status, 404);
    assert.equal((await call("friend", "PATCH", `/share/${notebookShare}`, { addEmails: ["me2@example.test"] })).status, 404);
  });

  test("fork a notebook: a deep copy that outlives the original", async () => {
    const res = await call("friend", "POST", `/share/fork/${notebookShare}`);
    assert.equal(res.status, 201);
    const copy = await m.StudyPage.findById(res.body.resourceId).lean();
    assert.equal(String(copy.userId), users.friend.id);
    assert.notEqual(String(copy._id), String(m.page._id));
    assert.equal(copy.version, 1);
    assert.ok(copy.contentKey.startsWith(`study/${users.friend.id}/pages/${copy._id}/`));
    // Change and delete the original: the copy and its content are untouched.
    await m.StudyPage.updateOne({ _id: m.page._id }, { $set: { title: "Changed" } });
    await m.storage.putStudyObject(m.page.contentKey, Buffer.from('{"changed":true}'), "application/json");
    const body = JSON.parse((await m.storage.getStudyObject(copy.contentKey)).toString());
    assert.equal(body.pages.length, 1);
    assert.equal((await m.StudyPage.findById(copy._id).lean()).title, "Cell notes");
    const forks = await call("friend", "GET", "/share/forks");
    assert.equal(forks.body.items[0].resourceId, String(copy._id));
    assert.equal(forks.body.items[0].forkedFrom.ownerName, "Owner");
    assert.equal(forks.body.items[0].forkedFrom.title, "Cell notes");
  });

  test("decks and question sets: cards vs questions, no progress, fork copies into a class of the same name", async () => {
    const deck = await call("owner", "POST", "/share", { resourceType: "deck", resourceId: String(m.cls._id), topic: "Cells", emails: ["friend@example.test"] });
    assert.equal(deck.status, 201);
    const view = await call("friend", "GET", `/share/view/${deck.body.share.id}`);
    assert.deepEqual(view.body.content.questions.map((q: any) => q.stem).sort(), ["Mitochondria?", "What is a cell?"]);
    assert.ok(view.body.content.questions.every((q: any) => q.stats.attempts === 0));
    const qs = await call("owner", "POST", "/share", { resourceType: "questions", resourceId: String(m.cls._id), emails: ["friend@example.test"] });
    const qview = await call("friend", "GET", `/share/view/${qs.body.share.id}`);
    assert.deepEqual(qview.body.content.questions.map((q: any) => q.stem).sort(), ["DNA?", "Explain osmosis"]);

    const fork = await call("friend", "POST", `/share/fork/${deck.body.share.id}`);
    assert.equal(fork.status, 201);
    assert.equal(fork.body.topic, "Cells");
    const cls = await m.StudyClass.findById(fork.body.classId).lean();
    assert.equal(String(cls.userId), users.friend.id);
    assert.equal(cls.name, "Biology 101");
    const copies = await m.StudyQuestion.find({ userId: new mongoose.Types.ObjectId(users.friend.id) }).lean();
    assert.equal(copies.length, 2);
    assert.ok(copies.every((q: any) => q.stats.attempts === 0 && String(q.classId) === fork.body.classId));
    // A second fork reuses the class with the same name.
    const fork2 = await call("friend", "POST", `/share/fork/${qs.body.share.id}`);
    assert.equal(fork2.body.classId, fork.body.classId);
    // Independence: deleting the owner's cards leaves the copies.
    await m.StudyQuestion.deleteMany({ userId: m.cls.userId });
    assert.equal(await m.StudyQuestion.countDocuments({ userId: new mongoose.Types.ObjectId(users.friend.id) }), 4);
  });

  test("concept maps: terms only, never the score; fork is a practice map", async () => {
    const s = await call("owner", "POST", "/share", { resourceType: "conceptMap", resourceId: String(m.map._id), emails: ["friend@example.test"] });
    const view = await call("friend", "GET", `/share/view/${s.body.share.id}`);
    assert.deepEqual(view.body.content.promptTerms, ["lipid", "protein"]);
    assert.equal(JSON.stringify(view.body).includes("Score"), false);
    assert.equal("score" in view.body.content, false);
    const fork = await call("friend", "POST", `/share/fork/${s.body.share.id}`);
    const copy = await m.StudyConceptMap.findById(fork.body.resourceId).lean();
    assert.equal(copy.source, "practice");
    assert.equal(copy.score, null);
    assert.equal(String(copy.userId), users.friend.id);
  });

  test("revoke: removing a person, turning the link off, stopping sharing", async () => {
    const removed = await call("owner", "PATCH", `/share/${notebookShare}`, { removeEmails: ["friend@example.test"] });
    assert.equal(removed.status, 200);
    assert.equal((await call("friend", "GET", `/share/view/${notebookShare}`)).status, 404);
    // The link still works until it is turned off; a new link gets a new token.
    assert.equal((await call("friend", "GET", `/share/view/${linkToken}`)).status, 200);
    await call("owner", "PATCH", `/share/${notebookShare}`, { link: false });
    assert.equal((await call("friend", "GET", `/share/view/${linkToken}`)).status, 404);
    const relinked = await call("owner", "PATCH", `/share/${notebookShare}`, { link: true });
    assert.notEqual(relinked.body.share.link.token, linkToken);
    assert.equal((await call("owner", "DELETE", `/share/${notebookShare}`)).status, 204);
    assert.equal((await call("stranger", "GET", `/share/view/${relinked.body.share.link.token}`)).status, 404);
    assert.equal((await call("owner", "GET", `/share/mine?resourceType=notebook&resourceId=${m.page._id}`)).body.share, null);
  });

  test("a deleted resource disappears from shared-with-me", async () => {
    const s = await call("owner", "POST", "/share", { resourceType: "conceptMap", resourceId: String(m.map._id) });
    assert.ok(s.body.share.id);
    await m.StudyConceptMap.deleteOne({ _id: m.map._id });
    const list = await call("friend", "GET", "/share/with-me");
    assert.equal(list.body.items.some((i: any) => i.resourceType === "conceptMap"), false);
  });
});
