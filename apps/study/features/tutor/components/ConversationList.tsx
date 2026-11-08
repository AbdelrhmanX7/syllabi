import { cn } from '@repo/ui';
import { MessageCircle, Plus, Target } from 'lucide-react';

import { useConversations } from '../hooks';

import { ActionButton, Badge, EmptyState, ErrorNote, LoadingRows } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';
import { isSampleData } from '@/lib/api/sample';
import { formatRelative } from '@/lib/format';

export interface ConversationListProps {
  classId?: string | null;
  activeId?: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

/** This class's threads, newest first, with a «New chat» button on top. */
export function ConversationList({ classId, activeId, onSelect, onNew }: ConversationListProps) {
  const list = useConversations(classId);
  const rows = list.data ?? [];

  return (
    <div className='flex h-full min-h-0 flex-col gap-3'>
      <ActionButton className='w-full' variant='primary' onClick={onNew}>
        <Plus className='h-4 w-4' /> New chat
      </ActionButton>
      <div className='min-h-0 flex-1 overflow-y-auto'>
        {list.isLoading && <LoadingRows rows={4} />}
        {list.error && <ErrorNote message={describeError(list.error)} onRetry={() => void list.refetch()} />}
        {!list.isLoading && !list.error && rows.length === 0 && (
          <EmptyState hint='Your chats with the tutor for this class will show up here.' title='No chats yet' />
        )}
        {rows.length > 0 && (
          <ul className='flex flex-col gap-1'>
            {rows.map((row) => {
              const active = row.id === activeId;
              const Icon = row.mode === 'quiz' ? Target : MessageCircle;

              return (
                <li key={row.id}>
                  <button
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'rounded-st flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors',
                      active ? 'bg-st-raised' : 'hover:bg-st-raised',
                    )}
                    type='button'
                    onClick={() => onSelect(row.id)}
                  >
                    <span className='flex items-center gap-2'>
                      <Icon className='text-st-muted h-4 w-4 shrink-0' strokeWidth={1.75} />
                      <span className='text-st-fg min-w-0 flex-1 truncate text-sm font-medium'>{row.title}</span>
                      {isSampleData(row) && <Badge tone='warn'>Sample</Badge>}
                    </span>
                    <span className='text-st-muted flex items-center gap-2 pl-6 text-xs'>
                      <span className='min-w-0 flex-1 truncate'>
                        {row.preview || (row.messageCount ? `${row.messageCount} messages` : '')}
                      </span>
                      <span className='shrink-0 tabular-nums'>{formatRelative(row.updatedAt)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
