import type { TutorSource } from '../types';
import type { LucideIcon } from 'lucide-react';

import { BookOpen, Captions, Compass, FileText, NotebookPen } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { requestSeek } from '../lib/seek';
import { formatClock, SOURCE_KIND_LABEL, sourceHref, transcriptHref } from '../lib/sources';

import { isStudyApiError } from '@/lib/api/errors';
import { getItem } from '@/lib/api/endpoints';

const ICON: Record<TutorSource['kind'], LucideIcon> = {
  library: BookOpen,
  item: FileText,
  transcript: Captions,
  page: NotebookPen,
  guide: Compass,
};

/** Where an answer came from — each chip opens the item / page / transcript moment. */
/**
 * A transcript chip: seek the player already open on it, else open it at `t`. Its id is a video item's
 * or a recorded lecture's — an item that 404s is a lecture.
 */
async function openTranscript(source: TutorSource, push: (href: string) => Promise<boolean>): Promise<void> {
  if (typeof source.t === 'number' && requestSeek(source.id, source.t)) return;
  try {
    await getItem(source.id);
    await push(transcriptHref('item', source.id, source.t));
  } catch (error) {
    await push(
      transcriptHref(
        isStudyApiError(error, 404) || isStudyApiError(error, 400) ? 'lecture' : 'item',
        source.id,
        source.t,
      ),
    );
  }
}

export function SourceChips({ sources, classId }: { sources: TutorSource[]; classId?: string | null }) {
  const router = useRouter();

  if (sources.length === 0) return null;

  return (
    <ul aria-label='Sources' className='mt-3 flex flex-wrap gap-1.5'>
      {sources.map((source, index) => {
        const Icon = ICON[source.kind];

        return (
          <li key={`${source.kind}:${source.id}:${index}`}>
            <Link
              className='border-st-line bg-st-surface text-st-fg hover:bg-st-raised inline-flex max-w-[260px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium'
              href={sourceHref(source, classId)}
              title={source.snippet || `${SOURCE_KIND_LABEL[source.kind]} · ${source.title}`}
              onClick={(event) => {
                if (source.kind !== 'transcript' || event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                void openTranscript(source, (href) => router.push(href));
              }}
            >
              <Icon className='text-st-muted h-3.5 w-3.5 shrink-0' strokeWidth={1.75} />
              <span className='truncate'>{source.title}</span>
              {source.kind === 'transcript' && typeof source.t === 'number' && (
                <span className='text-st-muted tabular-nums'>{formatClock(source.t)}</span>
              )}
              {typeof source.week === 'number' && <span className='text-st-muted'>W{source.week}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
