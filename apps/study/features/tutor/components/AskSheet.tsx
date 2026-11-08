import type { TutorContext, TutorMode } from '../types';

import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Sparkles, X } from 'lucide-react';
import Link from 'next/link';

import { Chat } from './Chat';

import { useClasses } from '@/lib/api/hooks';

export interface AskSheetProps {
  open: boolean;
  onClose: () => void;
  classId?: string | null;
  /** What the question is about — every turn in this sheet carries it. */
  context?: TutorContext;
  /** Shown under the title, e.g. «Lesson 3 · at 12:40». */
  contextLabel?: string | null;
  mode?: TutorMode;
}

export function tutorHref(classId?: string | null, conversationId?: string | null): string {
  const params = new URLSearchParams();

  if (classId) params.set('classId', classId);
  if (conversationId) params.set('id', conversationId);
  const query = params.toString();

  return `/tutor/${query ? `?${query}` : ''}`;
}

/**
 * The slide-over other screens open with context (an item, a notebook page, a moment in a video).
 * One thread per opening; «Open in Tutor» continues it on the full page.
 */
export function AskSheet({ open, onClose, classId, context, contextLabel, mode = 'explain' }: AskSheetProps) {
  const classes = useClasses('all');
  const cls = useMemo(
    () => classes.data?.find((candidate) => candidate.id === classId) ?? null,
    [classes.data, classId],
  );
  const [conversationId, setConversationId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, open]);

  // A fresh thread every time the sheet opens on something else.
  useEffect(() => {
    if (!open) setConversationId(null);
  }, [open]);

  if (!open) return null;

  return (
    <div className='fixed inset-0 z-50 flex justify-end'>
      <button aria-label='Close' className='absolute inset-0 bg-st-shadow/30' type='button' onClick={onClose} />
      <aside
        aria-label='Ask the tutor'
        className='bg-st-bg border-st-clay-edge relative flex h-full w-full max-w-md flex-col border-l-[1.5px]'
        role='dialog'
      >
        <header className='border-st-line flex items-center gap-2 border-b px-4 py-3'>
          <span className='bg-st-raised text-st-fg flex h-8 w-8 items-center justify-center rounded-full'>
            <Sparkles className='h-4 w-4' strokeWidth={1.75} />
          </span>
          <div className='min-w-0 flex-1'>
            <p className='text-st-fg truncate text-sm font-semibold'>Ask tutor{cls ? ` · ${cls.code}` : ''}</p>
            {contextLabel && <p className='text-st-muted truncate text-xs'>{contextLabel}</p>}
          </div>
          <Link
            className='text-st-muted hover:text-st-fg inline-flex h-9 items-center gap-1 rounded-full px-2 text-xs font-medium'
            href={tutorHref(classId, conversationId)}
            title='Continue on the Tutor page'
            onClick={onClose}
          >
            <ExternalLink className='h-3.5 w-3.5' /> Open in Tutor
          </Link>
          <button
            aria-label='Close'
            className='text-st-fg hover:bg-st-raised inline-flex h-9 w-9 items-center justify-center rounded-full'
            type='button'
            onClick={onClose}
          >
            <X className='h-5 w-5' />
          </button>
        </header>
        <div className='min-h-0 flex-1'>
          <Chat
            compact
            focusOnMount
            baseContext={context}
            classId={classId}
            cls={cls}
            contextLabel={contextLabel}
            conversationId={conversationId}
            initialMode={mode}
            onConversationCreated={setConversationId}
          />
        </div>
      </aside>
    </div>
  );
}
