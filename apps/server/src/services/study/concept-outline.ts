import { createHash } from "crypto";
import { Types } from "mongoose";
import { StudyClassOutline, type OutlineConcept } from "@/models/study/class-outline";
import { StudyItem } from "@/models/study/item";
import { StudyModule } from "@/models/study/module";
import { logger } from "@/services/logger.service";
import { spendForUser, textJson } from "./ai-models";
import { recordStudyUsage } from "./usage";

/**
 * The class's outline: what it teaches, read from its own material. The knowledge map used to know
 * only the topics of the questions a student had saved; a class whose professor opens one unit at
 * a time showed one lonely concept. Here the module names and the titles of what sits in them
 * (lessons, pages, videos, files, assignments) are read by a model ONCE per change into units and
 * the ideas under them. When new material appears the titles' fingerprint changes and the outline
 * is read again — the map grows as the class does, with nobody pressing anything.
 */

export const OUTLINE_TITLES_MAX = 500;
export const OUTLINE_CONCEPTS_MAX = 80;
/** A read that has been «running» longer than this is taken for dead. */
const RUNNING_STALE_MS = 3 * 60_000;

export const OUTLINE_SYSTEM = [
  "You read the material list of a college class (module names, and the titles of the lessons, pages, videos, files and assignments inside them) and name what the class teaches.",
  'Reply with ONE JSON object: {"concepts":[{"label":"…","parent":null|"<label of its unit>"}]}.',
  "Rules:",
  "- Units first (parent null): the big parts of the course, named as the material names them without numbering («Unit 2: Derivatives» → «Derivatives»). Skip modules that are not subject matter (course information, how-to, assessments, revisions).",
  "- Under each unit, the specific ideas and skills its titles name («Chain rule», «Related rates», «Optimization», «L'Hôpital's rule»), each with `parent` = that unit's label. Use the title's own wording, shortened to the idea: «Lesson 12 Practice (Implicit Differentiation)» → «Implicit differentiation».",
  "- Only what the titles show. A title that names no idea («Lesson 7 Practice», «Exit Reflection 3», «Assessment 2 Revisions») adds nothing — never guess what lesson 7 was about, and never fill a unit from your own knowledge of the subject.",
  "- Review material from an earlier course (titles marked with another course number, «review») goes under one unit named «Review» — or is left out when there is little of it.",
  "- When an idea matches one of the KNOWN NAMES, use that exact name.",
  "- Each label 1–5 words, Sentence case, no numbering, no duplicates. At most 60 concepts.",
].join("\n");

const squash = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

/** The class's material as the model sees it: its modules in order, each with its items' titles. */
export async function outlineMaterial(userId: Types.ObjectId, classId: Types.ObjectId): Promise<{ text: string; hash: string; titles: number }> {
  const [modules, items] = await Promise.all([
    StudyModule.find({ userId, classId }, { name: 1, position: 1 }).sort({ position: 1, _id: 1 }).lean(),
    StudyItem.find({ userId, classId, type: { $in: ["page", "video", "file", "assignment", "quiz", "link"] } }, { title: 1, moduleId: 1, modulePosition: 1 })
      .sort({ modulePosition: 1, _id: 1 })
      .lean(),
  ]);
  const byModule = new Map<string, string[]>();
  let titles = 0;
  for (const item of items) {
    const title = squash(item.title).slice(0, 140);
    if (!title || titles >= OUTLINE_TITLES_MAX) continue;
    const key = item.moduleId ? String(item.moduleId) : "";
    const list = byModule.get(key) ?? [];
    if (list.includes(title)) continue;
    list.push(title);
    byModule.set(key, list);
    titles += 1;
  }
  const lines: string[] = [];
  for (const module of modules) {
    lines.push(`MODULE: ${squash(module.name)}`);
    for (const title of byModule.get(String(module._id)) ?? []) lines.push(`- ${title}`);
  }
  const loose = byModule.get("") ?? [];
  if (loose.length) lines.push("NOT IN A MODULE:", ...loose.map((title) => `- ${title}`));
  const text = lines.join("\n");
  return { text, hash: createHash("sha1").update(text).digest("hex"), titles: titles + modules.length };
}

/** The model's reply → clean concepts: trimmed, deduped, parents that exist (else a unit of their own). */
export function cleanOutline(raw: any): OutlineConcept[] {
  const list = Array.isArray(raw?.concepts) ? raw.concepts : [];
  const seen = new Set<string>();
  const out: OutlineConcept[] = [];
  for (const entry of list) {
    const label = squash(entry?.label).slice(0, 80);
    const key = label.toLowerCase();
    if (!label || seen.has(key) || out.length >= OUTLINE_CONCEPTS_MAX) continue;
    seen.add(key);
    out.push({ label, parent: squash(entry?.parent).slice(0, 80) || null });
  }
  const units = new Set(out.filter((c) => !c.parent).map((c) => c.label.toLowerCase()));
  return out.map((c) => (c.parent && units.has(c.parent.toLowerCase()) && c.parent.toLowerCase() !== c.label.toLowerCase() ? c : { label: c.label, parent: null }));
}

async function readOutline(userId: Types.ObjectId, classId: Types.ObjectId, material: { text: string; hash: string }, known: string[]): Promise<void> {
  const claimed = await StudyClassOutline.findOneAndUpdate(
    { userId, classId, $or: [{ runningSince: null }, { runningSince: { $lt: new Date(Date.now() - RUNNING_STALE_MS) } }] },
    { $set: { runningSince: new Date() } },
    { upsert: true, new: true }
  ).catch(() => null);
  if (!claimed) return;
  const startedAt = Date.now();
  const spend = await spendForUser(userId, { background: true });
  try {
    const raw = await textJson(OUTLINE_SYSTEM, [known.length ? `KNOWN NAMES: ${known.slice(0, 80).join("; ")}` : "KNOWN NAMES: none", "", "MATERIAL:", material.text].join("\n"), spend, { maxTokens: 4000, disableThinking: true });
    const concepts = cleanOutline(raw);
    // An unreadable reply keeps the old outline, and the hash stays old so the next view tries again.
    await StudyClassOutline.updateOne({ userId, classId }, { $set: { runningSince: null, ...(concepts.length ? { concepts, hash: material.hash } : {}) } });
    await recordStudyUsage(userId, "concept_outline", spend, startedAt, concepts.length ? "done" : "error", concepts.length ? {} : { error: "no concepts in the reply" });
  } catch (e) {
    await StudyClassOutline.updateOne({ userId, classId }, { $set: { runningSince: null } }).catch(() => undefined);
    await recordStudyUsage(userId, "concept_outline", spend, startedAt, "error", { error: String((e as Error)?.message ?? e) });
    await logger.error("study class outline failed", e as Error, {});
  }
}

/**
 * The class's outline, kept fresh: returns what is stored; when the material changed since it was
 * read, a new read starts in the background (the next view has it). The very first read is waited
 * for, up to `waitMs`, so a class's first map is not empty.
 */
export async function classOutline(userId: Types.ObjectId, classId: Types.ObjectId, known: string[] = [], waitMs = 12_000): Promise<OutlineConcept[]> {
  const [stored, material] = await Promise.all([StudyClassOutline.findOne({ userId, classId }).lean(), outlineMaterial(userId, classId)]);
  if (material.titles < 3) return stored?.concepts ?? [];
  if (stored && stored.hash === material.hash) return stored.concepts;
  const run = readOutline(userId, classId, material, known).catch(() => undefined);
  if (stored?.concepts.length) return stored.concepts;
  await Promise.race([run, new Promise((resolve) => setTimeout(resolve, waitMs))]);
  return (await StudyClassOutline.findOne({ userId, classId }, { concepts: 1 }).lean())?.concepts ?? [];
}
