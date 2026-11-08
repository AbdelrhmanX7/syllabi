import { parseJsonLoose, Spend, visionCall } from "./ai-models";
import { cleanTerms } from "./concept-map-terms";

/**
 * Reference map from a phone photo (`POST /study/concept-maps/reference {images}`): the prompt
 * terms are read off the owner's pictures of the lecture — ONE vision call, all pictures in one
 * turn — together with a 1–3 sentence summary per picture that grounds the map as an `image` block.
 * The read terms only drive this request; they are never written to a map.
 */

export const PHOTO_IMAGES_MAX = 4;
/** Long edge of a picture sent to the model (the FE already sends ≤ 1600). */
export const PHOTO_MAX_PX = 1600;
const SUMMARY_MAX_CHARS = 600;

export const PHOTO_TERMS_PROMPT_EN = [
  "These pictures are from the lecture — slides, a textbook page, the board. List the key concept terms shown, exactly as written, at most 15.",
  "Also describe each picture in 1–3 sentences: what it shows and the ideas it connects (for a concept map of those terms).",
  "Skip course codes, dates, page numbers, headings like \"Lecture 8\" and instructions; a term is a concept, usually 1–4 words.",
  'Return ONE JSON object: {"terms":["..."],"pictures":[{"summary":"..."}]} with one entry in pictures per picture, in the order given. No terms readable: "terms":[].',
].join("\n");

export interface PhotoRead {
  terms: string[];
  /** One per picture, in input order ("" when the model said nothing about it). */
  summaries: string[];
}

export function parsePhotoRead(raw: unknown, pictures: number): PhotoRead {
  const o = typeof raw === "string" ? parseJsonLoose(raw) : raw;
  const terms = cleanTerms(Array.isArray(o?.terms) ? o.terms.filter((t: unknown): t is string => typeof t === "string") : []);
  const list = Array.isArray(o?.pictures) ? o.pictures : [];
  const summaries = Array.from({ length: pictures }, (_, i) => {
    const p = list[i];
    const s = typeof p === "string" ? p : typeof p?.summary === "string" ? p.summary : "";
    return s.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX_CHARS);
  });
  return { terms, summaries };
}

/** `pngs` (already normalised by the caller) → the terms + per-picture summaries. Throws on a vision failure. */
export async function readPhotoTerms(pngs: Buffer[], spend: Spend, signal?: AbortSignal): Promise<PhotoRead> {
  const prompt = `${PHOTO_TERMS_PROMPT_EN}${pngs.length > 1 ? `\n\nThere are ${pngs.length} pictures.` : ""}`;
  return parsePhotoRead(await visionCall(pngs, "image/png", prompt, spend, { signal, json: true }), pngs.length);
}
