import type { LucideIcon } from 'lucide-react';

import { ThemedShot } from '~/sections/ThemedShot';
import {
  CalendarRange,
  Download,
  Gift,
  GraduationCap,
  MonitorSmartphone,
  PenLine,
  PlayCircle,
  Repeat2,
  Sparkles,
  UserPlus,
} from 'lucide-react';

import { LinkButton, Surface } from '@/components/ui/primitives';

import { APP, RELEASES, SIGN_UP } from '~/sections/links';
import { TONE, type Tone } from '~/sections/tone';

const FACTS: { icon: LucideIcon; label: string }[] = [
  { icon: MonitorSmartphone, label: 'Web, phone and Android tablet' },
  { icon: GraduationCap, label: 'Classes from Canvas' },
  { icon: Sparkles, label: 'Connect Claude or ChatGPT' },
  { icon: Gift, label: 'Free to use' },
];

const PROPS: { icon: LucideIcon; title: string; text: string; href: string; tone: Tone }[] = [
  { icon: PenLine, title: 'Write by hand', text: 'Notes the AI can read.', href: '#notebooks', tone: 'purple' },
  { icon: Repeat2, title: 'Practice', text: 'Questions, flashcards, a tutor.', href: '#study', tone: 'green' },
  { icon: CalendarRange, title: 'Stay on top', text: 'Every class and due date.', href: '#organize', tone: 'coral' },
  { icon: MonitorSmartphone, title: 'Every device', text: 'Snap on a phone, study on a tablet.', href: '#devices', tone: 'citrine' },
];

export function Hero() {
  return (
    <section aria-labelledby='hero-title' className='mx-auto max-w-6xl px-4 pb-4 pt-8 md:pb-6 md:pt-12'>
      <div className='max-w-3xl'>
        <h1
          className='font-display text-st-fg text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl'
          id='hero-title'
        >
          Your whole semester in one study app.
        </h1>
        <p className='text-st-muted mt-3 max-w-2xl text-base sm:text-lg'>
          Write notes by hand, practise with questions that come back at the right time, ask an AI tutor, and see
          everything that is due. Free on the web and on Android tablets.
        </p>

        <div className='mt-5 flex flex-wrap items-center gap-3'>
          <LinkButton href={SIGN_UP} variant='primary'>
            <UserPlus aria-hidden className='h-4 w-4' />
            Create a free account
          </LinkButton>
          <LinkButton href={APP} variant='secondary'>
            <PlayCircle aria-hidden className='h-4 w-4' />
            Try the demo
          </LinkButton>
          <LinkButton className='border-[#155C3F] bg-[#1F7A55] text-white shadow-[0_4px_0_0_#155C3F] hover:bg-[#1F7A55] hover:brightness-110 active:translate-y-[3px] active:shadow-none dark:border-[#2E9E6E] dark:hover:bg-[#4FD69C] dark:bg-[#4FD69C] dark:text-[#06281A] dark:shadow-[0_4px_0_0_#2E9E6E]' href={RELEASES} variant='ghost'>
            <Download aria-hidden className='h-4 w-4' />
            Android app
          </LinkButton>
        </div>

        <ul className='text-st-muted mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm'>
          {FACTS.map(({ icon: Icon, label }) => (
            <li className='flex items-center gap-1.5' key={label}>
              <Icon aria-hidden className='text-st-accent h-4 w-4 shrink-0' />
              {label}
            </li>
          ))}
        </ul>
      </div>

      <div className='mt-7' data-hero-shot>
        <Surface className='p-2 sm:p-3'>
        <ThemedShot
          alt='The Syllabi Today screen: a plan, announcements, what is due and what to review across four classes'
          className='border-st-line block h-auto w-full rounded-md border'
          decoding='async'
          fetchPriority='high'
          height={800}
          loading='eager'
          src='/shots/today.png'
          width={1280}
        />
        </Surface>
      </div>

      <ul className='mt-6 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4'>
        {PROPS.map(({ icon: Icon, title, text, href, tone }) => (
          <li key={title} className='min-w-0' data-hero-item>
            <a
              className='hover:bg-st-raised focus-visible:outline-st-accent -mx-2 flex min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-100 focus-visible:outline focus-visible:outline-2'
              href={href}
            >
              <span aria-hidden className={`${TONE[tone].tile} inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md`}>
                <Icon className='h-5 w-5' />
              </span>
              <span className='min-w-0 text-sm leading-snug'>
                <span className='text-st-fg block font-semibold'>{title}</span>
                <span className='text-st-muted'>{text}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
