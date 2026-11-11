/**
 * Notebook page text for flashcards / questions (services/study/page-text.ts): the app's text is used
 * as it is; a page without it is read by AI once (stubbed here), saved, and reused until the page
 * changes; an empty page gets a plain error. The first block runs on stubs only; the second runs
 * the real save against a throwaway MongoDB database (skipped when none answers).
 */
import { after, before, describe, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const storageDir = mkdtempSync(path.join(tmpdir(), "syllabi-page-text-test-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = storageDir;
process.env.JWT_SECRET = process.env.JWT_SECRET || "page-text-test-" + Math.random().toString(36).slice(2);

import type { PageTextDeps } from "../src/services/study/page-text";

// Loaded after the env above is set (storage reads it on import).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pt: any;
before(async () => {
  pt = await import("../src/services/study/page-text");
});
const planPageText = (...a: unknown[]) => pt.planPageText(...a);
const storedPageText = (p: unknown) => pt.storedPageText(p);
const boardInfo = (raw: string) => pt.boardInfo(raw);
const cleanReading = (raw: string) => pt.cleanReading(raw);
const PAGE_EMPTY_MESSAGE = "This page is empty — write something first.";
const PAGE_UNREADABLE_MESSAGE = "Couldn't read the writing on this page — try again.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const spend = {} as Any;
const INK = JSON.stringify({ pages: [{ canvasJSON: '{"objects":[{"type":"path"}]}' }] });
const BLANK = JSON.stringify({ pages: [{ canvasJSON: '{"objects":[]}' }, { canvasJSON: null }] });

/** Stub deps over an in-memory page: counts AI calls, `saveReading` writes back like the real one. */
function fake(page: Any, objects: Record<string, string | Buffer>, reading = "Newton's 2nd law: $F = ma$") {
  const calls = { transcribe: 0, images: 0, saved: 0, pdf: [] as number[] };
  const deps: PageTextDeps = {
    loadObject: async (key) => {
      const v = objects[key];
      if (v === undefined) throw new Error("missing");
      return Buffer.isBuffer(v) ? v : Buffer.from(v);
    },
    pdfPagesText: async (_pdf, first, last) => {
      calls.pdf.push(first, last);
      return Array.from({ length: last - first + 1 }, (_, i) => `PDF page ${first + i} text`);
    },
    pageImages: async (_p, board) => (calls.images++, board.inkPages.map(() => Buffer.from("jpg"))),
    transcribe: async () => (calls.transcribe++, reading),
    cachedRead: async () => null,
    saveReading: async (p, text) => {
      calls.saved++;
      Object.assign(page, { ocrText: text, ocrUpdatedAt: new Date(), ocrAiVersion: p.version });
    },
  };
  return { deps, calls };
}

const pageOf = (extra: Any = {}) => ({ _id: "p1", userId: "64b000000000000000000001", version: 2, contentKey: "board", ocrText: null, ocrUpdatedAt: null, ocrAiVersion: null, renders: [], rendersCommitVersion: null, ...extra });

async function textOf(page: Any, deps: PageTextDeps) {
  const plan = await planPageText(page, deps);
  return plan.kind === "read" ? plan.read(spend) : plan;
}

describe("page text (stubs)", () => {
  nodeTest("has text from the app → uses it, no AI", async () => {
    const page = pageOf({ ocrText: "  my notes  " });
    const { deps, calls } = fake(page, { board: INK });
    assert.deepEqual(await planPageText(page, deps), { kind: "text", text: "my notes" });
    assert.equal(calls.transcribe, 0);
  });

  nodeTest("no text, with ink → AI reads it, saves it, and a second call does not call AI again", async () => {
    const page = pageOf();
    const { deps, calls } = fake(page, { board: INK });
    const plan = await planPageText(page, deps);
    assert.equal(plan.kind, "read");
    assert.equal(calls.transcribe, 0, "nothing paid before the stream opens");
    assert.deepEqual(await textOf(page, deps), { kind: "text", text: "Newton's 2nd law: $F = ma$" });
    assert.equal(calls.transcribe, 1);
    assert.equal(calls.saved, 1);
    assert.equal(page.ocrAiVersion, 2);
    assert.deepEqual(await planPageText(page, deps), { kind: "text", text: "Newton's 2nd law: $F = ma$" });
    assert.equal(calls.transcribe, 1);
  });

  nodeTest("empty page → empty, no AI", async () => {
    for (const page of [pageOf({ board: undefined, contentKey: "blank" }), pageOf({ version: 0, contentKey: null })]) {
      const { deps, calls } = fake(page, { blank: BLANK });
      assert.deepEqual(await planPageText(page, deps), { kind: "empty" });
      assert.equal(calls.transcribe, 0);
    }
  });

  nodeTest("an edited page is read again; the app's later text wins over AI's", async () => {
    const page = pageOf();
    const { deps, calls } = fake(page, { board: INK });
    await textOf(page, deps);
    page.version = 3; // edited after the reading
    assert.equal(storedPageText(page), null);
    assert.equal((await planPageText(page, deps)).kind, "read");
    await textOf(page, deps);
    assert.equal(calls.transcribe, 2);
    Object.assign(page, { version: 9, ocrText: "app text", ocrAiVersion: null }); // the app sent its own
    assert.deepEqual(await planPageText(page, deps), { kind: "text", text: "app text" });
    assert.equal(calls.transcribe, 2);
  });

  nodeTest("PDF pages add their text layer; a PDF with no writing on it needs no AI", async () => {
    const pdfKey = "study/64b000000000000000000001/pdf-assets/asset-1.pdf";
    const board = JSON.stringify({
      pages: [
        { canvasJSON: '{"objects":[]}', pdfAssetId: "asset-1", pdfPageIndex: 0 },
        { canvasJSON: '{"objects":[]}', pdfAssetId: "asset-1", pdfPageIndex: 4 },
      ],
    });
    const page = pageOf();
    const { deps, calls } = fake(page, { board, [pdfKey]: Buffer.from("%PDF-") });
    const r = await planPageText(page, deps);
    assert.equal(r.kind, "text");
    assert.match((r as Any).text, /PDF page 1 text\n\nPDF page 5 text/);
    assert.doesNotMatch((r as Any).text, /PDF page 2/);
    assert.deepEqual(calls.pdf, [1, 5], "one run over pages 1..5");
    assert.equal(calls.transcribe, 0);

    const inked = pageOf();
    const withInk = JSON.stringify({ pages: [{ canvasJSON: '{"objects":[{"type":"path"}]}', pdfAssetId: "asset-1", pdfPageIndex: 0 }] });
    const f = fake(inked, { board: withInk, [pdfKey]: Buffer.from("%PDF-") });
    const out = await textOf(inked, f.deps);
    assert.match((out as Any).text, /^Newton's 2nd law: \$F = ma\$\n\nPrinted text on the page:\nPDF page 1 text$/);
  });

  nodeTest("ink the model cannot make out → unreadable, nothing saved", async () => {
    const page = pageOf();
    const { deps, calls } = fake(page, { board: INK }, "(empty)");
    assert.deepEqual(await textOf(page, deps), { kind: "unreadable" });
    assert.equal(calls.saved, 0);
  });

  nodeTest("reading the writing fails on a PDF page → the PDF text alone when it is long enough, else the error", async () => {
    const pdfKey = "study/64b000000000000000000001/pdf-assets/asset-1.pdf";
    const board = JSON.stringify({ pages: [{ canvasJSON: '{"objects":[{"type":"path"}]}', pdfAssetId: "asset-1", pdfPageIndex: 0 }] });
    const long = "Photosynthesis turns light into sugar. ".repeat(10);
    const setup = (printed: string, fail: "transcribe" | "images" = "transcribe") => {
      const page = pageOf();
      const f = fake(page, { board, [pdfKey]: Buffer.from("%PDF-") });
      f.deps.pdfPagesText = async () => [printed];
      if (fail === "transcribe") f.deps.transcribe = async () => Promise.reject(new Error("AI is down"));
      else f.deps.pageImages = async () => Promise.reject(new Error("render failed"));
      return { page, ...f };
    };

    for (const fail of ["transcribe", "images"] as const) {
      const { page, deps, calls } = setup(long, fail);
      const out = await textOf(page, deps);
      assert.equal(out.kind, "text");
      assert.equal((out as Any).text, `Printed text on the page:\n${long.trim()}`);
      assert.equal(calls.saved, 0, "not saved: the writing is read again next time");
      assert.equal(page.ocrAiVersion, null);
    }

    const short = setup("Page 4");
    await assert.rejects(textOf(short.page, short.deps), /AI is down/);

    const aborted = setup(long);
    const ctl = new AbortController();
    ctl.abort();
    const plan = await planPageText(aborted.page, aborted.deps);
    await assert.rejects(plan.read(spend, ctl.signal), /AI is down/);
  });

  nodeTest("helpers", () => {
    assert.deepEqual(boardInfo(BLANK).inkPages, []);
    assert.deepEqual(boardInfo("not json").inkPages, []);
    assert.deepEqual(boardInfo(JSON.stringify({ objects: [{ type: "path" }] })).inkPages, [0]);
    const many = JSON.stringify({ pages: Array.from({ length: 9 }, () => ({ canvasJSON: '{"objects":[1]}' })) });
    assert.equal(boardInfo(many).inkPages.length, 4, "at most 4 page images");
    assert.equal(cleanReading("```\nx = 1\n```"), "x = 1");
    assert.equal(cleanReading('""'), "");
    assert.equal(storedPageText({ ocrText: "ai", ocrAiVersion: 4, version: 4 }), "ai");
    assert.equal(storedPageText({ ocrText: "app", ocrAiVersion: null, version: 40 }), "app");
  });
});

// ─── against MongoDB ─────────────────────────────────────────────────────────────────────

const dbName = `syllabi_test_pagetext_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseUri = (process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017").replace(/\/+$/, "");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mongoose: Any = require("mongoose");
let mongoUp = false;
const dbTest = (name: string, fn: () => Promise<void>) =>
  nodeTest(name, async (t) => {
    if (!mongoUp) return t.skip("MongoDB is not reachable");
    await fn();
  });

describe("page text (database)", () => {
  const m: Any = {};
  const owner = new mongoose.Types.ObjectId();

  before(async () => {
    mongoose.set("strictQuery", true);
    try {
      await mongoose.connect(`${baseUri}/${dbName}`, { serverSelectionTimeoutMS: 1500 });
      mongoUp = true;
    } catch {
      return;
    }
    m.StudyPage = (await import("../src/models/study/page")).StudyPage;
    m.storage = await import("../src/services/study/storage");
    m.text = await import("../src/services/study/text-sources");
    m.pt = await import("../src/services/study/page-text");
  });

  after(async () => {
    if (mongoUp) {
      await mongoose.connection.dropDatabase().catch(() => {});
      await mongoose.disconnect();
    }
    rmSync(storageDir, { recursive: true, force: true });
  });

  async function newPage(board: string | null, extra: Any = {}) {
    const _id = new mongoose.Types.ObjectId();
    const key = board ? m.storage.pageContentKey(String(owner), String(_id), 1) : null;
    if (key) await m.storage.putStudyObject(key, Buffer.from(board!), "application/json");
    return m.StudyPage.create({ _id, userId: owner, title: "Forces", kind: "note", version: key ? 1 : 0, contentKey: key, ...extra });
  }

  /** The real deps, with the page images and the AI stubbed. */
  function realDeps(reading = "F = ma") {
    const calls = { transcribe: 0 };
    const deps: PageTextDeps = {
      ...m.pt.defaultDeps,
      pageImages: async () => [Buffer.from("jpg")],
      transcribe: async () => (calls.transcribe++, reading),
    };
    return { deps, calls };
  }

  dbTest("has ocrText → uses it", async () => {
    const page = await newPage(INK, { ocrText: "from the app" });
    const { deps, calls } = realDeps();
    const ts = await m.text.pageTextSource(owner, String(page._id), deps);
    assert.equal(ts.kind, "text");
    assert.equal(ts.text, "Forces\n\nfrom the app");
    assert.equal(calls.transcribe, 0);
  });

  dbTest("no ocrText with ink → reads, saves with the version, second call is free", async () => {
    const page = await newPage(INK);
    const { deps, calls } = realDeps();
    const ts = await m.text.pageTextSource(owner, String(page._id), deps);
    assert.equal(ts.kind, "read");
    const ready = await ts.read(spend);
    assert.deepEqual([ready.kind, ready.text], ["text", "Forces\n\nF = ma"]);
    const row = await m.StudyPage.findById(page._id).lean();
    assert.equal(row.ocrText, "F = ma");
    assert.equal(row.ocrAiVersion, 1);
    assert.ok(row.ocrUpdatedAt instanceof Date);
    const again = await m.text.pageTextSource(owner, String(page._id), deps);
    assert.deepEqual([again.kind, again.text], ["text", "Forces\n\nF = ma"]);
    assert.equal(calls.transcribe, 1);
  });

  dbTest("text the app sends while AI is reading is kept", async () => {
    const page = await newPage(INK);
    const { deps } = realDeps("AI words");
    const ts = await m.text.pageTextSource(owner, String(page._id), deps);
    await m.StudyPage.updateOne({ _id: page._id }, { $set: { ocrText: "app words", ocrUpdatedAt: new Date(), ocrAiVersion: null } });
    await ts.read(spend);
    const row = await m.StudyPage.findById(page._id).lean();
    assert.equal(row.ocrText, "app words");
    assert.equal(row.ocrAiVersion, null);
  });

  dbTest("a copy keeps an AI reading marked as AI's", async () => {
    const { forkedOcrAiVersion } = await import("../src/services/share/resources");
    assert.equal(forkedOcrAiVersion({ ocrAiVersion: 5, version: 5 }, 1), 1);
    assert.equal(forkedOcrAiVersion({ ocrAiVersion: 4, version: 5 }, 1), -1);
    assert.equal(forkedOcrAiVersion({ ocrAiVersion: null, version: 5 }, 1), null);
    assert.equal(m.pt.storedPageText({ ocrText: "old", ocrAiVersion: -1, version: 1 }), null);
  });

  dbTest("empty page → the plain empty error; missing page → missing", async () => {
    const { deps, calls } = realDeps();
    for (const page of [await newPage(BLANK), await newPage(null)]) {
      const ts = await m.text.pageTextSource(owner, String(page._id), deps);
      assert.deepEqual([ts.kind, ts.message, ts.code], ["error", PAGE_EMPTY_MESSAGE, "EMPTY_PAGE"]);
    }
    assert.equal((await m.text.pageTextSource(owner, String(new mongoose.Types.ObjectId()), deps)).kind, "missing");
    assert.equal(calls.transcribe, 0);
    assert.equal(m.pt.PAGE_EMPTY_MESSAGE, PAGE_EMPTY_MESSAGE);
    assert.doesNotMatch(m.pt.PAGE_EMPTY_MESSAGE + m.pt.PAGE_UNREADABLE_MESSAGE, /OCR|\/study|PUT /);
  });

  dbTest("a real PDF under the page gives its text", async () => {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const words of ["Chapter one intro", "Kinematics equations here", "Middle filler", "Last page vectors"]) doc.addPage([300, 200]).drawText(words, { x: 20, y: 100, size: 14, font });
    await m.storage.putStudyObject(m.storage.pdfAssetKey(String(owner), "pdf-a"), Buffer.from(await doc.save()), "application/pdf");
    const page = await newPage(
      JSON.stringify({
        pages: [
          { canvasJSON: '{"objects":[]}', pdfAssetId: "pdf-a", pdfPageIndex: 1 },
          { canvasJSON: '{"objects":[]}', pdfAssetId: "pdf-a", pdfPageIndex: 3 },
        ],
      })
    );
    const { deps, calls } = realDeps();
    const ts = await m.text.pageTextSource(owner, String(page._id), deps);
    assert.equal(ts.kind, "text");
    assert.match(ts.text, /Kinematics equations here\s+Last page vectors/);
    assert.doesNotMatch(ts.text, /Chapter one|Middle filler/);
    assert.equal(calls.transcribe, 0);
  });
});
