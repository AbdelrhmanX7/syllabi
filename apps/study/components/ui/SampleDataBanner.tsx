import { cn } from '@repo/ui';
import { FlaskConical } from 'lucide-react';

/**
 * Shown above anything the mock answered (see `lib/api/sample.ts`). The wording is deliberate: the
 * numbers and dates on such a screen are fabricated, and must not be mistaken for Canvas.
 */
export function SampleDataBanner({ what, className }: { what: string; className?: string }) {
  return (
    <div
      className={cn(
        'border-st-warn/40 bg-st-warn/10 text-st-fg rounded-st flex items-start gap-3 border px-4 py-3 text-sm',
        className,
      )}
      role='status'
    >
      <FlaskConical className='text-st-warn mt-0.5 h-4 w-4 shrink-0' />
      <p>
        {/* explicit space: the compiler trims the leading blank of a wrapped text run after `{what}` */}
        <span className='font-semibold'>Sample preview.</span> Real {what}
        {' appears when the server side ships — these numbers, dates and deadlines are made up. Don’t act on them.'}
      </p>
    </div>
  );
}
