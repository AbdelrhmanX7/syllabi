import { createHash } from "crypto";
import { plural } from "./plural";
import { CANVAS_IMAGES_PER_SYNC, syncEmbeddedImages } from "./canvas-images";
import { Types } from "mongoose";
import { StudyCanvasConnection, IStudyCanvasConnection } from "@/models/study/canvas-connection";
import { StudyClass, IStudyClass } from "@/models/study/class";
import { StudyModule } from "@/models/study/module";
import { StudyItem, IStudyItem, StudyCanvasType } from "@/models/study/item";
import { StudyFileVersion } from "@/models/study/file-version";
import { logger } from "@/services/logger.service";
import { decryptToken } from "./crypto";
import { CanvasApiError, CanvasClient, createLimiter } from "./canvas-client";
import {
  assignmentIdentity,
  dedupeAssignments,
  externalToolName,
  extractYouTubeIds,
  fileExt,
  gradeTrend,
  GradingScheme,
  isSubmittable,
  letterFromScore,
  mapSubmission,
  selectCurrentTermCourses,
  youTubeIdFromUrl,
} from "./canvas-mapping";
import { putStudyObject, studyFileKey } from "./storage";
import { syncGradebook } from "./grade-sync";
import { syncConceptMapSubmissions } from "./concept-map-canvas";

export const FILE_MAX_BYTES = 200 * 1024 * 1024;
export const SYNC_STALE_MS = 30 * 60 * 1000;
export const TOKEN_EXPIRING_MS = 7 * 24 * 3600 * 1000;

export type SyncDeps = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Background step after a successful run (default: A-plan announcement digests). `null`
   * disables it; the default is skipped under jest so sync tests never start AI work.
   */
  afterSync?: ((userId: string) => Promise<unknown>) | null;
};

const defaultAfterSync = async (userId: string) => (await import("./a-plan/hooks")).aPlanAfterSync(userId);

export type SyncStats = {
  classes: number;
  items: number;
  filesDownloaded: number;
  filesStored: number;
  bytesStored: number;
  filesSkipped: number;
  pagesFetched: number;
  videos: number;
  requests: number;
  durationMs: number;
  /** Images embedded in item html (services/study/canvas-images.ts). */
  imagesStored?: number;
  imagesSkipped?: number;
  imagesFailed?: number;
  imagesDeferred?: number;
};

type Json = Record<string, any>;
type Err = { code: string; message: string };

const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
const sameTime = (a: Date | null | undefined, b: Date | null) => (a ? a.getTime() : null) === (b ? b.getTime() : null);

const errOf = (e: unknown): Err => {
  if (e instanceof CanvasApiError) {
    if (e.status === 401) return { code: "CANVAS_TOKEN_INVALID", message: "Canvas rejected the token" };
    return { code: e.code, message: e.message };
  }
  return { code: "SYNC_FAILED", message: (e as Error)?.message || String(e) };
};

/** 403/404 = the course disabled that tab (Pages/Files/Quizzes) — not an error, just no list. */
async function optionalList(client: CanvasClient, path: string): Promise<Json[] | null> {
  try {
    return await client.getAll(path);
  } catch (e) {
    if (e instanceof CanvasApiError && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}

// ─── claim / release ────────────────────────────────────────────────────────────────────

/**
 * Atomically take the per-user sync lock. A lock older than 30 min is considered dead
 * (a crashed process never ran its `finally`) and may be re-taken.
 */
export async function claimSync(userId: string, now = new Date()) {
  return StudyCanvasConnection.findOneAndUpdate(
    {
      userId: new Types.ObjectId(userId),
      $or: [{ syncing: false }, { syncStartedAt: null }, { syncStartedAt: { $lt: new Date(now.getTime() - SYNC_STALE_MS) } }],
    },
    { $set: { syncing: true, syncStartedAt: now } },
    { new: true }
  ).lean<IStudyCanvasConnection>();
}

/** Fire-and-forget: claim, then run in the background. Returns whether this call claimed a run. */
export async function startSync(userId: string, deps: SyncDeps = {}): Promise<boolean> {
  const conn = await claimSync(userId, deps.now?.() ?? new Date());
  if (!conn) return false;
  void executeSync(conn, deps).catch((e) => logger.error("study canvas sync crashed", e, { userId }));
  return true;
}

/** Awaitable run (cron, harness, tests). Null when another run holds the lock. */
export async function runSync(userId: string, deps: SyncDeps = {}): Promise<SyncStats | null> {
  const conn = await claimSync(userId, deps.now?.() ?? new Date());
  if (!conn) return null;
  return executeSync(conn, deps);
}

// ─── the run ────────────────────────────────────────────────────────────────────────────

type Ctx = {
  userId: Types.ObjectId;
  client: CanvasClient;
  now: Date;
  stats: SyncStats;
  skippedFiles: IStudyCanvasConnection["skippedFiles"];
  touched: Set<string>;
  /** New embedded-image downloads left for this run. */
  imageBudget: { left: number };
};

export async function executeSync(conn: IStudyCanvasConnection, deps: SyncDeps = {}): Promise<SyncStats> {
  const started = Date.now();
  const now = deps.now?.() ?? new Date();
  const stats: SyncStats = {
    classes: 0,
    items: 0,
    filesDownloaded: 0,
    filesStored: 0,
    bytesStored: 0,
    filesSkipped: 0,
    pagesFetched: 0,
    videos: 0,
    requests: 0,
    durationMs: 0,
  };
  const courseErrors: IStudyCanvasConnection["courseErrors"] = [];
  const skippedFiles: IStudyCanvasConnection["skippedFiles"] = [];
  let lastError: Err | null = null;
  let ok = false;
  let client: CanvasClient | null = null;

  try {
    let token: string;
    try {
      token = decryptToken(conn.tokenEnc);
    } catch {
      throw Object.assign(new Error("Stored Canvas token cannot be decrypted; save it again"), { code: "CANVAS_TOKEN_UNREADABLE" });
    }
    client = new CanvasClient({ baseUrl: conn.baseUrl, token, fetchImpl: deps.fetchImpl, sleep: deps.sleep });
    const ctx: Ctx = { userId: new Types.ObjectId(String(conn.userId)), client, now, stats, skippedFiles, touched: new Set(), imageBudget: { left: CANVAS_IMAGES_PER_SYNC } };

    const courses = await client.getAll<Json>("/api/v1/courses?include[]=term&include[]=total_scores&enrollment_state=active&per_page=100");
    const colors = await client.get<Json>("/api/v1/users/self/colors").catch(() => null);
    const kept = selectCurrentTermCourses(courses, now);

    await StudyClass.updateMany(
      // Manual classes are not in Canvas's course list — without this filter every sync
      // would mark them non-current and they would vanish from /classes and Today.
      { userId: ctx.userId, source: { $ne: "manual" }, canvasCourseId: { $nin: kept.map((c) => Number(c.id)) } },
      { $set: { current: false } }
    );

    for (const course of kept) {
      try {
        const { cls, isNew } = await upsertClass(ctx, course, colors);
        stats.classes++;
        await syncCourse(ctx, cls, course, isNew);
        // Grade plan (assignment groups, weights, grading standard). A failure here must not fail P1.
        await syncGradebook(ctx.client, ctx.userId, cls, course).catch(async (e) => {
          if (e instanceof CanvasApiError && e.status === 401) throw e;
          await logger.warn("study gradebook sync failed", { userId: String(conn.userId), courseId: course.id, ...errOf(e) });
        });
        // Concept maps: link + the professor's comments / the uploaded photo / derived terms. Must not fail P1 either.
        await syncConceptMapSubmissions(ctx.client, ctx.userId, cls).catch(async (e) => {
          if (e instanceof CanvasApiError && e.status === 401) throw e;
          await logger.warn("study concept-map sync failed", { userId: String(conn.userId), courseId: course.id, ...errOf(e) });
        });
        await StudyClass.updateOne({ _id: cls._id }, { $set: { lastSyncedAt: new Date() } });
      } catch (e) {
        const err = errOf(e);
        if (err.code === "CANVAS_TOKEN_INVALID") throw e;
        courseErrors.push({ courseId: Number(course.id), ...err });
        await logger.warn("study canvas course sync failed", { userId: String(conn.userId), courseId: course.id, ...err });
      }
    }
    stats.items = ctx.touched.size;
    ok = true;
  } catch (e) {
    lastError = (e as any)?.code === "CANVAS_TOKEN_UNREADABLE" ? { code: "CANVAS_TOKEN_UNREADABLE", message: (e as Error).message } : errOf(e);
  } finally {
    stats.requests = client?.requestCount ?? 0;
    stats.durationMs = Date.now() - started;
    stats.filesSkipped = skippedFiles.length;
    if (ok) {
      if (conn.tokenExpiresAt && new Date(conn.tokenExpiresAt).getTime() - now.getTime() < TOKEN_EXPIRING_MS) {
        lastError = { code: "TOKEN_EXPIRING", message: `Canvas token expires ${new Date(conn.tokenExpiresAt).toISOString()}` };
      } else if (courseErrors.length) {
        lastError = { code: "COURSE_SYNC_PARTIAL", message: `${courseErrors.length} ${plural(courseErrors.length, "course", "courses")} failed to sync` };
      }
    }
    await StudyCanvasConnection.updateOne(
      { _id: conn._id },
      {
        $set: {
          syncing: false,
          syncStartedAt: null,
          lastError,
          ...(ok ? { lastSyncAt: now, courseErrors, skippedFiles, lastSyncStats: stats } : {}),
        },
      }
    );
  }
  const after = deps.afterSync === undefined ? (process.env.NODE_ENV === "test" ? null : defaultAfterSync) : deps.afterSync;
  if (ok && after) void after(String(conn.userId)).catch((e) => logger.error("study post-sync hook failed", e as Error, { userId: String(conn.userId) }));
  return stats;
}

// ─── class ──────────────────────────────────────────────────────────────────────────────

async function gradingScheme(ctx: Ctx, course: Json): Promise<GradingScheme | null> {
  if (!course.grading_standard_id) return null;
  try {
    const list = await ctx.client.getAll<Json>(`/api/v1/courses/${course.id}/grading_standards?per_page=100`);
    const std = list.find((s) => Number(s.id) === Number(course.grading_standard_id));
    return Array.isArray(std?.grading_scheme)
      ? std.grading_scheme.map((r: Json) => ({ name: String(r.name), value: Number(r.value) }))
      : null;
  } catch {
    return null;
  }
}

async function upsertClass(ctx: Ctx, course: Json, colors: Json | null): Promise<{ cls: IStudyClass; isNew: boolean }> {
  const existing = await StudyClass.findOne({ userId: ctx.userId, canvasCourseId: Number(course.id) }).lean<IStudyClass>();
  const enr = (course.enrollments ?? []).find((e: Json) => e.type === "student") ?? course.enrollments?.[0];
  const score = typeof enr?.computed_current_score === "number" ? enr.computed_current_score : null;
  let letter: string | null = enr?.computed_current_grade ?? null;
  if (!letter && score !== null) letter = letterFromScore(score, await gradingScheme(ctx, course));
  const cls = await StudyClass.findOneAndUpdate(
    { userId: ctx.userId, canvasCourseId: Number(course.id) },
    {
      $set: {
        name: String(course.name ?? course.course_code ?? course.id),
        code: String(course.course_code ?? ""),
        term: {
          id: course.term?.id ?? null,
          name: course.term?.name ?? null,
          startAt: toDate(course.term?.start_at),
          endAt: toDate(course.term?.end_at),
        },
        canvasColor: colors?.custom_colors?.[`course_${course.id}`] ?? null,
        grade: { score, letter, trend: gradeTrend(existing?.grade?.score, score) },
        current: true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean<IStudyClass>();
  return { cls: cls!, isNew: !existing };
}

// ─── course content ─────────────────────────────────────────────────────────────────────

/** First sync: announcements posted within this window are left unseen. */
export const FIRST_SYNC_UNSEEN_ANNOUNCEMENT_MS = 14 * 86400e3;

async function syncCourse(ctx: Ctx, cls: IStudyClass, course: Json, stampSeen: boolean) {
  const { client, userId } = ctx;
  const cid = Number(course.id);
  const base = `/api/v1/courses/${cid}`;
  const classId = cls._id;
  // First sync of a class: everything it creates is "already seen", so the app does not
  // open on the whole semester as new. Later syncs leave new items unseen.
  const seenOnInsert = stampSeen ? ctx.now : null;

  const upsert = async (canvasType: StudyCanvasType, canvasId: string, set: Json, onInsert: Json = {}) => {
    const update: Json = { $setOnInsert: { seenAt: seenOnInsert, ...onInsert } };
    if (Object.keys(set).length) update.$set = set;
    const doc = await StudyItem.findOneAndUpdate(
      { userId, classId, canvasType, canvasId },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<IStudyItem>();
    ctx.touched.add(String(doc!._id));
    return doc!;
  };

  const htmlSources: { item: IStudyItem; html: string }[] = [];

  // 1. Assignments — includes classic-quiz and graded-discussion rows, keyed by what they ARE.
  const rawAssignments = (await optionalList(client, `${base}/assignments?include[]=submission&per_page=100`)) ?? [];
  const { kept, alias } = dedupeAssignments(rawAssignments);
  const assignmentKey = new Map<number, { canvasType: StudyCanvasType; canvasId: string }>();
  const quizIdsWithAssignment = new Set<string>();
  for (const a of kept) {
    const id = assignmentIdentity(a);
    assignmentKey.set(Number(a.id), id);
    if (a.quiz_id) quizIdsWithAssignment.add(String(a.quiz_id));
    const types: string[] = a.submission_types ?? [];
    const toolUrl = a.external_tool_tag_attributes?.url;
    const isExternal = types.includes("external_tool");
    // New Quizzes are LTI assignments on a `quiz-lti` host: they ARE quizzes.
    const isNewQuiz = isExternal && /quiz-lti/i.test(String(toolUrl ?? ""));
    const item = await upsert(id.canvasType, id.canvasId, {
      type: isNewQuiz ? "quiz" : id.type,
      title: String(a.name ?? ""),
      canvasUrl: a.html_url ?? null,
      canvasUpdatedAt: toDate(a.updated_at),
      dueAt: toDate(a.due_at),
      points: typeof a.points_possible === "number" ? a.points_possible : null,
      submission: mapSubmission(a.submission),
      submittable: isSubmittable(types),
      external: isExternal ? { tool: isNewQuiz ? "New Quizzes" : externalToolName(toolUrl) ?? "External tool" } : null,
      html: a.description || null,
    });
    if (a.description) htmlSources.push({ item, html: a.description });
  }
  for (const [dropped, keptId] of alias) assignmentKey.set(dropped, assignmentKey.get(keptId)!);

  // 2. Quizzes not attached to an assignment (practice quizzes / surveys).
  const quizzes = (await optionalList(client, `${base}/quizzes?per_page=100`)) ?? [];
  for (const q of quizzes) {
    if (quizIdsWithAssignment.has(String(q.id))) continue;
    let submission: { state: "unsubmitted" | "submitted" | "graded"; score: number | null } = { state: "unsubmitted", score: null };
    try {
      const subs = await client.get<Json>(`${base}/quizzes/${q.id}/submissions`);
      const latest = (subs?.quiz_submissions ?? []).sort((x: Json, y: Json) => (y.attempt ?? 0) - (x.attempt ?? 0))[0];
      if (latest) {
        const score = typeof latest.kept_score === "number" ? latest.kept_score : typeof latest.score === "number" ? latest.score : null;
        submission = { state: latest.workflow_state === "complete" ? (score !== null ? "graded" : "submitted") : "unsubmitted", score };
      }
    } catch {
      /* no submission access — keep unsubmitted */
    }
    await upsert("Quiz", String(q.id), {
      type: "quiz",
      title: String(q.title ?? ""),
      canvasUrl: q.html_url ?? null,
      canvasUpdatedAt: toDate(q.updated_at),
      dueAt: toDate(q.due_at),
      points: typeof q.points_possible === "number" ? q.points_possible : null,
      submission,
      submittable: true,
      html: q.description || null,
    });
  }

  // 3. Standalone lists — often disabled for students (403/404); modules are the fallback.
  const fileMetas = new Map<number, Json>();
  for (const f of (await optionalList(client, `${base}/files?per_page=100`)) ?? []) fileMetas.set(Number(f.id), f);
  const pageList = new Map<string, Json>();
  for (const p of (await optionalList(client, `${base}/pages?per_page=100`)) ?? []) if (p.url) pageList.set(String(p.url), p);
  const pageUrls = new Set<string>(pageList.keys());

  // 4. Announcements — the API defaults to the last 14 days, so pass the term window.
  const startDate = course.term?.start_at ?? course.start_at ?? new Date(ctx.now.getTime() - 180 * 86400e3).toISOString();
  const endDate = new Date(ctx.now.getTime() + 86400e3).toISOString();
  const announcements =
    (await optionalList(
      client,
      `/api/v1/announcements?context_codes[]=course_${cid}&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&per_page=100`
    )) ?? [];
  for (const an of announcements) {
    // Exception to the first-sync stamp: an announcement posted in the last 14 days stays
    // unseen, so a fresh connection still shows what was just announced.
    const postedAt = toDate(an.posted_at);
    const recent = !!postedAt && ctx.now.getTime() - postedAt.getTime() <= FIRST_SYNC_UNSEEN_ANNOUNCEMENT_MS;
    const item = await upsert(
      "Announcement",
      String(an.id),
      {
        type: "announcement",
        title: String(an.title ?? ""),
        canvasUrl: an.html_url ?? null,
        canvasUpdatedAt: toDate(an.posted_at ?? an.updated_at),
        html: an.message || null,
      },
      recent ? { seenAt: null } : {}
    );
    if (an.message) htmlSources.push({ item, html: an.message });
  }

  // 5. Modules. A module item for a File/Page/Assignment/Quiz/Discussion lands on the SAME
  //    Item as the standalone list (same canvasType+canvasId); it only adds moduleId.
  const modules = await optionalList(client, `${base}/modules?include[]=items&per_page=100`);
  if (modules) {
    const inModule = new Set<string>();
    const moduleIds: number[] = [];
    for (const m of modules) {
      moduleIds.push(Number(m.id));
      const mod = await StudyModule.findOneAndUpdate(
        { userId, classId, canvasId: Number(m.id) },
        { $set: { name: String(m.name ?? ""), position: Number(m.position ?? 0) } },
        { upsert: true, new: true }
      ).lean();
      const items: Json[] = Array.isArray(m.items) ? m.items : await client.getAll(`${base}/modules/${m.id}/items?per_page=100`);
      for (const it of items) {
        const place = { moduleId: mod!._id, modulePosition: Number(it.position ?? 0) };
        const title = String(it.title ?? "");
        let doc: IStudyItem | null = null;
        switch (it.type) {
          case "File": {
            const fid = Number(it.content_id);
            if (!fileMetas.has(fid)) {
              try {
                fileMetas.set(fid, await client.get(`${base}/files/${fid}`));
              } catch (e) {
                ctx.skippedFiles.push({ courseId: cid, fileId: fid, name: title, size: null, reason: `unavailable: ${errOf(e).message}` });
              }
            }
            doc = await upsert("File", String(fid), place, { type: "file", title, canvasUrl: `${client.origin}/courses/${cid}/files/${fid}` });
            break;
          }
          case "Page": {
            const url = String(it.page_url ?? "");
            if (!url) break;
            pageUrls.add(url);
            doc = await upsert("Page", url, place, { type: "page", title, canvasUrl: it.html_url ?? null });
            break;
          }
          case "Assignment": {
            const key = assignmentKey.get(Number(it.content_id)) ?? { canvasType: "Assignment" as const, canvasId: String(it.content_id) };
            doc = await upsert(key.canvasType, key.canvasId, place, { type: "assignment", title, canvasUrl: it.html_url ?? null });
            break;
          }
          case "Quiz":
            doc = await upsert("Quiz", String(it.content_id), place, { type: "quiz", title, canvasUrl: it.html_url ?? null });
            break;
          case "Discussion":
            // Graded discussion → already keyed Discussion/<topic id> by its assignment; else a link.
            doc = await upsert("Discussion", String(it.content_id), place, { type: "link", title, canvasUrl: it.html_url ?? null });
            break;
          case "ExternalUrl": {
            const vid = youTubeIdFromUrl(it.external_url);
            if (vid) {
              doc = await upsert("Video", vid, place, {
                type: "video",
                title,
                canvasUrl: `https://www.youtube.com/watch?v=${vid}`,
                video: { provider: "youtube", videoId: vid, durationSec: null, transcriptStatus: "none" },
              });
            } else {
              doc = await upsert("ExternalUrl", String(it.id), { ...place, type: "link", title, canvasUrl: it.external_url ?? null, external: null });
            }
            break;
          }
          case "ExternalTool":
            doc = await upsert("ExternalTool", String(it.id), {
              ...place,
              type: "link",
              title,
              canvasUrl: it.html_url ?? null,
              external: { tool: externalToolName(it.external_url) ?? "External tool" },
            });
            break;
          default:
            break; // SubHeader and anything unknown
        }
        if (doc) inModule.add(String(doc._id));
      }
    }
    await StudyItem.updateMany(
      { userId, classId, moduleId: { $ne: null }, _id: { $nin: [...inModule].map((id) => new Types.ObjectId(id)) } },
      { $set: { moduleId: null, modulePosition: null } }
    );
    await StudyModule.deleteMany({ userId, classId, canvasId: { $nin: moduleIds } });
  }

  // 6. Page bodies. With a page list, fetch only pages whose updated_at moved. Without one
  //    (tab disabled) the single-page GET is the only way to learn updated_at, so it is
  //    fetched, and the stored body is rewritten only when updated_at changed.
  const pageDocs = await Promise.all(
    [...pageUrls].map(async (url) => {
      const existing = await StudyItem.findOne({ userId, classId, canvasType: "Page", canvasId: url }).lean<IStudyItem>();
      const listed = pageList.get(url);
      if (listed && existing?.html != null && sameTime(existing.canvasUpdatedAt, toDate(listed.updated_at))) {
        ctx.touched.add(String(existing._id));
        return existing;
      }
      let page: Json;
      try {
        page = await client.get(`${base}/pages/${encodeURIComponent(url)}`);
        ctx.stats.pagesFetched++;
      } catch (e) {
        if (e instanceof CanvasApiError && e.status === 401) throw e;
        return existing;
      }
      const updatedAt = toDate(page.updated_at);
      if (existing?.html != null && sameTime(existing.canvasUpdatedAt, updatedAt)) return existing;
      return upsert("Page", url, {
        type: "page",
        title: String(page.title ?? existing?.title ?? url),
        canvasUrl: page.html_url ?? existing?.canvasUrl ?? null,
        canvasUpdatedAt: updatedAt,
        html: page.body ?? "",
      });
    })
  );
  htmlSources.unshift(...pageDocs.filter((d): d is IStudyItem => !!d?.html).map((d) => ({ item: d, html: d.html! })));

  // 7. Files → storage, every version kept.
  const fileLimit = createLimiter(2);
  await Promise.all([...fileMetas.values()].map((meta) => fileLimit(() => syncFile(ctx, classId, cid, meta, upsert))));

  // 8. YouTube embeds/links in HTML → one `video` item per (class, videoId).
  for (const src of htmlSources) {
    const ids = extractYouTubeIds(src.html);
    for (let i = 0; i < ids.length; i++) {
      await upsert(
        "Video",
        ids[i],
        {},
        {
          type: "video",
          title: ids.length > 1 ? `${src.item.title} — Video ${i + 1}` : `${src.item.title} — Video`,
          canvasUrl: `https://www.youtube.com/watch?v=${ids[i]}`,
          parentItemId: src.item._id,
          video: { provider: "youtube", videoId: ids[i], durationSec: null, transcriptStatus: "none" },
        }
      );
    }
  }
  ctx.stats.videos += await StudyItem.countDocuments({ userId, classId, type: "video" });

  // 9. Images embedded in any item's html (pages, assignments, quizzes, announcements) → cached
  //    once per Canvas file id. Every item, not just changed ones, so older pages fill in too.
  const withImages = await StudyItem.find({ userId, classId, html: /<img/i }, { html: 1 }).lean<Pick<IStudyItem, "html">[]>();
  const images = await syncEmbeddedImages(userId, ctx.client, withImages.map((i) => i.html ?? ""), ctx.imageBudget);
  ctx.stats.imagesStored = (ctx.stats.imagesStored ?? 0) + images.stored;
  ctx.stats.imagesSkipped = (ctx.stats.imagesSkipped ?? 0) + images.skipped;
  ctx.stats.imagesFailed = (ctx.stats.imagesFailed ?? 0) + images.failed;
  ctx.stats.imagesDeferred = (ctx.stats.imagesDeferred ?? 0) + images.deferred;
}

async function syncFile(
  ctx: Ctx,
  classId: Types.ObjectId,
  cid: number,
  meta: Json,
  upsert: (t: StudyCanvasType, id: string, set: Json, onInsert?: Json) => Promise<IStudyItem>
) {
  const fid = Number(meta.id);
  const name = String(meta.display_name ?? meta.filename ?? fid);
  const mime = String(meta["content-type"] ?? "application/octet-stream");
  const size = typeof meta.size === "number" ? meta.size : null;
  const updatedAt = toDate(meta.updated_at);
  const item = await upsert("File", String(fid), {
    type: "file",
    title: name,
    canvasUrl: `${ctx.client.origin}/courses/${cid}/files/${fid}`,
    canvasUpdatedAt: updatedAt,
  });
  const skip = (reason: string) => ctx.skippedFiles.push({ courseId: cid, fileId: fid, name, size, reason });

  if (item.file?.storageKey && sameTime(item.file.canvasUpdatedAt, updatedAt) && item.file.size === size) return; // unchanged
  if (meta.locked_for_user || meta.hidden_for_user || !meta.url) return void skip("locked");
  if (size !== null && size > FILE_MAX_BYTES) return void skip("too_large");

  let buf: Buffer;
  try {
    buf = await ctx.client.download(String(meta.url), FILE_MAX_BYTES);
    ctx.stats.filesDownloaded++;
  } catch (e) {
    const err = errOf(e);
    return void skip(err.code === "FILE_TOO_LARGE" ? "too_large" : `download_failed: ${err.message}`);
  }
  const sha256 = createHash("sha256").update(buf).digest("hex");
  if (item.file?.storageKey && item.file.sha256 === sha256) {
    // Canvas touched the metadata but the bytes are identical — no new version.
    await StudyItem.updateOne(
      { _id: item._id },
      { $set: { "file.canvasUpdatedAt": updatedAt, "file.size": buf.length, "file.name": name } }
    );
    return;
  }
  const storageKey = studyFileKey(String(ctx.userId), fileExt(meta.filename ?? name));
  await putStudyObject(storageKey, buf, mime);
  const version = (item.file?.version ?? 0) + 1;
  await StudyFileVersion.create({
    userId: ctx.userId,
    itemId: item._id,
    version,
    sha256,
    size: buf.length,
    mime,
    storageKey,
    canvasUpdatedAt: updatedAt,
  });
  await StudyItem.updateOne(
    { _id: item._id },
    { $set: { file: { name, mime, size: buf.length, version, sha256, storageKey, canvasUpdatedAt: updatedAt } } }
  );
  ctx.stats.filesStored++;
  ctx.stats.bytesStored += buf.length;
}
