import type { Item, ItemType, SubmissionState } from '@/lib/api/types';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@repo/ui';
import { Bell, ClipboardList, ExternalLink, FileText, HelpCircle, Link2, PlayCircle, StickyNote } from 'lucide-react';
import Link from 'next/link';

import { Badge, Dot } from '@/components/ui/primitives';
import { effectiveDue } from '@/lib/due';
import { formatDue, formatRelative } from '@/lib/format';

export const ITEM_TYPE_ICON: Record<ItemType, LucideIcon> = {
  file: FileText,
  page: StickyNote,
  assignment: ClipboardList,
  quiz: HelpCircle,
  video: PlayCircle,
  link: Link2,
  announcement: Bell,
};

export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  file: 'File',
  page: 'Page',
  assignment: 'Assignment',
  quiz: 'Quiz',
  video: 'Video',
  link: 'Link',
  announcement: 'Announcement',
};

/** Filter-chip labels: not every type pluralises with a plain "s". */
export const ITEM_TYPE_PLURAL: Record<ItemType, string> = {
  file: 'Files',
  page: 'Pages',
  assignment: 'Assignments',
  quiz: 'Quizzes',
  video: 'Videos',
  link: 'Links',
  announcement: 'Announcements',
};

const SUBMISSION_LABEL: Record<
  SubmissionState,
  { label: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' }
> = {
  unsubmitted: { label: 'Not submitted', tone: 'neutral' },
  submitted: { label: 'Submitted', tone: 'accent' },
  graded: { label: 'Graded', tone: 'ok' },
  missing: { label: 'Missing', tone: 'danger' },
  late: { label: 'Late', tone: 'warn' },
};

export function itemHref(item: Pick<Item, 'id'>): string {
  return `/item/?id=${encodeURIComponent(item.id)}`;
}

export function ItemRow({
  item,
  showClass,
  className,
}: {
  item: Item;
  showClass?: { name: string; color: string } | null;
  className?: string;
}) {
  const Icon = ITEM_TYPE_ICON[item.type] ?? FileText;
  const dueAt = effectiveDue(item);
  const isOverdue =
    !!dueAt &&
    new Date(dueAt).getTime() < Date.now() &&
    item.submission?.state !== 'submitted' &&
    item.submission?.state !== 'graded';
  const submission = item.submission ? SUBMISSION_LABEL[item.submission.state] : null;
  const isExternalLink = item.type === 'link';
  const content = (
    <>
      <span className='relative mt-0.5 shrink-0'>
        <Icon className='text-st-muted h-5 w-5' strokeWidth={1.75} />
        {!item.seenAt && <Dot className='absolute -right-1 -top-1 h-2 w-2' />}
      </span>
      <span className='min-w-0 flex-1'>
        <span className='flex flex-wrap items-center gap-x-2 gap-y-1'>
          <span className={cn('text-st-fg truncate text-sm font-medium', !item.seenAt && 'font-semibold')}>
            {item.title}
          </span>
          {item.external?.tool && <Badge tone='accent'>{item.external.tool}</Badge>}
          {submission && item.submission?.state !== 'unsubmitted' && (
            <Badge tone={submission.tone}>{submission.label}</Badge>
          )}
        </span>
        <span className='text-st-muted mt-0.5 flex flex-wrap items-center gap-x-2 text-xs'>
          {showClass && (
            <span className='inline-flex items-center gap-1'>
              <span className='h-2 w-2 rounded-sm' style={{ backgroundColor: showClass.color }} />
              {showClass.name}
            </span>
          )}
          <span>{ITEM_TYPE_LABEL[item.type]}</span>
          {dueAt && <span className={cn(isOverdue && 'text-st-danger font-medium')}>Due {formatDue(dueAt)}</span>}
          {item.dueChangedBy && (
            <span title={`Due date moved by an announcement: ${item.dueChangedBy.text}`}>
              <Badge tone='warn'>Moved by announcement</Badge>
            </span>
          )}
          {typeof item.points === 'number' && item.points > 0 && (
            <span>
              {item.submission?.score !== null && item.submission?.score !== undefined
                ? `${item.submission.score}/`
                : ''}
              {item.points} pts
            </span>
          )}
          {!dueAt && <span>Updated {formatRelative(item.updatedAt)}</span>}
        </span>
      </span>
      {isExternalLink && <ExternalLink className='text-st-muted h-4 w-4 shrink-0' />}
    </>
  );
  const rowClass = cn(
    'flex min-h-14 items-start gap-3 rounded-st px-3 py-2.5 transition-colors hover:bg-st-raised',
    className,
  );

  if (isExternalLink) {
    return (
      <a className={rowClass} href={item.canvasUrl ?? undefined} rel='noreferrer' target='_blank'>
        {content}
      </a>
    );
  }

  return (
    <Link className={rowClass} href={itemHref(item)}>
      {content}
    </Link>
  );
}
