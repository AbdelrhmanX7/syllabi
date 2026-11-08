/**
 * The shareable resources (models/share.ts): ownership, title, read-only snapshot and deep copy.
 * Everything that knows how a resource type is stored lives here, so sharing a new type means one
 * more entry, and phase 2 (editors) adds a `write` path next to `snapshot`.
 */
import { Types } from "mongoose";
import { StudyPage, IStudyPage } from "@/models/study/page";
import { StudyQuestion, IStudyQuestion } from "@/models/study/question";
import { StudyClass, IStudyClass } from "@/models/study/class";
import { StudyConceptMap, IStudyConceptMap } from "@/models/study/concept-map";
import type { ShareResourceType } from "@/models/share";
import { getStudyObject, pageContentKey, putStudyObject, signedGetUrl } from "@/services/study/storage";
import { questionDto, srsDto } from "@/services/study/questions";

export const FLASHCARD_TAG_RE = /^flashcard$/i;
/** A shared set never returns more than this many questions (and a fork copies at most this many). */
export const SHARE_QUESTIONS_MAX = 1000;
export const TOPIC_MAX = 120;

export interface ResourceRef {
  resourceType: ShareResourceType;
  resourceId: Types.ObjectId;
  topic: string | null;
}

export type OwnedResource =
  | { type: "notebook"; page: IStudyPage }
  | { type: "deck" | "questions"; cls: IStudyClass; topic: string | null }
  | { type: "conceptMap"; map: IStudyConceptMap; cls: IStudyClass | null };

const oid = (v: Types.ObjectId | string) => new Types.ObjectId(String(v));

/** The resource when `userId` owns it (and it is not deleted); null otherwise. */
export async function loadOwned(ref: ResourceRef, userId: Types.ObjectId | string): Promise<OwnedResource | null> {
  const owner = oid(userId);
  switch (ref.resourceType) {
    case "notebook": {
      const page = await StudyPage.findOne({ _id: ref.resourceId, userId: owner, deletedAt: null }).lean<IStudyPage>();
      return page ? { type: "notebook", page } : null;
    }
    case "deck":
    case "questions": {
      const cls = await StudyClass.findOne({ _id: ref.resourceId, userId: owner }).lean<IStudyClass>();
      return cls ? { type: ref.resourceType, cls, topic: ref.topic } : null;
    }
    case "conceptMap": {
      const map = await StudyConceptMap.findOne({ _id: ref.resourceId, userId: owner }).lean<IStudyConceptMap>();
      if (!map) return null;
      const cls = await StudyClass.findOne({ userId: owner, canvasCourseId: map.canvasCourseId }).lean<IStudyClass>();
      return { type: "conceptMap", map, cls };
    }
  }
}

export function resourceTitle(r: OwnedResource): string {
  switch (r.type) {
    case "notebook":
      return r.page.title?.trim() || "Untitled notebook";
    case "deck":
      return r.topic ? `${r.topic} (${r.cls.name})` : `${r.cls.name} flashcards`;
    case "questions":
      return r.topic ? `${r.topic} (${r.cls.name})` : `${r.cls.name} questions`;
    case "conceptMap":
      return r.map.lecture?.trim() || (r.map.number ? `Concept map ${r.map.number}` : "Concept map");
  }
}

function questionFilter(r: { type: "deck" | "questions"; cls: IStudyClass; topic: string | null }) {
  return {
    userId: r.cls.userId,
    classId: r.cls._id,
    ...(r.topic ? { topic: r.topic } : {}),
    tags: r.type === "deck" ? { $regex: FLASHCARD_TAG_RE } : { $not: FLASHCARD_TAG_RE },
  };
}

/** A question as the viewer sees it: no progress (stats / schedule) and no links into the owner's material. */
function sharedQuestionDto(q: IStudyQuestion) {
  return {
    ...questionDto(q),
    source: { kind: q.source?.kind ?? "manual", itemId: null, pageId: null, lectureId: null, ref: null },
    stats: { attempts: 0, correct: 0, lastResult: null, mastery: 0 },
    srs: srsDto(undefined),
  };
}

/** Read-only content of a resource. Never includes grades, scores or Canvas submissions. */
export async function snapshot(r: OwnedResource): Promise<Record<string, unknown>> {
  switch (r.type) {
    case "notebook":
      return {
        kind: r.page.kind,
        title: resourceTitle(r),
        version: r.page.version,
        contentUrl: r.page.contentKey ? (await signedGetUrl(r.page.contentKey, { contentType: "application/json" })).url : null,
        updatedAt: r.page.updatedAt,
      };
    case "deck":
    case "questions": {
      const rows = await StudyQuestion.find(questionFilter(r)).sort({ topic: 1, createdAt: 1 }).limit(SHARE_QUESTIONS_MAX).lean<IStudyQuestion[]>();
      return { className: r.cls.name, topic: r.topic, questions: rows.map(sharedQuestionDto) };
    }
    case "conceptMap":
      return {
        className: r.cls?.name ?? null,
        lecture: r.map.lecture ?? null,
        week: r.map.week ?? null,
        number: r.map.number ?? null,
        promptTerms: r.map.promptTerms ?? [],
      };
  }
}

/** When the content last changed (for "Shared with me"). */
export async function resourceUpdatedAt(r: OwnedResource): Promise<Date | null> {
  switch (r.type) {
    case "notebook":
      return r.page.updatedAt ?? null;
    case "conceptMap":
      return r.map.updatedAt ?? null;
    default: {
      const last = await StudyQuestion.findOne(questionFilter(r), { updatedAt: 1 }).sort({ updatedAt: -1 }).lean<{ updatedAt: Date }>();
      return last?.updatedAt ?? null;
    }
  }
}

/**
 * The caller's class to put a copy in: their class with the same name (classmates on the same course),
 * else a new manual class with that name (same negative-sentinel canvasCourseId as POST /classes).
 */
export async function forkTargetClass(userId: Types.ObjectId, name: string): Promise<IStudyClass> {
  const clean = name.trim().slice(0, 200) || "Shared with me";
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = await StudyClass.findOne({ userId, name: { $regex: new RegExp(`^${escaped}$`, "i") } }).lean<IStudyClass>();
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const doc = await StudyClass.create({
        userId,
        source: "manual",
        canvasCourseId: -(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
        name: clean,
        code: "",
        userColor: null,
        current: true,
      });
      return doc.toObject() as IStudyClass;
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
    }
  }
  throw new Error("Could not allocate a class id");
}

/**
 * Deep copy into `userId`'s account: new ids, the notebook's board JSON copied to the caller's own
 * storage prefix (deleting the owner's account never breaks the copy), fresh progress on questions.
 * Question images stay references to their public URL. Returns the new resource.
 */
export async function forkResource(r: OwnedResource, userId: Types.ObjectId): Promise<{ resourceId: Types.ObjectId; topic: string | null; classId: Types.ObjectId | null }> {
  switch (r.type) {
    case "notebook": {
      const id = new Types.ObjectId();
      let contentKey: string | null = null;
      let version = 0;
      if (r.page.contentKey) {
        const body = await getStudyObject(r.page.contentKey);
        version = 1;
        contentKey = pageContentKey(String(userId), String(id), version);
        await putStudyObject(contentKey, body, "application/json");
      }
      await StudyPage.create({
        _id: id,
        userId,
        classId: null,
        title: resourceTitle(r),
        kind: r.page.kind === "lecture" ? "note" : r.page.kind,
        version,
        contentKey,
        ocrText: r.page.ocrText ?? null,
        ocrUpdatedAt: r.page.ocrText ? new Date() : null,
      });
      return { resourceId: id, topic: null, classId: null };
    }
    case "deck":
    case "questions": {
      const cls = await forkTargetClass(userId, r.cls.name);
      const rows = await StudyQuestion.find(questionFilter(r)).sort({ createdAt: 1 }).limit(SHARE_QUESTIONS_MAX).lean<IStudyQuestion[]>();
      if (rows.length) {
        await StudyQuestion.insertMany(
          rows.map((q) => ({
            userId,
            classId: cls._id,
            topic: q.topic,
            subtopic: q.subtopic ?? null,
            difficulty: q.difficulty,
            source: { kind: q.source?.kind ?? "manual", itemId: null, pageId: null, lectureId: null, ref: null },
            type: q.type,
            stem: q.stem,
            imageUrl: q.imageUrl ?? null,
            choices: q.choices ?? [],
            pairs: (q.pairs ?? []).map((p) => ({ left: p.left, right: p.right })),
            answer: q.answer ?? "",
            solutionSteps: q.solutionSteps ?? [],
            tags: q.tags ?? [],
            stemHash: q.stemHash,
            shingles: q.shingles ?? [],
          }))
        );
      }
      return { resourceId: cls._id, topic: r.topic, classId: cls._id };
    }
    case "conceptMap": {
      const cls = await forkTargetClass(userId, r.cls?.name ?? "Concept maps");
      // A practice map (never linked to a Canvas assignment, so score sync leaves it alone).
      const doc = await StudyConceptMap.create({
        userId,
        canvasCourseId: cls.canvasCourseId,
        source: "practice",
        number: null,
        week: r.map.week ?? null,
        lecture: r.map.lecture ?? null,
        promptTerms: r.map.promptTerms ?? [],
        promptTermsSource: "manual",
        baseMapId: null,
      });
      return { resourceId: doc._id, topic: null, classId: cls._id };
    }
  }
}
