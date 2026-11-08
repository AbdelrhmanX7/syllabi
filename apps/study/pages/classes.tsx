import { useState } from 'react';
import { Layers, Plus } from 'lucide-react';
import Head from 'next/head';

import { ClassCard } from '@/components/classes/ClassCard';
import { ClassFormSheet } from '@/components/classes/ClassFormSheet';
import { PageHeader } from '@/components/layout/PageHeader';
import { ActionButton, EmptyState, ErrorNote, FilterChip, LinkButton, LoadingRows } from '@/components/ui/primitives';
import { useClasses } from '@/lib/api/hooks';
import { describeError } from '@/lib/api/errors';

export default function ClassesPage() {
  const [term, setTerm] = useState<'current' | 'all'>('current');
  const { data, isLoading, error, refetch } = useClasses(term === 'all' ? 'all' : undefined);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <Head>
        <title>Classes · Syllabi</title>
      </Head>
      <PageHeader
        actions={
          <>
            <FilterChip active={term === 'current'} onClick={() => setTerm('current')}>
              This term
            </FilterChip>
            <FilterChip active={term === 'all'} onClick={() => setTerm('all')}>
              All terms
            </FilterChip>
            <ActionButton variant='primary' onClick={() => setCreating(true)}>
              <Plus className='h-4 w-4' /> New class
            </ActionButton>
          </>
        }
        subtitle={data ? `${data.length} classes` : undefined}
        title='Classes'
      />
      {creating && <ClassFormSheet onClose={() => setCreating(false)} />}
      {error && <ErrorNote message={describeError(error)} onRetry={() => void refetch()} />}
      {isLoading && !data && <LoadingRows rows={4} />}
      {data && data.length === 0 && (
        <EmptyState
          action={
            <div className='flex flex-wrap justify-center gap-3'>
              <ActionButton variant='primary' onClick={() => setCreating(true)}>
                <Plus className='h-4 w-4' /> New class
              </ActionButton>
              <LinkButton href='/settings/'>Open Settings</LinkButton>
            </div>
          }
          hint='Make a class of your own, or connect Canvas and sync.'
          icon={Layers}
          title='No classes'
        />
      )}
      {data && data.length > 0 && (
        <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
          {data.map((cls) => (
            <ClassCard key={cls.id} cls={cls} />
          ))}
        </div>
      )}
    </>
  );
}
