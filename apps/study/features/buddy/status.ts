import type { DictationState } from '@/features/tutor/useDictation';

export type BuddyPhase = 'idle' | 'reading' | 'planning' | 'drawing' | 'done' | 'kept';

/** The one status line above the buddy's answer (null = nothing going on). */
export function buddyStatusLine({ phase, dictation }: { phase: BuddyPhase; dictation: DictationState }): string | null {
  if (dictation === 'recording') return 'Listening… let go to ask';
  if (dictation === 'transcribing') return 'Got it, one sec…';

  switch (phase) {
    case 'reading':
      return 'Looking at your page…';
    case 'planning':
      return 'Thinking…';
    case 'drawing':
      return 'Marking your page…';
    case 'kept':
      return 'Saved to your page.';
    default:
      return null;
  }
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
