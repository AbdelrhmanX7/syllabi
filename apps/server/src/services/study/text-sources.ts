import { Types } from "mongoose";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyPage, IStudyPage } from "@/models/study/page";
import { StudyLecture, IStudyLecture } from "@/models/study/lecture";
import { StudyTranscript, IStudyTranscript } from "@/models/study/transcript";
import { QuestionSourceKind } from "@/models/study/question";
import type { QuestionDraft } from "./questions";
import { htmlToText, pdfText } from "./extract-sources";
import { getStudyObject } from "./storage";
import { transcriptText } from "./transcribe";

/**
 * One text source (item / lecture / page) for the text-only AI steps (flashcards, transcript
 * extraction). `missing` = the row is not the caller's → 404; `error` = it exists but has no text
 * yet → an SSE `error` frame with that code.
 */
export type TextSource =
  | { kind: "missing"; what: "Item" | "Lecture" | "Page" | "Library doc" }
  | { kind: "error"; message: string; code: string; classId: Types.ObjectId | null }
  | { kind: "text"; text: string; source: QuestionDraft["source"]; classId: Types.ObjectId | null };

const src = (kind: QuestionSourceKind, ids: { itemId?: Types.ObjectId; pageId?: Types.ObjectId; lectureId?: Types.ObjectId } = {}): QuestionDraft["source"] => ({
  kind,
  itemId: ids.itemId ?? null,
  pageId: ids.pageId ?? null,
  lectureId: ids.lectureId ?? null,
  ref: null,
});

const readyTranscript = (userId: Types.ObjectId, key: { itemId: Types.ObjectId } | { lectureId: Types.ObjectId }) =>
  StudyTranscript.findOne({ userId, ...key, status: "ready" }, { segments: 1 }).lean<IStudyTranscript>();

export async function lectureTextSource(userId: Types.ObjectId, lectureId: string): Promise<TextSource> {
  const lec = await StudyLecture.findOne({ _id: lectureId, userId }, { classId: 1, title: 1 }).lean<IStudyLecture>();
  if (!lec) return { kind: "missing", what: "Lecture" };
  const t = await readyTranscript(userId, { lectureId: lec._id });
  if (!t?.segments?.length) return { kind: "error", message: "This lecture has no transcript yet — finish the recording and wait for it to be processed", code: "NO_TRANSCRIPT", classId: lec.classId };
  return { kind: "text", text: `${lec.title}\n\n${transcriptText(t.segments)}`, source: src("lecture", { lectureId: lec._id }), classId: lec.classId };
}

/** A video item's ready transcript. */
export async function videoTextSource(userId: Types.ObjectId, item: IStudyItem): Promise<TextSource> {
  const t = await readyTranscript(userId, { itemId: item._id });
  if (!t?.segments?.length) return { kind: "error", message: "This video has no transcript yet — request one (POST /study/videos/:itemId/transcript) and try again", code: "NO_TRANSCRIPT", classId: item.classId };
  return { kind: "text", text: `${item.title}\n\n${transcriptText(t.segments)}`, source: src("video", { itemId: item._id }), classId: item.classId };
}

const HTML_TYPES = ["page", "assignment", "quiz", "announcement"];

export async function itemTextSource(userId: Types.ObjectId, itemId: string): Promise<TextSource> {
  const item = await StudyItem.findOne({ _id: itemId, userId }).lean<IStudyItem>();
  if (!item) return { kind: "missing", what: "Item" };
  if (item.type === "video") return videoTextSource(userId, item);
  if (HTML_TYPES.includes(item.type)) {
    const text = `${item.title}\n\n${htmlToText(item.html ?? "")}`.trim();
    const kind: QuestionSourceKind = item.type === "quiz" ? "canvas_quiz" : /derivita/i.test(item.external?.tool ?? "") ? "derivita" : "manual";
    return text.length > item.title.length + 10
      ? { kind: "text", text, source: src(kind, { itemId: item._id }), classId: item.classId }
      : { kind: "error", message: "This item has no text to work from", code: "EMPTY_SOURCE", classId: item.classId };
  }
  if (item.type === "file" && item.file?.mime === "application/pdf" && item.file.storageKey) {
    const text = (await pdfText(await getStudyObject(item.file.storageKey))).trim();
    return text.length > 200
      ? { kind: "text", text: `${item.title}\n\n${text}`, source: src("pdf", { itemId: item._id }), classId: item.classId }
      : { kind: "error", message: "This PDF has no text layer (scanned?) — extract questions from it instead", code: "EMPTY_SOURCE", classId: item.classId };
  }
  return { kind: "error", message: `Flashcards cannot be made from a ${item.type} item`, code: "UNSUPPORTED_SOURCE", classId: item.classId };
}

export async function pageTextSource(userId: Types.ObjectId, pageId: string): Promise<TextSource> {
  const page = await StudyPage.findOne({ _id: pageId, userId, deletedAt: null }, { title: 1, ocrText: 1, classId: 1 }).lean<IStudyPage>();
  if (!page) return { kind: "missing", what: "Page" };
  return page.ocrText?.trim()
    ? { kind: "text", text: `${page.title}\n\n${page.ocrText}`, source: src("manual", { pageId: page._id }), classId: page.classId }
    : { kind: "error", message: "This page has no handwriting text yet — open it in the app so it can send its OCR text, then try again", code: "NO_OCR_TEXT", classId: page.classId };
}
