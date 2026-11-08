import type { ReactNode } from 'react';

import { Coffee, Download, Github, Server, Smartphone, Scale, PlayCircle } from 'lucide-react';

import { Badge, LinkButton, Surface } from '@/components/ui/primitives';

import { IosFund } from '~/sections/IosFund';

const REPO = 'https://github.com/AbdelrhmanX7/syllabi';

const FACTS: { icon: typeof Scale; title: string; body: ReactNode }[] = [
  {
    icon: Scale,
    title: 'MIT licensed',
    body: 'Read it, fork it, change it. The whole app is open source.',
  },
  {
    icon: Server,
    title: 'Your data on your server',
    body: (
      <>
        <code className='font-mono text-[0.9em]'>apps/server</code> is a Docker Compose stack — API, MongoDB,
        Redis and MinIO. Bring any OpenAI-compatible model.
      </>
    ),
  },
  {
    icon: PlayCircle,
    title: 'Demo mode, no server needed',
    body: 'Without a server the app runs on built-in sample data, so you can try everything first.',
  },
  {
    icon: Smartphone,
    title: 'Built for real student tablets',
    body: 'Tested on the Galaxy Tab A7 — works on older Android WebViews and stays fast on 3–4 GB of RAM.',
  },
];

type Line = { cmd: string; note?: string };

function CodeBlock({ label, lines }: { label: string; lines: Line[] }) {
  return (
    <div className='min-w-0'>
      <p className='text-st-muted mb-1.5 text-xs font-semibold'>{label}</p>
      <pre
        aria-label={label}
        className='rounded-st border-st-line bg-st-raised text-st-fg overflow-x-auto border px-3 py-2.5 font-mono text-[13px] leading-6'
        tabIndex={0}
      >
        <code>
          {lines.map((line, index) => (
            <span key={index} className='block whitespace-pre'>
              <span aria-hidden className='text-st-muted select-none'>
                ${' '}
              </span>
              {line.cmd}
              {line.note && <span className='text-st-muted'>{`   # ${line.note}`}</span>}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export function SelfHost() {
  return (
    <section aria-labelledby='self-host-title' className='mx-auto max-w-6xl px-4 py-10 md:py-14' id='self-host'>
      <div className='grid items-start gap-8 md:grid-cols-2 md:gap-10'>
        <div className='min-w-0'>
          <Badge tone='accent'>Open source · MIT</Badge>
          <h2
            className='font-display text-st-fg mt-3 text-2xl font-bold leading-tight md:text-3xl'
            id='self-host-title'
          >
            Open source. Run it yourself.
          </h2>
          <p className='text-st-muted mt-2 max-w-prose text-base'>
            Use the app as it is, or host your own server so your notes, classes and questions stay with you.
          </p>
          <ul className='mt-5 flex flex-col gap-3.5'>
            {FACTS.map(({ icon: Icon, title, body }) => (
              <li key={title} className='flex gap-3'>
                <Icon aria-hidden className='text-st-accent mt-0.5 h-5 w-5 shrink-0' strokeWidth={2} />
                <p className='text-st-muted min-w-0 text-sm leading-6'>
                  <span className='text-st-fg font-semibold'>{title}.</span> {body}
                </p>
              </li>
            ))}
          </ul>
        </div>

        <div className='flex min-w-0 flex-col gap-5'>
          <Surface className='flex min-w-0 flex-col gap-4 p-4 md:p-5'>
            <CodeBlock
              label='Run the app (demo mode)'
              lines={[
                { cmd: `git clone ${REPO} && cd syllabi` },
                { cmd: 'pnpm install' },
                { cmd: 'pnpm dev', note: 'http://localhost:3016 — demo mode' },
              ]}
            />
            <CodeBlock
              label='Start your own server'
              lines={[{ cmd: 'cd apps/server && cp .env.example .env && docker compose up -d' }]}
            />
          </Surface>
          <div className='flex flex-wrap gap-3'>
            <LinkButton href={`${REPO}/releases`} variant='primary'>
              <Download aria-hidden className='h-4 w-4' />
              Download for Android
            </LinkButton>
            <LinkButton href={REPO} variant='secondary'>
              <Github aria-hidden className='h-4 w-4' />
              GitHub
            </LinkButton>
            <LinkButton href='https://buymeacoffee.com/AbdelrhmanX7' variant='accent'>
              <Coffee aria-hidden className='h-4 w-4' />
              Buy me a coffee
            </LinkButton>
          </div>
          <IosFund />
        </div>
      </div>
    </section>
  );
}
