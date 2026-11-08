// Exam blueprint editing: validation mirroring the BE (#580 validateBlueprint) and display helpers.

import type { BlueprintSection, BlueprintSectionType, ExamBlueprint } from '../types';

export const BLUEPRINT_MAX_QUESTIONS = 50;
export const BLUEPRINT_MAX_MINUTES = 300;
export const DEFAULT_EXAM_MINUTES = 110;

export const SECTION_TYPES: { value: BlueprintSectionType; label: string }[] = [
  { value: 'mcq', label: 'Multiple choice' },
  { value: 'matching', label: 'Matching' },
  { value: 'fill_blank', label: 'Fill in the blank' },
  { value: 'free', label: 'Short answer / work it out' },
  { value: 'label_image', label: 'Label a diagram' },
  { value: 'code_output', label: 'Predict output' },
  { value: 'code_write', label: 'Write code' },
  { value: 'any', label: 'Any type' },
];

export const sectionTypeLabel = (type: BlueprintSectionType) =>
  SECTION_TYPES.find((t) => t.value === type)?.label ?? type;

export const blueprintQuestionCount = (bp: Pick<ExamBlueprint, 'sections'>) =>
  bp.sections.reduce((n, s) => n + (s.bonus ? 0 : s.count), 0);

/** Rows as typed → the blueprint the BE accepts, or the first problem as a message. */
export function cleanBlueprint(minutes: number | null, rows: BlueprintSection[]): ExamBlueprint | string {
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > BLUEPRINT_MAX_MINUTES))
    return `Minutes must be a whole number 1–${BLUEPRINT_MAX_MINUTES}.`;
  if (!rows.length) return 'Add at least one section.';
  if (rows.length > 20) return 'At most 20 sections.';
  const seen = new Set<string>();
  const sections: BlueprintSection[] = [];

  for (const [i, row] of rows.entries()) {
    const name = row.section.trim();

    if (!name) return `Section ${i + 1} needs a name.`;
    if (name.length > 80) return `${name.slice(0, 20)}…: name is too long (max 80).`;
    if (seen.has(name.toLowerCase())) return `"${name}" is listed twice.`;
    seen.add(name.toLowerCase());
    if (!Number.isInteger(row.count) || row.count < 1 || row.count > BLUEPRINT_MAX_QUESTIONS)
      return `${name}: count must be 1–${BLUEPRINT_MAX_QUESTIONS}.`;
    if (row.points !== undefined && (!Number.isFinite(row.points) || row.points < 0 || row.points > 1000))
      return `${name}: points must be 0–1000.`;
    sections.push({
      section: name,
      type: row.type,
      count: row.count,
      ...(row.points !== undefined ? { points: row.points } : {}),
      ...(row.bonus ? { bonus: true } : {}),
      ...(row.optional ? { optional: true } : {}),
      ...(row.preferImage ? { preferImage: true } : {}),
      ...(row.from ? { from: row.from } : {}),
    });
  }
  const total = sections.reduce((n, s) => n + s.count, 0);

  if (total > BLUEPRINT_MAX_QUESTIONS)
    return `The sections add up to ${total} questions (max ${BLUEPRINT_MAX_QUESTIONS}).`;

  return { minutes, sections };
}
