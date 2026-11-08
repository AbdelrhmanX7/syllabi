import { useEffect, useState } from 'react';
import { BookOpen, NotebookPen, Search as SearchIcon, Subtitles } from 'lucide-react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { notebookHref } from './class';

import { ItemRow, itemHref } from '@/components/items/ItemRow';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, ErrorNote, INPUT_CLASS, LoadingRows, SectionTitle, Surface } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';
import { useClasses, useSearch } from '@/lib/api/hooks';
import { formatDuration, formatRelative } from '@/lib/format';
import { rememberPages } from '@/lib/notebooks/pages-cache';

export default function SearchPage() {
  const router = useRouter();
  const initial = typeof router.query.q === 'string' ? router.query.q : '';
  const [text, setText] = useState(initial);
  const [q, setQ] = useState(initial);
  const { data, isFetching, error } = useSearch(q);
  const { data: classes } = useClasses('all');

  // The query string is empty on the first render of a static page; take it once the router has it.
  useEffect(() => {
    if (!router.isReady) return;
    const fromUrl = typeof router.query.q === 'string' ? router.query.q : '';

    if (fromUrl && !text) {
      setText(fromUrl);
      setQ(fromUrl.trim());
    }
  }, [router.isReady]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(text.trim()), 250);

    return () => window.clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (data?.pages) rememberPages(data.pages);
  }, [data?.pages]);

  const classOf = (classId: string | null) => classes?.find((cls) => cls.id === classId);
  const total = data ? data.items.length + data.pages.length + data.questions.length + data.transcripts.length : 0;

  return (
    <>
      <Head>
        <title>Search · Syllabi</title>
      </Head>
      <PageHeader title='Search' />
      <div className='relative mb-6'>
        <SearchIcon className='text-st-muted pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2' />
        <input
          className={`${INPUT_CLASS} min-h-14 pl-12 text-base`}
          placeholder='Search items, notebooks, questions, transcripts…'
          type='search'
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>

      {error && <ErrorNote message={describeError(error)} />}
      {isFetching && !data && <LoadingRows rows={4} />}
      {q.length > 1 && data && total === 0 && !isFetching && (
        <EmptyState icon={SearchIcon} title={`Nothing matches “${q}”`} />
      )}
      {q.length <= 1 && <EmptyState hint='Type at least two characters.' icon={SearchIcon} title='Search everything' />}

      {data && total > 0 && (
        <div className='grid gap-6 xl:grid-cols-2'>
          {data.items.length > 0 && (
            <Surface className='p-4'>
              <SectionTitle count={data.items.length}>Items</SectionTitle>
              {data.items.map((item) => {
                const cls = classOf(item.classId);

                return (
                  <ItemRow key={item.id} item={item} showClass={cls ? { name: cls.code, color: cls.color } : null} />
                );
              })}
            </Surface>
          )}
          {data.pages.length > 0 && (
            <Surface className='p-4'>
              <SectionTitle count={data.pages.length}>
                <NotebookPen className='text-st-muted mr-1 inline h-4 w-4' /> Notebooks
              </SectionTitle>
              {data.pages.map((page) => (
                <Link
                  key={page.id}
                  className='rounded-st hover:bg-st-raised flex min-h-12 items-center gap-3 px-3 py-2'
                  href={notebookHref(page)}
                >
                  <span className='min-w-0 flex-1'>
                    <span className='text-st-fg block truncate text-sm font-medium'>{page.title}</span>
                    <span className='text-st-muted block text-xs'>
                      {classOf(page.classId)?.code ?? ''} · {page.kind} · {formatRelative(page.updatedAt)}
                    </span>
                  </span>
                </Link>
              ))}
            </Surface>
          )}
          {data.questions.length > 0 && (
            <Surface className='p-4'>
              <SectionTitle count={data.questions.length}>
                <BookOpen className='text-st-muted mr-1 inline h-4 w-4' /> Questions
              </SectionTitle>
              {data.questions.map((question) => (
                <Link
                  key={question.id}
                  className='rounded-st hover:bg-st-raised flex min-h-12 flex-col justify-center px-3 py-2'
                  href={`/bank/?q=${encodeURIComponent(question.id)}`}
                >
                  <span className='text-st-fg line-clamp-2 text-sm'>{question.stem}</span>
                  <span className='text-st-muted text-xs'>
                    {classOf(question.classId)?.code ?? ''} · {question.topic}
                  </span>
                </Link>
              ))}
            </Surface>
          )}
          {data.transcripts.length > 0 && (
            <Surface className='p-4'>
              <SectionTitle count={data.transcripts.length}>
                <Subtitles className='text-st-muted mr-1 inline h-4 w-4' /> Transcripts
              </SectionTitle>
              {data.transcripts.map((hit, index) => (
                <Link
                  key={`${hit.itemId ?? hit.lectureId}-${index}`}
                  className='rounded-st hover:bg-st-raised flex min-h-12 items-start gap-3 px-3 py-2'
                  href={
                    hit.itemId
                      ? `${itemHref({ id: hit.itemId })}&t=${Math.floor(hit.start)}`
                      : `/lectures/?id=${encodeURIComponent(hit.lectureId ?? '')}&t=${Math.floor(hit.start)}`
                  }
                >
                  <span className='bg-st-raised text-st-muted mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs tabular-nums'>
                    {formatDuration(hit.start) || '0:00'}
                  </span>
                  <span className='text-st-fg line-clamp-2 text-sm'>{hit.text}</span>
                </Link>
              ))}
            </Surface>
          )}
        </div>
      )}
    </>
  );
}
