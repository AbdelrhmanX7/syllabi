/**
 * Sharing (docs/accounts.md, "Sharing and collaboration"): phase 1 read-only + fork, phase 2 part A
 * the "editor" role (editors change the original through the study write routes, services/share/edit.ts).
 * Mounted at /share and /study/share (the app's transport prefixes every live route with /study),
 * behind adminVerification + studyAccess: every call needs a signed-in account, a link included.
 *
 * People: `emails` / `addEmails` entries are an address (gets `role`, default "viewer") or
 * {email, role}; role is "viewer" | "editor". The link is always view-only.
 *
 *   POST   /share                     {resourceType, resourceId, topic?, emails?, role?, link?} owner only -> {share}
 *                                     (one share per resource: a second POST adds to it)
 *   GET    /share/mine?resourceType&resourceId&topic?                          -> {share|null}
 *   PATCH  /share/:id                 {addEmails?, role?, removeEmails?, roles?: [{email, role}], link?: boolean}
 *                                     owner only -> {share}
 *   DELETE /share/:id                 owner only, stops sharing                 -> 204
 *   GET    /share/with-me             shared to my account / verified email     -> {items}
 *   GET    /share/forks               where my copies came from                 -> {items}
 *   GET    /share/view/:idOrToken     read-only snapshot (grant, owner or link)  -> {share, content}
 *   GET    /share/view/:idOrToken/pdf-assets/:assetId  a shared notebook's PDF background
 *                                     -> {assetId, url, expiresAt} (same access as the view)
 *   POST   /share/fork/:idOrToken     deep copy into my account                 -> {resourceType, resourceId, topic, classId}
 *   GET    /share/preview/:token      NO account needed: title, kind, owner first name (routes/share-public.ts)
 *
 * The link ("Anyone with the link can get a copy"): a 43-char token, on/off with `link` in POST / PATCH.
 * Off = the token is gone, so the view, the copy and the preview all 404; copies already made stay.
 * Someone who came by link only ever sees the owner's first name.
 *
 * Strangers get 404 (never "exists but not yours"). Adding people needs a verified email (it sends
 * mail) and is rate limited per account; views and forks are rate limited too.
 */
import { Router, Request, Response, NextFunction } from "express";
import { publishPageEvent } from "@/services/study/page-live";
import { Types } from "mongoose";
import { Admin } from "@/models/admin";
import { IShare, Share, ShareFork, SHARE_RESOURCE_TYPES, SHARE_ROLES, ShareResourceType, ShareRole } from "@/models/share";
import { memoryRateLimit } from "@/auth/rate-limit";
import { normaliseEmail } from "@/auth/validate";
import { EMAIL_NOT_VERIFIED } from "@/auth/verified";
import { appLink } from "@/auth/config";
import { sendMailInBackground, shareInviteMail } from "@/auth/mail";
import { generateRawToken } from "@/auth/tokens";
import { bindEmailGrants, Caller, callerGrant, displayName, firstName, grantedToFilter, resolveShared, SHARE_ID_RE } from "@/services/share/access";
import { forkResource, loadOwned, resourceEditedBy, resourceTitle, resourceUpdatedAt, snapshot, TOPIC_MAX } from "@/services/share/resources";
import { logger } from "@/services/logger.service";
import { sendAssetUrl, validAssetId } from "@/services/study/pdf-assets";

export const EMAILS_PER_REQUEST = 20;
export const GRANTS_PER_SHARE = 50;

const router = Router();

const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ message, code });
const accountKey = (req: Request) => (req.adminId ? String(req.adminId) : null);
const writeLimit = memoryRateLimit({ windowMs: 15 * 60_000, max: 60, key: accountKey, message: "Too many sharing changes. Try again in a few minutes." });
const inviteLimit = memoryRateLimit({ windowMs: 24 * 3600_000, max: 100, key: accountKey, message: "You've shared with a lot of people today. Try again tomorrow." });
const readLimit = memoryRateLimit({ windowMs: 15 * 60_000, max: 600, key: accountKey, message: "Too many requests. Try again in a few minutes." });
const forkLimit = memoryRateLimit({ windowMs: 15 * 60_000, max: 30, key: accountKey, message: "Too many copies at once. Try again in a few minutes." });

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(async (e) => {
      await logger.error("share route failed", e instanceof Error ? e : new Error(String(e)), { path: req.originalUrl }).catch(() => {});
      if (!res.headersSent) fail(res, 500, "INTERNAL", "Something went wrong");
      else next(e);
    });

interface Me extends Caller {
  name: string;
}
const ME = Symbol("shareCaller");
const me = (req: Request): Me => (req as any)[ME];

// Who is calling (adminVerification already ran at the mount).
router.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = await Admin.findById(req.adminId, { name: 1, email: 1, isVerified: 1 }).lean<{ name?: string; email?: string; isVerified?: boolean }>();
    if (!a) return res.status(401).send("Account not found");
    (req as any)[ME] = {
      userId: new Types.ObjectId(String(req.adminId)),
      email: a.email ?? null,
      emailVerified: a.isVerified !== false,
      name: displayName(a),
    } satisfies Me;
    next();
  } catch (e) {
    next(e);
  }
});

/** Adding people sends mail: a verified email and the daily invite limit, only when the body adds someone. */
const inviteGate = (field: string) => (req: Request, res: Response, next: NextFunction) => {
  const v = (req.body ?? {})[field];
  if (!Array.isArray(v) || !v.length) return next();
  if (req.emailVerified === false) return res.status(403).json(EMAIL_NOT_VERIFIED);
  return inviteLimit(req, res, next);
};

// ─── input ──────────────────────────────────────────────────────────────────────────────

function parseRef(src: Record<string, unknown>): { resourceType: ShareResourceType; resourceId: Types.ObjectId; topic: string | null } | string {
  const resourceType = src.resourceType;
  if (typeof resourceType !== "string" || !(SHARE_RESOURCE_TYPES as readonly string[]).includes(resourceType))
    return `resourceType must be one of ${SHARE_RESOURCE_TYPES.join(", ")}`;
  if (typeof src.resourceId !== "string" || !SHARE_ID_RE.test(src.resourceId)) return "resourceId must be an id";
  let topic: string | null = null;
  if (src.topic !== undefined && src.topic !== null && src.topic !== "") {
    if (resourceType !== "deck" && resourceType !== "questions") return "topic is only for decks and question sets";
    if (typeof src.topic !== "string" || src.topic.trim().length > TOPIC_MAX) return `topic must be a string of at most ${TOPIC_MAX} characters`;
    topic = src.topic.trim() || null;
  }
  return { resourceType: resourceType as ShareResourceType, resourceId: new Types.ObjectId(src.resourceId), topic };
}

const isRole = (v: unknown): v is ShareRole => typeof v === "string" && (SHARE_ROLES as readonly string[]).includes(v);

function parseRole(v: unknown, field: string): ShareRole | string {
  if (v === undefined || v === null) return "viewer";
  return isRole(v) ? v : `${field} must be one of ${SHARE_ROLES.join(", ")}`;
}

interface Person {
  email: string;
  role: ShareRole;
}

/** A list of addresses or {email, role}; a bare address gets `defaultRole`. */
function parsePeople(v: unknown, field: string, defaultRole: ShareRole = "viewer"): Person[] | string {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return `${field} must be a list of email addresses`;
  if (v.length > EMAILS_PER_REQUEST) return `At most ${EMAILS_PER_REQUEST} addresses at a time`;
  const out: Person[] = [];
  for (const raw of v) {
    const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const email = normaliseEmail(obj ? obj.email : raw);
    if (!email) return `"${String(obj ? obj.email : raw).slice(0, 60)}" is not an email address`;
    let role = defaultRole;
    if (obj && obj.role !== undefined) {
      if (!isRole(obj.role)) return `${field}: role must be one of ${SHARE_ROLES.join(", ")}`;
      role = obj.role;
    }
    if (!out.some((p) => p.email === email)) out.push({ email, role });
  }
  return out;
}

const parseEmails = (v: unknown, field: string): string[] | string => {
  const people = parsePeople(v, field);
  return typeof people === "string" ? people : people.map((p) => p.email);
};

// ─── DTOs ───────────────────────────────────────────────────────────────────────────────

/** The owner's view of a share (people + link). */
async function ownerShareDto(s: IShare) {
  const ids = s.grants.map((g) => g.userId).filter(Boolean) as Types.ObjectId[];
  const accounts = ids.length ? await Admin.find({ _id: { $in: ids } }, { name: 1 }).lean<{ _id: Types.ObjectId; name?: string }[]>() : [];
  const names = new Map(accounts.map((a) => [String(a._id), a.name ?? null]));
  return {
    id: String(s._id),
    resourceType: s.resourceType,
    resourceId: String(s.resourceId),
    topic: s.topic ?? null,
    title: s.title,
    people: s.grants.map((g) => ({ email: g.email, role: g.role, name: g.userId ? (names.get(String(g.userId)) ?? null) : null, joined: Boolean(g.userId) })),
    link: s.link ? { role: s.link.role, url: appLink(`/shared/?id=${s.link.token}`), token: s.link.token } : null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function mailInvites(share: IShare, people: Person[], from: Me) {
  for (const p of people) {
    sendMailInBackground(shareInviteMail(p.email, from.name, share.resourceType, share.title, appLink(`/shared/?id=${share._id}`), p.role));
  }
}

async function addGrants(share: IShare, people: Person[], caller: Me): Promise<{ added: Person[] } | string> {
  const own = caller.email?.toLowerCase();
  const freshPeople = people.filter((p) => p.email !== own && !share.grants.some((g) => g.email === p.email));
  const fresh = freshPeople.map((p) => p.email);
  if (share.grants.length + fresh.length > GRANTS_PER_SHARE) return `A share can have at most ${GRANTS_PER_SHARE} people`;
  if (!fresh.length) return { added: [] };
  // Bind to existing VERIFIED accounts right away; others bind when they sign in with that address.
  const accounts = await Admin.find({ email: { $in: fresh }, isVerified: { $ne: false } }, { email: 1 }).lean<{ _id: Types.ObjectId; email: string }[]>();
  const byEmail = new Map(accounts.map((a) => [a.email, a._id]));
  const now = new Date();
  await Share.updateOne(
    { _id: share._id },
    { $push: { grants: { $each: freshPeople.map((p) => ({ email: p.email, userId: byEmail.get(p.email) ?? null, role: p.role, addedAt: now })) } } }
  );
  return { added: freshPeople };
}

// ─── owner routes ───────────────────────────────────────────────────────────────────────

router.post(
  "/",
  writeLimit,
  inviteGate("emails"),
  wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ref = parseRef(body);
    if (typeof ref === "string") return fail(res, 400, "VALIDATION_ERROR", ref);
    const role = parseRole(body.role, "role");
    if (!isRole(role)) return fail(res, 400, "VALIDATION_ERROR", role);
    const emails = parsePeople(body.emails, "emails", role);
    if (typeof emails === "string") return fail(res, 400, "VALIDATION_ERROR", emails);
    if (body.link !== undefined && typeof body.link !== "boolean") return fail(res, 400, "VALIDATION_ERROR", "link must be true or false");
    const caller = me(req);
    const owned = await loadOwned(ref, caller.userId);
    if (!owned) return fail(res, 404, "NOT_FOUND", "Not found");
    const title = resourceTitle(owned);
    let share: IShare | null = await Share.findOneAndUpdate(
      { ownerId: caller.userId, resourceType: ref.resourceType, resourceId: ref.resourceId, topic: ref.topic },
      { $set: { title }, $setOnInsert: { grants: [], link: null } },
      { upsert: true, new: true }
    ).lean<IShare>();
    if (body.link === true && !share!.link) await Share.updateOne({ _id: share!._id }, { $set: { link: { token: generateRawToken(), role: "viewer" } } });
    if (body.link === false && share!.link) await Share.updateOne({ _id: share!._id }, { $set: { link: null } });
    const result = await addGrants(share!, emails, caller);
    if (typeof result === "string") return fail(res, 400, "VALIDATION_ERROR", result);
    share = await Share.findById(share!._id).lean<IShare>();
    mailInvites(share!, result.added, caller);
    res.status(201).json({ share: await ownerShareDto(share!) });
  })
);

router.get(
  "/mine",
  readLimit,
  wrap(async (req, res) => {
    const ref = parseRef(req.query as Record<string, unknown>);
    if (typeof ref === "string") return fail(res, 400, "VALIDATION_ERROR", ref);
    const share = await Share.findOne({ ownerId: me(req).userId, resourceType: ref.resourceType, resourceId: ref.resourceId, topic: ref.topic }).lean<IShare>();
    res.json({ share: share ? await ownerShareDto(share) : null });
  })
);

const ownShare = async (req: Request, res: Response): Promise<IShare | null> => {
  const id = req.params.id;
  const share = SHARE_ID_RE.test(id) ? await Share.findOne({ _id: id, ownerId: me(req).userId }).lean<IShare>() : null;
  if (!share) fail(res, 404, "NOT_FOUND", "Not found");
  return share;
};

router.patch(
  "/:id",
  writeLimit,
  inviteGate("addEmails"),
  wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const role = parseRole(body.role, "role");
    if (!isRole(role)) return fail(res, 400, "VALIDATION_ERROR", role);
    const add = parsePeople(body.addEmails, "addEmails", role);
    if (typeof add === "string") return fail(res, 400, "VALIDATION_ERROR", add);
    const remove = parseEmails(body.removeEmails, "removeEmails");
    if (typeof remove === "string") return fail(res, 400, "VALIDATION_ERROR", remove);
    const roles = body.roles === undefined ? [] : parsePeople(body.roles, "roles");
    if (typeof roles === "string") return fail(res, 400, "VALIDATION_ERROR", roles);
    if (Array.isArray(body.roles) && body.roles.some((r: unknown) => !r || typeof r !== "object" || !isRole((r as Record<string, unknown>).role)))
      return fail(res, 400, "VALIDATION_ERROR", `roles must be a list of {email, role} with role one of ${SHARE_ROLES.join(", ")}`);
    if (body.link !== undefined && typeof body.link !== "boolean") return fail(res, 400, "VALIDATION_ERROR", "link must be true or false");
    if (!add.length && !remove.length && !roles.length && body.link === undefined)
      return fail(res, 400, "VALIDATION_ERROR", "Send addEmails, removeEmails, roles and/or link");
    const caller = me(req);
    let share = await ownShare(req, res);
    if (!share) return;
    const owned = await loadOwned({ resourceType: share.resourceType, resourceId: share.resourceId, topic: share.topic }, caller.userId);
    if (!owned) return fail(res, 404, "NOT_FOUND", "Not found");
    const set: Record<string, unknown> = { title: resourceTitle(owned) };
    if (body.link === true && !share.link) set.link = { token: generateRawToken(), role: "viewer" };
    if (body.link === false) set.link = null;
    await Share.updateOne({ _id: share._id }, { $set: set, ...(remove.length ? { $pull: { grants: { email: { $in: remove } } } } : {}) });
    // Role changes: one positional update per person still on the share (lowering takes effect on the next write).
    for (const r of roles) {
      if (remove.includes(r.email)) continue;
      await Share.updateOne({ _id: share._id, "grants.email": r.email }, { $set: { "grants.$.role": r.role } });
    }
    share = (await Share.findById(share._id).lean<IShare>())!;
    const result = await addGrants(share, add, caller);
    if (typeof result === "string") return fail(res, 400, "VALIDATION_ERROR", result);
    share = (await Share.findById(share._id).lean<IShare>())!;
    mailInvites(share, result.added, caller);
    // Someone removed or lowered: their open live stream on the notebook closes now, pushes already 404.
    if (share.resourceType === "notebook" && (remove.length || roles.length)) publishPageEvent(String(share.resourceId), { type: "revoke" });
    res.json({ share: await ownerShareDto(share) });
  })
);

router.delete(
  "/:id",
  writeLimit,
  wrap(async (req, res) => {
    const share = await ownShare(req, res);
    if (!share) return;
    await Share.deleteOne({ _id: share._id, ownerId: me(req).userId });
    if (share.resourceType === "notebook") publishPageEvent(String(share.resourceId), { type: "revoke" });
    res.status(204).end();
  })
);

/** Through the link, whoever last edited it shows by first name only, like the owner. */
const linkSafe = (e: { name: string; at: string | null } | null, via: string) => (e && via === "link" ? { ...e, name: firstName(e) } : e);

// ─── recipient routes ───────────────────────────────────────────────────────────────────

router.get(
  "/with-me",
  readLimit,
  wrap(async (req, res) => {
    const caller = me(req);
    await bindEmailGrants(caller);
    const shares = await Share.find(grantedToFilter(caller)).sort({ updatedAt: -1 }).limit(200).lean<IShare[]>();
    const owners = await Admin.find({ _id: { $in: shares.map((s) => s.ownerId) } }, { name: 1, email: 1 }).lean<{ _id: Types.ObjectId; name?: string; email?: string }[]>();
    const ownerName = new Map(owners.map((o) => [String(o._id), displayName(o)]));
    const items = [];
    for (const s of shares) {
      const resource = await loadOwned({ resourceType: s.resourceType, resourceId: s.resourceId, topic: s.topic }, s.ownerId);
      if (!resource) continue; // the owner deleted it
      items.push({
        id: String(s._id),
        resourceType: s.resourceType,
        title: resourceTitle(resource),
        ownerName: ownerName.get(String(s.ownerId)) ?? "Someone",
        role: callerGrant(s, caller)?.role ?? "viewer",
        sharedAt: callerGrant(s, caller)?.addedAt ?? s.createdAt,
        updatedAt: (await resourceUpdatedAt(resource)) ?? s.updatedAt,
        editedBy: await resourceEditedBy(resource),
      });
    }
    res.json({ items });
  })
);

router.get(
  "/forks",
  readLimit,
  wrap(async (req, res) => {
    const rows = await ShareFork.find({ userId: me(req).userId }).sort({ createdAt: -1 }).limit(500).lean();
    res.json({
      items: rows.map((f) => ({
        resourceType: f.resourceType,
        resourceId: String(f.resourceId),
        topic: f.topic ?? null,
        forkedFrom: { shareId: String(f.forkedFrom.shareId), ownerName: f.forkedFrom.ownerName, title: f.forkedFrom.title, resourceType: f.forkedFrom.resourceType },
        createdAt: f.createdAt,
      })),
    });
  })
);

router.get(
  "/view/:idOrToken",
  readLimit,
  wrap(async (req, res) => {
    const caller = me(req);
    await bindEmailGrants(caller);
    const found = await resolveShared(req.params.idOrToken, caller, "read");
    if (!found) return fail(res, 404, "NOT_FOUND", "This link doesn't work any more, or it wasn't shared with this account.");
    const { share, resource, via } = found;
    const owner = await Admin.findById(share.ownerId, { name: 1, email: 1 }).lean<{ name?: string; email?: string }>();
    // Opening by the share id as a named editor = editable; through the link it is always view-only.
    const role: ShareRole = via === "owner" ? "editor" : via === "grant" ? (callerGrant(share, caller)?.role ?? "viewer") : "viewer";
    res.json({
      share: {
        id: String(share._id),
        resourceType: share.resourceType,
        title: resourceTitle(resource),
        ownerName: via === "link" ? firstName(owner) : displayName(owner),
        isOwner: via === "owner",
        role,
        // Editors write through the study routes with these ids (the page, class or map).
        ...(role === "editor" ? { resourceId: String(share.resourceId), topic: share.topic ?? null } : {}),
        updatedAt: (await resourceUpdatedAt(resource)) ?? share.updatedAt,
        editedBy: linkSafe(await resourceEditedBy(resource), via),
      },
      content: await snapshot(resource),
    });
  })
);

// A shared notebook's PDF background, from the owner's store: anyone who may open the view (owner,
// named viewer or editor, link holder) — the view never hands viewers the page id, so they come here.
router.get(
  "/view/:idOrToken/pdf-assets/:assetId",
  readLimit,
  wrap(async (req, res) => {
    if (!validAssetId(req.params.assetId)) return fail(res, 400, "INVALID_ID", "Invalid asset id");
    const caller = me(req);
    await bindEmailGrants(caller);
    const found = await resolveShared(req.params.idOrToken, caller, "read");
    if (!found || found.resource.type !== "notebook") return fail(res, 404, "NOT_FOUND", "This link doesn't work any more, or it wasn't shared with this account.");
    await sendAssetUrl(res, String(found.share.ownerId), req.params.assetId);
  })
);

router.post(
  "/fork/:idOrToken",
  forkLimit,
  wrap(async (req, res) => {
    const caller = me(req);
    await bindEmailGrants(caller);
    const found = await resolveShared(req.params.idOrToken, caller, "read");
    if (!found) return fail(res, 404, "NOT_FOUND", "This link doesn't work any more, or it wasn't shared with this account.");
    const { share, resource, via } = found;
    const owner = await Admin.findById(share.ownerId, { name: 1, email: 1 }).lean<{ name?: string; email?: string }>();
    const title = resourceTitle(resource);
    const copy = await forkResource(resource, caller.userId);
    await ShareFork.create({
      userId: caller.userId,
      resourceType: share.resourceType,
      resourceId: copy.resourceId,
      topic: copy.topic,
      forkedFrom: { shareId: share._id, ownerName: via === "link" ? firstName(owner) : displayName(owner), title, resourceType: share.resourceType, resourceId: share.resourceId },
    });
    res.status(201).json({
      resourceType: share.resourceType,
      resourceId: String(copy.resourceId),
      topic: copy.topic,
      classId: copy.classId ? String(copy.classId) : null,
    });
  })
);

export default router;
