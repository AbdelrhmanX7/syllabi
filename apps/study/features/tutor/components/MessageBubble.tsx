import type { TutorContext, TutorMessage } from '../types';

import { cn } from '@repo/ui';
import { FileText, Image as ImageIcon, NotebookPen, PlayCircle } from 'lucide-react';

import { formatClock } from '../lib/sources';

import { SourceChips } from './SourceChips';

import { Badge } from '@/components/ui/primitives';
import { Markdown } from '@/features/bank';

/** What a user turn was about, as small chips (+ the attached picture). */
function ContextChips({ context }: { context: TutorContext }) {
  const chips: { icon: typeof FileText; label: string }[] = [];

  if (context.videoAt) chips.push({ icon: PlayCircle, label: `At ${formatClock(context.videoAt.t)}` });
  else if (context.itemId) chips.push({ icon: FileText, label: 'About this item' });
  if (context.pageId) chips.push({ icon: NotebookPen, label: 'Notebook page' });
  if (context.text)
    chips.push({ icon: FileText, label: `“${context.text.slice(0, 40)}${context.text.length > 40 ? '…' : ''}”` });

  if (chips.length === 0 && !context.imagePngB64) return null;

  return (
    <div className='mb-2 flex flex-wrap items-center gap-1.5'>
      {chips.map((chip) => {
        const Icon = chip.icon;

        return (
          <span
            key={chip.label}
            className='bg-st-bg/15 inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] font-medium opacity-90'
          >
            <Icon className='h-3 w-3' /> {chip.label}
          </span>
        );
      })}
      {context.imagePngB64 && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt='Attachment'
          className='border-st-bg/30 max-h-40 w-auto max-w-full rounded-md border bg-white'
          src={`data:image/png;base64,${context.imagePngB64}`}
        />
      )}
      {context.imagePngB64 && (
        <span className='sr-only'>
          <ImageIcon className='h-3 w-3' /> picture attached
        </span>
      )}
    </div>
  );
}

export interface MessageBubbleProps {
  message: TutorMessage;
  classId?: string | null;
  /** The assistant is still writing this one. */
  streaming?: boolean;
  /** The mock answered — a small chip says so. */
  sample?: boolean;
}

export function MessageBubble({ message, classId, streaming = false, sample = false }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'rounded-st-lg max-w-[min(100%,46rem)] px-4 py-3',
          isUser ? 'border-st-accent-lip bg-st-accent text-st-accent-fg border-2' : 'border-st-clay-edge bg-st-surface shadow-clay border-2',
        )}
      >
        {isUser ? (
          <>
            {message.context && <ContextChips context={message.context} />}
            {message.text && <p className='whitespace-pre-wrap text-base leading-7'>{message.text}</p>}
          </>
        ) : (
          <>
            {message.text ? (
              <Markdown text={message.text} />
            ) : (
              streaming && (
                <p aria-live='polite' className='text-st-muted text-sm'>
                  Thinking…
                </p>
              )
            )}
            {streaming && message.text && (
              <span aria-hidden className='bg-st-fg ml-0.5 inline-block h-4 w-1.5 animate-pulse align-middle' />
            )}
            {!streaming && message.sources && <SourceChips classId={classId} sources={message.sources} />}
            {sample && !streaming && (
              <div className='mt-2'>
                <Badge tone='warn'>Sample</Badge>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
