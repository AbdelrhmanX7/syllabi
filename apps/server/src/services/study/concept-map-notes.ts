import { createHash } from "crypto";
import type { IStudyConceptMap, NotesDigest } from "@/models/study/concept-map";
import { Spend, visionCall } from "./ai-models";
import { conceptLinks, normTerm, Reading, termPresent } from "./concept-map-parse";

/**
 * Notes-linked concept maps: the owner keeps one notebook note per lecture (the professor's
 * leading questions with the student's answers, pasted slide photos, and the concept map drawn at the
 * end). This module reads those pages (vision, cached per immutable page version), turns them
 * into a digest compared against the professor's wording ("professor wording wins"), and
 * derives notes-grounded grade suggestions DETERMINISTICALLY — the digest never touches a score.
 */

/** Per-page vision budget across all of its tiles (callVision `deadlineMs`). */
export const NOTES_PAGE_DEADLINE_MS = 30_000;
/** Bump when the read/digest prompts change so cached digests rebuild. */
export const NOTES_DIGEST_VERSION = 1;

export const NOTES_READ_PROMPT_EN = [
  "This image is (part of) a college student's handwritten lecture notes for a college class, written in colour pen on lined paper, possibly with photos of the professor's slides pasted in.",
  "Transcribe it FAITHFULLY as plain text, top to bottom — do not correct, summarise, complete or add anything.",
  "- The professor's leading questions (e.g. \"What is osmosis?\"): put each on its own line starting with \"Q: \", and the student's answer under it starting with \"A: \".",
  "- Headings, labels, arrows' words and diagram labels: transcribe them where they appear (an arrow as \"X → Y\").",
  "- Pasted slide photos: transcribe their text under a line \"[slide]\".",
  "- A hand-drawn concept map: list its boxes and labeled arrows under a line \"[concept map]\" as \"A —label→ B\".",
  "- Illegible words: [?]. Nothing readable at all: reply with an empty string.",
].join("\n");

export class NotesPageTimeout extends Error {
  readonly code = "TIMEOUT";
}

/**
 * One page's tiles → its transcription. Tiles are read in parallel under ONE shared deadline
 * (NOTES_PAGE_DEADLINE_MS from the start); a timeout throws NotesPageTimeout so the caller can
 * skip the page and carry on. The stored handwriting OCR, when present, rides along as a hint.
 */
export async function readNotesPage(tiles: Buffer[], ocrHint: string | null, spend: Spend, signal?: AbortSignal, deadlineMs = NOTES_PAGE_DEADLINE_MS): Promise<string> {
  const endAt = Date.now() + deadlineMs;
  const hint = ocrHint?.trim() ? `\n\nThe tablet's own handwriting OCR of this page (may be wrong — use it only to resolve hard-to-read words):\n${ocrHint.trim().slice(0, 4000)}` : "";
  const parts = await Promise.all(
    tiles.map(async (png, i) => {
      const left = endAt - Date.now();
      if (left < 50) throw new NotesPageTimeout("page read timed out");
      const prompt = `${NOTES_READ_PROMPT_EN}${tiles.length > 1 ? `\n\nThis is tile ${i + 1} of ${tiles.length} (top to bottom) of one tall page.` : ""}${hint}`;
      try {
        // effort low: same transcript on the probe page, ~20 % faster (the ink reader's setting).
        return (await visionCall(png, "image/png", prompt, spend, { signal, deadlineMs: left, timeoutMs: left, reasoning: { effort: "low" } })).trim();
      } catch (e: any) {
        if (e?.timedOut) throw new NotesPageTimeout("page read timed out");
        throw e;
      }
    })
  );
  return parts.filter(Boolean).join("\n");
}

/** Cache key of a digest: the pages (ids + versions, in order) + prompt terms + the instructor's feedback. */
export function notesHash(pages: Array<{ pageId: string; version: number }>, m: Pick<IStudyConceptMap, "promptTerms" | "instructor">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: NOTES_DIGEST_VERSION,
        pages: pages.map((p) => [p.pageId, p.version]),
        terms: m.promptTerms ?? [],
        instructor: [m.instructor?.modelAnswer ?? null, m.instructor?.comment ?? null],
      })
    )
    .digest("hex");
}

export const NOTES_DIGEST_SYSTEM_PROMPT = [
  "You compare a college student's own lecture notes with their professor's wording, for one concept-map assignment.",
  "You get: the concept map's prompt terms, the professor's model answer and comment (when known), excerpts of the professor's course material, and the transcription of the student's notes pages (leading questions Q:/A:, slide text, labels).",
  'Return ONE JSON object: {"concepts":[{"term":"...","definitionFromNotes":"...","matchesProfessor":true,"professorWording":"..."}],"questions":[{"q":"...","answerFromNotes":"..."}],"missingFromNotes":["..."],"conflicts":[{"term":"...","notes":"...","professor":"..."}]}',
  "Rules:",
  "- concepts: every prompt term the notes define or explain, plus up to 10 other key concepts the notes define. definitionFromNotes = the notes' definition, close to the student's own words (≤ 200 chars).",
  "- matchesProfessor: true when the notes' definition says the same thing as the professor's wording (model answer, class guide, course material); false when it is incomplete or differs. When false, professorWording = the professor's definition (≤ 200 chars). The professor's wording WINS over the notes and over the textbook.",
  "- professorWording: include it whenever you know the professor's definition, even when it matches.",
  "- questions: every leading question in the notes (lines starting Q:), with answerFromNotes = the student's answer as written (omit when he wrote none).",
  "- missingFromNotes: prompt terms the notes never mention or never define.",
  "- conflicts: only where the notes state something that CONTRADICTS the professor (not merely shorter). notes / professor = the two statements, short.",
  "- Never invent notes content: if the notes do not say it, it is not in definitionFromNotes.",
].join("\n");

/**
 * The digest turn's limits (chars). Together (~185k with the model answer) they stay under the
 * DeepSeek fallback's budget (cm-text CM_CONTEXT_BUDGET.deepseek), so this turn is never re-packed.
 */
export const NOTES_LIBRARY_MAX = 40_000;
export const NOTES_PAGES_TEXT_MAX = 120_000;

/**
 * Notes pages → the STUDENT'S NOTES text within `max`, cut only at page boundaries: whole pages in
 * order while they fit; a first page that alone overflows is cut to fit (so the turn is never
 * empty); everything after the first page that does not fit is dropped. `kept` = the pages in it.
 */
export function packNotesPages<T extends { title: string; text: string }>(pages: T[], max: number = NOTES_PAGES_TEXT_MAX): { text: string; kept: T[] } {
  const parts: string[] = [];
  const kept: T[] = [];
  let left = max;
  for (const [i, p] of pages.entries()) {
    const part = `## Page ${i + 1}${p.title ? ` — ${p.title}` : ""}\n${p.text}`;
    const cost = part.length + (parts.length ? 2 : 0);
    if (cost > left) {
      if (!parts.length) {
        parts.push(part.slice(0, left));
        kept.push(p);
      }
      break;
    }
    parts.push(part);
    kept.push(p);
    left -= cost;
  }
  return { text: parts.join("\n\n"), kept };
}

export function buildNotesDigestTurn(o: { terms: string[]; lecture: string | null; modelAnswer: string | null; comment: string | null; library: string; pages: Array<{ title: string; text: string }> }): string {
  return [
    `PROMPT TERMS: ${o.terms.join(", ") || "(none)"}`,
    o.lecture ? `LECTURE: ${o.lecture}` : "",
    o.modelAnswer ? `PROFESSOR'S MODEL ANSWER:\n${o.modelAnswer.slice(0, 20_000)}` : "",
    o.comment ? `PROFESSOR'S COMMENT: ${o.comment.slice(0, 1000)}` : "",
    o.library ? `PROFESSOR'S COURSE MATERIAL (excerpts):\n${o.library.slice(0, NOTES_LIBRARY_MAX)}` : "",
    `STUDENT'S NOTES:\n${packNotesPages(o.pages).text}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Model reply → NotesDigest. `missingFromNotes` keeps the model's prompt-term verdicts and adds
 * every prompt term that neither a digest concept nor the notes text mentions (deterministic).
 */
export function parseNotesDigest(raw: any, terms: string[], notesText: string): NotesDigest {
  const concepts: NotesDigest["concepts"] = [];
  for (const c of Array.isArray(raw?.concepts) ? raw.concepts : []) {
    const term = s(c?.term, 120);
    const def = s(c?.definitionFromNotes, 400);
    if (!term || !def || concepts.length >= 40 || concepts.some((x) => normTerm(x.term) === normTerm(term))) continue;
    const prof = s(c?.professorWording, 400);
    concepts.push({ term, definitionFromNotes: def, matchesProfessor: c?.matchesProfessor === true, ...(prof ? { professorWording: prof } : {}) });
  }
  const questions: NotesDigest["questions"] = [];
  for (const q of Array.isArray(raw?.questions) ? raw.questions : []) {
    const text = s(q?.q, 300);
    if (!text || questions.length >= 40) continue;
    const a = s(q?.answerFromNotes, 600);
    questions.push({ q: text, ...(a ? { answerFromNotes: a } : {}) });
  }
  const conflicts: NotesDigest["conflicts"] = [];
  for (const c of Array.isArray(raw?.conflicts) ? raw.conflicts : []) {
    const term = s(c?.term, 120);
    const notes = s(c?.notes, 400);
    const professor = s(c?.professor, 400);
    if (term && notes && professor && conflicts.length < 20) conflicts.push({ term, notes, professor });
  }
  const modelMissing = (Array.isArray(raw?.missingFromNotes) ? raw.missingFromNotes : []).map((t: unknown) => s(t, 120)).filter(Boolean);
  const textLines = notesText.split(/\n+/);
  const missingFromNotes = terms.filter(
    (t) =>
      modelMissing.some((m: string) => normTerm(m) === normTerm(t)) ||
      (!termPresent(t, concepts.map((c) => c.term)) && !termPresent(t, textLines))
  );
  return { concepts, questions, missingFromNotes, conflicts };
}

/** The digest as model context (grade / reference): what the notes say, with the professor's wording first. */
export function notesContext(d: NotesDigest): string {
  const lines = d.concepts.map((c) =>
    c.matchesProfessor || !c.professorWording ? `- ${c.term}: ${c.definitionFromNotes}` : `- ${c.term}: notes say "${c.definitionFromNotes}" — the professor says "${c.professorWording}" (use the professor's)`
  );
  const conflicts = d.conflicts.map((c) => `- ${c.term}: notes "${c.notes}" vs professor "${c.professor}" (the professor is right)`);
  return [
    lines.length ? `Definitions from the student's own lecture notes:\n${lines.join("\n")}` : "",
    conflicts.length ? `Where the notes contradict the professor:\n${conflicts.join("\n")}` : "",
    d.missingFromNotes.length ? `Prompt terms the notes never define: ${d.missingFromNotes.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const clip = (t: string, n = 120) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
const bestDef = (c: NotesDigest["concepts"][number]) => (!c.matchesProfessor && c.professorWording ? c.professorWording : c.definitionFromNotes);

/** Max notes-grounded lines added to a verdict's suggestions. */
export const NOTES_SUGGESTIONS_MAX = 3;

/**
 * Deterministic, notes-grounded suggestions for a graded map (never a score input):
 *  1. a prompt term the map is missing that the notes define → add it, with the definition;
 *  2. a concept the notes define whose node has an unlabeled concept→concept arrow → label it from the definition;
 *  3. a notes/professor conflict about a concept on the map → use the professor's wording.
 */
export function notesSuggestions(d: NotesDigest, reading: Reading, terms: string[]): string[] {
  const out: string[] = [];
  const labels = reading.nodes.map((n) => n.label);
  for (const t of terms) {
    if (termPresent(t, labels)) continue;
    const c = d.concepts.find((x) => termPresent(x.term, [t]) || termPresent(t, [x.term]));
    if (c) out.push(`${t} is in your notes but missing from the map — your notes define it as "${clip(bestDef(c))}".`);
  }
  const unlabeled = conceptLinks(reading).filter((e) => !String(e.label ?? "").trim());
  for (const c of d.concepts) {
    const node = reading.nodes.find((n) => (n.kind ?? "concept") === "concept" && termPresent(c.term, [n.label]));
    if (!node || !unlabeled.some((e) => e.from === node.id || e.to === node.id)) continue;
    out.push(`Your notes define ${c.term} as "${clip(bestDef(c))}" — but an arrow at ${node.label} is unlabeled; label it with that relationship.`);
  }
  for (const k of d.conflicts) {
    if (termPresent(k.term, labels)) out.push(`Your notes say ${k.term} is "${clip(k.notes, 80)}", but the professor says "${clip(k.professor, 100)}" — use the professor's wording on the map.`);
  }
  return out.slice(0, NOTES_SUGGESTIONS_MAX);
}
