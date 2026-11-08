import type { GroupStatus, RequirementStatus, SyllabusQuote } from '../types';
import type { BadgeTone } from '@/components/ui/primitives';

import { useState } from 'react';
import { cn } from '@repo/ui';
import { Quote } from 'lucide-react';
import Link from 'next/link';

import { itemHref } from '@/components/items/ItemRow';
import { Badge } from '@/components/ui/primitives';

export const STATUS_META: Record<GroupStatus, { label: string; tone: BadgeTone; bar: string; text: string }> = {
  on_track: { label: 'On track', tone: 'ok', bar: 'bg-st-ok', text: 'text-st-ok' },
  at_risk: { label: 'At risk', tone: 'warn', bar: 'bg-st-warn', text: 'text-st-warn' },
  below: { label: 'Out of reach', tone: 'danger', bar: 'bg-st-danger', text: 'text-st-danger' },
};

export const REQUIREMENT_META: Record<RequirementStatus, { label: string; tone: BadgeTone }> = {
  met: { label: 'Met', tone: 'ok' },
  on_track: { label: 'On track', tone: 'accent' },
  at_risk: { label: 'At risk', tone: 'warn' },
  missed: { label: 'Missed', tone: 'danger' },
};

export function StatusPill({ status, className }: { status: GroupStatus; className?: string }) {
  const meta = STATUS_META[status];

  return (
    <Badge className={className} tone={meta.tone}>
      {meta.label}
    </Badge>
  );
}

/** Progress bar with an optional target tick (both percents). */
export function PctBar({
  value,
  marker,
  tone = 'bg-st-accent',
  label,
}: {
  value: number | null;
  marker?: number | null;
  tone?: string;
  label: string;
}) {
  const width = Math.max(0, Math.min(100, value ?? 0));

  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={value === null ? undefined : Math.round(value)}
      className='bg-st-raised relative h-2.5 w-full overflow-visible rounded-full'
      role='progressbar'
    >
      <span
        className={cn('block h-full rounded-full transition-[width] duration-300', tone)}
        style={{ width: `${width}%` }}
      />
      {marker !== null && marker !== undefined && (
        <span
          aria-hidden
          className='bg-st-fg absolute -top-1 h-[18px] w-0.5 rounded-full'
          style={{ left: `calc(${Math.max(0, Math.min(100, marker))}% - 1px)` }}
        />
      )}
    </div>
  );
}

/** A line of copy that came from the syllabus: tap the quote mark to see the exact words. */
export function SyllabusLine({ text, quote }: { text: string; quote?: SyllabusQuote | null }) {
  const [open, setOpen] = useState(false);

  return (
    <div className='flex flex-col gap-2'>
      <p className='text-st-fg text-sm leading-relaxed'>
        {text}
        {quote && (
          <button
            aria-expanded={open}
            aria-label={open ? 'Hide syllabus quote' : 'Show syllabus quote'}
            className='text-st-muted hover:text-st-accent ml-1.5 inline-flex h-7 w-7 items-center justify-center rounded-full align-middle'
            type='button'
            onClick={() => setOpen((value) => !value)}
          >
            <Quote className='h-3.5 w-3.5' />
          </button>
        )}
      </p>
      {quote && open && (
        <blockquote className='border-st-accent/40 bg-st-raised/60 text-st-muted rounded-r-st border-l-2 px-3 py-2 text-sm italic'>
          {quote.text}
          <span className='text-st-muted/80 mt-1 block text-xs not-italic'>From the syllabus</span>
        </blockquote>
      )}
    </div>
  );
}

/** Links to the item page when there is a real Canvas item behind it. */
export function MaybeItemLink({
  itemId,
  className,
  children,
}: {
  itemId: string | null | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  if (!itemId) return <div className={className}>{children}</div>;

  return (
    <Link className={cn('hover:bg-st-raised transition-colors', className)} href={itemHref({ id: itemId })}>
      {children}
    </Link>
  );
}
