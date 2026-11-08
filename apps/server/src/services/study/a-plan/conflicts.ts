import type { ClassPolicy } from "@/models/study/class-policy";
import type { AssignmentGroupLite, OwnerPolicy } from "./deps";
import { categorySimilarity, pairCategories } from "./text-utils";

/**
 * Disagreements between the syllabus, Canvas and the owner's stated policy. Pure. A conflict
 * NEVER picks a side: it carries both values, and the plan shows it to the student as-is.
 */
export type ConflictKind =
  | "weight_mismatch"
  | "category_missing_in_canvas"
  | "category_missing_in_syllabus"
  | "canvas_unweighted"
  | "owner_policy";

export interface Conflict {
  kind: ConflictKind;
  severity: "high" | "medium" | "low";
  text: string;
  syllabus: unknown;
  other: unknown;
  otherSource: "canvas" | "owner";
}

const WEIGHT_TOLERANCE = 0.5;

/** Set the canvasGroupId on each syllabus category (name match) — returns a copy. */
export function linkCanvasGroups(policy: ClassPolicy, groups: AssignmentGroupLite[]): ClassPolicy {
  const pairs = pairCategories(policy.gradingCategories, groups);
  return { ...policy, gradingCategories: policy.gradingCategories.map((c) => ({ ...c, canvasGroupId: pairs.get(c)?.id ?? null })) };
}

export function canvasConflicts(policy: ClassPolicy, canvas: { applyWeights: boolean; groups: AssignmentGroupLite[] }): Conflict[] {
  const out: Conflict[] = [];
  const cats = policy.gradingCategories;
  const pairs = pairCategories(cats, canvas.groups);
  const weighted = canvas.applyWeights && canvas.groups.some((g) => (g.weight ?? 0) > 0);
  const syllabusWeights = cats.some((c) => c.weight !== null && c.weight > 0);

  if (syllabusWeights && !weighted) {
    out.push({
      kind: "canvas_unweighted",
      severity: "medium",
      text: "The syllabus weights grading categories, but Canvas does not weight its assignment groups — the Canvas total may not match the syllabus grade.",
      syllabus: cats.filter((c) => c.weight !== null).map((c) => ({ name: c.name, weight: c.weight })),
      other: { applyWeights: canvas.applyWeights, groups: canvas.groups.map((g) => ({ name: g.name, weight: g.weight })) },
      otherSource: "canvas",
    });
  }
  for (const c of cats) {
    const g = pairs.get(c);
    if (!g) {
      out.push({
        kind: "category_missing_in_canvas",
        severity: c.weight && c.weight > 0 ? "medium" : "low",
        text: `Syllabus category "${c.name}"${c.weight !== null ? ` (${c.weight}%)` : ""} has no matching Canvas assignment group.`,
        syllabus: { name: c.name, weight: c.weight },
        other: null,
        otherSource: "canvas",
      });
      continue;
    }
    if (weighted && c.weight !== null && Math.abs((g.weight ?? 0) - c.weight) > WEIGHT_TOLERANCE) {
      out.push({
        kind: "weight_mismatch",
        severity: "high",
        text: `"${c.name}" is ${c.weight}% in the syllabus but ${g.weight ?? 0}% in Canvas ("${g.name}").`,
        syllabus: { name: c.name, weight: c.weight },
        other: { id: g.id, name: g.name, weight: g.weight },
        otherSource: "canvas",
      });
    }
  }
  const matched = new Set([...pairs.values()]);
  for (const g of canvas.groups) {
    if (matched.has(g)) continue;
    // A Canvas group the syllabus never mentions matters only if it counts toward the grade.
    const counts = weighted ? (g.weight ?? 0) > 0 : (g.assignmentIds?.length ?? 1) > 0;
    if (!counts || !cats.length) continue;
    if (/do not count|optional|not count/i.test(g.name)) continue;
    out.push({
      kind: "category_missing_in_syllabus",
      severity: weighted ? "medium" : "low",
      text: `Canvas group "${g.name}"${weighted ? ` (${g.weight}%)` : ""} is not a category in the syllabus.`,
      syllabus: null,
      other: { id: g.id, name: g.name, weight: g.weight },
      otherSource: "canvas",
    });
  }
  return out;
}

/** A category name → the Canvas assignment group it is (same greedy name pairing as canvasGroupId). */
function resolveToGroups(names: string[], groups: AssignmentGroupLite[]): (number | null)[] {
  const cats = names.map((name) => ({ name }));
  const pairs = pairCategories(cats, groups);
  return cats.map((c) => pairs.get(c)?.id ?? null);
}

/**
 * Same category SET, order-insensitive, tolerant of naming ("Assessment Questions" ≡ "Assessments").
 *  1. Both sides resolve to Canvas assignment groups → compare group-id sets (owner ids win when known).
 *  2. Otherwise → a 1:1 pairing by normalized token overlap (case, plural, synonyms) covering every name.
 */
export function sameCategories(a: string[], b: string[], groups: AssignmentGroupLite[] = [], bGroupIds?: number[]): boolean {
  if (a.length !== b.length) return false;
  if (!a.length) return true;
  if (groups.length) {
    const ia = resolveToGroups(a, groups);
    const ib = bGroupIds?.length === b.length ? bGroupIds : resolveToGroups(b, groups);
    if (ia.every((x) => x !== null) && ib.every((x) => x !== null)) {
      const sa = new Set(ia);
      const sb = new Set(ib);
      return sa.size === sb.size && [...sa].every((x) => sb.has(x));
    }
  }
  const ca = a.map((name) => ({ name }));
  return pairCategories(ca, b.map((name) => ({ name }))).size === a.length;
}

export function ownerPolicyConflicts(policy: ClassPolicy | null, owner: OwnerPolicy | null, groups: AssignmentGroupLite[] = []): Conflict[] {
  if (!owner) return [];
  const a = policy?.aRequirement ?? null;
  const differs =
    !a ||
    a.kind !== owner.kind ||
    (owner.min !== null && a.min !== owner.min) ||
    (owner.categories.length > 0 && !sameCategories(a.categories, owner.categories, groups, owner.groupIds));
  if (!differs) return [];
  return [
    {
      kind: "owner_policy",
      severity: a ? "high" : "medium",
      text: a
        ? `Your stated A rule ("${owner.text}") differs from the syllabus ("${a.text || `${a.kind} ≥ ${a.min}`}"). Both are shown; neither is assumed.`
        : `Your stated A rule ("${owner.text}") could not be confirmed — the syllabus states no A requirement.`,
      syllabus: a,
      other: owner,
      otherSource: "owner",
    },
  ];
}
