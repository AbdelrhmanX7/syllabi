// Quick prompts per class. The owner's three subjects are recognised by course code / name; anything
// else gets the generic set. Pure, so the chips are testable without React.
import type { QuickPrompt } from '../types';

export type ClassKind = 'geology' | 'calc' | 'cpp' | 'other';

export function classKind(cls: { code?: string | null; name?: string | null } | null | undefined): ClassKind {
  const code = (cls?.code ?? '').toUpperCase();
  const name = (cls?.name ?? '').toLowerCase();

  if (/\b(GEOL|EAS)\b/.test(code) || /geolog|earth science/.test(name)) return 'geology';
  if (/\bMATH\b/.test(code) || /calculus|calc\b|analytic geometry/.test(name)) return 'calc';
  if (/\bCOMSC\b|\bCS\b|\bCIS\b/.test(code) || /c\+\+|programming|object oriented/.test(name)) return 'cpp';

  return 'other';
}

const PROMPTS: Record<ClassKind, QuickPrompt[]> = {
  geology: [
    { label: 'Quiz me on this week', question: 'Quiz me on this week, one question at a time.', mode: 'quiz' },
    {
      label: 'Define these terms the lecture’s way',
      question: 'Define this week’s key terms the way the professor words them in lecture, not the textbook.',
      mode: 'explain',
    },
    {
      label: 'What will the lab quiz ask?',
      question: 'What is the lab quiz this week likely to ask? Give me the gist and the traps.',
    },
  ],
  calc: [
    { label: 'Check my steps', question: 'Check my steps and tell me where the first mistake is.', pen: true },
    { label: 'Explain this limit', question: 'Explain how to evaluate this limit, step by step.', pen: true },
    { label: 'Quiz me on this unit', question: 'Quiz me on the current unit, one problem at a time.', mode: 'quiz' },
  ],
  cpp: [
    { label: 'Trace this code', question: 'Trace this code line by line and show the output.' },
    { label: 'Explain this error', question: 'Explain this compiler error and how to fix it.' },
    { label: 'Quiz me on this chapter', question: 'Quiz me on this chapter, one question at a time.', mode: 'quiz' },
  ],
  other: [
    { label: 'Summarize this week', question: 'Summarize what this week covered in five bullets.' },
    { label: 'Quiz me', question: 'Quiz me on recent material, one question at a time.', mode: 'quiz' },
    { label: 'Explain the hardest idea', question: 'What is the hardest idea this week? Explain it simply.' },
  ],
};

export function quickPromptsFor(kind: ClassKind): QuickPrompt[] {
  return PROMPTS[kind];
}

/** Prompts for a class record (or the generic set with no class). */
export const quickPromptsForClass = (cls: { code?: string | null; name?: string | null } | null | undefined) =>
  quickPromptsFor(classKind(cls));

/**
 * The board panel colours parts of an answer (whiteboard-react `ai/tones.ts`): green = correct, red =
 * a mistake, amber = a caution, blue = a tip. The tutor's system prompt lives on the backend
 * (`/study/ai/ask`), so the ask carries this instruction after the question. Kept short: it rides on
 * every board ask and follow-up.
 */
export const ANSWER_TONE_HINT =
  'Formatting: when part of your answer says what is correct, what is wrong (my mistake), a caution, or a tip, put it in a callout line starting with "> [!success]", "> [!wrong]", "> [!warning]" or "> [!info]" (continue it on following lines that start with ">"). For a short phrase inside a sentence you may write :success[phrase], :wrong[phrase], :warning[phrase] or :info[phrase]. Use them only where they fit; everything else is plain markdown.';

/** The question as sent to the tutor: the asked question, then the colour-callout instruction. */
export const withAnswerToneHint = (question: string): string => `${question}\n\n${ANSWER_TONE_HINT}`;

/** What a lasso action on the board asks the tutor (the panel's own prompt wins when given). */
export function boardAskQuestion(action: string, prompt?: string): string {
  const custom = prompt?.trim();

  if (custom) return custom;

  switch (action) {
    case 'solve':
      return 'Solve what I circled, step by step.';
    case 'check_answer':
      return 'Check my answer in the circled region and point out the first mistake.';
    case 'concept_map':
      return 'Read this concept map and tell me what is wrong or missing.';
    case 'explain':
    default:
      return 'Explain what I circled.';
  }
}
