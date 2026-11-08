import { useMemo } from 'react';
import { Network, PenLine } from 'lucide-react';
import Link from 'next/link';

import { useConceptMaps } from '../hooks';
import { byNumber, mapTitle } from '../lib/score';

import { LinkButton, Surface } from '@/components/ui/primitives';

/** The small card on a class page: how many maps, and the next map to practise. Maps are study tools, not grades. */
export function ConceptMapsPanel({ classId, className = '' }: { classId: string; className?: string }) {
  const maps = useConceptMaps(classId);
  const list = useMemo(() => maps.data ?? [], [maps.data]);
  const assigned = useMemo(() => list.filter((map) => map.source !== 'practice'), [list]);
  const examReview = assigned.filter((map) => map.examReview);
  const next = examReview[0] ?? [...assigned].sort((a, b) => byNumber(b, a))[0];
  const href = `/concept-maps/?classId=${encodeURIComponent(classId)}`;

  return (
    <Surface className={`flex flex-col gap-3 p-4 ${className}`}>
      <div className='flex items-center justify-between gap-2'>
        <h2 className='text-st-fg flex items-center gap-2 text-sm font-semibold'>
          <Network className='text-st-muted h-4 w-4' /> Concept maps
        </h2>
        <Link className='text-st-accent text-sm font-medium underline-offset-2 hover:underline' href={href}>
          Open
        </Link>
      </div>
      {maps.isLoading ? (
        <div className='bg-st-raised h-12 animate-pulse rounded' />
      ) : (
        <>
          <p className='text-st-muted text-sm tabular-nums'>
            {assigned.length} map{assigned.length === 1 ? '' : 's'}
            {examReview.length > 0 && ` · ${examReview.length} for the exam`}
          </p>
          {next && (
            <div className='rounded-st border-st-line flex items-center gap-3 border px-3 py-2'>
              <div className='min-w-0 flex-1'>
                <p className='text-st-fg truncate text-sm font-medium'>
                  {next.number !== null ? `Map ${next.number} · ` : ''}
                  {mapTitle(next)}
                </p>
                {next.promptTerms.length > 0 && (
                  <p className='text-st-muted truncate text-xs'>{next.promptTerms.join(' · ')}</p>
                )}
              </div>
              <LinkButton
                className='min-h-9 px-3 text-xs'
                href={`${href}&practice=${encodeURIComponent(next.id)}`}
                variant='primary'
              >
                <PenLine className='h-3.5 w-3.5' /> Practice
              </LinkButton>
            </div>
          )}
        </>
      )}
    </Surface>
  );
}
