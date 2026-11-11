/**
 * Uploading a PDF to a class Library (POST /study/classes/:id/library, services/study/library-upload.ts):
 * it lists at once, opens with a file url, keeps its text per page for search / flashcards, the same file
 * twice is one row, and nobody can upload into someone else's class. Same harness as share.test.ts
 * (throwaway MongoDB database, local storage driver; skipped when no MongoDB answers).
 */
import { after, before, describe, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const storageDir = mkdtempSync(path.join(tmpdir(), "syllabi-library-upload-test-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = storageDir;
process.env.JWT_SECRET = process.env.JWT_SECRET || "library-upload-test-" + Math.random().toString(36).slice(2);
process.env.APP_URL = "https://app.test";

const dbName = `syllabi_test_library_upload_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseUri = (process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017").replace(/\/+$/, "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mongoose: any = require("mongoose");
let mongoUp = false;

const test = (name: string, fn: () => Promise<void>) =>
  nodeTest(name, async (t) => {
    if (!mongoUp) return t.skip("MongoDB is not reachable");
    await fn();
  });

async function makePdf(pages: string[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const words of pages) doc.addPage([300, 200]).drawText(words, { x: 20, y: 100, size: 14, font });
  return Buffer.from(await doc.save());
}

describe("library PDF upload", () => {
  let server: Server;
  let base = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: Record<string, any> = {};
  const users: Record<string, { id: string; token: string }> = {};

  async function call(who: string, method: string, url: string, body?: Buffer) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { Authorization: `Bearer ${users[who].token}`, ...(body ? { "Content-Type": "application/pdf" } : {}) },
      body: body ? new Uint8Array(body) : undefined,
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
    m.upload = await import("../src/services/study/library-upload");
    for (const key of ["owner", "stranger"]) {
      const admin = await m.Admin.create({ name: key, email: `${key}@example.test`, role: "user", isVerified: true });
      users[key] = { id: String(admin._id), token: signSessionToken(String(admin._id)) };
    }
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    m.cls = await m.StudyClass.create({ userId: new mongoose.Types.ObjectId(users.owner.id), source: "manual", canvasCourseId: -987654, name: "Physics", code: "" });
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

  test("upload → in the list at once, opens with a file url, text kept per page; same file again is the same row", async () => {
    const pdf = await makePdf(["Kinematics and velocity", "Newton laws of motion", "Energy and work"]);
    const url = `/study/classes/${m.cls._id}/library?name=${encodeURIComponent("Week 3 slides.pdf")}`;
    const up = await call("owner", "POST", url, pdf);
    assert.equal(up.status, 201);
    assert.equal(up.body.title, "Week 3 slides");
    assert.equal(up.body.kind, "pdf");
    assert.equal(up.body.path, "Uploaded/Week 3 slides.pdf");

    const list = await call("owner", "GET", `/study/classes/${m.cls._id}/library`);
    assert.deepEqual(list.body.map((d: any) => d.id), [up.body.id]);

    const detail = await call("owner", "GET", `/study/library/${up.body.id}`);
    assert.equal(detail.body.fileStored, true);
    assert.equal(detail.body.mime, "application/pdf");
    assert.equal(detail.body.pages, 3);
    assert.ok(detail.body.url);

    const chunks = await m.StudyLibraryChunk.find({ docId: new mongoose.Types.ObjectId(up.body.id) }).sort({ page: 1 }).lean();
    assert.deepEqual(chunks.map((c: any) => c.page), [1, 2, 3]);
    assert.match(chunks[1].text, /Newton laws of motion/);
    // Flashcards / questions read the doc through its text source.
    const { libraryTextSource } = await import("../src/services/study/library");
    const ts = await libraryTextSource(new mongoose.Types.ObjectId(users.owner.id), up.body.id);
    assert.equal(ts.kind, "text");
    assert.equal(String((ts as any).classId), String(m.cls._id));

    const again = await call("owner", "POST", url, pdf);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, up.body.id);
    // A different file with the same name gets its own path.
    const other = await call("owner", "POST", url, await makePdf(["Other slides entirely"]));
    assert.equal(other.status, 201);
    assert.equal(other.body.path, "Uploaded/Week 3 slides (2).pdf");
    assert.equal(await m.StudyLibraryDoc.countDocuments({ userId: new mongoose.Types.ObjectId(users.owner.id) }), 2);
  });

  test("not a PDF → 415, empty → 400, someone else's class → 404", async () => {
    assert.equal((await call("owner", "POST", `/study/classes/${m.cls._id}/library?name=x.pdf`, Buffer.from("hello there"))).status, 415);
    assert.equal((await call("owner", "POST", `/study/classes/${m.cls._id}/library?name=x.pdf`, Buffer.alloc(0))).status, 400);
    assert.equal((await call("stranger", "POST", `/study/classes/${m.cls._id}/library?name=x.pdf`, await makePdf(["Mine now"]))).status, 404);
  });

  test("names", () => {
    assert.equal(m.upload.uploadTitle("C:\\fakepath\\Lecture 1.PDF"), "Lecture 1");
    assert.equal(m.upload.uploadTitle(""), "Uploaded PDF");
    assert.equal(m.upload.uploadPath("a/b", new Set()), "Uploaded/a-b.pdf");
  });
});
