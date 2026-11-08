import { ArrowRight } from 'lucide-react';

import { ThemeToggle } from '~/sections/ThemeToggle';
import { LinkButton } from '@/components/ui/primitives';

import { SIGN_IN, SIGN_UP } from '~/sections/links';

const LINKS = [
  { href: '/#notebooks', label: 'Notebooks' },
  { href: '/#study', label: 'Study' },
  { href: '/#organize', label: 'Organize' },
  { href: '/#ai', label: 'Your AI' },
  { href: '/#devices', label: 'Devices' },
  { href: '/#self-host', label: 'Self-host' },
] as const;

export function Nav() {
  return (
    <header className='border-st-line bg-st-bg border-b'>
      <nav aria-label='Main' className='mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4'>
        <a
          aria-label='Syllabi home'
          className='focus-visible:outline-st-accent flex shrink-0 items-center gap-2 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
          href='/'
        >
          <img alt='' height={28} src='/logo-mark.svg' width={28} />
          <span className='font-display text-st-fg text-lg font-bold'>Syllabi</span>
        </a>

        <ul className='hidden items-center gap-1 lg:flex'>
          {LINKS.map((link) => (
            <li key={link.href}>
              <a
                className='text-st-muted hover:text-st-fg focus-visible:outline-st-accent rounded-md px-2.5 py-2 text-sm font-medium transition-colors duration-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
                href={link.href}
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className='flex shrink-0 items-center gap-2 sm:gap-3'>
          <ThemeToggle />
          <LinkButton className='hidden px-3 sm:inline-flex' href={SIGN_IN} variant='ghost'>
            Sign in
          </LinkButton>
          <LinkButton className='px-3 sm:px-4' href={SIGN_UP} variant='primary'>
            Open Syllabi
            <ArrowRight aria-hidden className='h-4 w-4' />
          </LinkButton>
        </div>
      </nav>
    </header>
  );
}
