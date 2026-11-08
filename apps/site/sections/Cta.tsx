import { PlayCircle, UserPlus } from 'lucide-react';

import { LinkButton, Surface } from '@/components/ui/primitives';

import { APP, SIGN_UP } from '~/sections/links';

export function Cta() {
  return (
    <section aria-labelledby='cta-title' className='mx-auto max-w-6xl px-4 pb-8 pt-2 md:pb-10' data-reveal>
      <div data-reveal-item>
        <Surface className='flex min-w-0 flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between md:p-5'>
          <div className='min-w-0'>
            <h2 className='font-display text-st-fg text-xl font-bold md:text-2xl' id='cta-title'>
              Start this semester in Syllabi.
            </h2>
            <p className='text-st-muted mt-1 text-sm'>Free account, or look around the demo first. No install needed.</p>
          </div>
          <div className='flex shrink-0 flex-wrap gap-3'>
            <LinkButton href={SIGN_UP} variant='primary'>
              <UserPlus aria-hidden className='h-4 w-4' />
              Create a free account
            </LinkButton>
            <LinkButton href={APP} variant='secondary'>
              <PlayCircle aria-hidden className='h-4 w-4' />
              Try the demo
            </LinkButton>
          </div>
        </Surface>
      </div>
    </section>
  );
}
