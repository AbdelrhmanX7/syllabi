import type { LucideIcon } from 'lucide-react';

import { Badge, Surface } from '@/components/ui/primitives';
import { FileDown, Hand, Layers, PenLine, Ruler, ScanText, Sparkles } from 'lucide-react';

type Feature = { icon: LucideIcon; title: string; text: string };

const FEATURES: Feature[] = [
  { icon: PenLine, title: 'Pen board', text: 'S Pen and stylus pressure, smooth ink.' },
  { icon: Hand, title: 'Palm rejection', text: 'Rest your hand on the screen while you write.' },
  { icon: Layers, title: 'Pages per class', text: 'A notebook for each class or lecture.' },
  { icon: Ruler, title: 'Rulers and shapes', text: 'Straight lines, angles and clean figures.' },
  { icon: ScanText, title: 'Reads your handwriting', text: 'The AI sees what you wrote on the page.' },
  { icon: Sparkles, title: 'Explains and draws', text: 'Ask about a step; it answers and draws on the page.' },
  { icon: FileDown, title: 'Export to PDF', text: 'Save your pages as a PDF to share or print.' },
];

export function Notebooks() {
  return (
    <section aria-labelledby='notebooks-title' className='mx-auto max-w-6xl scroll-mt-20 px-4 py-10 md:py-14' id='notebooks'>
      <div className='grid items-start gap-8 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-10'>
        <div className='min-w-0'>
          <Badge tone='accent'>Handwritten notebooks</Badge>
          <h2
            className='font-display text-st-fg mt-3 text-2xl font-bold leading-tight md:text-3xl'
            id='notebooks-title'
          >
            Write by hand. The AI reads along.
          </h2>
          <p className='text-st-muted mt-2 text-base leading-relaxed'>
            A real pen board for your tablet. Work a problem on the page, then ask the tutor about the step you
            are stuck on: it reads your handwriting, explains, and can draw the fix right next to yours.
          </p>

          <ul className='mt-5 grid gap-x-6 gap-y-3 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2'>
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li className='flex min-w-0 items-start gap-2.5' key={title}>
                <Icon aria-hidden className='text-st-accent mt-0.5 h-5 w-5 shrink-0' strokeWidth={2} />
                <p className='min-w-0 text-sm leading-snug'>
                  <span className='text-st-fg font-semibold'>{title}.</span>{' '}
                  <span className='text-st-muted'>{text}</span>
                </p>
              </li>
            ))}
          </ul>
        </div>

        <div className='flex min-w-0 flex-col gap-4'>
          <Surface className='p-2'>
            <img
              alt='A Syllabi notebook page: a worksheet photo from the phone, marked up with the pen'
              className='rounded-st h-auto w-full'
              height={800}
              loading='lazy'
              src='/shots/notebook.png'
              width={1280}
            />
          </Surface>

          <div className='flex min-w-0 items-center gap-4'>
            <Surface className='w-2/5 shrink-0 p-1.5'>
              <img
                alt='The Syllabi phone inbox listing pages snapped on a phone, ready to add to a notebook'
                className='rounded-st h-auto w-full'
                height={800}
                loading='lazy'
                src='/shots/inbox.png'
                width={1280}
              />
            </Surface>
            <p className='text-st-muted min-w-0 text-sm leading-snug'>
              <span className='text-st-fg font-semibold'>Phone inbox.</span> Photograph a worksheet or the
              whiteboard on your phone. It shows up in the tablet&apos;s inbox, ready to drop onto a page.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
