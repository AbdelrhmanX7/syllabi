import type { ReactNode } from 'react';

import { useState } from 'react';

import { Check, Copy, Download, Github, PlayCircle, Scale, Server, Smartphone } from 'lucide-react';

import { ActionButton, Badge, LinkButton, Surface } from '@/components/ui/primitives';

import { RELEASES, REPO } from '~/sections/links';
import { TONE } from '~/sections/tone';

const FACTS: { icon: typeof Scale; title: string; body: ReactNode }[] = [
  {
    icon: Scale,
    title: 'Free and open',
    body: 'Anyone can read the code, change it and run it.',
  },
  {
    icon: Server,
    title: 'Your notes stay with you',
    body: 'Run it on your own computer so your notes stay there. You pick the AI it uses.',
  },
  {
    icon: PlayCircle,
    title: 'Try it first',
    body: 'It starts with sample classes, so you can look around before adding your own.',
  },
  {
    icon: Smartphone,
    title: 'Made for tablets',
    body: 'Tested on a Galaxy Tab S9 Ultra, and kept light so cheaper and older tablets stay quick too.',
  },
];

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <ActionButton
      aria-label={copied ? 'Copied' : `Copy: ${label}`}
      className='h-9 min-h-9 w-9 shrink-0 px-0'
      title={copied ? 'Copied' : 'Copy'}
      variant='secondary'
      onClick={copy}
    >
      {copied ? (
        <Check aria-hidden className='text-tone-green-fg h-4 w-4' />
      ) : (
        <Copy aria-hidden className='h-4 w-4' />
      )}
    </ActionButton>
  );
}

/** One short command per line, so nothing ever scrolls sideways; wrapping is only a safety net. */
function CodeBlock({ label, lines, caption }: { label: string; lines: string[]; caption?: string }) {
  return (
    <div className='min-w-0'>
      <div className='mb-3 flex min-w-0 items-center justify-between gap-3'>
        <p className='text-st-fg min-w-0 text-sm font-semibold'>{label}</p>
        <CopyButton label={label} text={lines.join('\n')} />
      </div>
      <pre
        aria-label={label}
        className='border-st-line bg-st-raised text-st-fg whitespace-pre-wrap rounded-md border px-3 py-2.5 font-mono text-[13px] leading-6 [overflow-wrap:break-word]'
      >
        <code>
          {lines.map((line) => (
            <span key={line} className='block'>
              <span aria-hidden className='text-st-muted select-none'>
                ${' '}
              </span>
              {/* Break long URLs only after a slash, never mid-word. */}
              {line.split('/').map((part, index) => (
                <span key={index}>
                  {index > 0 && (
                    <>
                      /<wbr />
                    </>
                  )}
                  {part}
                </span>
              ))}
            </span>
          ))}
        </code>
      </pre>
      {caption && <p className='text-st-muted mt-1.5 text-xs'>{caption}</p>}
    </div>
  );
}

export function SelfHost() {
  return (
    <section aria-labelledby='self-host-title' className='mx-auto max-w-6xl scroll-mt-4 px-4 py-8 md:py-10' data-reveal id='self-host'>
      <div className='grid items-start gap-8 md:grid-cols-2 md:gap-10'>
        <div className='min-w-0'>
          <Badge className={TONE.green.badge}>Run it yourself</Badge>
          <h2
            className='font-display text-st-fg mt-3 text-2xl font-bold leading-tight md:text-3xl'
            id='self-host-title'
          >
            Run it on your own computer.
          </h2>
          <p className='text-st-muted mt-2 max-w-prose text-base'>
            Prefer to keep everything at home? Syllabi is free and open source, so you can run your own copy.
          </p>
          <ul className='mt-5 flex flex-col gap-3.5'>
            {FACTS.map(({ icon: Icon, title, body }) => (
              <li key={title} className='flex gap-3' data-reveal-item>
                <Icon aria-hidden className='text-tone-green-fg mt-0.5 h-5 w-5 shrink-0' strokeWidth={2} />
                <p className='text-st-muted min-w-0 text-sm leading-6'>
                  <span className='text-st-fg font-semibold'>{title}.</span> {body}
                </p>
              </li>
            ))}
          </ul>
        </div>

        <div className='flex min-w-0 flex-col gap-5'>
          <div data-reveal-item>
          <Surface className='flex min-w-0 flex-col gap-4 p-4 md:p-5'>
            <CodeBlock
              label='Try the app'
              caption='Then open localhost:3016 in your browser. It starts with sample classes.'
              lines={[`git clone ${REPO}`, 'cd syllabi', 'pnpm install', 'pnpm dev']}
            />
            <CodeBlock
              label='Keep your own data'
              lines={['cd apps/server', 'cp .env.example .env', 'docker compose up -d']}
            />
          </Surface>
          </div>
          <div className='flex flex-wrap gap-3' data-reveal-item>
            <LinkButton href={REPO} variant='secondary'>
              <Github aria-hidden className='h-4 w-4' />
              Source on GitHub
            </LinkButton>
            <LinkButton href={RELEASES} variant='secondary'>
              <Download aria-hidden className='h-4 w-4' />
              Android releases
            </LinkButton>
          </div>
        </div>
      </div>
    </section>
  );
}
