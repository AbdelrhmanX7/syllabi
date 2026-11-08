import type { LucideIcon } from 'lucide-react';

import { Badge, Surface } from '@/components/ui/primitives';
import { MessageSquareText, Network, Repeat2, Video } from 'lucide-react';

type Feature = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const FEATURES: Feature[] = [
  {
    icon: Repeat2,
    title: 'Question bank',
    body: 'Questions made from your own material, a spaced-repetition review queue, mock exams and weak-topic tracking.',
  },
  {
    icon: MessageSquareText,
    title: 'AI tutor',
    body: 'Chat about any item, lecture or notebook page. It explains what went wrong in a mistake.',
  },
  {
    icon: Network,
    title: 'Concept maps',
    body: 'For any class or topic. Draw one or start from a photo; the AI builds a reference map or checks yours.',
  },
  {
    icon: Video,
    title: 'Lectures',
    body: 'Recordings or YouTube links become transcripts and lecture notes you can study from.',
  },
];

const SHOTS = [
  {
    src: '/shots/bank.png',
    alt: 'Question bank in Syllabi: a review queue of spaced-repetition questions with weak topics listed',
    caption: 'Question bank: review queue, mock exams, weak topics',
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
      className='mx-auto max-w-6xl scroll-mt-20 px-4 py-10 md:py-14'
      id='study'
    >
      <div className='mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1'>
        <h2
          className='font-display text-st-fg text-2xl font-bold md:text-3xl'
          id='study-title'
        >
          Practice what you learned
        </h2>
        <p className='text-st-muted text-base'>
          Review on a schedule, ask when you are stuck, and see how ideas connect.
        </p>
      </div>

      <ul className='grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4'>
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <li key={title} className='flex'>
            <Surface as='article' className='flex w-full flex-col gap-2 p-4'>
              <div className='flex items-center gap-2.5'>
                <span
                  aria-hidden
                  className='rounded-st bg-st-accent-soft text-st-accent inline-flex h-9 w-9 shrink-0 items-center justify-center'
                >
                  <Icon className='h-5 w-5' strokeWidth={2} />
                </span>
                <h3 className='font-display text-st-fg text-base font-bold leading-tight'>
                  {title}
                </h3>
              </div>
              <p className='text-st-muted text-sm leading-snug'>{body}</p>
            </Surface>
          </li>
        ))}
      </ul>

      <div className='mt-6 grid grid-cols-1 gap-4 md:grid-cols-2'>
        {SHOTS.map((shot) => (
          <Surface key={shot.src} as='article' className='flex flex-col gap-2 p-2.5'>
            <div className='rounded-st border-st-line bg-st-raised overflow-hidden border'>
              <img
                alt={shot.alt}
                className='block h-auto w-full'
                height={800}
                loading='lazy'
                src={shot.src}
                width={1280}
              />
            </div>
            <div className='flex flex-wrap items-center gap-2 px-1 pb-0.5'>
              <Badge tone='accent'>Demo data</Badge>
              <p className='text-st-muted min-w-0 text-sm'>{shot.caption}</p>
            </div>
          </Surface>
        ))}
      </div>
    </section>
  );
}
