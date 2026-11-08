import { Download, Github } from 'lucide-react';

import { LinkButton } from '@/components/ui/primitives';

const RELEASES = 'https://github.com/AbdelrhmanX7/syllabi/releases';
const REPO = 'https://github.com/AbdelrhmanX7/syllabi';

const LINKS = [
  { href: '/#notebooks', label: 'Notebooks' },
  { href: '/#study', label: 'Study' },
  { href: '/#organize', label: 'Organize' },
  { href: '/#self-host', label: 'Self-host' },
] as const;

export function Nav() {
  return (
    <header className='border-b border-st-line bg-st-bg'>
      <nav
        aria-label='Main'
        className='mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4'
      >
        <a
          aria-label='Syllabi home'
          className='flex shrink-0 items-center gap-2 rounded-st focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-st-accent'
          href='/'
        >
          <img alt='' height={28} src='/logo-mark.svg' width={28} />
          <span className='font-display text-lg font-bold text-st-fg'>Syllabi</span>
        </a>

        <ul className='hidden items-center gap-1 md:flex'>
          {LINKS.map((link) => (
            <li key={link.href}>
              <a
                className='rounded-st px-3 py-2 text-sm font-medium text-st-muted transition-colors duration-100 hover:text-st-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-st-accent'
                href={link.href}
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className='flex shrink-0 items-center gap-3'>
          <LinkButton className='px-3 sm:px-4' href={REPO} variant='secondary'>
            <Github aria-hidden className='h-4 w-4' />
            <span className='sr-only sm:not-sr-only'>GitHub</span>
          </LinkButton>
          <LinkButton className='px-3 sm:px-4' href={RELEASES} variant='primary'>
            <Download aria-hidden className='h-4 w-4' />
            Download
          </LinkButton>
        </div>
      </nav>
    </header>
  );
}
