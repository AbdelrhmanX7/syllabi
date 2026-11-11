/**
 * Share links ("Anyone with the link can get a copy"): the signed-out preview (routes/share-public.ts),
 * a copy through the link, turning the link off, and what a copy never carries. Same setup as
 * share.test.ts: a throwaway MongoDB database (skipped when none answers) + the local storage driver.
 */
import { after, before, describe, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const storageDir = mkdtempSync(path.join(tmpdir(), "syllabi-share-link-test-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = storageDir;
process.env.JWT_SECRET = process.env.JWT_SECRET || "share-link-test-secret-" + Math.random().toString(36).slice(2);
process.env.APP_URL = "https://app.test";

const dbName = `syllabi_test_share_link_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseUri = (process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017").replace(/\/+$/, "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mongoose: any = require("mongoose");
let mongoUp = false;

const test = (name: string, fn: () => Promise<void>) =>
  nodeTest(name, async (t) => {
    if (!mongoUp) return t.skip("MongoDB is not reachable");
    await fn();
  });

describe("share links", () => {
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
    return { status: res.status, body: json, headers: res.headers };
  }

  const linkOn = async (resourceType: string, resourceId: string, topic?: string) => {
    const res = await call("owner", "POST", "/share", { resourceType, resourceId, topic, link: true });
    assert.equal(res.status, 201);
    return res.body.share as { id: string; link: { token: string; url: string } };
  };

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
    for (const [key, name, email] of [
      ["owner", "Maya Chen Lopez", "maya.chen.lopez@school.test"],
      ["stranger", "Sam Ortiz", "sam@example.test"],
      ["noname", "", "jordan.private@school.test"],
    ] as const) {
      const admin = await m.Admin.create({ name, email, role: "user", isVerified: true });
      users[key] = { id: String(admin._id), token: signSessionToken(String(admin._id)), email };
    }
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const owner = new mongoose.Types.ObjectId(users.owner.id);
    m.cls = await m.StudyClass.create({ userId: owner, source: "manual", canvasCourseId: -223344, name: "Chemistry 201", code: "" });
    const pageId = new mongoose.Types.ObjectId();
    const key = m.storage.pageContentKey(users.owner.id, String(pageId), 2);
    const board = {
      id: String(pageId),
      pages: [
        { id: "a", canvasJSON: '{"objects":[1]}', bookmark: { at: 1700000000000, label: "exam!" } },
        { id: "b", canvasJSON: '{"objects":[2]}' },
      ],
    };
    await m.storage.putStudyObject(key, Buffer.from(JSON.stringify(board)), "application/json");
    m.page = await m.StudyPage.create({
      _id: pageId,
      userId: owner,
      title: "Acids and bases",
      kind: "note",
      version: 2,
      contentKey: key,
      bookmarks: [{ index: 0, boardPageId: "a", pageLabel: "1", label: "exam!", at: 1700000000000 }],
    });
    const note = { w: 100, h: 50, strokes: [{ c: "#123456", w: 2, pts: [0, 0, 10, 10] }] };
    await m.StudyQuestion.insertMany([
      { userId: owner, classId: m.cls._id, topic: "pH", stem: "What is pH 7?", answer: "Neutral", tags: ["flashcard"], stemHash: "a", bookmarked: true, note, stats: { attempts: 9, correct: 2, mastery: 0.2 } },
      { userId: owner, classId: m.cls._id, topic: "pH", stem: "Strong acid?", answer: "HCl", tags: ["flashcard"], stemHash: "b" },
    ]);
    m.map = await m.StudyConceptMap.create({ userId: owner, canvasCourseId: -223344, source: "practice", lecture: "Buffers", promptTerms: ["buffer", "pKa"], manualScore: 6, score: 6 });
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

  test("create: the owner gets an unguessable link to the web app; a non-owner can't make one", async () => {
    assert.equal((await call("stranger", "POST", "/share", { resourceType: "notebook", resourceId: String(m.page._id), link: true })).status, 404);
    const share = await linkOn("notebook", String(m.page._id));
    // 32 random bytes, base64url: 43 characters, 256 bits.
    assert.match(share.link.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(share.link.url, `https://app.test/shared/?id=${share.link.token}`);
    // A non-owner can't turn on (or off) the owner's link through PATCH either.
    assert.equal((await call("stranger", "PATCH", `/share/${share.id}`, { link: true })).status, 404);
    assert.equal((await call("stranger", "PATCH", `/share/${share.id}`, { link: false })).status, 404);
    m.notebookShare = share;
  });

  test("preview: no account needed, only title + kind + the owner's first name", async () => {
    const { token } = m.notebookShare.link;
    for (const prefix of ["/share/preview", "/study/share/preview"]) {
      const res = await call(null, "GET", `${prefix}/${token}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { preview: { title: "Acids and bases", resourceType: "notebook", ownerName: "Maya" } });
      assert.equal(res.headers.get("cache-control"), "no-store");
      const raw = JSON.stringify(res.body);
      for (const secret of ["maya.chen", "school.test", "Lopez", users.owner.id, String(m.page._id), "Chemistry"]) assert.equal(raw.includes(secret), false, secret);
    }
    // A deck's title is the class + topic it came from; nothing else.
    const deck = await linkOn("deck", String(m.cls._id), "pH");
    const d = await call(null, "GET", `/share/preview/${deck.link.token}`);
    assert.deepEqual(Object.keys(d.body.preview).sort(), ["ownerName", "resourceType", "title"]);
    assert.equal(d.body.preview.resourceType, "deck");
    m.deckShare = deck;
  });

  test("preview: a wrong, made-up or share-id token is the same 404; the rest of /share still needs an account", async () => {
    for (const bad of ["A".repeat(43), "short", m.notebookShare.id, "x".repeat(200)]) {
      const res = await call(null, "GET", `/share/preview/${bad}`);
      assert.equal(res.status, 404, bad);
      assert.equal(res.body.code, "NOT_FOUND");
    }
    assert.equal((await call(null, "GET", `/share/view/${m.notebookShare.link.token}`)).status, 401);
    assert.equal((await call(null, "POST", `/share/fork/${m.notebookShare.link.token}`)).status, 401);
  });

  test("an owner with no name shows as Someone, never their email", async () => {
    const own = new mongoose.Types.ObjectId(users.noname.id);
    const page = await m.StudyPage.create({ userId: own, title: "Mine", kind: "note", version: 0, contentKey: null });
    const res = await call("noname", "POST", "/share", { resourceType: "notebook", resourceId: String(page._id), link: true });
    const preview = await call(null, "GET", `/share/preview/${res.body.share.link.token}`);
    assert.equal(preview.body.preview.ownerName, "Someone");
  });

  test("signed in through the link: view shows the first name; Add to my Syllabi makes an independent copy", async () => {
    const { token } = m.notebookShare.link;
    const view = await call("stranger", "GET", `/share/view/${token}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.share.ownerName, "Maya");
    assert.equal(view.body.share.role, "viewer");
    assert.equal("resourceId" in view.body.share, false);

    const fork = await call("stranger", "POST", `/share/fork/${token}`);
    assert.equal(fork.status, 201);
    const copy = await m.StudyPage.findById(fork.body.resourceId).lean();
    assert.equal(String(copy.userId), users.stranger.id);
    assert.equal(copy.title, "Acids and bases");
    // The copy is theirs to edit: a normal page in their account, through the normal study routes.
    const own = await call("stranger", "PATCH", `/study/pages/${copy._id}`, { title: "My acids" });
    assert.ok(own.status < 300, `rename status ${own.status}`);
    assert.equal((await m.StudyPage.findById(m.page._id).lean()).title, "Acids and bases");
    const forks = await call("stranger", "GET", "/share/forks");
    assert.equal(forks.body.items[0].forkedFrom.ownerName, "Maya");
    m.notebookCopy = copy;
  });

  test("a copy never carries the owner's private marks", async () => {
    // Notebook: no page bookmark in the copied board, none on the row; the ink is all there.
    const body = JSON.parse((await m.storage.getStudyObject(m.notebookCopy.contentKey)).toString());
    assert.equal(body.pages.length, 2);
    assert.ok(body.pages.every((p: any) => !("bookmark" in p)));
    assert.equal(body.pages[0].canvasJSON, '{"objects":[1]}');
    assert.deepEqual(m.notebookCopy.bookmarks ?? [], []);
    // The owner's own board still has it.
    const orig = JSON.parse((await m.storage.getStudyObject(m.page.contentKey)).toString());
    assert.equal(orig.pages[0].bookmark.label, "exam!");

    // Cards: no bookmark, no handwritten note, no progress.
    const deckFork = await call("stranger", "POST", `/share/fork/${m.deckShare.link.token}`);
    assert.equal(deckFork.status, 201);
    const cards = await m.StudyQuestion.find({ userId: new mongoose.Types.ObjectId(users.stranger.id) }).lean();
    assert.equal(cards.length, 2);
    for (const c of cards) {
      assert.notEqual(c.bookmarked, true);
      assert.equal(c.note ?? null, null);
      assert.equal(c.stats?.attempts ?? 0, 0);
    }
    // The shared view of the deck hides them too.
    const view = await call("stranger", "GET", `/share/view/${m.deckShare.link.token}`);
    assert.ok(view.body.content.questions.every((q: any) => q.bookmarked === false && q.note === null && q.stats.attempts === 0));

    // Concept map: terms, never the score.
    const mapShare = await linkOn("conceptMap", String(m.map._id));
    const mapFork = await call("stranger", "POST", `/share/fork/${mapShare.link.token}`);
    const map = await m.StudyConceptMap.findById(mapFork.body.resourceId).lean();
    assert.deepEqual(map.promptTerms, ["buffer", "pKa"]);
    assert.equal(map.score ?? null, null);
    assert.equal(map.manualScore ?? null, null);
  });

  test("turning the link off stops the preview, the view and new copies; copies already made stay", async () => {
    const { token } = m.notebookShare.link;
    const off = await call("owner", "PATCH", `/share/${m.notebookShare.id}`, { link: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.share.link, null);
    assert.equal((await call(null, "GET", `/share/preview/${token}`)).status, 404);
    assert.equal((await call("stranger", "GET", `/share/view/${token}`)).status, 404);
    assert.equal((await call("stranger", "POST", `/share/fork/${token}`)).status, 404);
    assert.ok(await m.StudyPage.findById(m.notebookCopy._id).lean());
    // On again = a brand-new link; the old one stays dead.
    const on = await call("owner", "PATCH", `/share/${m.notebookShare.id}`, { link: true });
    assert.notEqual(on.body.share.link.token, token);
    assert.equal((await call(null, "GET", `/share/preview/${on.body.share.link.token}`)).status, 200);
    assert.equal((await call(null, "GET", `/share/preview/${token}`)).status, 404);
  });

  test("a deleted resource: the link answers 404", async () => {
    const s = await call("owner", "GET", `/share/mine?resourceType=notebook&resourceId=${m.page._id}`);
    await m.StudyPage.updateOne({ _id: m.page._id }, { $set: { deletedAt: new Date() } });
    assert.equal((await call(null, "GET", `/share/preview/${s.body.share.link.token}`)).status, 404);
  });

  test("the preview is rate limited per visitor", async () => {
    const { PREVIEW_LIMIT } = await import("../src/routes/share-public");
    let limited = false;
    // Earlier tests already spent some of this IP's budget; keep going until it trips.
    for (let i = 0; i < PREVIEW_LIMIT.max + 5 && !limited; i++) limited = (await call(null, "GET", `/share/preview/${"B".repeat(43)}`)).status === 429;
    assert.equal(limited, true);
  });
});
