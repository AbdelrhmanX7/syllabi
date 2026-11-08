import type { LucideIcon } from 'lucide-react';

import { GitFork, History, Users } from 'lucide-react';

import { Badge } from '@/components/ui/primitives';

import { TONE } from '~/sections/tone';

// Planned, not built (docs/accounts.md «Sharing and collaboration»). Shown as a roadmap, never as a feature.
const PLANNED: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: GitFork,
    title: 'Share and copy',
    text: 'Share a notebook, deck, question set or concept map by email or link, so others can view, comment or edit. Anyone who can see it can make their own copy.',
  },
  {
    icon: History,
    title: 'Edit history',
    text: 'See who changed what, restore an earlier version, and comment on pages and cards.',
  },
  {
    icon: Users,
    title: 'Study together, live',
    text: 'Several people on one page or deck at once, with each other’s ink appearing live.',
  },
];

export function ComingNext() {
  return (
    <section aria-labelledby='next-title' className='mx-auto max-w-6xl px-4 py-6 md:py-8' data-reveal id='next'>
      <div className='border-st-clay-edge rounded-lg border-2 border-dashed p-4 md:p-5'>
        <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1'>
          <Badge className={TONE.purple.badge}>Coming next</Badge>
          <h2 className='font-display text-st-fg text-lg font-bold md:text-xl' id='next-title'>
            Sharing and studying together
          </h2>
          <span className='text-st-muted text-sm'>Planned, not in the app yet.</span>
        </div>
        <ul className='mt-4 grid gap-x-6 gap-y-3 md:grid-cols-3'>
          {PLANNED.map(({ icon: Icon, title, text }) => (
            <li className='flex min-w-0 items-start gap-2.5' data-reveal-item key={title}>
              <Icon aria-hidden className={`${TONE.purple.text} mt-0.5 h-5 w-5 shrink-0`} />
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
