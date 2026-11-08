import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import mongoose, { Types } from "mongoose";
import { StudyCanvasConnection } from "@/models/study/canvas-connection";
import {
  IStudyLibraryDoc,
  LibraryKind,
  StudyClassGuide,
  StudyExamResult,
  StudyLabSpecimen,
  StudyLibraryChunk,
  StudyLibraryDoc,
  ExamScheduleEntry,
} from "@/models/study/library";
import { StudyConceptMap } from "@/models/study/concept-map";
import {
  parseConceptMapsMd,
  parseIndexWeeks,
  parseKitTable,
  parseMineralKit,
  parseSchedule,
  sanitizeGuide,
  weekOfDate,
  KitRow,
} from "./concept-map-parse";
import { putStudyObject } from "./storage";
import { splitText } from "./ai";

/**
 * Re-runnable import of the owner's local class folder into class library docs (P-CM).
 *
 *   <root>/<NNNN>-<course>/...      → course `courseMap[NNNN]` (relPath relative to that folder)
 *   <root>/<file>                   → `rootCourse` (relPath = file name)
 *   <root>/CLAUDE.md                → the class guide of every mapped course (not a library doc)
 *   <course>/concept maps/CONCEPT-MAPS.md → also parsed into `study_concept_maps`
 *
 * Owner: the admin whose study Canvas connection has `canvasUser.id === canvasUserId`; when there
 * is none yet every row is written with `userId: null` (pending) and attached when that
 * connection is saved (services/study/library.ts `attachPendingImports`). Upsert identity =
 * (canvasUserId, canvasCourseId, relPath); an unchanged file (same sha256) is not re-uploaded.
 * Logs carry only titles, paths, counts and sizes — never file content.
 */
const run = promisify(execFile);

/** Top-level folder name → Canvas course id. Empty by default; pass `courseMap` / `rootCourse`. */
export const DEFAULT_COURSE_MAP: Record<string, number> = {};
export const DEFAULT_ROOT_COURSE = 0;
export const FILE_CAP_BYTES = 25 * 1024 * 1024;
export const NOTE_CHUNK_CHARS = 4000;
const PDF_TEXT_TIMEOUT_MS = 240_000;

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const kindOf = (ext: string): LibraryKind | null => (ext === ".md" ? "note" : ext === ".pdf" ? "pdf" : MIME[ext] ? "image" : null);

export interface ExamResultSeed {
  canvasCourseId: number;
  name: string;
  date?: string | null;
  score: number;
  maxScore: number;
  chapters?: string[];
  sections?: Array<{ name: string; score: number; max: number }>;
  notes?: string | null;
}

export interface ImportOpts {
  canvasUserId: number;
  dryRun?: boolean;
  courseMap?: Record<string, number>;
  rootCourse?: number;
  fileCapBytes?: number;
  examResults?: ExamResultSeed[];
  log?: (line: string) => void;
}

export interface ImportReport {
  dryRun: boolean;
  owner: { userId: string | null; pending: boolean };
  files: number;
  counts: Record<LibraryKind, number>;
  created: number;
  updated: number;
  unchanged: number;
  bytesTotal: number;
  bytesUploaded: number;
  chunks: number;
  skipped: Array<{ path: string; reason: string; size: number }>;
  textOnly: Array<{ path: string; size: number }>;
  conceptMaps: Array<{ course: number; number: number; terms: number; score: number | null; modelAnswer: boolean; comment: boolean; submissionImage: boolean; transcription: boolean }>;
  guides: number;
  schedule: ExamScheduleEntry[];
  specimens: number;
  examResults: number;
}

interface FileEntry {
  abs: string;
  rel: string;
  course: number;
  topDir: string | null;
  size: number;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []));
const toPosix = (p: string) => p.split(path.sep).join("/");

/**
 * The week number a library path belongs to: the first path segment that STARTS with `Week-NN`
 * ("Week-03-📖-Course-Textbook/…", "Week-01-Res/WEEK.md") gives NN, whatever follows the number.
 * No WEEK.md date check — resource modules ("Dates: —") are weeks too, and the old gate left
 * every undated folder with `week: null`.
 */
export function weekFromPath(rel: string): number | null {
  for (const seg of rel.split("/")) {
    const m = seg.match(/^Week[-_ ]*(\d{1,3})(?!\d)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

const titleOf = (rel: string, kind: LibraryKind, text: string | null) => {
  if (kind === "note" && text) {
    const h = text.match(/^#\s+(.+)$/m);
    if (h) return h[1].trim().slice(0, 200);
  }
  return path.posix.basename(rel).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim().slice(0, 200);
};

/** pdftotext over the whole PDF, split per page (form feed). [] when there is no text layer. */
export async function pdfPages(abs: string): Promise<string[]> {
  try {
    const { stdout } = await run("pdftotext", ["-layout", abs, "-"], { maxBuffer: 128 << 20, timeout: PDF_TEXT_TIMEOUT_MS });
    const pages = String(stdout)
      .split("\f")
      .map((p) => p.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim());
    if (pages.length && !pages[pages.length - 1]) pages.pop(); // pdftotext ends every page with \f
    return pages;
  } catch {
    return [];
  }
}

/** Resolve the owner admin (or null = pending) for a Canvas user id. */
export async function ownerFor(canvasUserId: number): Promise<Types.ObjectId | null> {
  const c = await StudyCanvasConnection.findOne({ "canvasUser.id": canvasUserId }, { userId: 1 }).sort({ updatedAt: -1 }).lean<{ userId: Types.ObjectId }>();
  return c?.userId ?? null;
}

const ownerSet = (owner: Types.ObjectId | null) => (owner ? { userId: owner } : {});
const ownerInsert = (owner: Types.ObjectId | null) => (owner ? {} : { userId: null });

export async function importLibraryFolder(rootPath: string, opts: ImportOpts): Promise<ImportReport> {
  const log = opts.log ?? (() => {});
  const dryRun = !!opts.dryRun;
  const courseMap = opts.courseMap ?? DEFAULT_COURSE_MAP;
  const rootCourse = opts.rootCourse ?? DEFAULT_ROOT_COURSE;
  const cap = opts.fileCapBytes ?? FILE_CAP_BYTES;
  const canvasUserId = Number(opts.canvasUserId);
  if (!Number.isInteger(canvasUserId) || canvasUserId <= 0) throw new Error("canvasUserId must be a positive integer");
  const root = path.resolve(rootPath);
  if (!fs.statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);

  const owner = await ownerFor(canvasUserId);
  const keyOwner = owner ? String(owner) : `pending-c${canvasUserId}`;
  const report: ImportReport = {
    dryRun,
    owner: { userId: owner ? String(owner) : null, pending: !owner },
    files: 0,
    counts: { note: 0, pdf: 0, image: 0 },
    created: 0,
    updated: 0,
    unchanged: 0,
    bytesTotal: 0,
    bytesUploaded: 0,
    chunks: 0,
    skipped: [],
    textOnly: [],
    conceptMaps: [],
    guides: 0,
    schedule: [],
    specimens: 0,
    examResults: 0,
  };

  // ── collect ───────────────────────────────────────────────────────────────────────────
  const courseDirs = new Map<number, string>();
  const entries: FileEntry[] = [];
  let guideFile: string | null = null;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, e.name);
    if (e.isDirectory()) {
      const course = courseMap[e.name.match(/^(\d{3,6})-/)?.[1] ?? ""];
      if (!course) {
        report.skipped.push({ path: `${e.name}/`, reason: "folder not mapped to a course", size: 0 });
        continue;
      }
      courseDirs.set(course, abs);
      for (const f of walk(abs)) {
        const rel = toPosix(path.relative(abs, f));
        const top = rel.includes("/") ? rel.split("/")[0] : null;
        entries.push({ abs: f, rel, course, topDir: top, size: fs.statSync(f).size });
      }
    } else if (e.isFile()) {
      if (e.name === "CLAUDE.md") guideFile = abs;
      else entries.push({ abs, rel: e.name, course: rootCourse, topDir: null, size: fs.statSync(abs).size });
    }
  }

  const docIdsByPath = new Map<string, Types.ObjectId>(); // `${course}:${rel}` → doc id
  const keyByPath = new Map<string, string>(); // same → storage key (images, for concept-map submissions)
  const altText = new Map<string, string[]>(); // image key → alt texts used in notes

  // ── files ─────────────────────────────────────────────────────────────────────────────
  for (const f of entries.sort((a, b) => a.course - b.course || a.rel.localeCompare(b.rel))) {
    const base = path.basename(f.rel);
    const ext = path.extname(base).toLowerCase();
    const kind = kindOf(ext);
    if (base === ".DS_Store" || base.startsWith("._")) {
      report.skipped.push({ path: toPosix(path.relative(root, f.abs)), reason: "junk", size: f.size });
      continue;
    }
    if (!kind) {
      report.skipped.push({ path: toPosix(path.relative(root, f.abs)), reason: `unsupported type ${ext || "(none)"}`, size: f.size });
      continue;
    }
    const tooBig = f.size > cap;
    if (tooBig && kind !== "pdf") {
      report.skipped.push({ path: toPosix(path.relative(root, f.abs)), reason: `over ${Math.round(cap / 1048576)} MB`, size: f.size });
      continue;
    }
    report.files++;
    report.counts[kind]++;
    report.bytesTotal += f.size;
    if (tooBig) report.textOnly.push({ path: toPosix(path.relative(root, f.abs)), size: f.size });
    const week = weekFromPath(f.rel);
    const bytes = fs.readFileSync(f.abs);
    const hash = sha256(bytes);
    const pk = `${f.course}:${f.rel}`;
    const filter = { canvasUserId, canvasCourseId: f.course, relPath: f.rel };
    const existing = await StudyLibraryDoc.findOne(filter, { sha256: 1, file: 1, week: 1, userId: 1 }).lean<IStudyLibraryDoc>();
    const markdown = kind === "note" ? bytes.toString("utf8") : null;
    if (markdown) {
      for (const m of markdown.matchAll(/!\[([^\]]*)\]\(<?([^)>]+)>?\)/g)) {
        const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f.rel), m[2].trim()));
        const k = `${f.course}:${rel}`;
        if (m[1].trim()) altText.set(k, [...(altText.get(k) ?? []), m[1].trim()]);
      }
    }
    if (existing && existing.sha256 === hash && (tooBig || kind === "note" || existing.file?.storageKey)) {
      report.unchanged++;
      docIdsByPath.set(pk, existing._id);
      if (existing.file?.storageKey) keyByPath.set(pk, existing.file.storageKey);
      if (!dryRun && ((owner && !existing.userId) || existing.week !== week)) {
        await StudyLibraryDoc.updateOne({ _id: existing._id }, { $set: { ...ownerSet(owner), week } });
        await StudyLibraryChunk.updateMany({ docId: existing._id }, { $set: { ...ownerSet(owner), week } });
      }
      log(`  = ${f.rel}`);
      continue;
    }

    // Text for retrieval.
    let chunks: string[] = [];
    if (kind === "pdf") chunks = dryRun ? [] : await pdfPages(f.abs);
    else if (markdown) chunks = splitText(markdown, NOTE_CHUNK_CHARS);
    const textChars = chunks.reduce((n, c) => n + c.length, 0);
    log(`  ${existing ? "~" : "+"} ${f.rel} (${kind}, ${(f.size / 1024).toFixed(0)} KB${tooBig ? ", text only" : ""})`);
    if (dryRun) {
      existing ? report.updated++ : report.created++;
      continue;
    }

    let file: IStudyLibraryDoc["file"] = null;
    if (kind !== "note" && !tooBig) {
      const key = `study/${keyOwner}/library/${randomUUID()}${ext === ".jpeg" ? ".jpg" : ext}`;
      await putStudyObject(key, bytes, MIME[ext]);
      file = { storageKey: key, mime: MIME[ext], size: f.size, sha256: hash };
      report.bytesUploaded += f.size;
      keyByPath.set(pk, key);
    }
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const doc = await StudyLibraryDoc.findOneAndUpdate(
          filter,
          {
            $set: { ...ownerSet(owner), title: titleOf(f.rel, kind, markdown), kind, week, markdown, file, size: f.size, sha256: hash, pages: chunks.length || null, textChars },
            $setOnInsert: ownerInsert(owner),
          },
          { upsert: true, new: true, session }
        ).lean<IStudyLibraryDoc>();
        docIdsByPath.set(pk, doc!._id);
        await StudyLibraryChunk.deleteMany({ docId: doc!._id }, { session });
        const rows = chunks
          .map((text, i) => ({ docId: doc!._id, userId: doc!.userId ?? null, canvasUserId, canvasCourseId: f.course, week, page: i + 1, text }))
          .filter((r) => r.text.trim());
        for (let i = 0; i < rows.length; i += 500) await StudyLibraryChunk.insertMany(rows.slice(i, i + 500), { session });
        report.chunks += rows.length;
      });
    } finally {
      await session.endSession();
    }
    existing ? report.updated++ : report.created++;
  }

  // ── concept maps ──────────────────────────────────────────────────────────────────────
  for (const [course, dir] of courseDirs) {
    const cmFile = path.join(dir, "concept maps", "CONCEPT-MAPS.md");
    if (!fs.existsSync(cmFile)) continue;
    const parsed = parseConceptMapsMd(fs.readFileSync(cmFile, "utf8"));
    for (const m of parsed.maps) {
      const imgRel = m.imagePath ? path.posix.normalize(path.posix.join("concept maps", m.imagePath)) : null;
      const imageKey = imgRel ? keyByPath.get(`${course}:${imgRel}`) ?? null : null;
      report.conceptMaps.push({
        course,
        number: m.number,
        terms: m.promptTerms.length,
        score: m.score,
        modelAnswer: !!m.modelAnswer,
        comment: !!m.comment,
        submissionImage: !!imageKey || (dryRun && !!imgRel && entries.some((e) => e.course === course && e.rel === imgRel)),
        transcription: !!m.transcription,
      });
      if (dryRun) continue;
      await StudyConceptMap.findOneAndUpdate(
        { canvasUserId, canvasCourseId: course, source: "import", number: m.number },
        {
          $set: {
            ...ownerSet(owner),
            week: m.week,
            lecture: m.lecture,
            dueAt: m.dueAt ? new Date(`${m.dueAt}T00:00:00.000Z`) : null,
            promptTerms: m.promptTerms,
            submission: imageKey || m.transcription ? { imageKey, transcription: m.transcription } : null,
            instructor: m.comment || m.modelAnswer ? { comment: m.comment, modelAnswer: m.modelAnswer } : null,
            score: m.score,
            maxScore: m.points || 10,
            canvasAssignmentId: m.canvasAssignmentId,
          },
          $setOnInsert: { ...ownerInsert(owner), canvasItemId: null },
        },
        { upsert: true }
      );
    }
    if (parsed.rubric && !dryRun) {
      await StudyClassGuide.updateOne({ canvasUserId, canvasCourseId: course }, { $set: { ...ownerSet(owner), conceptMapRubric: parsed.rubric }, $setOnInsert: ownerInsert(owner) }, { upsert: true });
    }
  }

  // ── class guide + exam schedule + lab kit ─────────────────────────────────────────────
  if (guideFile) {
    const raw = fs.readFileSync(guideFile, "utf8");
    const guide = sanitizeGuide(raw);
    const rows = parseSchedule(raw);
    const indexOf = (course: number) => {
      const d = courseDirs.get(course);
      const f = d ? path.join(d, "INDEX.md") : "";
      return f && fs.existsSync(f) ? parseIndexWeeks(fs.readFileSync(f, "utf8")) : [];
    };
    const lectureWeeks = indexOf(rootCourse);
    report.schedule = rows.map((r) => ({ name: r.name, week: weekOfDate(r.date, lectureWeeks), date: r.date, chapters: r.chapters, topics: r.topics }));
    for (const course of courseDirs.keys()) {
      report.guides++;
      if (dryRun) continue;
      const g = await StudyClassGuide.findOne({ canvasUserId, canvasCourseId: course }, { editedAt: 1, scheduleEditedAt: 1 }).lean<any>();
      const set: Record<string, unknown> = { ...ownerSet(owner) };
      if (!g?.editedAt) set.markdown = guide;
      if (!g?.scheduleEditedAt) set.examsSchedule = course === rootCourse ? report.schedule : [];
      await StudyClassGuide.updateOne({ canvasUserId, canvasCourseId: course }, { $set: set, $setOnInsert: ownerInsert(owner) }, { upsert: true });
    }

    const kit = parseMineralKit(raw);
    const labCourse = [...courseDirs.entries()].find(([, d]) => /lab/i.test(path.basename(d)))?.[0];
    if (labCourse && (kit.items.length || kit.unknown.length)) {
      const labDir = courseDirs.get(labCourse)!;
      const guidePdf = walk(labDir).find((f) => /study-guide/i.test(path.basename(f)) && /\.pdf$/i.test(f) && /quiz-2|mineral/i.test(path.basename(f)));
      const table: Map<number, KitRow> = guidePdf ? parseKitTable((await pdfPages(guidePdf)).join("\n")) : new Map();
      const all = [...kit.items.map((i) => ({ ...i, unknown: false })), ...kit.unknown.map((n) => ({ number: n, name: null as string | null, unknown: true }))];
      for (const s of all) {
        report.specimens++;
        if (dryRun) continue;
        const props = table.get(s.number);
        const names = s.name ? [s.name, ...(/k-?feldspar/i.test(s.name) ? ["potassium feldspar", "orthoclase"] : [])] : [];
        const photoDocIds: Types.ObjectId[] = [];
        if (names.length) {
          const rx = new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
          for (const [k, id] of docIdsByPath) {
            const rel = k.slice(k.indexOf(":") + 1);
            if (!/\.(png|jpe?g|webp|gif)$/i.test(rel)) continue;
            if (rx.test(path.basename(rel)) || (altText.get(k) ?? []).some((a) => rx.test(a))) photoDocIds.push(id);
          }
        }
        await StudyLabSpecimen.updateOne(
          { canvasUserId, canvasCourseId: labCourse, kit: "minerals", number: s.number },
          {
            $set: {
              ...ownerSet(owner),
              name: s.name,
              unknown: s.unknown,
              properties: { luster: props?.luster ?? null, hardness: props?.hardness ?? null, streak: props?.streak ?? null, cleavage: props?.cleavage ?? null, notes: props?.notes ?? null },
              photoDocIds: [...new Set(photoDocIds.map(String))].slice(0, 6).map((i) => new Types.ObjectId(i)),
            },
            $setOnInsert: ownerInsert(owner),
          },
          { upsert: true }
        );
      }
    }
  }

  // ── exam results ──────────────────────────────────────────────────────────────────────
  for (const r of opts.examResults ?? []) {
    report.examResults++;
    if (dryRun) continue;
    await StudyExamResult.updateOne(
      { canvasUserId, canvasCourseId: r.canvasCourseId, seedKey: r.name },
      {
        $set: {
          ...ownerSet(owner),
          name: r.name,
          date: r.date ?? null,
          score: r.score,
          maxScore: r.maxScore,
          chapters: r.chapters ?? [],
          sections: r.sections ?? [],
          notes: r.notes ?? null,
        },
        $setOnInsert: ownerInsert(owner),
      },
      { upsert: true }
    );
  }
  return report;
}

/** Ensure the import collections' indexes exist (prod runs with autoIndex off). */
export async function ensureLibraryIndexes(): Promise<void> {
  for (const M of [StudyLibraryDoc, StudyLibraryChunk, StudyClassGuide, StudyLabSpecimen, StudyExamResult, StudyConceptMap] as any[]) await M.createIndexes();
  const { StudyConceptMapAttempt } = await import("@/models/study/concept-map");
  await StudyConceptMapAttempt.createIndexes();
}
