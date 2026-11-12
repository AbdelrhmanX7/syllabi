import type { DictationState } from '@/features/tutor/useDictation';

export type BuddyPhase = 'idle' | 'reading' | 'planning' | 'drawing' | 'done' | 'kept';

/** The orb's motion for a step (the board package's thinking orb). */
export type BuddyOrb = 'searching' | 'composing' | 'shaping' | 'solving';

export interface BuddyStatus {
  line: string;
  orb: BuddyOrb;
}

/**
 * What the tutor is doing while it works, in the order it really does it: it reads the page, solves
 * the problem itself, compares with the student's steps, then picks what to mark. The waiting part is
 * one long step on our side, so its lines turn over every couple of seconds (`tick`) and stay on the
 * last one — a student should see it WORKING, never a frozen «Thinking…».
 */
export const BUDDY_THINKING_LINES: readonly BuddyStatus[] = [
  { line: 'Working it out myself first…', orb: 'composing' },
  { line: 'Comparing with your steps…', orb: 'solving' },
  { line: 'Finding the exact spot…', orb: 'searching' },
  { line: 'Choosing what to mark…', orb: 'shaping' },
  { line: 'Almost there…', orb: 'solving' },
];

/** How long each thinking line stays, ms. */
export const BUDDY_LINE_MS = 2200;

/** The status above the buddy's answer (null = nothing going on). `tick` counts thinking lines shown so far. */
export function buddyStatus({ phase, dictation, tick = 0 }: { phase: BuddyPhase; dictation: DictationState; tick?: number }): BuddyStatus | null {
  if (dictation === 'recording') return { line: 'Listening… let go to ask', orb: 'searching' };
  if (dictation === 'transcribing') return { line: 'Writing down what you said…', orb: 'composing' };

  switch (phase) {
    case 'reading':
      return { line: 'Reading your page…', orb: 'searching' };
    case 'planning':
      return BUDDY_THINKING_LINES[Math.min(Math.max(0, tick), BUDDY_THINKING_LINES.length - 1)]!;
    case 'drawing':
      return { line: 'Marking your page…', orb: 'shaping' };
    default:
      return null;
  }
}

/** The plain line (no orb): «Saved» after Keep, else the working status. */
export function buddyStatusLine(input: { phase: BuddyPhase; dictation: DictationState; tick?: number }): string | null {
  if (input.dictation === 'idle' && input.phase === 'kept') return 'Saved to your page.';

  return buddyStatus(input)?.line ?? null;
}

/**
 * One-tap questions — a pen user should never need the keyboard. The tutor sees the page, so a
 * question written on it by hand is a question too.
 */
export const BUDDY_QUICK_ASKS: ReadonlyArray<{ label: string; short: string; question: string }> = [
  { label: 'Check my work', short: 'Check', question: 'Check my work on this page. Is it right? If not, show me exactly where it goes wrong and how to fix it.' },
  { label: 'Give me a hint', short: 'Hint', question: 'Give me a hint for the next step only. Do not give the full answer or solve it for me.' },
  { label: 'Explain this', short: 'Explain', question: 'Explain what matters on this page in simple words, and point at the key parts.' },
];
