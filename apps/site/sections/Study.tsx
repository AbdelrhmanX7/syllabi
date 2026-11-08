import type { LucideIcon } from 'lucide-react';

import { ThemedShot } from '~/sections/ThemedShot';
import { Layers3, MessageSquareText, Network, Repeat2, Video } from 'lucide-react';

import { Badge, Surface } from '@/components/ui/primitives';

import { TONE, type Tone } from '~/sections/tone';

type Feature = { icon: LucideIcon; title: string; body: string; tone: Tone };

const FEATURES: Feature[] = [
  {
    icon: Repeat2,
    title: 'Question bank',
    body: 'Questions made from your own material that come back right before you would forget them, plus practice exams.',
    tone: 'green',
  },
  {
    icon: Layers3,
    title: 'Flashcards',
    body: 'Decks for each class, reviewed on the same schedule so the hard cards come back sooner.',
    tone: 'citrine',
  },
  {
    icon: MessageSquareText,
    title: 'AI tutor',
    body: 'Ask about any reading, lecture or page of your notes. It shows you where a wrong answer went off track.',
    tone: 'blue',
  },
  {
    icon: Network,
    title: 'Concept maps',
    body: 'Map how ideas connect. Draw one or snap a photo, and the AI checks it or makes one to compare.',
    tone: 'purple',
  },
  {
    icon: Video,
    title: 'Lectures',
    body: 'Add a recording or a YouTube link and get the full text and notes to study from.',
    tone: 'coral',
  },
];

const SHOTS = [
  {
    src: '/shots/bank.png',
    alt: 'Question bank in Syllabi: questions to review today, filtered by class and topic',
    caption: 'Question bank: what to review today, practice exams, weak topics',
  },
  {
    src: '/shots/concept-maps.png',
    alt: 'Concept maps in Syllabi: a topic map with linked ideas for a class',
    caption: 'Concept maps: build one or have yours checked',
  },
];

export function Study() {
  return (
    <section
      aria-labelledby='study-title'
      className='mx-auto max-w-6xl scroll-mt-4 px-4 py-8 md:py-10'
      data-reveal
      id='study'
    >
      <div className='mb-5 max-w-3xl'>
        <Badge className={TONE.green.badge}>Study</Badge>
        <h2 className='font-display text-st-fg mt-3 text-2xl font-bold leading-tight md:text-3xl' id='study-title'>
          Practice what you learned
        </h2>
        <p className='text-st-muted mt-2 text-base'>
          Review on a schedule, ask when you are stuck, and see how ideas connect.
        </p>
      </div>

      <ul className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5'>
        {FEATURES.map(({ icon: Icon, title, body, tone }, index) => (
          <li
            key={title}
            className={index === FEATURES.length - 1 ? 'flex sm:col-span-2 lg:col-span-1' : 'flex'}
            data-reveal-item
          >
            <Surface as='article' className='flex w-full flex-col gap-2 p-4'>
              <div className='flex items-center gap-2.5'>
                <span
                  aria-hidden
                  className={`${TONE[tone].tile} inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md`}
                >
                  <Icon className='h-5 w-5' strokeWidth={2} />
                </span>
                <h3 className='font-display text-st-fg text-base font-bold leading-tight'>{title}</h3>
              </div>
              <p className='text-st-muted text-sm leading-snug'>{body}</p>
            </Surface>
          </li>
        ))}
      </ul>

      <div className='mt-6 grid grid-cols-1 gap-4 md:grid-cols-2'>
        {SHOTS.map((shot) => (
          <div key={shot.src} className='min-w-0' data-reveal-item>
            <Surface as='article' className='flex flex-col gap-2 p-2.5'>
              <ThemedShot
                alt={shot.alt}
                className='border-st-line block h-auto w-full rounded-md border'
                height={800}
                loading='lazy'
                src={shot.src}
                width={1280}
              />
              <p className='text-st-muted px-1 pb-0.5 text-sm'>{shot.caption}</p>
            </Surface>
          </div>
        ))}
      </div>
    </section>
  );
}
