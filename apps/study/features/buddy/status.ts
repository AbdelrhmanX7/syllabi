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
