import type { LucideIcon } from 'lucide-react';

import { BellRing, CalendarClock, Hourglass, Layers3, ListPlus, SlidersHorizontal, WifiOff } from 'lucide-react';

import { Badge, Surface } from '@/components/ui/primitives';

import { TONE } from '~/sections/tone';

type Feature = { icon: LucideIcon; title: string; text: string };

const FEATURES: Feature[] = [
  { icon: CalendarClock, title: 'The night before', text: 'A heads-up at 6 PM for anything due tomorrow.' },
  { icon: Hourglass, title: 'Hours before', text: 'One more nudge before it closes.' },
  { icon: Layers3, title: 'Flashcards', text: 'One reminder a day when cards are ready.' },
  { icon: ListPlus, title: 'Your own', text: 'Study chapter 3, Tuesday at 7. Once, daily or weekly.' },
  { icon: SlidersHorizontal, title: 'You choose', text: 'Pick how early, or turn any of it off.' },
  { icon: WifiOff, title: 'No signal needed', text: 'Set on your tablet, so they still come offline.' },
];

// Invented sample reminders (demo classes only).
const NOTES = [
  { when: '5:00 PM', title: '17 flashcards ready', body: 'A few minutes now keeps them fresh.' },
  { when: '6:00 PM', title: 'Due tomorrow', body: 'Lab 4: Bank account class · CS 101' },
  { when: '8:59 PM', title: 'Quiz 4 closes in 3 hours', body: 'CS 101 · due at 11:59 PM' },
  { when: 'Tue 7:00 PM', title: 'Your reminder', body: 'Study chapter 3 for the midterm' },
];

export function Reminders() {
  const tone = TONE.coral;

  return (
    <section
      aria-labelledby='reminders-title'
      className='mx-auto max-w-6xl scroll-mt-4 px-4 py-8 md:py-10'
      data-reveal
      id='reminders'
    >
      <div className='grid items-start gap-8 md:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] md:gap-10'>
        <div className='min-w-0'>
          <Badge className={tone.badge}>Reminders</Badge>
          <h2
            className='font-display text-st-fg mt-3 text-2xl font-bold leading-tight md:text-3xl'
            data-reveal-item
            id='reminders-title'
          >
            Never miss a deadline again.
          </h2>
          <p className='text-st-muted mt-2 text-base leading-relaxed' data-reveal-item>
            Syllabi knows every due date from your classes and taps you on the shoulder before it is too late, plus
            the reminders you set for yourself.
          </p>

          <ul className='mt-5 grid gap-x-6 gap-y-3 sm:grid-cols-2'>
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li className='flex min-w-0 items-start gap-2.5' data-reveal-item key={title}>
                <Icon aria-hidden className={`${tone.text} mt-0.5 h-5 w-5 shrink-0`} strokeWidth={2} />
                <p className='min-w-0 text-sm leading-snug'>
                  <span className='text-st-fg font-semibold'>{title}.</span>{' '}
                  <span className='text-st-muted'>{text}</span>
                </p>
              </li>
            ))}
          </ul>
        </div>

        <div className='min-w-0' data-reveal-item>
          <Surface className='p-3 sm:p-4'>
            <div
              aria-label='Sample reminders on a tablet: due tomorrow, flashcards ready, a quiz closing soon, and your own reminder'
              className='border-st-line bg-st-bg flex flex-col gap-3 rounded-md border p-3 sm:p-4'
              role='img'
            >
              <div className='text-st-muted flex items-center gap-2 text-xs font-semibold'>
                <BellRing aria-hidden className={`${tone.text} h-4 w-4`} />
                Today on your tablet
              </div>
              {NOTES.map((note) => (
                <div
                  className='border-st-line bg-st-surface flex min-w-0 items-start gap-3 rounded-md border p-3'
                  data-reveal-item
                  key={note.title}
                >
                  <img alt='' className='mt-0.5 h-5 w-5 shrink-0' height={20} src='/logo-mark.svg' width={20} />
                  <div className='min-w-0 flex-1'>
                    <div className='flex items-baseline justify-between gap-2'>
                      <span className='text-st-fg text-sm font-semibold'>{note.title}</span>
                      <span className='text-st-muted shrink-0 text-xs'>{note.when}</span>
                    </div>
                    <p className='text-st-muted text-sm leading-snug'>{note.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </Surface>
        </div>
      </div>
    </section>
  );
}
