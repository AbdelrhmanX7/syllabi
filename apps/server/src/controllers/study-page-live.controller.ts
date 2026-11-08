import { Request, Response } from "express";
import { StudyPage, IStudyPage } from "@/models/study/page";
import { getStudyObject, pageContentKey, putStudyObject } from "@/services/study/storage";
import { pageFor, scopedPage } from "@/services/share/edit";
import { loadCaller } from "@/services/share/access";
import { applyOps, BoardDoc, ensureDocIds, LiveOps, opsError } from "@/services/share/live-merge";
import { dropPresence, PagePerson, pagePeople, publishPageEvent, subscribePage, touchPresence, withPageLock } from "@/services/study/page-live";
import { openStudySse, PING_MS } from "@/services/study/sse";
import { authorOf, casCommit, PAGE_PROJECTION } from "./study-pages.controller";
import { fail, isOid, wrap } from "./study.controller";

/**
 * Live co-editing of a notebook page (sharing phase 2 part B). The owner and the people they invited
 * to edit, nobody else (viewers keep the read-only share view; strangers get 404).
 *
 *   POST /pages/:id/live {clientId, ops}  → {prevVersion, version}
 *     Small batches of changes (services/share/live-merge.ts) applied to the CURRENT version under the
 *     page lock, written as version+1 with the normal version check, and sent to everyone else on the
 *     page as `ops {prevVersion, version, ops, by}`.
 *   GET /pages/:id/live/stream?clientId=  → SSE
 *     `hello {version, people}`, then `ops`, `presence {people}`; `error {code: ACCESS_REVOKED}` ends
 *     it when the caller's access goes (checked on every sharing change and every 30 s).
 *   GET /pages/:id/content?version=N      → {url, version}: an earlier version (the base a device
 *     last had, for merging edits it made offline).
 */

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
/** Ops bigger than this travel as "re-read the page" (an inserted photo can be megabytes). */
const MAX_EVENT_OPS_BYTES = 256 * 1024;
const RECHECK_MS = 30_000;
const MAX_TRIES = 3;

/** Last boards read or written by this process, by storage key (pushes come in bursts). */
const boardCache = new Map<string, string>();
const BOARD_CACHE_MAX = 12;
const rememberBoard = (key: string, json: string) => {
  boardCache.delete(key);
  boardCache.set(key, json);
  while (boardCache.size > BOARD_CACHE_MAX) boardCache.delete(boardCache.keys().next().value as string);
};

async function readBoard(page: IStudyPage): Promise<BoardDoc> {
  if (!page.version || !page.contentKey) {
    const now = Date.now();
    return { id: String(page._id), title: page.title, pages: [], currentPageIndex: 0, createdAt: now, updatedAt: now, thumbnail: "" };
  }
  const json = boardCache.get(page.contentKey) ?? (await getStudyObject(page.contentKey)).toString("utf8");
  rememberBoard(page.contentKey, json);
  const doc = JSON.parse(json);
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.pages)) throw new Error("Stored board is not readable");
  return doc as BoardDoc;
}

const personOf = async (req: Request, clientId: string, editorName: string | null): Promise<PagePerson> => ({
  clientId,
  userId: String(req.adminId),
  name: editorName ?? (await loadCaller(req.adminId))?.name ?? "Someone",
});

export const pushPageLive = wrap(async (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as { clientId?: unknown; ops?: unknown };
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid page id");
  const clientId = typeof body.clientId === "string" && CLIENT_ID_RE.test(body.clientId) ? body.clientId : null;
  if (!clientId) return fail(res, 400, "VALIDATION_ERROR", "clientId is required");
  const bad = opsError(body.ops);
  if (bad) return fail(res, 400, "VALIDATION_ERROR", bad);
  const found = await scopedPage(req, req.params.id, { _id: 1, userId: 1 });
  if (!found) return fail(res, 404, "NOT_FOUND", "Page not found");
  const author = await authorOf(req, found.editor);
  const ops = body.ops as LiveOps;
  const pageId = String(found.doc._id);

  const result = await withPageLock(pageId, async () => {
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const fresh = await StudyPage.findOne({ _id: pageId, deletedAt: null }, PAGE_PROJECTION).lean<IStudyPage>();
      if (!fresh) return null;
      const next = applyOps(ensureDocIds(await readBoard(fresh)), ops);
      next.updatedAt = Date.now();
      const version = (fresh.version ?? 0) + 1;
      const key = pageContentKey(String(fresh.userId), pageId, version);
      const json = JSON.stringify(next);
      await putStudyObject(key, Buffer.from(json, "utf8"), "application/json");
      if (await casCommit(fresh, version, key, author)) {
        rememberBoard(key, json);
        return { prevVersion: fresh.version ?? 0, version };
      }
    }
    return "stale" as const;
  });
  if (result === null) return fail(res, 404, "NOT_FOUND", "Page not found");
  if (result === "stale") return res.status(409).json({ message: "The page keeps changing, try again", code: "STALE_VERSION" });

  const by: PagePerson = { clientId, userId: String(req.adminId), name: author?.name ?? "Someone" };
  const small = JSON.stringify(ops).length <= MAX_EVENT_OPS_BYTES;
  publishPageEvent(pageId, { type: "ops", ...result, ops: small ? ops : null, by });
  res.json(result);
});

async function announcePeople(pageId: string): Promise<void> {
  publishPageEvent(pageId, { type: "presence", people: await pagePeople(pageId) });
}

export const streamPageLive = async (req: Request, res: Response) => {
  try {
    if (!isOid(req.params.id)) return void fail(res, 400, "INVALID_ID", "Invalid page id");
    const raw = req.query.clientId;
    const clientId = typeof raw === "string" && CLIENT_ID_RE.test(raw) ? raw : null;
    if (!clientId) return void fail(res, 400, "VALIDATION_ERROR", "clientId is required");
    const found = await pageFor(req.adminId, req.params.id, { _id: 1, userId: 1, version: 1 });
    if (!found) return void fail(res, 404, "NOT_FOUND", "Page not found");
    const pageId = String(found.doc._id);
    const adminId = req.adminId;
    const me = await personOf(req, clientId, found.editor?.name ?? null);

    const sse = openStudySse(res);
    let closed = false;
    let checking = false;
    const recheck = async () => {
      if (closed || checking) return;
      checking = true;
      try {
        if (!(await pageFor(adminId, pageId, { _id: 1 }))) {
          sse.error("You no longer have access to this page", "ACCESS_REVOKED");
          cleanup();
        }
      } catch {
        /* a database blip is not a revocation; the next check decides */
      } finally {
        checking = false;
      }
    };
    const unsubscribe = subscribePage(pageId, (event) => {
      if (closed) return;
      if (event.type === "ops") {
        if (event.by.clientId !== clientId) sse.send("ops", event);
      } else if (event.type === "presence") {
        sse.send("presence", { people: event.people });
      } else if (event.type === "revoke") {
        void recheck();
      }
    });
    let ticks = 0;
    const timer = setInterval(() => {
      if (closed) return;
      ticks += 1;
      void touchPresence(pageId, me);
      if ((ticks * PING_MS) % RECHECK_MS < PING_MS) {
        void recheck();
        void pagePeople(pageId).then((people) => sse.send("presence", { people }));
      }
    }, PING_MS);
    timer.unref?.();
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      unsubscribe();
      void dropPresence(pageId, clientId!).then(() => announcePeople(pageId));
    }
    res.on("close", cleanup);

    await touchPresence(pageId, me);
    sse.send("hello", { version: found.doc.version ?? 0, people: await pagePeople(pageId) });
    void announcePeople(pageId);
  } catch (error) {
    if (!res.headersSent) fail(res, 500, "INTERNAL", "Could not open the live stream");
    else res.end();
    void error;
  }
};
