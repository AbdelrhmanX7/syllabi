import type { LucideIcon } from 'lucide-react';

import { FileDown, Hand, Layers, PenLine, Ruler, ScanText, Sparkles } from 'lucide-react';

import { Badge, Surface } from '@/components/ui/primitives';

import { TONE } from '~/sections/tone';

type Feature = { icon: LucideIcon; title: string; text: string };

const FEATURES: Feature[] = [
  { icon: PenLine, title: 'Feels like a pen', text: 'Write with your tablet pen, smooth as paper.' },
  { icon: Hand, title: 'Rest your hand', text: 'Lean on the screen while you write; only the pen draws.' },
  { icon: Layers, title: 'Pages per class', text: 'A notebook for each class or lecture.' },
  { icon: Ruler, title: 'Rulers and shapes', text: 'Straight lines, angles and clean figures.' },
  { icon: ScanText, title: 'Reads your handwriting', text: 'The AI sees what you wrote on the page.' },
  { icon: Sparkles, title: 'Explains and draws', text: 'Ask about a step; it answers and draws on the page.' },
  { icon: FileDown, title: 'Save as a file', text: 'Share your pages or print them.' },
];

export function Notebooks() {
  const tone = TONE.purple;

  return (
    <section
      aria-labelledby='notebooks-title'
      className='mx-auto max-w-6xl scroll-mt-4 px-4 py-8 md:py-10'
      data-reveal
      id='notebooks'
    >
      <div className='grid items-start gap-8 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-10'>
        <div className='min-w-0'>
          <Badge className={tone.badge}>Handwritten notebooks</Badge>
          <h2
            className='font-display text-st-fg mt-3 text-2xl font-bold leading-tight md:text-3xl'
            data-reveal-item
            id='notebooks-title'
          >
            Write by hand. The AI reads along.
          </h2>
          <p className='text-st-muted mt-2 text-base leading-relaxed' data-reveal-item>
            Write on your tablet like it is paper. Work a problem on the page, then ask the tutor about the step you are
            stuck on: it reads your handwriting, explains, and can draw the fix right next to yours.
          </p>

          <ul className='mt-5 grid gap-x-6 gap-y-3 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2'>
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
          <Surface className='p-2 sm:p-3'>
          <img
            alt='A Syllabi notebook page: a sketch drawn with the pen, with the toolbar of pens, shapes and rulers'
            className='border-st-line block h-auto w-full rounded-md border'
            height={800}
            loading='lazy'
            src='/shots/notebook.png'
            width={1280}
          />
          </Surface>
        </div>
      </div>
    </section>
  );
}
