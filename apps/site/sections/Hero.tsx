import type { LucideIcon } from 'lucide-react';

import { Download, Scale, Server, Tablet, Terminal, PlayCircle } from 'lucide-react';

import { LinkButton, Surface } from '@/components/ui/primitives';

const RELEASES = 'https://github.com/AbdelrhmanX7/syllabi/releases';

const FACTS: { icon: LucideIcon; label: string }[] = [
  { icon: Scale, label: 'MIT licensed' },
  { icon: Tablet, label: 'Android tablets + web' },
  { icon: Server, label: 'Self-hostable' },
  { icon: PlayCircle, label: 'Demo mode, no server needed' },
];

export function Hero() {
  return (
    <section aria-labelledby='hero-title' className='mx-auto max-w-6xl px-4 pb-10 pt-8 md:pb-14 md:pt-12'>
      <div className='max-w-3xl'>
        <h1
          className='font-display text-4xl font-bold leading-[1.1] tracking-tight text-st-fg sm:text-5xl'
          id='hero-title'
        >
          Your whole semester on one tablet.
        </h1>
        <p className='mt-3 max-w-2xl text-base text-st-muted sm:text-lg'>
          Syllabi is an open-source study app with handwritten notebooks, an AI tutor,
          spaced-repetition questions and a calendar of everything due.
        </p>

        <div className='mt-5 flex flex-wrap items-center gap-3'>
          <LinkButton href={RELEASES} variant='primary'>
            <Download aria-hidden className='h-4 w-4' />
            Download for Android
          </LinkButton>
          <LinkButton href='#self-host' variant='secondary'>
            <Terminal aria-hidden className='h-4 w-4' />
            Run it yourself
          </LinkButton>
        </div>

        <ul className='mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-st-muted'>
          {FACTS.map(({ icon: Icon, label }) => (
            <li className='flex items-center gap-1.5' key={label}>
              <Icon aria-hidden className='h-4 w-4 shrink-0 text-st-accent' />
              {label}
            </li>
          ))}
        </ul>
      </div>

      <Surface className='mt-8 p-2 sm:p-3'>
        <img
          alt='The Syllabi Today screen: what is due and what to review across your classes'
          className='block h-auto w-full rounded-st border border-st-line'
          decoding='async'
          fetchPriority='high'
          height={800}
          loading='eager'
          src='/shots/today.png'
          width={1280}
        />
      </Surface>
    </section>
  );
}
