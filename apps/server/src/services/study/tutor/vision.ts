import { callVision } from "@/services/whiteboard-ai/vision";
import { STUDY_VISION_MODELS, type Spend } from "../ai-models";
import { toPng } from "../extract-sources";

/**
 * The lasso image (`context.imagePngB64`) is READ first — one short vision call, hard-capped at
 * 20 s overall — and the reading is folded into the question as the student's selection.
 */
export const LASSO_DEADLINE_MS = 20_000;
/** Per model attempt; the overall deadline above still wins. */
const PER_MODEL_MS = 15_000;
export const MAX_IMAGE_B64 = 11 * 1024 * 1024; // ≈ 8 MB decoded

export const LASSO_READ_PROMPT = [
  "This is a selection a student lassoed on their notes, a slide, or a page.",
  "Transcribe what it contains, briefly and literally, WITHOUT solving or explaining:",
  "- text (printed or handwritten) as written; math as LaTeX between $…$;",
  "- a diagram/graph/figure: one or two sentences on what it shows (labels, axes, values).",
  "At most 150 words. If nothing is readable, reply exactly: (nothing readable)",
].join("\n");

export const decodeImageB64 = (v: unknown): Buffer | null => {
  if (typeof v !== "string" || !v || v.length > MAX_IMAGE_B64) return null;
  const b = Buffer.from(v.replace(/^data:[^;]+;base64,/, ""), "base64");
  return b.length > 32 ? b : null;
};

/** The reading ("" when nothing is readable). Throws on a vision failure / the 20 s deadline. */
export async function readLasso(image: Buffer, spend: Spend, signal: AbortSignal): Promise<string> {
  const png = await toPng(image);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(LASSO_DEADLINE_MS)]);
  try {
    const v = await callVision(png, "image/png", LASSO_READ_PROMPT, { signal: deadline, timeoutMs: PER_MODEL_MS, deadlineMs: LASSO_DEADLINE_MS, models: STUDY_VISION_MODELS });
    spend.visionCostUsd += v.costUsd;
    spend.models.push(...v.tried.slice(0, -1).map((m) => `openrouter/${m}`), v.model);
    const text = String(v.raw ?? "").trim();
    return /^\(?nothing readable\)?\.?$/i.test(text) ? "" : text.slice(0, 2000);
  } catch (e: any) {
    spend.visionCostUsd += Number(e?.costUsd) || 0;
    if (Array.isArray(e?.tried)) spend.models.push(...e.tried.map((m: string) => `openrouter/${m}`));
    throw e;
  }
}
