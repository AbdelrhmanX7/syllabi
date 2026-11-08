import { Request, Response } from "express";
import { StudyPage, IStudyPage } from "@/models/study/page";
import { canAccess, loadCaller } from "@/services/share/access";
import { pageFor } from "@/services/share/edit";
import { parseAssetIds, presentAssets, sendAssetHead, sendAssetUrl, storeAsset, validAssetId } from "@/services/study/pdf-assets";
import { fail, isOid, wrap } from "./study.controller";

/**
 * Notebook PDF backgrounds (services/study/pdf-assets.ts). Stored per account by asset id.
 *
 *   GET  /pages/:id/pdf-assets?ids=a,b     which of these the page owner holds -> {present}
 *   HEAD /pages/:id/pdf-assets/:assetId    200 / 404
 *   GET  /pages/:id/pdf-assets/:assetId    -> {assetId, url, expiresAt} (signed, fetch without auth)
 *   PUT  /pages/:id/pdf-assets/:assetId    raw PDF ≤ 60 MB -> 201 written / 200 already there
 *   GET|HEAD|PUT /pdf-assets[/:assetId]    the same on the caller's own account (no page: an old
 *                                          install's one-time upload)
 *
 * Page routes: read = the owner, an editor or a named viewer (`canAccess(read)`); write = the owner or
 * an editor (`canAccess(write)`). Always the OWNER's store. Link holders read through
 * `GET /share/view/:idOrToken/pdf-assets/:assetId` (routes/share.ts). Anyone else: 404.
 */

const ownerOf = (p: Pick<IStudyPage, "userId">) => String(p.userId);

async function readablePage(req: Request, res: Response): Promise<IStudyPage | null> {
  if (!isOid(req.params.id)) {
    fail(res, 400, "INVALID_ID", "Invalid page id");
    return null;
  }
  const page = await StudyPage.findOne({ _id: req.params.id, deletedAt: null }, { userId: 1 }).lean<IStudyPage>();
  const caller = page ? await loadCaller(req.adminId) : null;
  const ok =
    page && caller
      ? await canAccess(caller, { resourceType: "notebook", resourceId: page._id, topic: null, ownerId: page.userId }, "read")
      : false;
  if (!ok) {
    fail(res, 404, "NOT_FOUND", "Page not found");
    return null;
  }
  return page;
}

async function writablePage(req: Request, res: Response): Promise<IStudyPage | null> {
  if (!isOid(req.params.id)) {
    fail(res, 400, "INVALID_ID", "Invalid page id");
    return null;
  }
  const found = await pageFor(req.adminId, req.params.id, { userId: 1 });
  if (!found) {
    fail(res, 404, "NOT_FOUND", "Page not found");
    return null;
  }
  return found.doc;
}

function assetIdOf(req: Request, res: Response): string | null {
  if (validAssetId(req.params.assetId)) return req.params.assetId;
  fail(res, 400, "INVALID_ID", "Invalid asset id");
  return null;
}

function idsOf(req: Request, res: Response): string[] | null {
  const ids = parseAssetIds(req.query.ids);
  if (!ids) fail(res, 400, "VALIDATION_ERROR", "ids must be 1..200 comma-separated asset ids");
  return ids;
}

// ─── by page ────────────────────────────────────────────────────────────────────────────

export const listPagePdfAssets = wrap(async (req, res) => {
  const ids = idsOf(req, res);
  if (!ids) return;
  const page = await readablePage(req, res);
  if (!page) return;
  res.json({ present: await presentAssets(ownerOf(page), ids) });
});

export const headPagePdfAsset = wrap(async (req, res) => {
  const assetId = assetIdOf(req, res);
  if (!assetId) return;
  const page = await readablePage(req, res);
  if (!page) return;
  await sendAssetHead(res, ownerOf(page), assetId);
});

export const getPagePdfAsset = wrap(async (req, res) => {
  const assetId = assetIdOf(req, res);
  if (!assetId) return;
  const page = await readablePage(req, res);
  if (!page) return;
  await sendAssetUrl(res, ownerOf(page), assetId);
});

export const putPagePdfAsset = wrap(async (req, res) => {
  const assetId = assetIdOf(req, res);
  if (!assetId) return;
  const page = await writablePage(req, res);
  if (!page) return;
  await storeAsset(res, ownerOf(page), assetId, req.body);
});

// ─── my account ─────────────────────────────────────────────────────────────────────────

const me = (req: Request) => String(req.adminId);

export const listMyPdfAssets = wrap(async (req, res) => {
  const ids = idsOf(req, res);
  if (!ids) return;
  res.json({ present: await presentAssets(me(req), ids) });
});

export const headMyPdfAsset = wrap(async (req, res) => {
  const assetId = assetIdOf(req, res);
  if (!assetId) return;
  await sendAssetHead(res, me(req), assetId);
});

export const getMyPdfAsset = wrap(async (req, res) => {
  const assetId = assetIdOf(req, res);
  if (!assetId) return;
  await sendAssetUrl(res, me(req), assetId);
});

export const putMyPdfAsset = wrap(async (req, res) => {
  const assetId = assetIdOf(req, res);
  if (!assetId) return;
  await storeAsset(res, me(req), assetId, req.body);
});
