import type { LucideIcon } from 'lucide-react';

import { CalendarDays, CalendarRange, GraduationCap, Library } from 'lucide-react';

import { Badge, Surface } from '@/components/ui/primitives';

interface Point {
  icon: LucideIcon;
  title: string;
  isNew?: boolean;
  text: string;
}

const POINTS: Point[] = [
  {
    icon: GraduationCap,
    title: 'Classes from Canvas',
    text: 'Grades, assignments, quizzes, files, pages and announcements sync into one place. Add manual classes for anything not on Canvas.',
  },
  {
    icon: CalendarDays,
    title: 'Today',
    text: 'One screen with what is due and what to review next.',
  },
  {
    icon: CalendarRange,
    title: 'Calendar',
    isNew: true,
    text: 'Week and month views of due dates, exams, class times and reviews, each in its class colour. Tap any entry to open it.',
  },
  {
    icon: Library,
    title: 'Library',
    text: 'Every file and reading from every class, in one searchable list.',
  },
];

export function Organize() {
  return (
    <section aria-labelledby='organize-title' className='scroll-mt-16 py-10 md:py-14' id='organize'>
      <div className='mx-auto max-w-6xl px-4'>
        <div className='mb-6 max-w-2xl'>
          <h2
            className='font-display text-st-fg text-2xl font-bold leading-tight md:text-3xl'
            id='organize-title'
          >
            Stay on top of the semester
          </h2>
          <p className='text-st-muted mt-2 text-base'>
            Your classes, deadlines and readings in one app, so nothing due slips past.
          </p>
        </div>

        <div className='grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,8fr)]'>
          <div className='flex min-w-0 flex-col gap-6'>
            <ul className='divide-st-line flex flex-col divide-y'>
              {POINTS.map(({ icon: Icon, title, isNew, text }) => (
                <li key={title} className='flex gap-3 py-3 first:pt-0'>
                  <span className='bg-st-accent-soft text-st-accent rounded-st mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center'>
                    <Icon aria-hidden className='h-4 w-4' />
                  </span>
                  <div className='min-w-0'>
                    <h3 className='text-st-fg flex flex-wrap items-center gap-2 text-base font-semibold'>
                      {title}
                      {isNew && <Badge tone='accent'>New</Badge>}
                    </h3>
                    <p className='text-st-muted mt-0.5 text-sm leading-snug'>{text}</p>
                  </div>
                </li>
              ))}
            </ul>

            <Surface className='hidden p-2 lg:block'>
              <div className='border-st-line rounded-st overflow-hidden border'>
                <img
                  alt='Classes screen: a card per class with its colour, code, grade and what is due'
                  className='block h-auto w-full'
                  height={800}
                  loading='lazy'
                  src='/shots/classes.png'
                  width={1280}
                />
              </div>
            </Surface>
          </div>

          <Surface className='min-w-0 p-2 md:p-3'>
            <div className='border-st-line rounded-st overflow-hidden border'>
              <img
                alt='Calendar month view with assignment due dates, exams, class times and reviews, each coloured by class'
                className='block h-auto w-full'
                height={800}
                loading='lazy'
                src='/shots/calendar.png'
                width={1280}
              />
            </div>
          </Surface>
        </div>
      </div>
    </section>
  );
}
