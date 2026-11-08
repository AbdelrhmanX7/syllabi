import type { NotesDigest } from './api';
import type { DigestPageRead } from './digest-frames';

import { AlertTriangle, Check, Database, Loader2, NotebookText, Quote, RefreshCw } from 'lucide-react';

import { BuiltFrom } from '../components/BuiltFrom';

import { skippedPages } from './digest-frames';
import { normTerm } from './workspace-state';

import { Badge, ErrorNote, LoadingRows } from '@/components/ui/primitives';

/**
 * What his notes say about each of the professor's terms, set against her wording (hers wins on the
 * exam), plus the terms she listed that his notes never mention. Rendered only while the backend has
 * the digest route.
 */
export interface DigestPanelProps {
  terms: string[];
  digest: NotesDigest | null;
  loading: boolean;
  error: string | null;
  /** Pages read so far in this run (`page` frames), with whether each came from the cache. */
  pages: DigestPageRead[];
  progress: string | null;
  sample: boolean;
  titleOf: (pageId: string) => string | undefined;
  onRetry: () => void;
}

export function DigestPanel({
  terms,
  digest,
  loading,
  error,
  pages,
  progress,
  sample,
  titleOf,
  onRetry,
}: DigestPanelProps) {
  const skipped = skippedPages(pages);

  if (loading && !digest) {
    return (
      <div className='flex flex-col gap-3'>
        <p className='text-st-fg flex items-center gap-2 text-sm font-medium'>
          <Loader2 className='text-st-accent h-4 w-4 animate-spin' /> {progress ?? 'Reading your notes…'}
        </p>
        {pages.length > 0 && (
          <ul className='flex flex-col gap-1'>
            {pages.map((page, index) => (
              <li key={page.pageId} className='text-st-muted flex items-center gap-2 text-sm'>
                {skipped.includes(`Page ${index + 1} couldn’t be read`) ? (
                  <AlertTriangle className='text-st-warn h-3.5 w-3.5' />
                ) : (
                  <Check className='text-st-ok h-3.5 w-3.5' />
                )}
                <span className='text-st-fg min-w-0 flex-1 truncate'>{titleOf(page.pageId) ?? 'Notes page'}</span>
                {page.cached && (
                  <span className='inline-flex items-center gap-1 text-xs' title='Unchanged since the last read'>
                    <Database className='h-3 w-3' /> cached
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <LoadingRows rows={3} />
      </div>
    );
  }
  if (error && !digest) return <ErrorNote message={error} onRetry={onRetry} />;
  if (!digest) return null;

  const byTerm = new Map(digest.concepts.map((row) => [normTerm(row.term), row]));
  const conflicts = new Map(digest.conflicts.map((row) => [normTerm(row.term), row]));
  // Her order first; anything the digest adds beyond her list after.
  const order = [
    ...terms,
    ...digest.concepts.map((row) => row.term).filter((term) => !terms.some((t) => normTerm(t) === normTerm(term))),
  ];

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex items-center gap-2'>
        <h3 className='text-st-fg text-sm font-semibold'>Your notes vs. the term list</h3>
        {sample && <Badge tone='warn'>Sample</Badge>}
        <span className='flex-1' />
        <button
          aria-label='Read the notes again'
          className='text-st-muted hover:bg-st-raised flex h-9 w-9 items-center justify-center rounded-full'
          type='button'
          onClick={onRetry}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <BuiltFrom provenance={digest.provenance} />

      {loading && progress && (
        <p className='text-st-muted flex items-center gap-2 text-xs'>
          <Loader2 className='h-3.5 w-3.5 animate-spin' /> {progress}
        </p>
      )}
      {error && <ErrorNote message={error} onRetry={onRetry} />}
      {skipped.length > 0 && (
        <p className='text-st-warn flex items-center gap-1.5 text-xs'>
          <AlertTriangle className='h-3.5 w-3.5 shrink-0' /> {skipped.join(' · ')} — the rest was used.
        </p>
      )}

      {digest.missingFromNotes.length > 0 && (
        <div className='rounded-st border-st-warn/40 bg-st-warn/10 border px-3 py-2'>
          <p className='text-st-fg flex items-center gap-1.5 text-sm font-medium'>
            <AlertTriangle className='text-st-warn h-4 w-4' /> Not in your notes
          </p>
          <p className='text-st-fg mt-1 text-sm'>{digest.missingFromNotes.join(' · ')}</p>
          <p className='text-st-muted mt-1 text-xs'>On the list — take them from the slide or the glossary.</p>
        </div>
      )}

      <ul className='flex flex-col gap-2'>
        {order.map((term) => {
          const key = normTerm(term);
          const row = byTerm.get(key);
          const conflict = conflicts.get(key);

          if (!row) return null;
          const wording = conflict?.professor || row.professorWording;

          return (
            <li key={key} className='rounded-st border-st-line bg-st-bg/60 border px-3 py-2.5'>
              <div className='flex items-center gap-2'>
                <span className='text-st-fg text-sm font-semibold'>{row.term}</span>
                <span className='flex-1' />
                {row.matchesProfessor && !conflict ? (
                  <Badge tone='ok'>
                    <Check className='h-3 w-3' /> matches
                  </Badge>
                ) : (
                  <Badge tone={conflict ? 'danger' : 'accent'}>{conflict ? 'conflicts' : 'reworded'}</Badge>
                )}
              </div>
              <p className='text-st-muted mt-1.5 flex gap-1.5 text-sm'>
                <NotebookText className='mt-0.5 h-3.5 w-3.5 shrink-0' />
                <span className='text-st-fg'>
                  {conflict?.notes || row.definitionFromNotes || 'No definition written.'}
                </span>
              </p>
              {wording && (!row.matchesProfessor || conflict) && (
                <p className='rounded-st border-st-accent/30 bg-st-accent/5 text-st-fg mt-1.5 flex gap-1.5 border px-2 py-1.5 text-sm'>
                  <Quote className='text-st-accent mt-0.5 h-3.5 w-3.5 shrink-0' />
                  <span>{wording}</span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
