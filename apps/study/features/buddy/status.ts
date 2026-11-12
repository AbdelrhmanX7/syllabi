import type { DictationState } from '@/features/tutor/useDictation';

export type BuddyPhase = 'idle' | 'reading' | 'planning' | 'drawing' | 'done' | 'kept';

/** The one status line above the buddy's answer (null = nothing going on). */
export function buddyStatusLine({ phase, dictation, seconds }: { phase: BuddyPhase; dictation: DictationState; seconds: number }): string | null {
  if (dictation === 'recording') return `Listening… ${seconds}s · let go to ask`;
  if (dictation === 'transcribing') return 'Got it, one sec…';

  switch (phase) {
    case 'reading':
      return 'Looking at your page…';
    case 'planning':
      return 'Thinking…';
    case 'drawing':
      return 'Showing you…';
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
export const BUDDY_QUICK_ASKS: ReadonlyArray<{ label: string; question: string }> = [
  { label: 'Check my work', question: 'Check my work on this page. Is it right? If not, show me exactly where it goes wrong and how to fix it.' },
  { label: 'Give me a hint', question: 'Give me a hint for the next step only. Do not give the full answer or solve it for me.' },
  { label: 'Explain this', question: 'Explain what matters on this page in simple words, and point at the key parts.' },
  { label: 'Answer what I wrote', question: 'I wrote my question on the page by hand. Find it, read it, and answer it.' },
];
