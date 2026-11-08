import { Response } from "express";
import { logger } from "@/services/logger.service";
import { getStudyObject, pdfAssetKey, PDF_ASSET_ID_RE, putStudyObject, signedGetUrl, studyObjectExists } from "@/services/study/storage";

/**
 * Notebook PDF backgrounds on the server (storage layout: `pdfAssetKey`). A board's JSON only carries
 * `pdfAssetId` refs; the file itself used to stay on the tablet that imported it. The app now uploads
 * every referenced asset after a save and downloads a missing one before the board mounts.
 *
 * Assets are kept per ACCOUNT, keyed by the asset id, not per page: an id is a client uuid that every
 * page (and every copy of a page) referencing the file shares, an old install can upload without
 * knowing which server page ids its boards became, and deleting the account deletes them with the rest
 * of `study/<userId>/`. The page routes are only an access lens onto the page owner's store.
 */

/** A PDF has `%PDF-` in its first KB (the spec tolerates a little junk before it). */
export const looksLikePdf = (body: Buffer) => body.subarray(0, 1024).includes("%PDF-");

export const validAssetId = (v: unknown): v is string => typeof v === "string" && PDF_ASSET_ID_RE.test(v);

/** `?ids=a,b,c` (max 200, each a valid asset id) or null when malformed. */
export function parseAssetIds(raw: unknown): string[] | null {
  if (typeof raw !== "string" || !raw) return null;
  const ids = Array.from(new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)));
  if (!ids.length || ids.length > 200 || !ids.every(validAssetId)) return null;
  return ids;
}

/** Which of `ids` the account holds. */
export async function presentAssets(ownerId: string, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) if (await studyObjectExists(pdfAssetKey(ownerId, id))) out.push(id);
  return out;
}

const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ message, code });

/**
 * Store one asset under `ownerId`: 400 empty, 415 not a PDF, 200 when the account already holds it
 * (nothing is rewritten), 201 when written now.
 */
export async function storeAsset(res: Response, ownerId: string, assetId: string, body: unknown): Promise<void> {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    fail(res, 400, "EMPTY_BODY", "Request body is empty");
    return;
  }
  if (!looksLikePdf(body)) {
    fail(res, 415, "NOT_A_PDF", "That file is not a PDF");
    return;
  }
  const key = pdfAssetKey(ownerId, assetId);
  if (await studyObjectExists(key)) {
    res.status(200).json({ assetId, created: false });
    return;
  }
  await putStudyObject(key, body, "application/pdf");
  res.status(201).json({ assetId, created: true, size: body.length });
}

/**
 * `{url, expiresAt}` for one asset (404 when the account lacks it). A signed url, fetched WITHOUT the
 * session header, rather than a 302: old WebViews keep `Authorization` across a cross-origin redirect,
 * and a bucket refuses a request carrying both header and query auth.
 */
export async function sendAssetUrl(res: Response, ownerId: string, assetId: string): Promise<void> {
  const key = pdfAssetKey(ownerId, assetId);
  if (!(await studyObjectExists(key))) {
    fail(res, 404, "NOT_FOUND", "That PDF is not stored on the server");
    return;
  }
  res.json({ assetId, ...(await signedGetUrl(key, { contentType: "application/pdf" })) });
}

export async function sendAssetHead(res: Response, ownerId: string, assetId: string): Promise<void> {
  res.status((await studyObjectExists(pdfAssetKey(ownerId, assetId))) ? 200 : 404).end();
}

/** The asset ids a stored board JSON references (`pages[].pdfAssetId`); [] for anything unreadable. */
export function boardAssetIds(body: Buffer | string): string[] {
  try {
    const doc = JSON.parse(typeof body === "string" ? body : body.toString("utf8")) as { pages?: { pdfAssetId?: unknown }[] } | null;
    const ids = new Set<string>();
    for (const page of Array.isArray(doc?.pages) ? doc!.pages : []) if (validAssetId(page?.pdfAssetId)) ids.add(page.pdfAssetId);
    return Array.from(ids);
  } catch {
    return [];
  }
}

/**
 * A copy of a shared page: the PDFs its board references go along, under the same ids (so the copied
 * board's refs resolve) in the new owner's store. Best effort, one at a time: a missing or failing asset
 * never fails the copy.
 */
export async function copyBoardAssets(board: Buffer | string, fromUserId: string, toUserId: string): Promise<number> {
  let copied = 0;
  for (const id of boardAssetIds(board)) {
    try {
      const from = pdfAssetKey(fromUserId, id);
      const to = pdfAssetKey(toUserId, id);
      if (!(await studyObjectExists(from)) || (await studyObjectExists(to))) continue;
      await putStudyObject(to, await getStudyObject(from), "application/pdf");
      copied++;
    } catch (e) {
      await logger.warn("study pdf asset copy failed", { assetId: id, error: String((e as Error)?.message ?? e).slice(0, 300) }).catch(() => {});
    }
  }
  return copied;
}
