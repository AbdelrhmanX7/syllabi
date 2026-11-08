import type { Item, StudyClass } from '@/lib/api/types';

import { useMemo } from 'react';
import { Bell, CalendarClock, CheckCircle2, RefreshCw, Sparkles } from 'lucide-react';
import dynamic from 'next/dynamic';
import Head from 'next/head';

import { ClassCard } from '@/components/classes/ClassCard';
import { ItemRow } from '@/components/items/ItemRow';
import { PageHeader } from '@/components/layout/PageHeader';
import { SampleDataBanner } from '@/components/ui/SampleDataBanner';
import {
  Badge,
  EmptyState,
  ErrorNote,
  LinkButton,
  LoadingRows,
  SectionTitle,
  Surface,
} from '@/components/ui/primitives';
import { useCanvasStatus, useToday } from '@/lib/api/hooks';
import { describeError } from '@/lib/api/errors';
import { isSampleData } from '@/lib/api/sample';

// Grade-goal nudges + high-priority announcements, from the same Today cache (features/aplan).
const TodayAPlanStrip = dynamic(() => import('@/features/aplan').then((mod) => mod.TodayAPlanStrip), { ssr: false });

// Upcoming exams across every class, nearest first; renders nothing when none is scheduled (features/guide).
const ExamCountdown = dynamic(() => import('@/features/guide').then((mod) => mod.ExamCountdown), { ssr: false });

// «Class today»: a one-tap lecture note for each class that meets today (features/lecturenotes).
const TodayLectures = dynamic(
  () => import('@/features/lecturenotes/components/TodayLectures').then((mod) => mod.TodayLectures),
  { ssr: false },
);

function greeting(): string {
  const hour = new Date().getHours();

  return hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

function ItemList({ items, classes, empty }: { items: Item[]; classes: Map<string, StudyClass>; empty: string }) {
  if (items.length === 0) return <p className='text-st-muted px-3 py-4 text-sm'>{empty}</p>;

  return (
    <div className='flex flex-col'>
      {items.map((item) => {
        const cls = classes.get(item.classId);

        return <ItemRow key={item.id} item={item} showClass={cls ? { name: cls.code, color: cls.color } : null} />;
      })}
    </div>
  );
}

export default function TodayPage() {
  const { data, isLoading, error, refetch } = useToday();
  const canvas = useCanvasStatus();
  const syncing = Boolean(canvas.data?.syncing);
  const classes = useMemo(() => new Map((data?.classes ?? []).map((cls) => [cls.id, cls])), [data?.classes]);
  const today = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());

  return (
    <>
      <Head>
        <title>Today · Syllabi</title>
      </Head>
      <PageHeader
        eyebrow={today}
        subtitle={
          <span className='inline-flex flex-wrap items-center gap-2'>
            {data && `${data.due.length} due this week · ${data.overdue.length} overdue · ${data.unseen.length} new`}
            {syncing && (
              <Badge tone='accent'>
                <RefreshCw className='h-3 w-3 animate-spin' /> Syncing Canvas…
              </Badge>
            )}
          </span>
        }
        title={greeting()}
      />

      {error && <ErrorNote message={describeError(error)} onRetry={() => void refetch()} />}

      {isLoading && !data && <LoadingRows rows={6} />}

      {data && isSampleData(data) && <SampleDataBanner className='mb-5' what='Today data' />}
      {data && <ExamCountdown className='mb-6' />}
      {data && <TodayAPlanStrip />}
      {data && <TodayLectures classes={data.classes} />}

      {data && (
        <div className='grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'>
          <div className='flex flex-col gap-6'>
            <Surface className='p-4'>
              <SectionTitle count={data.overdue.length + data.due.length}>
                <CalendarClock className='text-st-muted mr-1 inline h-4 w-4' /> Due
              </SectionTitle>
              {data.overdue.length > 0 && (
                <div className='mb-2'>
                  <p className='text-st-danger px-3 pb-1 text-xs font-semibold uppercase tracking-wide'>Overdue</p>
                  <ItemList classes={classes} empty='' items={data.overdue} />
                </div>
              )}
              <ItemList classes={classes} empty='Nothing due in the next 7 days.' items={data.due} />
            </Surface>

            <Surface className='p-4'>
              <SectionTitle count={data.unseen.length}>
                <Sparkles className='text-st-muted mr-1 inline h-4 w-4' /> New since last time
              </SectionTitle>
              <ItemList classes={classes} empty='Nothing new.' items={data.unseen} />
            </Surface>
          </div>

          <div className='flex flex-col gap-6'>
            <Surface className='p-4'>
              <SectionTitle
                action={
                  <LinkButton href='/bank/' variant='primary'>
                    Review now
                  </LinkButton>
                }
              >
                <CheckCircle2 className='text-st-muted mr-1 inline h-4 w-4' /> Review
              </SectionTitle>
              <div className='flex items-end gap-6 px-3 pb-2'>
                <div>
                  <p className='text-st-fg text-4xl font-semibold tabular-nums'>{data.review.dueCount}</p>
                  <p className='text-st-muted text-sm'>cards due</p>
                </div>
                <div>
                  <p className='text-st-fg text-2xl font-semibold tabular-nums'>{data.review.newCount}</p>
                  <p className='text-st-muted text-sm'>new</p>
                </div>
              </div>
              {data.weakTopics.length > 0 && (
                <div className='border-st-line mt-2 border-t pt-3'>
                  <p className='text-st-muted px-3 pb-2 text-xs font-semibold uppercase tracking-wide'>Weak topics</p>
                  <ul className='flex flex-col gap-1 px-3'>
                    {data.weakTopics.slice(0, 6).map((topic) => {
                      const cls = classes.get(topic.classId);

                      return (
                        <li key={`${topic.classId}:${topic.topic}`} className='flex items-center gap-3 text-sm'>
                          {cls && (
                            <span className='h-2 w-2 shrink-0 rounded-sm' style={{ backgroundColor: cls.color }} />
                          )}
                          <span className='text-st-fg min-w-0 flex-1 [overflow-wrap:anywhere]'>{topic.topic}</span>
                          <span className='bg-st-raised h-1.5 w-16 shrink-0 overflow-hidden sm:w-24 rounded-full'>
                            <span
                              className='bg-st-warn block h-full rounded-full'
                              style={{ width: `${Math.round(topic.mastery * 100)}%` }}
                            />
                          </span>
                          <span className='text-st-muted w-10 text-right text-xs tabular-nums'>
                            {Math.round(topic.mastery * 100)}%
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </Surface>

            <Surface className='p-4'>
              <SectionTitle count={data.announcements.length}>
                <Bell className='text-st-muted mr-1 inline h-4 w-4' /> Announcements
              </SectionTitle>
              <ItemList classes={classes} empty='No unread announcements.' items={data.announcements.slice(0, 8)} />
            </Surface>
          </div>

          <section className='xl:col-span-2'>
            <SectionTitle count={data.classes.length}>Classes</SectionTitle>
            {data.classes.length === 0 ? (
              <EmptyState
                action={<LinkButton href='/settings/'>Connect Canvas</LinkButton>}
                hint='Connect your Canvas token in Settings and run a sync.'
                title='No classes yet'
              />
            ) : (
              <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
                {data.classes.map((cls) => (
                  <ClassCard key={cls.id} cls={cls} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {data && data.overdue.length === 0 && data.due.length === 0 && data.unseen.length === 0 && (
        <div className='mt-6 flex justify-center'>
          <Badge tone='ok'>All caught up</Badge>
        </div>
      )}
    </>
  );
}
