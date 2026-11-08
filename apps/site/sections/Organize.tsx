import type { LucideIcon } from 'lucide-react';

import { ThemedShot } from '~/sections/ThemedShot';
import { CalendarDays, CalendarRange, GraduationCap, Library } from 'lucide-react';

import { Badge, Surface } from '@/components/ui/primitives';

import { TONE, type Tone } from '~/sections/tone';

interface Point {
  icon: LucideIcon;
  title: string;
  isNew?: boolean;
  tone: Tone;
  text: string;
}

const POINTS: Point[] = [
  {
    icon: GraduationCap,
    title: 'Classes from Canvas',
    tone: 'blue',
    text: 'Your grades, assignments, quizzes, files and announcements in one place. Not on Canvas? Add the class yourself.',
  },
  {
    icon: CalendarDays,
    title: 'Today',
    tone: 'citrine',
    text: 'One screen with what is due and what to review next.',
  },
  {
    icon: CalendarRange,
    title: 'Calendar',
    tone: 'coral',
    isNew: true,
    text: 'Week and month views of due dates, exams, class times and reviews, each in its class colour. Tap any entry to open it.',
  },
  {
    icon: Library,
    title: 'Library',
    tone: 'green',
    text: 'Every file and reading from every class, in one searchable list.',
  },
];

export function Organize() {
  return (
    <section aria-labelledby='organize-title' className='scroll-mt-4 py-8 md:py-10' data-reveal id='organize'>
      <div className='mx-auto max-w-6xl px-4'>
        <div className='mb-6 max-w-2xl'>
          <Badge className={TONE.coral.badge}>Organize</Badge>
          <h2
            className='font-display text-st-fg mt-3 text-2xl font-bold leading-tight md:text-3xl'
            id='organize-title'
          >
            Stay on top of the semester
          </h2>
          <p className='text-st-muted mt-2 text-base'>
            Your classes, deadlines and readings in one app, so nothing due slips past.
          </p>
        </div>

        <div className='grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-8'>
          <ul className='divide-st-line flex flex-col divide-y'>
            {POINTS.map(({ icon: Icon, title, isNew, text, tone }) => (
              <li key={title} className='flex gap-3 py-3 first:pt-0' data-reveal-item>
                <span className={`${TONE[tone].tile} mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md`}>
                  <Icon aria-hidden className='h-5 w-5' />
                </span>
                <div className='min-w-0'>
                  <h3 className='text-st-fg flex flex-wrap items-center gap-2 text-base font-semibold'>
                    {title}
                    {isNew && <Badge className={TONE.coral.badge}>New</Badge>}
                  </h3>
                  <p className='text-st-muted mt-0.5 text-sm leading-snug'>{text}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className='min-w-0'>
            <div className='min-w-0' data-reveal-item>
              <Surface className='p-2 md:p-3'>
                <ThemedShot
                  alt='Calendar week view with class times, due dates, exams and reviews, each coloured by class'
                  className='border-st-line block h-auto w-full rounded-md border'
                  height={800}
                  loading='lazy'
                  src='/shots/calendar.png'
                  width={1280}
                />
              </Surface>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
