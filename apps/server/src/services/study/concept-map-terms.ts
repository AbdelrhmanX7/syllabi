import { createHash } from "crypto";
import { Types } from "mongoose";
import { IStudyConceptMap, StudyConceptMap } from "@/models/study/concept-map";
import { IStudyItem, StudyItem } from "@/models/study/item";
import { StudyAiUsage } from "@/models/study/ai-usage";
import { logger } from "@/services/logger.service";
import { newSpend, spendTotal, textJson, spendForUser } from "./ai-models";
import { aiEnabledFor } from "@/auth/verified";
import { htmlToText } from "./extract-sources";
import { splitTerms } from "./concept-map-parse";
import { itemTextSource } from "./text-sources";

/**
 * Concept-map prompt terms from the linked Canvas "Concept Map N" assignment.
 *
 * Deterministic first (parseTermsHtml): a "terms:/concepts:" list, an <ul>/<ol> whose items
 * are all term-shaped, or bold terms under such a cue. Only when the description (or a linked
 * PDF attachment) CUES a term list that the parser cannot read does ONE cheap text-model call
 * extract them — cached on the map by the hash of that text, spend in `study_ai_usages`
 * (`concept_map_terms`). A manual list (PATCH, `promptTermsSource:'manual'`) always wins.
 *
 * Note: some professors' descriptions carry NO terms ("Follow the prompt provided in
 * lecture"). Once the professor posts a model answer (a submission comment, pulled by the
 * Canvas sync), the same one cheap call reads the terms from that answer instead — still cached
 * by hash, still only while the map has none.
 */

export const TERMS_MAX = 15;
const TERM_MAX_CHARS = 120;

const BOILERPLATE = /^(?:concept\s*map(?:\s*\d+)?|.*\binstructions?|ai\s*policy|grading|rubric|due(?:\s*date)?|submission|points?|note|important|reminder|prompt|key\s*terms|terms|concepts)$/i;
const INSTRUCTION_WORDS = /\b(?:you|your|please|upload|submit|create|take|click|follow|refer|include|use|using|make|draw|complete)\b/i;

/** A list entry that reads like a term, not an instruction or a heading. */
export function termLike(raw: string): boolean {
  const t = raw.trim();
  return !!t && t.length <= 60 && t.split(/\s+/).length <= 6 && !/[.?!:;]$/.test(t) && !BOILERPLATE.test(t) && !INSTRUCTION_WORDS.test(t);
}

/** Trim, drop empties, de-duplicate case-insensitively (first spelling wins), cap at TERMS_MAX. */
export function cleanTerms(xs: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of xs) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (t && t.length <= TERM_MAX_CHARS && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()].slice(0, TERMS_MAX);
}

/** "terms: …", "Concepts (use all):", "Vocabulary —" … followed by the list on the same line or the next. */
const CUE = /\b(?:prompt\s*terms?|key\s*terms?|terms|concepts|vocabulary)\b[^.\n:]{0,40}?(?::|\s[-–—]\s)[ \t]*/i;

/**
 * Deterministic read of a Canvas assignment description. `cue` = it announces a term list
 * (the model fallback is worth one call); [] with no cue = the description has no terms.
 */
export function parseTermsHtml(html: string | null | undefined): { terms: string[]; cue: boolean } {
  if (!html) return { terms: [], cue: false };
  const text = htmlToText(html);
  const m = text.match(new RegExp(`${CUE.source}([^\\n]*)`, "i"));
  const cue = !!m;
  if (m) {
    const inline = splitTerms(m[1]).filter(termLike);
    if (inline.length >= 2) return { terms: cleanTerms(inline), cue: true };
  }
  for (const list of html.matchAll(/<(ul|ol)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const items = [...list[2].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((x) => htmlToText(x[1]).trim()).filter(Boolean);
    if (items.length >= 2 && items.every(termLike)) return { terms: cleanTerms(items), cue: true };
  }
  if (cue) {
    const bold = [...html.matchAll(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((x) => htmlToText(x[2]).trim()).filter(termLike);
    if (bold.length >= 2) return { terms: cleanTerms(bold), cue };
  }
  return { terms: [], cue };
}

export const TERMS_EXTRACT_SYSTEM_PROMPT = [
  "You read a college professor's Canvas assignment for an in-class concept map and list the PROMPT TERMS: the key terms/concepts the student's concept map must include.",
  'Return ONE JSON object: {"terms":["...","..."]}.',
  "- Only terms the text actually lists for this map, in its order, spelled as written. At most 15.",
  "- Not instructions, headings, policies, grading notes, or generic words like \"key terms\" or \"concepts\".",
  '- If the text gives no specific terms (e.g. "follow the prompt provided in lecture"), return {"terms":[]}.',
].join("\n");

export const TERMS_FROM_ANSWER_SYSTEM_PROMPT = [
  "You read a college professor's MODEL ANSWER for an in-class concept map and list the PROMPT TERMS they gave for that map: the 4–6 key terms/concepts the answer is built around and defines.",
  'Return ONE JSON object: {"terms":["...","..."]}.',
  "- Short noun phrases spelled as in the answer, capitalised like a heading (e.g. \"Cell Membrane\"), in the order the answer introduces them. At most 8.",
  "- Only the central terms the answer explains and connects — not every noun, example, name or place it mentions.",
].join("\n");

const FILE_LINK = /\/files\/(\d+)/g;

/** Text of PDF attachments linked from the description (synced Canvas file items), ≤ 2 files. */
async function attachmentTexts(userId: Types.ObjectId, item: IStudyItem): Promise<string[]> {
  const ids = [...new Set([...(item.html ?? "").matchAll(FILE_LINK)].map((x) => x[1]))].slice(0, 5);
  if (!ids.length) return [];
  const files = await StudyItem.find({ userId, classId: item.classId, type: "file", canvasId: { $in: ids } }, { _id: 1 }).limit(2).lean<IStudyItem[]>();
  const out: string[] = [];
  for (const f of files) {
    const src = await itemTextSource(userId, String(f._id)).catch(() => null);
    if (src?.kind === "text") out.push(src.text.slice(0, 10_000));
  }
  return out;
}

async function extractWithModel(userId: Types.ObjectId, text: string, system = TERMS_EXTRACT_SYSTEM_PROMPT): Promise<string[]> {
  const spend = await spendForUser(userId, { background: true });
  const startedAt = Date.now();
  let status: "done" | "error" = "done";
  let error: string | null = null;
  try {
    const raw = await textJson(system, text.slice(0, 20_000), spend, { maxTokens: 1024, disableThinking: true, claude: "haiku" });
    return cleanTerms((Array.isArray(raw?.terms) ? raw.terms : []).filter((t: unknown): t is string => typeof t === "string"));
  } catch (e) {
    status = "error";
    error = String((e as Error)?.message ?? e).slice(0, 500);
    throw e;
  } finally {
    if (spend.models.length)
      await StudyAiUsage.create({
        userId,
        endpoint: "concept_map_terms",
        status,
        error,
        models: spend.models,
        visionCostUsd: 0,
        textCostUsd: Number(spend.textCostUsd.toFixed(6)),
        costUsd: Number(spendTotal(spend).toFixed(6)),
        latencyMs: Date.now() - startedAt,
      }).catch(() => undefined);
  }
}

/**
 * Lazy fill (list / GET / grade / reference / practice / Canvas sync): a map with no prompt terms
 * and no manual list gets them — deterministically from its Canvas assignment when it lists them,
 * else by one cached model call over the professor's model answer (when there is one), else over
 * a description that cues a list. Returns the map as it now reads. Never throws — a failed
 * extraction leaves the map as it was.
 */
export async function fillPromptTerms(userId: Types.ObjectId, m: IStudyConceptMap): Promise<IStudyConceptMap> {
  if (m.promptTerms?.length || m.promptTermsSource === "manual") return m;
  const answer = m.instructor?.modelAnswer?.trim() || null;
  if (!m.canvasItemId && !answer) return m;
  try {
    const item = m.canvasItemId ? await StudyItem.findOne({ _id: m.canvasItemId, userId }, { html: 1, classId: 1 }).lean<IStudyItem>() : null;
    const parsed = parseTermsHtml(item?.html);
    let terms = parsed.terms;
    let termsExtraction = m.termsExtraction ?? null;
    if (!terms.length) {
      // One source per map, so the single cache slot never ping-pongs between two hashes.
      let source: string | null = null;
      let system = TERMS_EXTRACT_SYSTEM_PROMPT;
      if (answer) {
        source = `MODEL ANSWER:\n${answer}`;
        system = TERMS_FROM_ANSWER_SYSTEM_PROMPT;
      } else if (item?.html) {
        const attachments = await attachmentTexts(userId, item);
        if (parsed.cue || attachments.length) source = [htmlToText(item.html), ...attachments].join("\n\n---\n\n");
      }
      if (!source) return m;
      const hash = createHash("sha256").update(source).digest("hex");
      if (termsExtraction?.hash === hash) terms = termsExtraction.terms;
      else if (!(await aiEnabledFor(userId))) return m; // the model read is an AI feature
      else {
        terms = await extractWithModel(userId, source, system);
        termsExtraction = { hash, terms, at: new Date() };
        await StudyConceptMap.updateOne({ _id: m._id, userId }, { $set: { termsExtraction } }, { timestamps: false });
      }
    }
    if (!terms.length) return { ...m, termsExtraction };
    const r = await StudyConceptMap.updateOne(
      { _id: m._id, userId, "promptTerms.0": { $exists: false }, promptTermsSource: { $ne: "manual" } },
      { $set: { promptTerms: terms, promptTermsSource: "canvas" } }
    );
    return r.modifiedCount ? { ...m, promptTerms: terms, promptTermsSource: "canvas", termsExtraction } : ((await StudyConceptMap.findById(m._id).lean<IStudyConceptMap>()) ?? m);
  } catch (e) {
    await logger.warn("study concept-map terms: extraction failed", { mapId: String(m._id), error: String((e as Error)?.message ?? e).slice(0, 300) });
    return m;
  }
}
