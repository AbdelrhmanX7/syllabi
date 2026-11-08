/**
 * Pure parsers for the class folder (P-CM): CONCEPT-MAPS.md, the class guide (CLAUDE.md),
 * INDEX.md week dates, the mineral-kit line and the lab study-guide table. No I/O here, so the
 * tests drive them with small synthetic strings — never with the owner's files.
 */

export interface ParsedConceptMap {
  number: number;
  week: number | null;
  lecture: string | null;
  dueAt: string | null;
  points: number;
  promptTerms: string[];
  imagePath: string | null;
  transcription: string | null;
  comment: string | null;
  modelAnswer: string | null;
  score: number | null;
  canvasAssignmentId: string | null;
}

const NOT_YET = /^_?(not added yet|none beyond the model answer below|none)\b.*_?\.?$/i;
const clean = (t: string | null | undefined): string | null => {
  const s = (t ?? "").trim();
  if (!s || NOT_YET.test(s) || /^_[^_]*not added yet[^_]*_\.?$/i.test(s)) return null;
  return s;
};

/** "A, B, C and D." / "A, B, and C" / bullet lists → ["A","B","C","D"]. */
export function splitTerms(raw: string): string[] {
  const t = raw
    .replace(/<[^>]+>/g, "\n")
    .replace(/\*\*/g, "")
    .replace(/\.\s*$/, "")
    .trim();
  const parts = t
    .split(/\s*(?:,|;|\n|•|^\s*[-*]\s+|\band\b)\s*/im)
    .map((p) => p.replace(/^[-*\d.)\s]+/, "").replace(/[.]+$/, "").trim())
    .filter((p) => p && p.length <= 80 && !/^and$/i.test(p));
  return [...new Map(parts.map((p) => [p.toLowerCase(), p])).values()].slice(0, 20);
}

/** Text between `**Label**` (optionally followed by more words/parens and a colon) and the next bold label. */
function field(section: string, label: RegExp): string | null {
  const m = section.match(new RegExp(`\\*\\*(?:${label.source})\\*\\*([^\\n]*)\\n?([\\s\\S]*?)(?=\\n\\*\\*[A-Z][^*]{1,60}\\*\\*|\\nSource:|$)`, "i"));
  if (!m) return null;
  const inline = m[1].replace(/^\s*(\([^)]*\))?\s*:?\s*/, "").trim();
  const body = m[2].trim();
  return [inline, body].filter(Boolean).join("\n").trim() || null;
}

/** CONCEPT-MAPS.md → the rubric page text + one record per "### Assignment: … Concept Map N" section. */
export function parseConceptMapsMd(md: string): { rubric: string | null; maps: ParsedConceptMap[] } {
  const sections = md.split(/\n(?=### )/);
  const rubricSec = sections.find((s) => /^### Page:.*grad/i.test(s));
  const rubric = rubricSec ? rubricSec.replace(/^### Page:[^\n]*\n/, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim() : null;
  const maps: ParsedConceptMap[] = [];
  for (const sec of sections) {
    const h = sec.match(/^### Assignment:.*?Concept Map\s*(\d+)/i);
    if (!h) continue;
    const number = Number(h[1]);
    const meta = sec.match(/Due:\s*(\d{4}-\d{2}-\d{2})?[^\n]*/i)?.[0] ?? "";
    const week = meta.match(/Week\s*(\d+)/i);
    const points = meta.match(/Points:\s*(\d+(?:\.\d+)?)/i);
    const lecture = meta.match(/·\s*(Lecture\s*\d+[^·\n]*)$/i);
    const terms = field(sec, /Prompt terms/);
    const img = sec.match(/!\[[^\]]*\]\(<?([^)>]+)>?\)/);
    const transcription = field(sec, /Transcription of my map/);
    const comment = field(sec, /Instructor comment/);
    const modelRaw = field(sec, /Instructor notes \(model answer\)|Instructor notes/);
    const model = modelRaw
      ? modelRaw
          .split("\n")
          .map((l) => l.replace(/^>\s?/, ""))
          .join("\n")
          .replace(/^\(added [^)]*\)\s*/i, "")
          .trim()
      : null;
    const scoreRaw = clean(field(sec, /Score/));
    const scoreNum = scoreRaw?.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of)?/);
    const src = sec.match(/Source:\s*\S*\/assignments\/(\d+)/i);
    maps.push({
      number,
      week: week ? Number(week[1]) : null,
      lecture: lecture ? lecture[1].replace(/^Lecture\s*(\d+):\s*/i, "L$1 ").trim() : null,
      dueAt: meta.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
      points: points ? Number(points[1]) : 10,
      promptTerms: terms && clean(terms) ? splitTerms(terms) : [],
      imagePath: img ? img[1].trim() : null,
      transcription: clean(transcription?.replace(/^_\(Image file[^\n]*\n?/i, "").trim()),
      comment: clean(comment?.replace(/^"|"$/g, "")),
      modelAnswer: clean(model),
      score: scoreNum ? Number(scoreNum[1]) : null,
      canvasAssignmentId: src ? src[1] : null,
    });
  }
  return { rubric, maps: maps.sort((a, b) => a.number - b.number) };
}

// ─── class guide ────────────────────────────────────────────────────────────────────────

/** Sections of the folder guide that are about local tooling, not the class. */
const DROP_SECTIONS = /^(folder layout|how to find things|making study materials)\b/i;
const DROP_LINE = /claude\.ai\/artifact|pdftotext|google-chrome|headless|file:\/\/|reportlab|convert-pptx|_originals|\bgrep\b|`[^`]*\.(?:md|pdf|sh)`|scratchpad|\bshell\b|quote paths|\bfind\b`|LibreOffice/i;

/** The folder's CLAUDE.md → class guide markdown without local paths and tooling. */
export function sanitizeGuide(md: string): string {
  const parts = md.split(/\n(?=## )/);
  const kept = parts.filter((p) => !DROP_SECTIONS.test(p.replace(/^##\s*/, "")));
  return kept
    .map((p) =>
      p
        .split("\n")
        .filter((l) => !DROP_LINE.test(l))
        .join("\n")
    )
    .join("\n")
    .replace(/^# .*guide for Claude.*$/im, "# Class guide")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** INDEX.md week table → [{week, start, end}] (rows without dates are skipped). */
export function parseIndexWeeks(md: string): Array<{ week: number; start: string; end: string }> {
  const out: Array<{ week: number; start: string; end: string }> = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\|\s*`?Week-(\d+)[^|]*\|[^|]*\|\s*(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})\s*\|/);
    if (m) out.push({ week: Number(m[1]), start: m[2], end: m[3] });
  }
  return out;
}

export const weekOfDate = (date: string | null, weeks: Array<{ week: number; start: string; end: string }>): number | null => {
  if (!date) return null;
  const w = weeks.find((x) => date >= x.start && date <= x.end);
  return w ? w.week : null;
};

export interface ScheduleRow {
  name: string;
  date: string | null;
  chapters: string[];
  topics: string[];
}

/** "Ch. 5–8" → ["Ch.5","Ch.6","Ch.7","Ch.8"]. */
export function chapterRange(text: string): string[] {
  const m = text.match(/Ch\.?\s*(\d+)\s*(?:[–\-~]\s*(\d+))?/i);
  if (!m) return [];
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (b < a || b - a > 30) return [`Ch.${a}`];
  return Array.from({ length: b - a + 1 }, (_, i) => `Ch.${a + i}`);
}

/** The guide's "## Schedule" table → exam rows (name, date, chapters, topics). Non-exam rows are dropped. */
export function parseSchedule(md: string): ScheduleRow[] {
  const sec = md.split(/\n(?=## )/).find((p) => /^##\s*Schedule/i.test(p));
  if (!sec) return [];
  const out: ScheduleRow[] = [];
  for (const line of sec.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4 || /^-+$/.test(cells[1]) || /^when$/i.test(cells[1])) continue;
    const [when, what] = [cells[1], cells[2].replace(/\*\*/g, "")];
    const name = what.match(/^((?:Exam\s*\d+|Final|Midterm(?:\s*\d+)?|Quiz\s*\d+)[^(:,]*)/i)?.[1]?.trim();
    if (!name) continue;
    const topics = (what.split(/:\s*/)[1] ?? "")
      .split(/,\s*/)
      .map((t) => t.replace(/[.;]+$/, "").replace(/^done$/i, "").trim())
      .filter(Boolean);
    out.push({ name, date: when.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null, chapters: chapterRange(what), topics });
  }
  return out;
}

/** "**Lab mineral kit numbers** (…): 1 talc, 2 gypsum, … 20 limonite. Samples 21–30 are unknowns." */
export function parseMineralKit(md: string): { items: Array<{ number: number; name: string }>; unknown: number[] } {
  const line = md.match(/\*\*Lab mineral kit numbers\*\*[^:]*:\s*([^\n]+)/i)?.[1];
  if (!line) return { items: [], unknown: [] };
  const items: Array<{ number: number; name: string }> = [];
  for (const m of line.split(/\.\s+Samples|\.\s*$/i)[0].matchAll(/(\d{1,3})\s+([A-Za-z][A-Za-z\- ]*?)(?=,|\.|$)/g)) items.push({ number: Number(m[1]), name: m[2].trim() });
  const u = line.match(/Samples\s*(\d+)\s*[–\-]\s*(\d+)\s*are unknown/i);
  const unknown = u ? Array.from({ length: Number(u[2]) - Number(u[1]) + 1 }, (_, i) => Number(u[1]) + i) : [];
  return { items, unknown };
}

/** Best-effort row parse of a `pdftotext -layout` kit table: "N  Name  NM|M  H  streak  cleavage". */
export type KitRow = { luster: string; hardness: string; streak: string | null; cleavage: string | null; notes: string | null };
export function parseKitTable(text: string): Map<number, KitRow> {
  const out = new Map<number, KitRow>();
  for (const line of text.split("\n")) {
    const tok = line.trim().split(/\s{2,}/);
    if (tok.length < 4 || !/^\d{1,2}$/.test(tok[0])) continue;
    const li = tok.findIndex((t, i) => i > 0 && /^(NM|M)$/.test(t));
    if (li < 1 || li + 1 >= tok.length || !/^[\d.]+(?:\s*[–\-]\s*[\d.]+)?$/.test(tok[li + 1])) continue;
    const n = Number(tok[0]);
    if (out.has(n)) continue;
    out.set(n, { luster: tok[li] === "M" ? "metallic" : "nonmetallic", hardness: tok[li + 1], streak: tok[li + 2] ?? null, cleavage: tok[li + 3] ?? null, notes: tok.slice(li + 4).join(" ") || null });
  }
  return out;
}

// ─── fuzzy term matching (deterministic grading facts) ─────────────────────────────────

export const normTerm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[’']s\b/g, "s")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join(" ");

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const similar = (a: string, b: string) => {
  if (!a || !b) return false;
  const d = levenshtein(a, b);
  return d <= Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.2));
};

/** A prompt term counts as present when a label contains it (word-aligned) or a label window is a near spelling. */
export function termPresent(term: string, labels: string[]): boolean {
  const t = normTerm(term);
  if (!t) return true;
  const tw = t.split(" ");
  for (const raw of labels) {
    const l = normTerm(raw);
    if (!l) continue;
    if (` ${l} `.includes(` ${t} `) || similar(l, t)) return true;
    const lw = l.split(" ");
    for (let i = 0; i + tw.length <= lw.length; i++) if (similar(lw.slice(i, i + tw.length).join(" "), t)) return true;
  }
  return false;
}

/** `kind`: "concept" = a boxed/circled term or idea; "note" = a free-standing definition/explanation. */
export interface Reading {
  nodes: Array<{ id: string; label: string; kind?: "concept" | "note" }>;
  edges: Array<{ from: string; to: string; label: string }>;
}

export const missingTermsOf = (terms: string[], r: Reading) => terms.filter((t) => !termPresent(t, r.nodes.map((n) => n.label)));

/**
 * Links that need a label: arrows between two CONCEPT nodes. An arrow from a concept to its own
 * definition note says "is defined as" by itself, so it is not held to the labeling rule.
 */
export function conceptLinks(r: Reading) {
  const note = new Set(r.nodes.filter((n) => n.kind === "note").map((n) => n.id));
  return r.edges.filter((e) => !note.has(e.from) && !note.has(e.to));
}
export const unlabeledArrowsOf = (r: Reading) => conceptLinks(r).filter((e) => !String(e.label ?? "").trim()).length;

const LINK_LEAD = new Set(
  "can may might will is are was were has have had when which that leads lead causes cause forms form contains contain made makes consists produces produce results becomes become includes include used uses such e.g. for by through via gives give creates create shows show called known divided classified identified composed formed occurs occur happens found".split(" ")
);
const LINK_TAIL = new Set("by of to in into as from with for show shows include includes like called produce produces form forms are is via through create creates cause causes contain contains become becomes".split(" "));

/** A linking phrase drawn as its own box ("Can be identified by", "leads to") — words of an arrow label, not a concept. */
export function isLinkingPhrase(label: string): boolean {
  const w = label.toLowerCase().replace(/[^a-z.\s-]/g, " ").split(/\s+/).filter(Boolean);
  return w.length >= 1 && w.length <= 6 && (LINK_LEAD.has(w[0]) || LINK_TAIL.has(w[w.length - 1]));
}

/**
 * The vision reader sometimes reads an arrow's label as a node of its own (Novak-style linking
 * phrases: Silicates → "Can be identified by" → Hardness / Luster). A concept node that is not a
 * prompt term, sits BETWEEN concepts (≥1 concept in, ≥1 concept out) and reads like a linking
 * phrase is folded back into labeled arrows: A —"can be identified by"→ B. Deterministic and
 * idempotent; everything else is untouched.
 */
export function collapseLinkingPhrases(r: Reading, terms: string[]): Reading {
  let nodes = r.nodes;
  let edges = r.edges;
  for (let guard = 0; guard < 40; guard++) {
    const kind = new Map(nodes.map((n) => [n.id, n.kind ?? "concept"]));
    const L = nodes.find(
      (n) =>
        (n.kind ?? "concept") === "concept" &&
        isLinkingPhrase(n.label) &&
        !terms.some((t) => termPresent(t, [n.label])) &&
        edges.some((e) => e.to === n.id && kind.get(e.from) === "concept") &&
        edges.some((e) => e.from === n.id && kind.get(e.to) === "concept")
    );
    if (!L) break;
    const ins = edges.filter((e) => e.to === L.id && kind.get(e.from) === "concept");
    const outs = edges.filter((e) => e.from === L.id && kind.get(e.to) === "concept");
    const joined = ins.flatMap((a) => outs.filter((b) => b.to !== a.from).map((b) => ({ from: a.from, to: b.to, label: [a.label, L.label, b.label].filter((x) => x && x.trim()).join(" ") })));
    nodes = nodes.filter((n) => n.id !== L.id);
    edges = [...edges.filter((e) => e.from !== L.id && e.to !== L.id), ...joined];
  }
  return nodes === r.nodes ? r : { nodes, edges };
}
