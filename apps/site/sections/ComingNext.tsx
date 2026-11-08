import type { LucideIcon } from 'lucide-react';

import { GitFork, History, Users } from 'lucide-react';

import { Badge } from '@/components/ui/primitives';

import { TONE } from '~/sections/tone';

// Sharing and collaboration — shipped (share sheet, page versions, live co-editing on notebook pages).
const SHIPPED: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: GitFork,
    title: 'Share and copy',
    text: 'Share a notebook, flashcard deck, question set or concept map by email or link, so others can view or edit. Anyone who can see it can make their own copy.',
  },
  {
    icon: History,
    title: 'Edit history',
    text: 'See who changed a notebook and when, and bring back an earlier version.',
  },
  {
    icon: Users,
    title: 'Study together, live',
    text: 'Several people on one notebook page at once, with each other’s ink showing up as they write.',
  },
];

export function ComingNext() {
  return (
    <section aria-labelledby='next-title' className='mx-auto max-w-6xl px-4 py-6 md:py-8' data-reveal id='next'>
      <div className='border-st-clay-edge rounded-lg border-2 p-4 md:p-5'>
        <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1'>
          <Badge className={TONE.green.badge}>New</Badge>
          <h2 className='font-display text-st-fg text-lg font-bold md:text-xl' id='next-title'>
            Share and study together
          </h2>
        </div>
        <ul className='mt-4 grid gap-x-6 gap-y-3 md:grid-cols-3'>
          {SHIPPED.map(({ icon: Icon, title, text }) => (
            <li className='flex min-w-0 items-start gap-2.5' data-reveal-item key={title}>
              <Icon aria-hidden className={`${TONE.green.text} mt-0.5 h-5 w-5 shrink-0`} />
              <p className='min-w-0 text-sm leading-snug'>
                <span className='text-st-fg font-semibold'>{title}.</span>{' '}
                <span className='text-st-muted'>{text}</span>
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
