/**
 * Notebooks on Library PDFs (one per document, never a copy) and page bookmarks kept on the page row
 * at each commit. Pure tests for the board reader; the HTTP part uses the pdf-assets.test.ts harness
 * (throwaway MongoDB database, local storage driver; skipped when no MongoDB answers).
 */
import { after, before, describe, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { boardBookmarks, pageLabels } from "../src/services/study/page-bookmarks";

const storageDir = mkdtempSync(path.join(tmpdir(), "syllabi-bookmarks-test-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = storageDir;
process.env.JWT_SECRET = process.env.JWT_SECRET || "bookmarks-test-secret-" + Math.random().toString(36).slice(2);
process.env.APP_URL = "https://app.test";

const dbName = `syllabi_test_bookmarks_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseUri = (process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017").replace(/\/+$/, "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mongoose: any = require("mongoose");
let mongoUp = false;

const test = (name: string, fn: () => Promise<void>) =>
  nodeTest(name, async (t) => {
    if (!mongoUp) return t.skip("MongoDB is not reachable");
    await fn();
  });

const board = (pages: object[]) => JSON.stringify({ id: "b", title: "x", pages });

describe("boardBookmarks (pure)", () => {
  nodeTest("reads bookmarked pages in order with their pager labels", () => {
    const marks = boardBookmarks(
      board([
        { id: "p1", pdfAssetId: "a", pdfPageIndex: 0 },
        { id: "s1", sheetAspect: 1.4, bookmark: { at: 5, label: "  my proof  " } },
        { id: "p2", pdfAssetId: "a", pdfPageIndex: 1, bookmark: { at: 7 } },
        { id: "p3", bookmark: { label: "no time" } },
      ])
    );
    assert.deepEqual(marks, [
      { index: 1, boardPageId: "s1", pageLabel: "1a", label: "my proof", at: 5 },
      { index: 2, boardPageId: "p2", pageLabel: "2", label: "", at: 7 },
    ]);
  });

  nodeTest("anything unreadable is no bookmarks", () => {
    assert.deepEqual(boardBookmarks("{nope"), []);
    assert.deepEqual(boardBookmarks(Buffer.from("null")), []);
    assert.deepEqual(boardBookmarks({ pages: "x" }), []);
  });

  nodeTest("free notebook pages count 1, 2, 3", () => {
    assert.deepEqual(pageLabels([{ sheetAspect: 1.4, boardRuled: true }, { sheetAspect: 1.4, boardRuled: true }, {}]), ["1", "2", "3"]);
  });
});

describe("Library notebooks and bookmarks (HTTP)", () => {
  let server: Server;
  let base = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: Record<string, any> = {};
  let token = "";
  let otherToken = "";

  async function call(method: string, url: string, body?: object | string, who = token) {
    const raw = typeof body === "string";
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${who}` },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const { Admin } = await import("../src/models/admin");
    Object.assign(m, await import("../src/models/study"));
    const owner = await Admin.create({ name: "Owner", email: "owner@example.test", role: "user", isVerified: true });
    const other = await Admin.create({ name: "Other", email: "other@example.test", role: "user", isVerified: true });
    token = signSessionToken(String(owner._id));
    otherToken = signSessionToken(String(other._id));
    m.doc = await m.StudyLibraryDoc.create({ userId: owner._id, canvasUserId: 1, canvasCourseId: 2, relPath: "week-01/slides.pdf", title: "slides.pdf", kind: "pdf" });
    m.doc2 = await m.StudyLibraryDoc.create({ userId: owner._id, canvasUserId: 1, canvasCourseId: 2, relPath: "week-02/more.pdf", title: "more.pdf", kind: "pdf" });
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.closeAllConnections();
    server?.close();
    (await import("../src/middleware/rate-limit")).closeRateLimitRedis();
    (await import("../src/services/study/page-live")).closePageLive();
    if (mongoUp) {
      await mongoose.connection.dropDatabase().catch(() => {});
      await mongoose.disconnect();
    }
    rmSync(storageDir, { recursive: true, force: true });
  });

  test("one notebook per Library document: asking again returns the same one", async () => {
    const first = await call("POST", "/study/pages", { classId: null, title: "slides", kind: "pdf", libraryId: String(m.doc._id) });
    assert.equal(first.status, 201);
    assert.equal(first.body.libraryId, String(m.doc._id));
    assert.deepEqual(first.body.bookmarks, []);
    const again = await call("POST", "/study/pages", { classId: null, title: "slides (2)", kind: "pdf", libraryId: String(m.doc._id) });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id);
    const listed = await call("GET", `/study/pages?libraryId=${m.doc._id}`);
    assert.deepEqual(listed.body.map((p: { id: string }) => p.id), [first.body.id]);
    // Someone else's document is not found.
    assert.equal((await call("POST", "/study/pages", { title: "x", kind: "pdf", libraryId: String(m.doc._id) }, otherToken)).status, 404);
    m.pageId = first.body.id;
  });

  test("an older notebook can be linked once; a second link to the same document is refused", async () => {
    const old = await call("POST", "/study/pages", { classId: null, title: "older", kind: "pdf" });
    assert.equal((await call("PATCH", `/study/pages/${old.body.id}`, { libraryId: String(m.doc._id) })).status, 409);
    const linked = await call("PATCH", `/study/pages/${old.body.id}`, { libraryId: String(m.doc2._id) });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.libraryId, String(m.doc2._id));
  });

  test("bookmarks in a saved board land on the page row and follow every save", async () => {
    const save = async (baseVersion: number, pages: object[]) => {
      const res = await fetch(`${base}/study/pages/${m.pageId}/content/blob?baseVersion=${baseVersion}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: board(pages),
      });
      assert.equal(res.status, 200);
    };
    await save(0, [{ id: "a" }, { id: "b", bookmark: { at: 1700000000000, label: "Key idea" } }]);
    let page = (await call("GET", `/study/pages/${m.pageId}`)).body;
    assert.deepEqual(page.bookmarks, [{ boardPageId: "b", index: 1, pageLabel: "2", label: "Key idea", at: new Date(1700000000000).toISOString() }]);
    await save(1, [{ id: "a" }, { id: "b" }]);
    page = (await call("GET", `/study/pages/${m.pageId}`)).body;
    assert.deepEqual(page.bookmarks, []);
  });

  test("notebooks saved before the field existed get their bookmarks filled once", async () => {
    const storage = await import("../src/services/study/storage");
    const { backfillPageBookmarks } = await import("../src/services/study/page-bookmarks");
    const owner = (await m.StudyPage.findById(m.pageId).lean()).userId;
    const id = new mongoose.Types.ObjectId();
    const key = storage.pageContentKey(String(owner), String(id), 1);
    await storage.putStudyObject(key, Buffer.from(board([{ id: "q", bookmark: { at: 9 } }])), "application/json");
    await m.StudyPage.collection.insertOne({ _id: id, userId: owner, title: "old", kind: "note", version: 1, contentKey: key, deletedAt: null, updatedAt: new Date(0) });
    assert.ok((await backfillPageBookmarks(100)) >= 1);
    const row = await m.StudyPage.findById(id).lean();
    assert.deepEqual(row.bookmarks, [{ index: 0, boardPageId: "q", pageLabel: "1", label: "", at: 9 }]);
    assert.equal(new Date(row.updatedAt).getTime(), 0);
    assert.equal(await backfillPageBookmarks(100), 0);
  });
});
