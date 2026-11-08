import type { StudyClass } from '@/lib/api/types';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';

import { Chat } from './components/Chat';
import { ConversationList } from './components/ConversationList';

import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, FilterChip, LoadingRows } from '@/components/ui/primitives';
import { useClasses } from '@/lib/api/hooks';

export { AskSheet, tutorHref } from './components/AskSheet';
export { AskTutorButton } from './components/AskTutorButton';
export { Chat } from './components/Chat';
export { createStudyBoardAi, useStudyBoardAi, STUDY_BOARD_AI_LABEL } from './boardAi';
export { tutorKeys, useAsk, useConversation, useConversations } from './hooks';
export { classKind, quickPromptsForClass } from './lib/prompts';
export { tutorMockRoutes } from './mock';
export type * from './types';

/**
 * `/tutor` — the AI tutor, per class. Threads on the left, the chat on the right; the class chips
 * switch both. The shell owns the route (`?classId=&id=`); this screen keeps the URL in step.
 */

const LAST_CLASS_KEY = 'study_tutor_class';

function readLastClass(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(LAST_CLASS_KEY);
  } catch {
    return null;
  }
}

function rememberClass(classId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_CLASS_KEY, classId);
  } catch {
    // private mode — the chips still work for this session
  }
}

export interface TutorHomeProps {
  classId?: string;
  conversationId?: string;
  className?: string;
}

export default function TutorHome({
  classId: initialClassId,
  conversationId: initialConversationId,
  className = '',
}: TutorHomeProps) {
  const router = useRouter();
  const classes = useClasses();
  const classList = useMemo(() => classes.data ?? [], [classes.data]);
  const [picked, setPicked] = useState<string | null>(initialClassId ?? null);
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId ?? null);

  useEffect(() => {
    if (initialClassId) setPicked(initialClassId);
  }, [initialClassId]);

  useEffect(() => {
    setConversationId(initialConversationId ?? null);
  }, [initialConversationId]);

  const classId = useMemo(() => {
    if (picked && classList.some((cls) => cls.id === picked)) return picked;
    const last = readLastClass();

    if (last && classList.some((cls) => cls.id === last)) return last;

    return classList[0]?.id ?? '';
  }, [classList, picked]);
  const cls: StudyClass | null = useMemo(
    () => classList.find((entry) => entry.id === classId) ?? null,
    [classList, classId],
  );

  const syncUrl = useCallback(
    (nextClassId: string, nextConversationId: string | null) => {
      const query: Record<string, string> = {};

      if (nextClassId) query.classId = nextClassId;
      if (nextConversationId) query.id = nextConversationId;
      void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
    },
    [router],
  );

  const selectClass = (next: string) => {
    rememberClass(next);
    setPicked(next);
    setConversationId(null);
    syncUrl(next, null);
  };

  const selectConversation = (id: string) => {
    setConversationId(id);
    syncUrl(classId, id);
  };

  const startNew = () => {
    setConversationId(null);
    syncUrl(classId, null);
  };

  if (classes.isLoading) return <LoadingRows rows={6} />;

  if (classList.length === 0) {
    return (
      <EmptyState hint='Connect Canvas in Settings so the tutor knows which classes you take.' title='No classes yet' />
    );
  }

  return (
    <div className={`flex h-[calc(100vh-7.5rem-var(--st-nav-offset,0px))] min-h-[32rem] supports-[height:100dvh]:h-[calc(100dvh-7.5rem-var(--st-nav-offset,0px))] flex-col ${className}`}>
      <PageHeader
        actions={
          classList.length > 1 ? (
            <div className='flex flex-wrap gap-2'>
              {classList.map((entry) => (
                <FilterChip key={entry.id} active={entry.id === classId} onClick={() => selectClass(entry.id)}>
                  <span className='h-2 w-2 rounded-sm' style={{ backgroundColor: entry.color }} />
                  {entry.code}
                </FilterChip>
              ))}
            </div>
          ) : undefined
        }
        eyebrow={cls ? `${cls.code} · ${cls.name}` : 'AI tutor'}
        title='Tutor'
      />
      <div className='grid min-h-0 flex-1 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]'>
        <aside className='hidden min-h-0 lg:block'>
          <ConversationList
            activeId={conversationId}
            classId={classId}
            onNew={startNew}
            onSelect={selectConversation}
          />
        </aside>
        <section className='min-h-0'>
          <Chat
            key={`${classId}:${conversationId ?? 'new'}`}
            focusOnMount
            classId={classId}
            cls={cls}
            conversationId={conversationId}
            onConversationCreated={selectConversation}
          />
        </section>
      </div>
    </div>
  );
}
