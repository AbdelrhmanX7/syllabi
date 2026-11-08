import { cn } from '@repo/ui';
import { BOARD_CHIP } from '@/components/ui/primitives';
import { Loader2, Sparkles } from 'lucide-react';

/**
 * «N waiting from Claude» in a board's top-right cluster: inbox items Claude filed into this note.
 * One tap appends them all, oldest first (a PDF stops at its import sheet). Nothing when none wait.
 */
export function PageQueueChip({
  count,
  busy,
  onAppend,
  className,
}: {
  count: number;
  busy: boolean;
  onAppend: () => void;
  className?: string;
}) {
  if (count === 0) return null;

  return (
    <button
      aria-label={`${count} waiting from Claude — add to this note`}
      className={cn(
        BOARD_CHIP,
        className,
      )}
      disabled={busy}
      title='Claude filed these into this note — tap to add them at the end'
      type='button'
      onClick={onAppend}
    >
      {busy ? (
        <Loader2 className='text-st-accent h-4 w-4 animate-spin' />
      ) : (
        <Sparkles className='text-st-accent h-4 w-4' />
      )}
      <span className='font-semibold tabular-nums'>{count}</span>
      <span data-chip-label>waiting from Claude</span>
    </button>
  );
}
