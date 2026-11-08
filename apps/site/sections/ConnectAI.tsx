import type { LucideIcon } from 'lucide-react';

import { BookOpenCheck, CalendarCheck, NotebookPen, Search } from 'lucide-react';

import { Badge, Surface } from '@/components/ui/primitives';

import { TONE, type Tone } from '~/sections/tone';

// Only what the MCP server really exposes (apps/server/src/services/study/mcp-tools.ts).
const GROUPS: { icon: LucideIcon; title: string; text: string; tone: Tone }[] = [
  {
    icon: Search,
    title: 'Reads your semester',
    text: 'Your classes, what is due, grades, files, and what was said in lectures.',
    tone: 'blue',
  },
  {
    icon: BookOpenCheck,
    title: 'Builds practice',
    text: 'Writes questions and flashcards, quizzes you, explains a mistake, finds your weak spots.',
    tone: 'green',
  },
  {
    icon: NotebookPen,
    title: 'Works on your pages',
    text: 'Reads your handwritten pages, adds new ones, writes and draws on them.',
    tone: 'purple',
  },
  {
    icon: CalendarCheck,
    title: 'Plans ahead',
    text: 'Makes a study plan and lecture handouts, and sends files to your inbox.',
    tone: 'citrine',
  },
];

/** A notebook page: the student's parabola in ink, the AI's marks drawn on top in blue. */
function DrawnPage() {
  return (
    <Surface className='flex min-w-0 flex-col gap-3 p-3 sm:p-4'>
      <div className='border-st-line bg-st-bg rounded-md border'>
        <svg
          aria-label='A notebook page: a hand-drawn parabola; the AI circles the vertex and marks both roots'
          className='block h-auto w-full'
          role='img'
          viewBox='0 0 400 238'
        >
          <g className='text-st-line' stroke='currentColor' strokeWidth='1'>
            {[40, 80, 120, 160, 200].map((y) => (
              <line key={y} x1='0' x2='400' y1={y} y2={y} />
            ))}
          </g>
          <g className='text-st-fg' fill='none' stroke='currentColor' strokeLinecap='round' strokeWidth='3'>
            <path d='M60 196 L340 196' />
            <path d='M200 30 L200 214' />
            <path d='M96 196 C 130 40, 270 40, 304 196' />
          </g>
          <g className='text-st-accent' fill='none' stroke='currentColor' strokeLinecap='round' strokeWidth='3'>
            <path d='M200 64 m -18 0 a 18 18 0 1 0 36 0 a 18 18 0 1 0 -36 0' data-draw pathLength={1} />
            <path d='M290 40 C 260 44, 236 52, 222 60' data-draw pathLength={1} />
            <path d='M222 60 l 12 -2 M222 60 l 6 10' data-draw pathLength={1} />
            <path d='M96 186 l 0 20 M304 186 l 0 20' data-draw pathLength={1} />
          </g>
          <g className='text-st-accent' data-draw-label fill='currentColor' fontFamily='Inter, sans-serif' fontSize='15' fontWeight='600'>
            <text x='296' y='44'>vertex</text>
            <text x='70' y='226'>x = −2</text>
            <text x='282' y='226'>x = 2</text>
          </g>
        </svg>
      </div>
      <p className='text-st-fg text-sm leading-snug' data-draw-label>
        <span className='text-st-accent font-semibold'>Your AI:</span> The vertex is right. I marked both roots on your
        page, at x = −2 and x = 2.
      </p>
    </Surface>
  );
}

export function ConnectAI() {
  return (
    <section
      aria-labelledby='ai-title'
      className='mx-auto max-w-6xl scroll-mt-4 px-4 py-8 md:py-10'
      data-reveal
      id='ai'
    >
      <div className='grid items-start gap-8 md:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] md:gap-10'>
        <div className='min-w-0'>
          <Badge className={TONE.blue.badge}>Connect your AI</Badge>
          <h2 className='font-display text-st-fg mt-3 text-2xl font-bold leading-tight md:text-3xl' id='ai-title'>
            Bring the AI you already use.
          </h2>
          <p className='text-st-muted mt-2 text-base leading-relaxed'>
            Connect Claude or ChatGPT to Syllabi and it can see your real classes, notes and questions, so you don’t
            have to paste your work into a chat.
          </p>

          <ul className='mt-5 grid gap-x-6 gap-y-3 sm:grid-cols-2'>
            {GROUPS.map(({ icon: Icon, title, text, tone }) => (
              <li className='flex min-w-0 items-start gap-2.5' data-reveal-item key={title}>
                <span
                  aria-hidden
                  className={`${TONE[tone].tile} inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md`}
                >
                  <Icon className='h-5 w-5' />
                </span>
                <p className='min-w-0 text-sm leading-snug'>
                  <span className='text-st-fg block font-semibold'>{title}</span>
                  <span className='text-st-muted'>{text}</span>
                </p>
              </li>
            ))}
          </ul>

          <p className='text-st-muted border-st-line mt-5 border-t pt-3 text-sm leading-snug' data-reveal-item>
            <span className='text-st-fg font-semibold'>How to connect.</span> In Claude, add Syllabi as a connector
            and sign in. Settings in Syllabi walks you through it.
          </p>
        </div>

        <div className='min-w-0' data-ai-page data-reveal-item>
          <DrawnPage />
        </div>
      </div>
    </section>
  );
}
