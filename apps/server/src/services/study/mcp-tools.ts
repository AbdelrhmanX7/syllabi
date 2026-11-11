import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StudyCanvasConnection } from "@/models/study/canvas-connection";
import { StudyCanvasImage } from "@/models/study/canvas-image";
import { canvasImageJpeg, extractImages, storedCanvasImage, withImageMarkers } from "./canvas-images";
import sharp from "sharp";
import { z } from "zod";
import { Types } from "mongoose";
import { StudyClass } from "@/models/study/class";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyPage, IStudyPage } from "@/models/study/page";
import { StudyQuestion, IStudyQuestion } from "@/models/study/question";
import { StudyMcpQuiz, IStudyMcpQuiz } from "@/models/study/mcp";
import { getClasses, getClassItems, getItem, getToday } from "@/controllers/study.controller";
import { createPage, pageDto, putPageOcr, search } from "@/controllers/study-pages.controller";
import { attemptQuestion, createQuestions, flashcards, FLASHCARDS_MAX, listQuestions, patchQuestion } from "@/controllers/study-questions.controller";
import { getLecture, getVideoTranscript } from "@/controllers/study-lectures.controller";
import { getClassAPlan } from "@/controllers/study-a-plan.controller";
import { getConceptMap } from "@/controllers/study-concept-maps.controller";
import { itemsDto, listClasses, LIST_PROJECTION, todayRules } from "./views";
import { correctChoiceIndex, studentChoiceIndex } from "./ai";
import { reviewNext, REVIEW_MAX, todayReview, topicMastery, WEAK_TOPIC_MIN_ATTEMPTS } from "./questions";
import { htmlToText } from "./extract-sources";
import { invokeController, Invoked } from "./mcp-invoke";
import { classifyAiError, logAiFailure } from "./ai-errors";
import { buildStudyPlan, explainMistake } from "./mcp-ai";
import { IMAGE_SIZES, ImageShape, imageGen, newSpend } from "./ai-models";
import { recordStudyUsage } from "./usage";
import { AI_NOT_ENABLED, aiEnabledFor, premiumAiFor } from "@/auth/verified";
import { logger } from "@/services/logger.service";
import { IStudyClass } from "@/models/study/class";
import { getLectureMaterial } from "./lecture-material";
import { putStudyObject, signedGetUrl, SIGNED_URL_TTL_SEC, studyFileKey } from "./storage";
import { escapeRegex } from "@/controllers/study.controller";
import { DRAW_MAX_SHAPES, DrawError, deleteDrawing, drawOnPage, drawShapeSchema } from "./board-draw";
import { parseRuler, RulerError, rulerDto, rulersDto, validatePage } from "./page-ruler";
import { getOrSeedProfile, parseProfilePatch, patchProfile, profileDto } from "./drawing-profile";
import { copyInboxImageToQuestion, QuestionImageError } from "./question-images";
import { annotationDto } from "@/controllers/study-page-renders.controller";
import {
  MCP_IMAGE_MAX_EDGE,
  NOTEBOOK_DEFAULT_PAGES,
  NOTEBOOK_MAX_IMAGE_BYTES,
  NOTEBOOK_MAX_PAGES,
  NOTEBOOK_PDF_MAX_PAGES,
  notebookPageCount,
  notebookPdf,
  rendersByPage,
  renderJpeg,
} from "./notebook-renders";
import { createGeneratedPdfPage, DOC_PAGE_SIZES, DocPageSize, renderDocumentPdf } from "./generated-pdf";
import type { InboxSource } from "./inbox/source";
import { createInboxItem, InboxError, listInboxItems, queueInboxItemsForPage, validateMeta, validatePageTarget } from "./inbox/items";
import { InboxMediaError } from "./inbox/media";
import { createUploadLink, InboxTokenError } from "./inbox/tokens";
import {
  buildDeckHtml,
  DeckInputError,
  deckOutlineHtml,
  deckSlideSchema,
  deckStyleSchema,
  DECK_MAX_SLIDES,
  markdownToHtml,
  mergeDeckStyle,
  pdfPageCount,
  prepareMedia,
  renderDeckPdf,
} from "./lecture-pdf";

/**
 * The Study MCP tool set (contract "MCP (remote, for Claude)"). A fresh server is built per
 * HTTP request, bound to the ONE owner id the auth layer resolved; every tool reads/writes
 * through the same controllers/services the REST routes use, scoped by that id.
 * Outputs are a single text block of compact JSON.
 */

type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

/**
 * The Canvas origin an item's images are resolved against: the item's own canvasUrl first (it
 * survives a Canvas disconnect, which keeps synced items), else the owner's connection.
 */
const itemOrigin = async (userId: Types.ObjectId, canvasUrl: string | null | undefined): Promise<string | null> => {
  try {
    if (canvasUrl) return new URL(canvasUrl).origin;
  } catch {
    /* fall through */
  }
  return canvasOrigin(userId);
};

/** The owner's Canvas origin (images are only resolved for that host). */
const canvasOrigin = async (userId: Types.ObjectId): Promise<string | null> => {
  const conn = await StudyCanvasConnection.findOne({ userId }, { baseUrl: 1 }).lean<{ baseUrl?: string }>();
  try {
    return conn?.baseUrl ? new URL(conn.baseUrl).origin : null;
  } catch {
    return null;
  }
};

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const toolError = (message: string, code = "ERROR"): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }], isError: true });

/** REST reply → tool result: 4xx/5xx and SSE `error` frames become tool errors. */
function fromInvoked(r: Invoked, pick: (r: Invoked) => unknown = (x) => x.body): ToolResult {
  if (r.status >= 400) return toolError(String(r.body?.message ?? "Request failed"), String(r.body?.code ?? `HTTP_${r.status}`));
  const err = r.events.find((e) => e.event === "error");
  if (err) return toolError(String(err.data?.message ?? "Failed"), String(err.data?.code ?? "ERROR"));
  return ok(pick(r));
}

const oid = z.string().regex(/^[0-9a-fA-F]{24}$/, "must be a 24-hex id");
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const ownClass = (userId: Types.ObjectId, classId: string) => StudyClass.exists({ _id: classId, userId });

/** A real calendar date (2026-02-30 is not). */
const realDate = dateStr.refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  // "2026-99-99" is an Invalid Date, whose toISOString() THROWS — inside a refine that would be a protocol error, not a validation one
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, "must be a real date");
/** The page `lecture` field (contract: {number|null, key, date}). */
const pageLecture = z.object({ number: z.number().int().min(1).max(200).nullable().optional(), key: z.string().trim().min(1).max(80), date: realDate }).strict();
const week = z.number().int().min(1).max(30);

/** Question as shown DURING a quiz: no answer, no solution. */
const quizQuestion = (q: IStudyQuestion) => ({ id: String(q._id), type: q.type, topic: q.topic, difficulty: q.difficulty, stem: q.stem, imageUrl: q.imageUrl ?? null, choices: q.choices ?? [] });

const TRANSCRIPT_MAX_CHARS = 150_000;
const clock = (sec: number) => {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
/** Segments → one `[mm:ss] text` line each, capped so a 3-hour lecture stays a sane tool result. */
function transcriptText(segments: { start: number; text: string }[] | undefined) {
  const lines: string[] = [];
  let n = 0;
  for (const s of segments ?? []) {
    const line = `[${clock(s.start)}] ${String(s.text ?? "").trim()}`;
    if (n + line.length > TRANSCRIPT_MAX_CHARS) return { text: lines.join("\n"), truncated: true };
    lines.push(line);
    n += line.length + 1;
  }
  return { text: lines.join("\n"), truncated: false };
}

const ASSIGNMENT_STATUSES = ["upcoming", "due", "overdue", "submitted", "graded", "missing", "all"] as const;

/**
 * `publicBase` = the origin the MCP request came in on (`https://<host>`), for links the tools hand out.
 * `inboxSource` = which app is calling (claude / codex / other), resolved only when a tool saves to the inbox.
 */
export function buildStudyMcpServer(ownerId: string, opts: { publicBase?: string; inboxSource?: () => Promise<InboxSource> } = {}): McpServer {
  const base = (opts.publicBase || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, "");
  const source = async (): Promise<InboxSource> => {
    try {
      return opts.inboxSource ? await opts.inboxSource() : "other";
    } catch {
      return "other";
    }
  };
  const userId = new Types.ObjectId(ownerId);
  const run = (handler: any, input: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown }, label: string) =>
    invokeController(handler, { userId: ownerId, ...input, label });
  // Tools that call a paid model on the server check this (the controllers they run in-process
  // check it themselves: flashcards, answer_quiz with typed work, the A plan).
  const noAi = () => toolError(AI_NOT_ENABLED.message, AI_NOT_ENABLED.code);

  const server = new McpServer(
    { name: "study", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "The owner's personal study data: Canvas classes, items (files, pages, assignments, quizzes, videos, announcements), notebook pages, and a question bank with spaced repetition. Ids are 24-hex strings returned by the tools. Before giving or making any drawing for a notebook page, call get_drawing_profile; give all lengths in real mm and angles in degrees. After creating a quiz or map page that needs measuring, call set_page_ruler.",
    }
  );

  server.registerTool(
    "list_classes",
    { description: "List the owner's classes (current term, not hidden) with grade and due/overdue/unseen counts. all=true includes past and hidden classes.", inputSchema: { all: z.boolean().optional() }, annotations: READ },
    async ({ all }) => fromInvoked(await run(getClasses, { query: all ? { term: "all" } : {} }, "list_classes"))
  );

  server.registerTool(
    "get_today",
    { description: "Today's dashboard: assignments due in 7 days, overdue, unseen items, unread announcements, question-bank review counts, weak topics, classes.", inputSchema: {}, annotations: READ },
    async () => fromInvoked(await run(getToday, {}, "get_today"))
  );

  server.registerTool(
    "list_items",
    {
      description: "List one class's items, newest first. type filters to file|page|assignment|quiz|video|link|announcement.",
      inputSchema: { classId: oid, type: z.enum(["file", "page", "assignment", "quiz", "video", "link", "announcement"]).optional() },
      annotations: READ,
    },
    async ({ classId, type }) => fromInvoked(await run(getClassItems, { params: { id: classId }, query: type ? { type } : {} }, "list_items"))
  );

  server.registerTool(
    "get_a_plan",
    {
      description:
        "One class's A plan: syllabus grading policy, conflicts, announcement digests and the synthesized plan to an A. Returns {status:'building'} the first time (a build starts — call again shortly); a cached plan carries stale=true while a background rebuild runs.",
      inputSchema: { classId: oid },
      annotations: READ,
    },
    async ({ classId }) => fromInvoked(await run(getClassAPlan, { params: { id: classId } }, "get_a_plan"))
  );

  server.registerTool(
    "get_item",
    { description: "One item (Canvas item) or notebook page by id, with its text: page/assignment/announcement body as plain text, a notebook page's handwriting/markdown text. Pictures in the body show in the text as ⟦image N: alt⟧ and are listed in images[] (index, alt, available) — fetch them with get_item_images.", inputSchema: { id: oid }, annotations: READ },
    async ({ id }) => {
      const r = await run(getItem, { params: { id } }, "get_item");
      if (r.status === 200) {
        const { html, ...rest } = r.body ?? {};
        const out: Record<string, unknown> = { entity: "item", ...rest };
        if (typeof html === "string") {
          out.text = htmlToText(withImageMarkers(html)).slice(0, 100_000);
          const imgs = extractImages(html, await itemOrigin(userId, rest.canvasUrl));
          if (imgs.length) {
            const stored = new Set((await StudyCanvasImage.find({ userId, canvasFileId: { $in: imgs.flatMap((i) => (i.fileId === null ? [] : [i.fileId])) }, status: "stored" }, { canvasFileId: 1 }).lean()).map((r) => r.canvasFileId));
            out.images = imgs.map((i) => ({ index: i.index, alt: i.alt, available: i.fileId !== null && stored.has(i.fileId), ...(i.fileId !== null && stored.has(i.fileId) ? { ref: `canvas-image:${i.fileId}` } : {}) }));
          }
        }
        if (rest.type === "video") {
          const t = await run(getVideoTranscript, { params: { itemId: id } }, "get_item");
          if (t.status === 200) {
            const { segments, ...meta } = t.body ?? {};
            out.transcript = { ...meta, ...transcriptText(segments) };
          }
        }
        return ok(out);
      }
      if (r.status !== 404) return fromInvoked(r);
      const page = await StudyPage.findOne({ _id: id, userId, deletedAt: null }).lean<IStudyPage>();
      if (!page) return toolError("No item or page with that id", "NOT_FOUND");
      return ok({ entity: "page", ...pageDto(page), text: page.ocrText ?? null });
    }
  );

  server.registerTool(
    "get_item_images",
    {
      description:
        "The pictures embedded in a Canvas item (page, assignment, quiz, announcement), or a Canvas image file itself — the figures get_item's text marks as ⟦image N: alt⟧. Returns each requested image as an image block (JPEG, long edge ≤ 1568 px) plus its index, alt text and a ref. Use the ref as an image url in create_lecture_pdf (images[].url, credit e.g. \"Course page figure\") or in render_pdf_to_inbox (<img src=\"<ref>\"> / ![alt](<ref>)). indices = which images (1-based, from get_item's images list); default the first 6. At most 6 per call, ~3 MB total. Images are fetched by the Canvas sync; one that is not available yet (available:false) appears after the next sync.",
      inputSchema: { id: oid, indices: z.array(z.number().int().min(1).max(500)).min(1).max(6).optional() },
      annotations: READ,
    },
    async ({ id, indices }) => {
      const item = await StudyItem.findOne({ _id: id, userId }, { html: 1, title: 1, type: 1, canvasType: 1, canvasId: 1, canvasUrl: 1, file: 1 }).lean<IStudyItem>();
      if (!item) return toolError("Item not found", "NOT_FOUND");
      // A synced Canvas image FILE (not a page): register its stored bytes as a canvas-image so the
      // same ref works in the PDF tools, then return it like a page figure.
      if (item.type === "file") {
        const fid = Number(item.canvasId);
        if (item.canvasType !== "File" || !Number.isSafeInteger(fid) || !item.file?.storageKey || !/^image\/(jpeg|png|webp|gif)$/i.test(item.file.mime ?? "")) {
          return toolError("This file is not an image — use get_item for its text", "NOT_AN_IMAGE");
        }
        await StudyCanvasImage.updateOne(
          { userId, canvasFileId: fid },
          { $set: { status: "stored", reason: null, storageKey: item.file.storageKey, contentType: item.file.mime, bytes: item.file.size ?? 0, sha256: item.file.sha256 ?? null } },
          { upsert: true }
        );
        const row = (await storedCanvasImage(userId, fid))!;
        const jpg = await canvasImageJpeg(row, MCP_IMAGE_MAX_EDGE);
        return {
          content: [
            { type: "text", text: JSON.stringify({ itemId: id, title: item.title, count: 1, images: [{ index: 1, alt: item.title, available: true, ref: `canvas-image:${fid}`, width: jpg.width, height: jpg.height }] }) },
            { type: "image", data: jpg.data.toString("base64"), mimeType: "image/jpeg" },
          ],
        };
      }
      const all = extractImages(item.html, await itemOrigin(userId, item.canvasUrl));
      if (!all.length) return ok({ itemId: id, title: item.title, count: 0, images: [] });
      const want = (indices ?? all.slice(0, 6).map((i) => i.index)).filter((n) => n <= all.length);
      const content: ToolResult["content"] = [];
      const meta: Record<string, unknown>[] = [];
      let bytes = 0;
      for (const n of want) {
        const im = all[n - 1];
        const row = im.fileId !== null ? await storedCanvasImage(userId, im.fileId) : null;
        if (!row) {
          meta.push({ index: n, alt: im.alt, available: false, reason: im.fileId === null ? "not a Canvas file image (external host)" : "not synced yet" });
          continue;
        }
        const jpg = await canvasImageJpeg(row, MCP_IMAGE_MAX_EDGE);
        if (bytes + jpg.data.length > NOTEBOOK_MAX_IMAGE_BYTES) {
          meta.push({ index: n, alt: im.alt, available: true, ref: `canvas-image:${im.fileId}`, omitted: "over this call's size budget — ask for it alone" });
          continue;
        }
        bytes += jpg.data.length;
        meta.push({ index: n, alt: im.alt, available: true, ref: `canvas-image:${im.fileId}`, width: row.width, height: row.height });
        content.push({ type: "text", text: `image ${n}${im.alt ? `: ${im.alt}` : ""}` }, { type: "image", data: jpg.data.toString("base64"), mimeType: "image/jpeg" });
      }
      return { content: [{ type: "text", text: JSON.stringify({ itemId: id, title: item.title, count: all.length, images: meta }) }, ...content] };
    }
  );

  server.registerTool(
    "get_concept_map",
    {
      description:
        "One concept map by id: prompt terms, the professor's model answer/comment, score, the linked notebook notesPageIds and notesDigest (what the owner's own lecture notes define for each concept vs the professor's wording, leading questions with his answers, prompt terms missing from the notes, conflicts) — null until a digest was built.",
      inputSchema: { id: oid },
      annotations: READ,
    },
    async ({ id }) => fromInvoked(await run(getConceptMap, { params: { id } }, "get_concept_map"))
  );

  server.registerTool(
    "search",
    { description: "Search everything the owner has: item titles + bodies, notebook page titles + text, question stems + tags. Case-insensitive substring.", inputSchema: { q: z.string().min(1).max(200) }, annotations: READ },
    async ({ q }) => fromInvoked(await run(search, { query: { q } }, "search"))
  );

  server.registerTool(
    "get_transcript",
    {
      description: "Transcript of a video item (itemId) or a recorded lecture (lectureId): `[mm:ss] text` lines plus summary and key points. transcriptStatus none/pending/failed means there is no transcript yet.",
      inputSchema: { itemId: oid.optional(), lectureId: oid.optional() },
      annotations: READ,
    },
    async ({ itemId, lectureId }) => {
      if (!!itemId === !!lectureId) return toolError("Pass exactly one of itemId or lectureId", "VALIDATION_ERROR");
      if (itemId) {
        const r = await run(getVideoTranscript, { params: { itemId } }, "get_transcript");
        return fromInvoked(r, (x) => {
          const { segments, ...meta } = x.body ?? {};
          return { ...meta, ...transcriptText(segments) };
        });
      }
      const r = await run(getLecture, { params: { id: lectureId! } }, "get_transcript");
      return fromInvoked(r, (x) => {
        const l = x.body ?? {};
        return {
          lectureId: l.id,
          classId: l.classId,
          title: l.title,
          startedAt: l.startedAt,
          durationSec: l.durationSec,
          status: l.status,
          summary: l.summary ?? null,
          keyPoints: l.keyPoints ?? [],
          ...(l.transcript ? transcriptText(l.transcript.segments) : { text: null, truncated: false }),
        };
      });
    }
  );

  server.registerTool(
    "get_assignments",
    {
      description:
        "Assignments and quizzes with due dates. status: upcoming (due later, not handed in), due (next 7 days, not handed in), overdue, submitted, graded, missing, all (default upcoming). Optional classId.",
      inputSchema: { classId: oid.optional(), status: z.enum(ASSIGNMENT_STATUSES).optional() },
      annotations: READ,
    },
    async ({ classId, status = "upcoming" }) => {
      let classIds: Types.ObjectId[];
      if (classId) {
        if (!(await ownClass(userId, classId))) return toolError("Class not found", "NOT_FOUND");
        classIds = [new Types.ObjectId(classId)];
      } else classIds = (await listClasses(userId, false)).map((c) => new Types.ObjectId(c.id));
      const now = new Date();
      const rules = todayRules(now);
      const byStatus: Record<string, object> = {
        upcoming: { dueAt: { $gte: now }, "submission.state": { $nin: ["submitted", "graded", "late"] } },
        due: rules.due,
        overdue: rules.overdue,
        submitted: { "submission.state": { $in: ["submitted", "late"] } },
        graded: { "submission.state": "graded" },
        missing: { "submission.state": "missing" },
        all: {},
      };
      const rows = await StudyItem.find({ userId, classId: { $in: classIds }, type: { $in: ["assignment", "quiz"] }, ...byStatus[status] }, LIST_PROJECTION)
        .sort(status === "overdue" || status === "graded" || status === "submitted" ? { dueAt: -1, _id: 1 } : { dueAt: 1, _id: 1 })
        .limit(200)
        .lean<IStudyItem[]>();
      return ok(await itemsDto(rows));
    }
  );

  server.registerTool(
    "get_weak_topics",
    { description: "Weakest question-bank topics (lowest mastery among topics tried at least twice), per class. Optional classId.", inputSchema: { classId: oid.optional() }, annotations: READ },
    async ({ classId }) => {
      if (classId && !(await ownClass(userId, classId))) return toolError("Class not found", "NOT_FOUND");
      const rows = await topicMastery(userId, classId ? { classId: new Types.ObjectId(classId) } : {});
      return ok(rows.filter((t) => t.attempts >= WEAK_TOPIC_MIN_ATTEMPTS).slice(0, 20));
    }
  );

  server.registerTool(
    "get_questions",
    {
      description: "Question-bank questions of a class (newest first), with answers, solution steps, stats and spaced-repetition state. due=true → only reviews due now.",
      inputSchema: { classId: oid, topic: z.string().max(120).optional(), due: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() },
      annotations: READ,
    },
    async ({ classId, topic, due, limit }) => {
      if (!(await ownClass(userId, classId))) return toolError("Class not found", "NOT_FOUND");
      const query: Record<string, unknown> = { classId, limit: String(limit ?? 50) };
      if (topic) query.topic = topic;
      if (due) query.due = "1";
      return fromInvoked(await run(listQuestions, { query }, "get_questions"));
    }
  );

  const questionInput = z.object({
    classId: oid,
    stem: z.string().min(1).max(20_000),
    type: z.enum(["free", "mcq", "code_output", "code_write", "label_image"]).optional(),
    topic: z.string().max(120).optional(),
    subtopic: z.string().max(120).optional(),
    difficulty: z.number().int().min(1).max(5).optional(),
    choices: z.array(z.string().max(2000)).max(10).optional(),
    answer: z.string().max(20_000).optional(),
    solutionSteps: z.array(z.string().max(4000)).max(40).optional(),
    tags: z.array(z.string().max(60)).max(30).optional(),
  });

  const imageInboxId = oid.describe("An inbox item id (an image you uploaded to the owner's Study inbox). It is copied to permanent storage and shown above the question.");
  /** imageInboxId → imageUrl (a copy that does not expire); a bad id fails the whole call before anything is saved. */
  const withImage = async <T extends { imageInboxId?: string }>(q: T): Promise<Omit<T, "imageInboxId"> & { imageUrl?: string }> => {
    const { imageInboxId: id, ...rest } = q;
    return id ? { ...rest, imageUrl: await copyInboxImageToQuestion(userId, id) } : rest;
  };

  server.registerTool(
    "add_questions",
    {
      description:
        "Save questions to the question bank (near-duplicates in the same class are merged — to change a saved question use update_question). mcq: choices without letters, answer = the exact correct choice text. Math as $LaTeX$. imageInboxId attaches a picture (a figure) shown above the question: upload it to the Study inbox first, then pass the inbox item id.",
      inputSchema: { questions: z.array(questionInput.extend({ imageInboxId: imageInboxId.optional() })).min(1).max(100) },
      annotations: WRITE,
    },
    async ({ questions }) => {
      try {
        const body = { questions: await Promise.all(questions.map(async (q) => ({ ...(await withImage(q)), source: { kind: "manual" } }))) };
        return fromInvoked(await run(createQuestions, { body }, "add_questions"));
      } catch (e) {
        if (e instanceof QuestionImageError) return toolError(e.message, e.code);
        throw e;
      }
    }
  );

  server.registerTool(
    "update_question",
    {
      description:
        "Edit a saved question by id (from get_questions / add_questions): send only what changes — stem, type, topic, subtopic, difficulty, choices, answer, solutionSteps, tags, bookmarked (pins it under Bookmarked in Flashcards). imageInboxId replaces its picture with a copy of that inbox image; removeImage: true clears it. Returns the updated question.",
      inputSchema: {
        id: oid,
        stem: questionInput.shape.stem.optional(),
        type: questionInput.shape.type,
        topic: questionInput.shape.topic,
        subtopic: questionInput.shape.subtopic,
        difficulty: questionInput.shape.difficulty,
        choices: questionInput.shape.choices,
        answer: questionInput.shape.answer,
        solutionSteps: questionInput.shape.solutionSteps,
        tags: questionInput.shape.tags,
        bookmarked: z.boolean().optional(),
        imageInboxId: imageInboxId.optional(),
        removeImage: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    async ({ id, removeImage, ...fields }) => {
      if (removeImage && fields.imageInboxId) return toolError("Send imageInboxId or removeImage, not both", "VALIDATION_ERROR");
      try {
        const body: Record<string, unknown> = await withImage(fields);
        if (removeImage) body.imageUrl = "";
        return fromInvoked(await run(patchQuestion, { params: { id }, body }, "update_question"));
      } catch (e) {
        if (e instanceof QuestionImageError) return toolError(e.message, e.code);
        throw e;
      }
    }
  );

  server.registerTool(
    "create_flashcards",
    {
      description:
        "Generate question-bank flashcards (spaced repetition) from the owner's material: from.itemId (a Canvas page/assignment/quiz/file or a transcribed video), from.lectureId (a transcribed lecture) or from.pageId (a notebook page with text). classId defaults to the source's class.",
      inputSchema: {
        from: z.object({ itemId: oid.optional(), lectureId: oid.optional(), pageId: oid.optional() }),
        classId: oid.optional(),
        count: z.number().int().min(1).max(FLASHCARDS_MAX).optional(),
      },
      annotations: WRITE,
    },
    async ({ from, classId, count }) => {
      const r = await run(flashcards, { body: { ...from, ...(classId ? { classId } : {}), ...(count ? { count } : {}) } }, "create_flashcards");
      return fromInvoked(r, (x) => {
        const qs = x.events.filter((e) => e.event === "question").map((e) => ({ id: e.data?.id, topic: e.data?.topic, type: e.data?.type, stem: String(e.data?.stem ?? "").slice(0, 300) }));
        const done = x.events.find((e) => e.event === "done")?.data ?? {};
        return { created: qs.length, ...done, questions: qs };
      });
    }
  );

  server.registerTool(
    "start_quiz",
    {
      description: "Start a quiz from a class's question bank: due reviews and the weakest topics first, then new cards. Returns questions WITHOUT answers; answer each with answer_quiz.",
      inputSchema: { classId: oid, topic: z.string().max(120).optional(), count: z.number().int().min(1).max(20).optional() },
      annotations: WRITE,
    },
    async ({ classId, topic, count = 5 }) => {
      if (!(await ownClass(userId, classId))) return toolError("Class not found", "NOT_FOUND");
      const cls = new Types.ObjectId(classId);
      const sameTopic = (q: IStudyQuestion) => !topic || q.topic.toLowerCase() === topic.toLowerCase();
      const picked = (await reviewNext(userId, cls, REVIEW_MAX)).filter(sameTopic).slice(0, count);
      if (picked.length < count) {
        const filter: Record<string, unknown> = { userId, classId: cls, _id: { $nin: picked.map((q) => q._id) } };
        if (topic) filter.topic = { $regex: `^${topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" };
        picked.push(...(await StudyQuestion.find(filter, { shingles: 0 }).sort({ "stats.mastery": 1, _id: 1 }).limit(count - picked.length).lean<IStudyQuestion[]>()));
      }
      if (!picked.length) return toolError(topic ? `No questions on "${topic}" in this class` : "This class has no questions yet", "EMPTY");
      const quiz = await StudyMcpQuiz.create({ userId, classId: cls, topic: topic ?? null, questionIds: picked.map((q) => q._id), expiresAt: new Date(Date.now() + 24 * 3600e3) });
      return ok({ quizId: String(quiz._id), total: picked.length, questions: picked.map(quizQuestion) });
    }
  );

  server.registerTool(
    "answer_quiz",
    {
      description: "Answer one question of a quiz started with start_quiz. Graded like the app (mcq/code output exactly, other types by the model); the result updates mastery and the spaced-repetition schedule. Returns the verdict and the correct answer.",
      inputSchema: { quizId: oid, questionId: oid, answer: z.string().min(1).max(50_000) },
      annotations: WRITE,
    },
    async ({ quizId, questionId, answer }) => {
      const quiz = await StudyMcpQuiz.findOne({ _id: quizId, userId }).lean<IStudyMcpQuiz>();
      if (!quiz) return toolError("Quiz not found or expired", "NOT_FOUND");
      if (!quiz.questionIds.some((id) => String(id) === questionId)) return toolError("That question is not part of this quiz", "VALIDATION_ERROR");
      if (quiz.answers.some((a) => String(a.questionId) === questionId)) return toolError("That question was already answered in this quiz", "ALREADY_ANSWERED");
      const q = await StudyQuestion.findOne({ _id: questionId, userId }, { shingles: 0 }).lean<IStudyQuestion>();
      if (!q) return toolError("Question not found", "NOT_FOUND");
      const asChoice = q.type === "mcq" && correctChoiceIndex(q) !== null && studentChoiceIndex(q, answer) !== null;
      const r = await run(attemptQuestion, { params: { id: questionId }, body: asChoice ? { choice: answer } : { typed: answer } }, "answer_quiz");
      if (r.status >= 400 || r.events.some((e) => e.event === "error")) return fromInvoked(r);
      const verdict = r.events.find((e) => e.event === "verdict")?.data;
      const done = r.events.find((e) => e.event === "done")?.data ?? {};
      if (!verdict) return toolError("Grading did not finish", "AI_FAILED");
      const after = await StudyMcpQuiz.findOneAndUpdate(
        { _id: quiz._id, userId, "answers.questionId": { $ne: q._id } },
        { $push: { answers: { questionId: q._id, result: verdict.result } } },
        { new: true }
      ).lean<IStudyMcpQuiz>();
      const answers = after?.answers ?? quiz.answers;
      return ok({
        result: verdict.result,
        steps: verdict.steps,
        firstErrorStep: verdict.firstErrorStep,
        hint: verdict.hint,
        correctAnswer: q.answer || null,
        solutionSteps: q.solutionSteps ?? [],
        stats: done.stats ?? null,
        srs: done.srs ?? null,
        progress: { answered: answers.length, total: quiz.questionIds.length, right: answers.filter((a) => a.result === "right").length },
      });
    }
  );

  server.registerTool(
    "explain_mistake",
    { description: "Explain a question-bank question step by step — why the reference answer is right and, if studentAnswer is given, where that answer goes wrong.", inputSchema: { questionId: oid, studentAnswer: z.string().max(20_000).optional() }, annotations: READ },
    async ({ questionId, studentAnswer }) => {
      if (!(await aiEnabledFor(userId))) return noAi();
      const q = await StudyQuestion.findOne({ _id: questionId, userId }, { shingles: 0 }).lean<IStudyQuestion>();
      if (!q) return toolError("Question not found", "NOT_FOUND");
      try {
        return ok({ questionId, ...(await explainMistake(q, studentAnswer?.trim() || null)) });
      } catch (e) {
        const c = classifyAiError(e);
        await logAiFailure("study mcp ai step failed", e, {}, c.code);
        return toolError(c.message, c.code);
      }
    }
  );

  server.registerTool(
    "create_study_plan",
    {
      description: "Draft a day-by-day study plan from today until a date (max 120 days), from real deadlines, weak topics and due reviews. Optional classIds limits it to some classes. Not saved.",
      inputSchema: { until: dateStr, classIds: z.array(oid).max(30).optional() },
      annotations: READ,
    },
    async ({ until, classIds }) => {
      if (!(await aiEnabledFor(userId))) return noAi();
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const untilEnd = new Date(`${until}T23:59:59.999Z`);
      if (Number.isNaN(untilEnd.getTime()) || until < today) return toolError("until must be today or later (YYYY-MM-DD)", "VALIDATION_ERROR");
      if (untilEnd.getTime() - now.getTime() > 120 * 86400e3) return toolError("until can be at most 120 days ahead", "VALIDATION_ERROR");
      let classes = (await listClasses(userId, false)).map((c) => ({ id: c.id, name: c.name }));
      if (classIds?.length) {
        const owned = await StudyClass.find({ _id: { $in: classIds }, userId }, { name: 1 }).lean();
        if (owned.length !== new Set(classIds).size) return toolError("Class not found", "NOT_FOUND");
        classes = owned.map((c: any) => ({ id: String(c._id), name: c.name }));
      }
      if (!classes.length) return toolError("No classes to plan for", "EMPTY");
      const ids = classes.map((c) => new Types.ObjectId(c.id));
      const rules = todayRules(now);
      const [upcoming, overdue, bank] = await Promise.all([
        StudyItem.find({ userId, classId: { $in: ids }, type: { $in: ["assignment", "quiz"] }, dueAt: { $gte: now, $lte: untilEnd }, "submission.state": { $nin: ["submitted", "graded", "late"] } }, LIST_PROJECTION)
          .sort({ dueAt: 1 })
          .limit(150)
          .lean<IStudyItem[]>(),
        StudyItem.find({ userId, classId: { $in: ids }, ...rules.overdue }, LIST_PROJECTION).sort({ dueAt: -1 }).limit(50).lean<IStudyItem[]>(),
        todayReview(userId, ids, now),
      ]);
      const assignments = [...overdue, ...upcoming].map((i) => ({
        itemId: String(i._id),
        classId: String(i.classId),
        title: i.title,
        type: i.type,
        dueAt: i.dueAt ? new Date(i.dueAt).toISOString() : null,
        points: i.points ?? null,
        state: i.submission?.state ?? null,
      }));
      try {
        const plan = await buildStudyPlan(userId, { today, until, classes, assignments, weakTopics: bank.weakTopics, review: bank.review });
        return ok({ until, ...plan });
      } catch (e) {
        const c = classifyAiError(e);
        await logAiFailure("study mcp ai step failed", e, {}, c.code);
        return toolError(c.message, c.code);
      }
    }
  );

  server.registerTool(
    "add_note_page",
    {
      description: "Create a typed notebook page (kind note) in a class, or with no class (omit classId) for a plain note. The markdown is stored as the page's text (searchable; usable by create_flashcards). The handwriting board starts empty.",
      inputSchema: { classId: oid.optional(), title: z.string().min(1).max(200), markdown: z.string().min(1).max(200_000) },
      annotations: WRITE,
    },
    async ({ classId, title, markdown }) => {
      const created = await run(createPage, { body: { classId: classId ?? null, title, kind: "note" } }, "add_note_page");
      if (created.status !== 201) return fromInvoked(created);
      const text = await run(putPageOcr, { params: { id: created.body.id }, body: { text: markdown } }, "add_note_page");
      if (text.status >= 400) return fromInvoked(text);
      return ok({ ...created.body, textChars: markdown.trim().length });
    }
  );

  server.registerTool(
    "create_lecture_pdf",
    {
      description:
        "Render a lecture slide deck PDF (one slide per page) in the professor's style and open it in the owner's notebook as an annotatable PDF (pen ink per page), filed under the lecture (week + lecture {number,key,date}). Default look: 4:3, Source Sans 3, centred title + optional subtitle, part label top-right, an empty dashed NOTES strip on the right for the pen, footer «CLASS · Lecture N · Title» + page number. Slides: kind 'content' (default) or 'divider' (opens a part: part label, big title, bullets as the part's agenda, images[0] as a full-height photo). Content slide fields: title, subtitle, part, bullets, markdown body (> quote = callout; math as $LaTeX$ text), cards [{title?, text}], callout {label?, text}, table {head, rows, highlightRow?}, flow (rows of boxes joined by arrows), images [{url, caption?, credit?, fit?}] and svg (+ svgCaption). Image urls: the owner's own inbox uploads (inbox item id or our media url), a Canvas page figure ref (canvas-image:<id>, from get_item_images), or an https url on an open-license host — upload.wikimedia.org, thumb.wikimedia.org (search/imageinfo thumbnails), commons.wikimedia.org, or *.usgs.gov / *.nasa.gov / *.noaa.gov / *.nps.gov — which then REQUIRES credit (author, licence, source); those are fetched (≤ 8 MB, PNG/JPEG/GIF/WebP, ≤ 3 redirects on allowed hosts) and re-encoded to JPEG ≤ 1600 px. Prefer direct file urls (upload.wikimedia.org/… or a thumb.wikimedia.org thumbnail), not description pages (commons.wikimedia.org/wiki/File:… is an HTML page and fails). Anything else is refused, and a fetch that fails fails the deck. filled = source label → [F] pill «Filled in from …» for content you added that the professor's slides lack. notes = speaker notes (kept in the deck outline, not drawn). Body text stays ≥ 20px, so warnings name slides whose content overflows — split those. A slide with only a title (+ subtitle) renders as a title slide. style overrides page/fonts/colors/sizes/notes strip/footer. Use get_lecture_material first to fill gaps from the lecture's own material.",
      inputSchema: {
        classId: oid,
        title: z.string().trim().min(1).max(200),
        lecture: pageLecture.optional(),
        week: week.optional(),
        slides: z.array(deckSlideSchema).min(1).max(DECK_MAX_SLIDES),
        style: deckStyleSchema.optional(),
      },
      annotations: WRITE,
    },
    async ({ classId, title, lecture, week: wk, slides, style }) => {
      const cls = await StudyClass.findOne({ _id: classId, userId }).lean<IStudyClass>();
      if (!cls) return toolError("Class not found", "NOT_FOUND");
      let media: Awaited<ReturnType<typeof prepareMedia>>;
      try {
        media = await prepareMedia(userId, slides);
      } catch (e) {
        if (e instanceof DeckInputError) return toolError(e.message, e.code);
        throw e;
      }
      const meta = { title, className: cls.code || cls.name || null, lecture: lecture ?? null };
      const deckStyle = mergeDeckStyle(style);
      let pdf: Buffer;
      let overflow: number[];
      let pages: number;
      try {
        ({ pdf, overflow } = await renderDeckPdf(buildDeckHtml(meta, slides, media, deckStyle), deckStyle.page));
        pages = await pdfPageCount(pdf);
      } catch (e) {
        await logger.warn("study mcp: lecture pdf render failed", { error: String((e as Error)?.message ?? e).slice(0, 300) });
        return toolError("The PDF could not be rendered", "RENDER_FAILED");
      }
      if (pages !== slides.length) return toolError(`Rendered ${pages} pages for ${slides.length} slides`, "RENDER_FAILED");

      const r = await createGeneratedPdfPage(ownerId, cls, pdf, { title, week: wk, lecture, html: deckOutlineHtml(meta, slides), label: "create_lecture_pdf" });
      if (!r.ok) return fromInvoked(r.invoked);
      return ok({ pageId: r.pageId, itemId: r.itemId, pdfUrl: r.pdfUrl, expiresAt: r.expiresAt, pages, page: r.page, warnings: overflow.map((n) => `slide ${n}: content overflows the slide (clipped) — split it or cut text`) });
    }
  );

  server.registerTool(
    "render_pdf_to_inbox",
    {
      description:
        "Render a document (markdown OR html, exactly one) to a PDF and drop it in the owner's Study inbox, where he adds it to his notes from the tablet. Use this whenever the owner asks for a PDF of something you wrote. markdown: headings, lists, quotes, code fences, tables as preformatted text; math stays as written ($LaTeX$ text); the title is printed on top. html: printed as given (the title is NOT added — put your own heading in), a fragment (gets a clean print style) or a full document with its own <style>/@page. The renderer loads NOTHING over the network and runs no scripts — inline images/fonts as data: URIs; any http(s) src is simply missing. The owner's inbox images (e.g. from generate_image) go in as src=\"inbox:<inboxItemId>\" (html) or ![alt](inbox:<inboxItemId>) (markdown), and Canvas page figures as src=\"canvas-image:<id>\" / ![alt](canvas-image:<id>) (refs from get_item_images); up to 30 images. page: A4 (default, portrait), Letter, 16:9 (13.333×7.5 in), 4:3 (10×7.5 in). With classId + asPage: true it skips the inbox and opens the PDF directly as a NEW annotatable notebook page in that class (returns pageId). With pageId (an existing notebook page, from search) the PDF is queued for that page instead: the tablet appends its pages to that note the next time it opens.",
      inputSchema: {
        title: z.string().trim().min(1).max(200),
        markdown: z.string().min(1).max(200_000).optional(),
        html: z.string().min(1).max(500_000).optional(),
        classId: oid.optional(),
        note: z.string().trim().max(500).optional(),
        page: z.enum(Object.keys(DOC_PAGE_SIZES) as [DocPageSize, ...DocPageSize[]]).optional(),
        asPage: z.boolean().optional(),
        pageId: oid.optional(),
      },
      annotations: WRITE,
    },
    async ({ title, markdown, html, classId, note, page, asPage, pageId }) => {
      if ((markdown === undefined) === (html === undefined)) return toolError("Pass exactly one of markdown or html", "VALIDATION_ERROR");
      if (asPage && !classId) return toolError("asPage needs classId", "VALIDATION_ERROR");
      if (asPage && pageId) return toolError("Pass asPage (a new page) or pageId (an existing page), not both", "VALIDATION_ERROR");
      const cls = classId ? await StudyClass.findOne({ _id: classId, userId }).lean<IStudyClass>() : null;
      if (classId && !cls) return toolError("Class not found", "NOT_FOUND");
      let target: Awaited<ReturnType<typeof validatePageTarget>> | null = null;
      if (pageId) {
        try {
          target = await validatePageTarget(userId, pageId);
        } catch (e) {
          if (e instanceof InboxError) return toolError(e.message, e.code);
          throw e;
        }
      }
      let pdf: Buffer;
      let pages: number;
      try {
        ({ pdf, pages } = await renderDocumentPdf({ title, page: page ?? "A4", html, markdown }, userId));
      } catch (e) {
        if (e instanceof DeckInputError) return toolError(e.message, e.code);
        await logger.warn("study mcp: document pdf render failed", { error: String((e as Error)?.message ?? e).slice(0, 300) });
        return toolError("The PDF could not be rendered", "RENDER_FAILED");
      }
      if (asPage && cls) {
        const r = await createGeneratedPdfPage(ownerId, cls, pdf, { title, html: markdown !== undefined ? markdownToHtml(markdown) : undefined, label: "render_pdf_to_inbox" });
        if (!r.ok) return fromInvoked(r.invoked);
        return ok({ pageId: r.pageId, itemId: r.itemId, pages, bytes: pdf.length, url: r.pdfUrl, expiresAt: r.expiresAt, page: r.page });
      }
      try {
        const item = await createInboxItem(userId, pdf, { note: note || title, classId: cls?._id ?? target?.classId ?? null, pageId: target?._id ?? null, tokenId: null, source: await source() });
        return ok({ inboxItemId: item.id, pageId: item.pageId, pages, bytes: item.bytes, url: item.url, expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SEC * 1000).toISOString() });
      } catch (e) {
        if (e instanceof InboxError || e instanceof InboxMediaError) return toolError(e.message, e.code);
        throw e;
      }
    }
  );

  server.registerTool(
    "generate_image",
    {
      description:
        "Generate ONE illustration with an AI image model (GPT Image 2.5 Flare, Sunburst as fallback; ~$0.01 each, 20–60 s) and save it to the owner's Study inbox. Returns inboxItemId plus a small preview so you can check it before using it. Use the id in create_lecture_pdf images[].url (credit: \"AI-generated\"), or in render_pdf_to_inbox as <img src=\"inbox:<id>\"> (html) / ![alt](inbox:<id>) (markdown). Prompt for a picture with NO text, labels or numbers in it — image models misspell; put labels in the slide/document text or an svg instead. Describe subject, style (clean textbook illustration, flat diagram, photo-real…), background and framing. shape: landscape 1536×1024 (default, slides), portrait 1024×1536, square 1024×1024. Only images that teach something — at most ~8 per document.",
      inputSchema: {
        prompt: z.string().trim().min(3).max(4000),
        shape: z.enum(Object.keys(IMAGE_SIZES) as [ImageShape, ...ImageShape[]]).optional(),
        note: z.string().trim().max(500).optional(),
        classId: oid.optional(),
      },
      annotations: WRITE,
    },
    async ({ prompt, shape, note, classId }) => {
      if (!(await premiumAiFor(userId))) return noAi(); // image generation: premium only
      if (classId && !(await StudyClass.exists({ _id: classId, userId }))) return toolError("Class not found", "NOT_FOUND");
      const spend = newSpend("premium", userId);
      const startedAt = Date.now();
      let image: Buffer;
      let model: string;
      try {
        ({ image, model } = await imageGen(prompt, shape ?? "landscape", spend));
      } catch (e) {
        const c = classifyAiError(e, { code: "AI_FAILED", message: "The image could not be generated — try again or rephrase the prompt" });
        await recordStudyUsage(userId, "image_gen", spend, startedAt, "error", { error: String((e as Error)?.message ?? e), errorCode: c.code });
        await logAiFailure("study mcp: image generation failed", e, {}, c.code);
        return toolError(c.message, c.code);
      }
      await recordStudyUsage(userId, "image_gen", spend, startedAt, "done");
      try {
        const item = await createInboxItem(userId, image, { note: note || `AI image: ${prompt.slice(0, 200)}`, classId: classId ? new Types.ObjectId(classId) : null, tokenId: null, source: await source() });
        const preview = await sharp(image).resize(512, 512, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                inboxItemId: item.id,
                width: item.width,
                height: item.height,
                bytes: item.bytes,
                model,
                costUsd: Number((spend.imageCostUsd ?? 0).toFixed(6)),
                url: item.url,
                use: { deck: { url: item.id, credit: "AI-generated" }, html: `<img src="inbox:${item.id}">`, markdown: `![](inbox:${item.id})` },
              }),
            },
            { type: "image", data: preview.toString("base64"), mimeType: "image/jpeg" },
          ],
        };
      } catch (e) {
        if (e instanceof InboxError || e instanceof InboxMediaError) return toolError(e.message, e.code);
        throw e;
      }
    }
  );

  server.registerTool(
    "get_inbox_upload_link",
    {
      description:
        "For a file you already have on disk (Claude Code, or any client with a shell): returns a one-shot upload link to the owner's Study inbox plus a ready-to-run curl — replace <PATH> with the file. Photos (JPEG/PNG/WebP/HEIC) and PDFs, ≤ 25 MB. The link works ONCE and expires after 15 minutes; note/classId given here are applied to the upload. pageId (an existing notebook page, from search) queues the upload for that note: the tablet appends it there the next time the page opens. Get a fresh link per file. To send a document you are writing, use render_pdf_to_inbox instead.",
      inputSchema: { note: z.string().trim().max(500).optional(), classId: oid.optional(), pageId: oid.optional() },
      annotations: WRITE,
    },
    async ({ note, classId, pageId }) => {
      try {
        const meta = await validateMeta(userId, note, classId, pageId);
        const { token, expiresAt } = await createUploadLink(userId, meta);
        const url = `${base}/study/inbox`;
        return ok({ url, expiresAt, curl: `curl -sS -H 'Authorization: Bearer ${token}' -F 'file=@<PATH>' '${url}'` });
      } catch (e) {
        if (e instanceof InboxError || e instanceof InboxTokenError) return toolError(e.message, e.code);
        throw e;
      }
    }
  );

  server.registerTool(
    "list_inbox",
    {
      description:
        "The owner's Study inbox (photos/PDFs from the phone, upload links and render_pdf_to_inbox), newest 50 first: id, kind, note, classId, pageId (the page it is queued for), createdAt, usedAt (null = not placed yet). since = ISO time, only newer items. includeUsed false (default true) hides items already placed.",
      inputSchema: { since: z.string().datetime({ offset: true }).optional(), includeUsed: z.boolean().optional() },
      annotations: READ,
    },
    async ({ since, includeUsed }) => {
      const items = await listInboxItems(userId, since);
      return ok({
        items: items
          .filter((i) => includeUsed !== false || !i.usedAt)
          .map((i) => ({ id: i.id, kind: i.kind, note: i.note, classId: i.classId, pageId: i.pageId, createdAt: i.createdAt, usedAt: i.usedAt })),
      });
    }
  );

  server.registerTool(
    "add_inbox_to_page",
    {
      description:
        "File items already in the owner's Study inbox (photos or PDFs, ids from list_inbox or render_pdf_to_inbox) into an EXISTING notebook page — find the page's id with search (pages[].id). The tablet owns the page's ink, so this queues them: the next time that page opens, the notebook appends each PDF's pages to the end of the note and places each photo, oldest upload first, then marks them used. An item already placed elsewhere is queued again for this page. Returns the queued items and any ids that were not found.",
      inputSchema: { pageId: oid, inboxItemIds: z.array(oid).min(1).max(20) },
      annotations: WRITE,
    },
    async ({ pageId, inboxItemIds }) => {
      try {
        const r = await queueInboxItemsForPage(userId, pageId, inboxItemIds);
        if (!r.items.length) return toolError("None of those inbox items were found", "NOT_FOUND");
        return ok({
          page: { id: String(r.page._id), title: r.page.title, kind: r.page.kind, classId: r.page.classId ? String(r.page.classId) : null },
          queued: r.items.map((i) => ({ inboxItemId: i.id, kind: i.kind, note: i.note })),
          notFound: r.notFound,
        });
      } catch (e) {
        if (e instanceof InboxError) return toolError(e.message, e.code);
        throw e;
      }
    }
  );

  server.registerTool(
    "get_lecture_material",
    {
      description:
        "One lecture's material as text, to fill gaps before create_lecture_pdf or to study: the week module's slides (PDF text) and Canvas pages, the lecture's video transcripts and that day's recordings, and the owner's notes pages for it. Pick the lecture by lecture {number?, key? ('L8' lecture, 'W8' week, or a date), date? YYYY-MM-DD} and/or week. Returns the resolved scope, the sources included and the packed text (about 200k chars max; slides first, every source keeps a share).",
      inputSchema: {
        classId: oid,
        lecture: z.object({ number: z.number().int().min(1).max(200).optional(), key: z.string().trim().min(1).max(80).optional(), date: realDate.optional() }).strict().optional(),
        week: week.optional(),
      },
      annotations: READ,
    },
    async ({ classId, lecture, week: wk }) => {
      if (!wk && !(lecture && (lecture.number || lecture.key || lecture.date))) return toolError("Pass lecture {number, key or date} or week", "VALIDATION_ERROR");
      const cls = await StudyClass.findOne({ _id: classId, userId }).lean<IStudyClass>();
      if (!cls) return toolError("Class not found", "NOT_FOUND");
      const r = await getLectureMaterial(userId, cls, { lecture, week: wk });
      const s = r.scope;
      const scope = { week: s.week, number: s.number, key: s.key, date: s.date, moduleId: s.moduleId ? String(s.moduleId) : null, moduleName: s.moduleName, timeZone: s.timeZone };
      if (!r.sources.length) return toolError(`No material found for that lecture (resolved scope: ${JSON.stringify(scope)})`, "NO_MATERIAL");
      return ok({ scope, sources: r.sources, truncated: r.truncated, text: r.text });
    }
  );

  // ─── notebook boards: what the owner WROTE (client renders of each board page) ───────────

  const ownNotebook = (pageId: string) => StudyPage.findOne({ _id: pageId, userId, deletedAt: null }).lean<IStudyPage>();
  const pageNumbers = z.array(z.number().int().min(1).max(500)).min(1).max(NOTEBOOK_PDF_MAX_PAGES);

  server.registerTool(
    "list_notebook_pages",
    {
      description:
        "The owner's handwritten notebook pages (boards), newest 50 first: id, title, classId, kind, week, lecture, updatedAt, version, renderedPages (board pages with an image) and rendersStale (some images are older than the latest ink). classId/week filter; query matches title + handwriting text. Read one with get_notebook_page.",
      inputSchema: { classId: oid.optional(), query: z.string().trim().min(1).max(200).optional(), week: week.optional() },
      annotations: READ,
    },
    async ({ classId, query, week: wk }) => {
      const filter: Record<string, unknown> = { userId, deletedAt: null };
      if (classId) filter.classId = new Types.ObjectId(classId);
      if (wk) filter.week = wk;
      if (query) {
        const rx = { $regex: escapeRegex(query), $options: "i" };
        filter.$or = [{ title: rx }, { ocrText: rx }];
      }
      const rows = await StudyPage.find(filter, { ocrText: 0, annotations: 0 }).sort({ updatedAt: -1, _id: 1 }).limit(50).lean<IStudyPage[]>();
      return ok(
        rows.map((p) => {
          const { thumbUrl: _t, itemId: _i, moduleId: _m, lectureId: _l, ...dto } = pageDto(p);
          return { ...dto, renderedPages: p.renders?.length ?? 0, rendersStale: (p.renders ?? []).some((r) => r.version < (p.version ?? 0)) };
        })
      );
    }
  );

  server.registerTool(
    "get_notebook_page",
    {
      description:
        "SEE a handwritten notebook page: returns each board page as an IMAGE (the owner's pen ink over its PDF/paper background, as he sees it on the tablet) plus a JSON block with the page's stored text (handwriting OCR or typed markdown) and pageCount. Use it to grade solutions, check answers, read diagrams. pages = 1-based board page numbers (\"page 3\" = 3); default the first 4, max 10 per call — ask for the rest by number. missing = pages never rendered (the tablet has not synced them yet); stale = images older than the latest ink. Find pageId with list_notebook_pages or search.",
      inputSchema: { pageId: oid, pages: z.array(z.number().int().min(1).max(500)).min(1).max(NOTEBOOK_MAX_PAGES).optional() },
      annotations: READ,
    },
    async ({ pageId, pages }) => {
      const page = await ownNotebook(pageId);
      if (!page) return toolError("Notebook page not found", "NOT_FOUND");
      const pageCount = notebookPageCount(page);
      const byPage = rendersByPage(page);
      const wanted = pages ? [...new Set(pages)].sort((a, b) => a - b) : Array.from({ length: Math.min(pageCount, NOTEBOOK_DEFAULT_PAGES) }, (_, i) => i + 1);
      const images: { type: "image"; data: string; mimeType: string }[] = [];
      const returned: number[] = [];
      const missing: number[] = [];
      const stale: number[] = [];
      const skipped: number[] = [];
      let bytes = 0;
      for (const n of wanted) {
        const r = byPage.get(n);
        if (!r) {
          missing.push(n);
          continue;
        }
        if (bytes >= NOTEBOOK_MAX_IMAGE_BYTES) {
          skipped.push(n);
          continue;
        }
        const { data } = await renderJpeg(r, MCP_IMAGE_MAX_EDGE, 80);
        bytes += data.length;
        images.push({ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
        returned.push(n);
        if (r.version < (page.version ?? 0)) stale.push(n);
      }
      const rest = Array.from({ length: pageCount }, (_, i) => i + 1).filter((n) => !wanted.includes(n));
      const hint = skipped.length
        ? `Size cap reached: request pages ${skipped.join(", ")} in another call.`
        : rest.length
          ? `${rest.length} more board page(s) not shown (${rest.slice(0, 20).join(", ")}${rest.length > 20 ? ", …" : ""}); pass pages:[…] to see them (max ${NOTEBOOK_MAX_PAGES} per call).`
          : null;
      const { thumbUrl: _t, ...dto } = pageDto(page);
      const meta = { ...dto, rulers: rulersDto(page.rulers), pageCount, returned, missing, stale, ...(skipped.length ? { skipped } : {}), text: page.ocrText ?? null, hint };
      if (!images.length && !meta.text)
        return toolError(pageCount ? "None of those board pages has an image yet — the tablet uploads them after it syncs" : "This page has no rendered board pages yet — open it on the tablet so it syncs", "NOT_RENDERED");
      return { content: [{ type: "text", text: JSON.stringify(meta) }, ...images] };
    }
  );

  server.registerTool(
    "export_notebook_pdf",
    {
      description:
        "Export a handwritten notebook page as a PDF built from its board page images (one PDF page per board page, at its own aspect ratio). pages = 1-based board page numbers (default all rendered). Returns a download url (valid 1 hour); toInbox: true also drops the PDF in the owner's Study inbox. missing = board pages with no image yet (left out).",
      inputSchema: { pageId: oid, pages: pageNumbers.optional(), toInbox: z.boolean().optional() },
      annotations: WRITE,
    },
    async ({ pageId, pages, toInbox }) => {
      const page = await ownNotebook(pageId);
      if (!page) return toolError("Notebook page not found", "NOT_FOUND");
      const byPage = rendersByPage(page);
      const pageCount = notebookPageCount(page);
      const wanted = pages ? [...new Set(pages)].sort((a, b) => a - b) : Array.from({ length: pageCount }, (_, i) => i + 1);
      const missing = wanted.filter((n) => !byPage.has(n));
      const included = wanted.filter((n) => byPage.has(n));
      if (!included.length) return toolError("None of those board pages has an image yet — the tablet uploads them after it syncs", "NOT_RENDERED");
      const title = page.title || "Notebook";
      let pdf: Buffer;
      try {
        pdf = await notebookPdf(included.map((n) => byPage.get(n)!), title);
      } catch (e) {
        await logger.warn("study mcp: notebook pdf failed", { error: String((e as Error)?.message ?? e).slice(0, 300) });
        return toolError("The PDF could not be built", "RENDER_FAILED");
      }
      if (toInbox) {
        try {
          const item = await createInboxItem(userId, pdf, { note: title, classId: page.classId ?? null, tokenId: null, source: await source() });
          return ok({ url: item.url, expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SEC * 1000).toISOString(), pages: included, bytes: pdf.length, missing, inboxItemId: item.id });
        } catch (e) {
          if (e instanceof InboxError || e instanceof InboxMediaError) return toolError(e.message, e.code);
          throw e;
        }
      }
      const key = studyFileKey(ownerId, "pdf");
      await putStudyObject(key, pdf, "application/pdf");
      const { url, expiresAt } = await signedGetUrl(key, { contentType: "application/pdf" });
      return ok({ url, expiresAt, pages: included, bytes: pdf.length, missing });
    }
  );

  server.registerTool(
    "annotate_notebook_page",
    {
      description:
        "Leave feedback ON a handwritten notebook page (grading, corrections, hints) — the owner sees it on that board page in the app. page = 1-based board page number; markdown (math as $LaTeX$). Returns annotationId.",
      inputSchema: { pageId: oid, page: z.number().int().min(1).max(500), markdown: z.string().trim().min(1).max(8000) },
      annotations: WRITE,
    },
    async ({ pageId, page: n, markdown }) => {
      const annotation = { _id: new Types.ObjectId(), page: n, markdown, author: "claude" as const, createdAt: new Date() };
      const r = await StudyPage.updateOne(
        { _id: pageId, userId, deletedAt: null, "annotations.199": { $exists: false } },
        { $push: { annotations: annotation } },
        { timestamps: false }
      );
      if (!r.matchedCount) {
        const exists = await StudyPage.exists({ _id: pageId, userId, deletedAt: null });
        return exists ? toolError("This page already has 200 annotations — the owner should clear some first", "LIMIT") : toolError("Notebook page not found", "NOT_FOUND");
      }
      return ok({ annotationId: String(annotation._id), ...annotationDto(annotation) });
    }
  );

  server.registerTool(
    "get_drawing_profile",
    {
      description:
        "The owner's drawing profile: device (Galaxy Tab S9 Ultra), ruler calibration, board units per paper mm, usable page size in mm, pen line modes, the notebook PAPER ruling (lined and grid spacing in mm — every PDF, worksheet or study guide for the notebook must be ruled at exactly that spacing, see paperNote), and the GUIDE for giving real-size drawings (state scale 1:N and vertical exaggeration first; lengths in real mm; angles in degrees counter-clockwise from horizontal; one origin; solid vs dashed; always a scale bar; numbered steps). Call this BEFORE giving or making any drawing.",
      inputSchema: {},
      annotations: READ,
    },
    async () => ok(profileDto(await getOrSeedProfile(userId)))
  );

  server.registerTool(
    "set_paper_settings",
    {
      description:
        "Save the owner's notebook paper ruling in mm (lined = space between lines, grid = grid/dot spacing), e.g. when the owner says 'my lined paper is 7.9 mm'. get_drawing_profile returns it as paper, and every PDF or worksheet for the notebook must match it. null clears a value.",
      inputSchema: {
        linedMm: z.number().min(2).max(40).nullable().optional(),
        gridMm: z.number().min(2).max(40).nullable().optional(),
      },
      annotations: WRITE,
    },
    async ({ linedMm, gridMm }) => {
      const paper: Record<string, number | null> = {};
      if (linedMm !== undefined) paper.linedMm = linedMm;
      if (gridMm !== undefined) paper.gridMm = gridMm;
      const parsed = parseProfilePatch({ paper });
      if ("error" in parsed) return toolError(parsed.error, "VALIDATION_ERROR");
      const p = profileDto(await patchProfile(userId, parsed.set));
      return ok({ paper: p.paper });
    }
  );

  server.registerTool(
    "draw_on_notebook_page",
    {
      description: `Draw real ink (not an annotation) on a handwritten notebook board page, in real millimetres. page = 1-based board page (one past the last appends a blank page). origin = 'bottom-left' (default; x right, y UP from the page's bottom-left corner) or 'top-left' (y measured DOWN from the top edge); angles are always degrees counter-clockwise from +x. Page size comes from get_drawing_profile (usablePageMm) or the PDF sheet; every point must fit or nothing is drawn. Shapes (max ${DRAW_MAX_SHAPES}): {type:'line',from:[x,y],to:[x,y]}, {type:'polyline',points:[[x,y],…],closed?}, {type:'arc',center:[x,y],radiusMm,startDeg,endDeg}, {type:'text',at:[x,y] (bottom-left),text,sizeMm?}, {type:'scaleBar',at:[x,y],realLength:'1 km',ratio:25000} (bar = L*1000/N mm with ticks and a label). line/polyline/arc also take dashed?, color? (#rrggbb), widthMm? (0.1–5, default 0.5). Returns drawingId + the stroke ids per shape; undo with delete_notebook_drawing. The tablet shows it after it next syncs; get_notebook_page shows the render once the tablet re-renders.`,
      inputSchema: {
        pageId: oid,
        page: z.number().int().min(1).max(500),
        origin: z.enum(["bottom-left", "top-left"]).optional(),
        shapes: z.array(drawShapeSchema).min(1).max(DRAW_MAX_SHAPES),
      },
      annotations: WRITE,
    },
    async ({ pageId, page, origin, shapes }) => {
      try {
        const profile = await getOrSeedProfile(userId);
        const r = await drawOnPage(userId, pageId, { page, origin, shapes }, profile);
        return ok({ drawingId: r.drawingId, page: r.page, version: r.version, shapes: r.shapes, strokeCount: r.objects.length, note: "Drawn as AI-authored ink; delete_notebook_drawing({pageId, ids:[drawingId]}) removes it." });
      } catch (e) {
        if (e instanceof DrawError) return toolError(e.message, e.code);
        throw e;
      }
    }
  );

  server.registerTool(
    "set_page_ruler",
    {
      description:
        "Set up the owner's on-screen ruler for this page (e.g. after creating a map/quiz) so it opens already fitted: put zeroAt on the map's scale-bar 0, set mapScale so the ruler reads ground distance, and angle along the measured line. Units are paper mm; read get_drawing_profile first. page = 1-based board page; zeroAt = {xMm,yMm} from the page's top-left; pageFactor 0.2..10 (tick spacing over paper scale); angleDeg 0..360; mapScale = N of 1:N; groundUnit ft|m|km|mi. Instead of mapScale you may pass scaleBar {lengthMm, groundLength, groundUnit} (a scale bar drawn on the page: 100 mm = 2400 m → mapScale 24000). Replaces the page's whole preset.",
      inputSchema: {
        pageId: oid,
        page: z.number().int().min(1).max(500),
        ruler: z.object({
          pageFactor: z.number().optional(),
          angleDeg: z.number().optional(),
          zeroAt: z.object({ xMm: z.number(), yMm: z.number() }).optional(),
          mapScale: z.number().optional(),
          groundUnit: z.enum(["ft", "m", "km", "mi"]).optional(),
        }),
        scaleBar: z.object({ lengthMm: z.number(), groundLength: z.number(), groundUnit: z.enum(["ft", "m", "km", "mi"]) }).optional(),
      },
      annotations: WRITE,
    },
    async ({ pageId, page: n, ruler, scaleBar }) => {
      try {
        validatePage(n);
        const fields = parseRuler(ruler, scaleBar);
        const preset = { ...fields, setBy: "claude" as const, updatedAt: new Date() };
        const r = await StudyPage.updateOne({ _id: pageId, userId, deletedAt: null }, { $set: { [`rulers.${n}`]: preset } }, { timestamps: false });
        if (!r.matchedCount) return toolError("Notebook page not found", "NOT_FOUND");
        return ok({ page: n, ruler: rulerDto(preset) });
      } catch (e) {
        if (e instanceof RulerError) return toolError(e.message, e.code);
        throw e;
      }
    }
  );

  server.registerTool(
    "clear_page_ruler",
    {
      description: "Remove the ruler preset for one board page of a notebook page (set_page_ruler's counterpart). page = 1-based board page.",
      inputSchema: { pageId: oid, page: z.number().int().min(1).max(500) },
      annotations: WRITE,
    },
    async ({ pageId, page: n }) => {
      const r = await StudyPage.updateOne({ _id: pageId, userId, deletedAt: null }, { $unset: { [`rulers.${n}`]: "" } }, { timestamps: false });
      if (!r.matchedCount) return toolError("Notebook page not found", "NOT_FOUND");
      return ok({ page: n, cleared: true });
    }
  );

  server.registerTool(
    "delete_notebook_drawing",
    {
      description: "Undo draw_on_notebook_page: removes the ink with the given ids from a notebook page. ids = a drawingId (the whole drawing) and/or individual stroke ids from its result. Returns how many strokes were removed (0 if the owner's tablet re-saved the page and dropped the AI marks, or it was already erased).",
      inputSchema: { pageId: oid, ids: z.array(z.string().min(8).max(64)).min(1).max(500) },
      annotations: WRITE,
    },
    async ({ pageId, ids }) => {
      try {
        const r = await deleteDrawing(userId, pageId, ids);
        return ok(r);
      } catch (e) {
        if (e instanceof DrawError) return toolError(e.message, e.code);
        throw e;
      }
    }
  );

  server.registerTool(
    "get_grades",
    { description: "Current grade per class (score, letter, trend) plus the 50 most recent graded assignments/quizzes.", inputSchema: {}, annotations: READ },
    async () => {
      const classes = await listClasses(userId, false);
      const graded = await StudyItem.find(
        { userId, classId: { $in: classes.map((c) => new Types.ObjectId(c.id)) }, "submission.state": "graded" },
        { title: 1, classId: 1, type: 1, points: 1, submission: 1, dueAt: 1, canvasUpdatedAt: 1 }
      )
        .sort({ canvasUpdatedAt: -1, _id: 1 })
        .limit(50)
        .lean<IStudyItem[]>();
      return ok({
        classes: classes.map((c) => ({ classId: c.id, name: c.name, code: c.code, grade: c.grade })),
        recentGraded: graded.map((i) => ({ itemId: String(i._id), classId: String(i.classId), title: i.title, type: i.type, score: i.submission?.score ?? null, points: i.points ?? null, dueAt: i.dueAt ? new Date(i.dueAt).toISOString() : null })),
      });
    }
  );

  return server;
}
