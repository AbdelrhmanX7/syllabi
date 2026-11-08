import type { StudyClass } from '@/lib/api/types';

import dynamic from 'next/dynamic';
import Link from 'next/link';

import { Badge, GradeChip } from '@/components/ui/primitives';

// Compact grade-goal line (no links inside, so it can live within the card's own Link).
const GradeGoalCard = dynamic(() => import('@/features/aplan').then((mod) => mod.GradeGoalCard), { ssr: false });

export function classHref(cls: Pick<StudyClass, 'id'>): string {
  return `/class/?id=${encodeURIComponent(cls.id)}`;
}

/**
 * A class on the clay card: colour dot + code and the grade on one line, the name, then ONE footer
 * line — what needs doing on the left, the grade goal on the right. Same shape for every card
 * (footer pinned to the bottom), no coloured top bar.
 */
export function ClassCard({ cls }: { cls: StudyClass }) {
  const caughtUp = cls.counts.overdue === 0 && cls.counts.due === 0 && cls.counts.unseen === 0;

  return (
    <Link
      className='rounded-st-lg border-st-clay-edge bg-st-surface shadow-clay hover:border-st-accent flex h-full flex-col gap-1.5 border-2 p-4 transition-[transform,box-shadow,border-color] duration-100 active:translate-y-[3px] active:shadow-none'
      href={classHref(cls)}
    >
      <div className='flex items-center gap-2'>
        <span aria-hidden className='h-2.5 w-2.5 shrink-0 rounded-full' style={{ background: cls.color }} />
        <p className='text-st-muted min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide'>
          {cls.code || 'Your class'}
        </p>
        {cls.source !== 'manual' && (
          <GradeChip letter={cls.grade.letter} score={cls.grade.score} trend={cls.grade.trend} />
        )}
      </div>
      <h3 className='text-st-fg line-clamp-2 text-base font-semibold leading-snug'>{cls.name}</h3>
      <div className='mt-auto flex flex-wrap items-center gap-1.5 pt-1.5'>
        {cls.counts.overdue > 0 && <Badge tone='danger'>{cls.counts.overdue} overdue</Badge>}
        {cls.counts.due > 0 && <Badge tone='warn'>{cls.counts.due} due soon</Badge>}
        {cls.counts.unseen > 0 && <Badge tone='accent'>{cls.counts.unseen} new</Badge>}
        {caughtUp && <Badge tone='ok'>All caught up</Badge>}
        {cls.source !== 'manual' && (
          <span className='ms-auto min-w-0'>
            <GradeGoalCard compact classId={cls.id} />
          </span>
        )}
      </div>
    </Link>
  );
}
