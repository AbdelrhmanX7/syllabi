/**
 * Notebook details: the AI-made title, description, tags and cover of a notebook page, and the
 * rules that keep the owner's own edits safe. Pure helpers only (no database, no model), so the
 * describe route (controllers/study-page-meta.controller.ts) and the tests share one copy.
 *
 * The same lists live in the app (apps/study/lib/notebooks/page-meta.ts): change both together.
 */

export const META_DESCRIPTION_MAX = 300;
export const META_TAGS_MAX = 6;
export const META_TAG_MAX_CHARS = 24;
export const META_TITLE_MAX = 200;
/** Content versions a notebook must move past `metaAiVersion` before the app asks for a fresh description. */
export const META_REDESCRIBE_VERSIONS = 5;

export const MATH_TOOLS_MODES = ["auto", "on", "off"] as const;
export type MathToolsMode = (typeof MATH_TOOLS_MODES)[number];

export const META_FIELDS = ["title", "description", "tags", "cover"] as const;
export type MetaField = (typeof META_FIELDS)[number];
export type MetaEdited = Record<MetaField, boolean>;

/** Lucide icon names a colour cover may carry (the app maps each one to its icon). */
export const COVER_ICONS = [
  "book-open",
  "calculator",
  "sigma",
  "atom",
  "flask-conical",
  "dna",
  "microscope",
  "leaf",
  "sprout",
  "globe",
  "map",
  "landmark",
  "scale",
  "gavel",
  "brain",
  "heart-pulse",
  "code",
  "cpu",
  "chart-line",
  "coins",
  "briefcase",
  "building-2",
  "music",
  "palette",
  "pen-tool",
  "languages",
  "rocket",
  "lightbulb",
  "file-text",
  "notebook-pen",
] as const;
export type CoverIcon = (typeof COVER_ICONS)[number];

/** Brand palette names a colour cover may use (Notebook Blue: primary, star, ok, warn, danger, muted). */
export const COVER_COLORS = ["blue", "star", "green", "amber", "red", "slate"] as const;
export type CoverColor = (typeof COVER_COLORS)[number];

/**
 * Tags that mean "this notebook has formulas in it": with math tools on Auto, any of these turns the
 * math symbol bar on. Matched on the whole tag or on one of its words ("linear algebra" → "algebra").
 */
export const MATH_TAGS = [
  "math",
  "maths",
  "mathematics",
  "calculus",
  "precalculus",
  "pre-calculus",
  "algebra",
  "linear algebra",
  "geometry",
  "trigonometry",
  "trig",
  "statistics",
  "stats",
  "probability",
  "physics",
  "mechanics",
  "differential equations",
  "equations",
  "discrete math",
  "number theory",
  "chemistry",
  "econometrics",
  "integrals",
  "derivatives",
  "matrices",
  "vectors",
] as const;
const MATH_TAG_SET = new Set<string>(MATH_TAGS);

export function isMathTag(tag: string): boolean {
  const t = tag.trim().toLowerCase();
  if (!t) return false;
  if (MATH_TAG_SET.has(t)) return true;
  return t.split(/[\s/-]+/).some((w) => MATH_TAG_SET.has(w));
}

export const hasMathTag = (tags: readonly string[] | null | undefined) => (tags ?? []).some(isMathTag);

/** Whether the board shows the math symbol bar for this notebook. */
export const mathToolsOn = (mode: MathToolsMode | null | undefined, tags: readonly string[] | null | undefined) =>
  mode === "on" ? true : mode === "off" ? false : hasMathTag(tags);

/** One tag: lowercase, trimmed, inner spaces collapsed, leading '#' dropped, ≤ 24 chars; '' when unusable. */
export function normalizeTag(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const t = raw
    .replace(/[\u0000-\u001f]/g, " ")
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!t) return "";
  return t.length > META_TAG_MAX_CHARS ? t.slice(0, META_TAG_MAX_CHARS).trim() : t;
}

/** A tag list: normalised, de-duplicated, at most 6. Non-arrays → []. */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    const t = normalizeTag(r);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= META_TAGS_MAX) break;
  }
  return out;
}

/** A description: one paragraph, trimmed, ≤ 300 chars (cut on a word when possible); null when empty. */
export function normalizeDescription(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length <= META_DESCRIPTION_MAX) return t;
  const cut = t.slice(0, META_DESCRIPTION_MAX - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 200 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}

export function normalizeTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").replace(/^["'«“]+|["'»”]+$/g, "").trim();
  if (!t) return null;
  return t.length > 80 ? `${t.slice(0, 79).trim()}…` : t;
}

export interface DescribeReply {
  title: string | null;
  description: string | null;
  tags: string[];
  icon: CoverIcon;
  color: CoverColor;
}

/** The model's JSON → clean fields. Anything missing or off-list falls back to a safe value; never throws. */
export function sanitizeDescribeReply(raw: unknown): DescribeReply {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const icon = typeof o.icon === "string" ? o.icon.trim().toLowerCase() : "";
  const color = typeof o.color === "string" ? o.color.trim().toLowerCase() : "";
  return {
    title: normalizeTitle(o.title),
    description: normalizeDescription(o.description),
    tags: normalizeTags(o.tags),
    icon: (COVER_ICONS as readonly string[]).includes(icon) ? (icon as CoverIcon) : "notebook-pen",
    color: (COVER_COLORS as readonly string[]).includes(color) ? (color as CoverColor) : "blue",
  };
}

// ─── who wrote what ───────────────────────────────────────────────────────────────────────

const DAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \\d{1,2}";
/** Mirror of apps/study/lib/notebooks/note-title.ts: names the app generates. */
const AUTO_TITLE = new RegExp(`^(?:.+ — (?:Week \\d+ · )?${DAY}|(?:Lecture|Lab|Session|Recitation|Week) (?:\\d+|\\?)(?: — .+)?|Note · [A-Z][a-z]{2} \\d{1,2}|Notebook|Untitled)$`);

export function isAutoNoteTitle(title: string | null | undefined): boolean {
  const v = (title ?? "").trim();
  return v === "" || AUTO_TITLE.test(v);
}

export interface PageMetaState {
  title: string;
  description?: string | null;
  tags?: string[] | null;
  cover?: { by: "ai" | "user" } | null;
  metaEdited?: Partial<MetaEdited> | null;
}

/**
 * Which fields the owner wrote (so AI keeps away). A flag that was never set is read from the data:
 * a title the app did not generate counts as typed by the owner; a cover the owner picked counts too.
 */
export function effectiveEdited(p: PageMetaState): MetaEdited {
  const e = p.metaEdited ?? {};
  return {
    title: typeof e.title === "boolean" ? e.title : !isAutoNoteTitle(p.title),
    description: e.description === true,
    tags: e.tags === true,
    cover: typeof e.cover === "boolean" ? e.cover : p.cover?.by === "user",
  };
}

export interface MetaPlan {
  /** Only the fields AI may write, already cleaned. */
  set: Partial<{ title: string; description: string | null; tags: string[] }>;
  /** True when AI may (re)make the cover. */
  cover: boolean;
}

/**
 * What a describe run may write: never a field the owner edited. `only: "cover"` (Make a new cover)
 * leaves the text fields alone. An empty AI title or description never blanks an existing one.
 */
export function planMetaWrite(p: PageMetaState, reply: DescribeReply, opts: { only?: "cover" } = {}): MetaPlan {
  const edited = effectiveEdited(p);
  const set: MetaPlan["set"] = {};
  if (opts.only !== "cover") {
    if (!edited.title && reply.title) set.title = reply.title.slice(0, META_TITLE_MAX);
    if (!edited.description && reply.description) set.description = reply.description;
    if (!edited.tags && reply.tags.length) set.tags = reply.tags;
  }
  return { set, cover: !edited.cover };
}

/** Skip a describe when nothing moved since the last one (unless forced). */
export const describeIsFresh = (p: { version?: number | null; metaAiVersion?: number | null }, force: boolean) =>
  !force && p.metaAiVersion !== null && p.metaAiVersion !== undefined && (p.version ?? 0) <= p.metaAiVersion;

// ─── prompts ──────────────────────────────────────────────────────────────────────────────

export const DESCRIBE_SYSTEM = [
  "You name and describe a student's handwritten notebook so they can find it later.",
  "Reply with ONE JSON object and nothing else: {\"title\": string, \"description\": string, \"tags\": string[], \"icon\": string, \"color\": string}.",
  "title: 2 to 6 words naming the topic (e.g. \"Limits and continuity\"), no dates, no course codes, no quotes.",
  `description: one or two plain sentences (max ${META_DESCRIPTION_MAX} characters) saying what the notes cover. Write like a friend, no filler.`,
  `tags: 2 to ${META_TAGS_MAX} short lowercase subject words (e.g. "calculus", "limits", "physics"). The first tag is the broad subject.`,
  `icon: exactly one of ${COVER_ICONS.join(", ")}.`,
  `color: exactly one of ${COVER_COLORS.join(", ")}.`,
  "If the pages are empty or unreadable, use the file and class names you are given; never invent topics that are not there.",
].join("\n");

export function describeUserTurn(ctx: { title: string; className?: string | null; fileName?: string | null; text?: string | null; pageCount: number }): string {
  const lines = [
    `Current name: ${ctx.title || "(none)"}`,
    ctx.className ? `Class: ${ctx.className}` : null,
    ctx.fileName ? `PDF on the pages: ${ctx.fileName}` : null,
    `Pages shown: ${ctx.pageCount}`,
    ctx.text ? `Handwriting read from the pages (may be rough):\n${ctx.text.slice(0, 6000)}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

/** The picture prompt: no text in the image (image models misspell), calm flat style. */
export function coverImagePrompt(r: Pick<DescribeReply, "title" | "description" | "tags">): string {
  const topic = [r.title, r.description, r.tags.length ? `Topics: ${r.tags.join(", ")}` : null].filter(Boolean).join(". ");
  return [
    `A square cover illustration for a student's notebook about: ${topic || "study notes"}.`,
    "Clean flat illustration, one simple central subject, calm soft colours, plain light background, generous margins.",
    "Absolutely no text, letters, numbers, equations, labels, logos or writing of any kind in the image.",
  ].join(" ");
}

/** Storage key of a generated cover: `study/<userId>/pages/<pageId>/cover-<stamp>.webp` (fresh per cover). */
export const pageCoverKey = (userId: string, pageId: string, stamp: string) => `study/${userId}/pages/${pageId}/cover-${stamp}.webp`;
