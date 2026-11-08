import { Download } from 'lucide-react';

import { LinkButton } from '@/components/ui/primitives';

import { APP, DOWNLOAD, RELEASES, REPO, SIGN_IN, SIGN_UP } from '~/sections/links';

const COLUMNS = [
  {
    title: 'App',
    links: [
      { label: 'Open in browser', href: APP },
      { label: 'Android tablets', href: DOWNLOAD },
      { label: 'Create account', href: SIGN_UP },
      { label: 'Sign in', href: SIGN_IN },
    ],
  },
  {
    title: 'Project',
    links: [
      { label: 'Source code', href: REPO },
      { label: 'All versions', href: RELEASES },
      { label: 'Run your own', href: '/#self-host' },
      { label: 'License', href: `${REPO}/blob/master/LICENSE` },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy', href: '/privacy/' },
      { label: 'Terms', href: '/terms/' },
      { label: 'Report a problem', href: `${REPO}/issues` },
    ],
  },
] as const;

const linkClass =
  'text-st-muted hover:text-st-fg focus-visible:outline-st-accent rounded-sm underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className='border-st-line bg-st-surface mt-6 border-t'>
      <div className='mx-auto grid max-w-6xl gap-8 px-4 py-8 md:grid-cols-[1.4fr_1fr_1fr_1fr] md:py-10'>
        <div className='flex min-w-0 flex-col items-start gap-3'>
          <a
            aria-label='Syllabi home'
            className='focus-visible:outline-st-accent flex items-center gap-2 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
            href='/'
          >
            <img alt='' height={28} src='/logo-mark.svg' width={28} />
            <span className='font-display text-st-fg text-lg font-bold'>Syllabi</span>
          </a>
          <p className='text-st-muted max-w-xs text-sm'>
            Notes by hand, every deadline in one place, and flashcards made from your own notes. Free for every student.
          </p>
          <LinkButton className='px-4' href={DOWNLOAD} variant='primary'>
            <Download aria-hidden className='h-4 w-4' />
            Get the app
          </LinkButton>
        </div>

        <nav aria-label='Footer' className='grid grid-cols-3 gap-4 md:contents'>
          {COLUMNS.map((column) => (
            <div key={column.title} className='min-w-0'>
              <h2 className='text-st-fg mb-2 text-sm font-semibold'>{column.title}</h2>
              <ul className='flex flex-col gap-2 text-sm'>
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a className={linkClass} href={link.href}>
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <div className='border-st-line border-t'>
        <div className='text-st-muted mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-4 text-xs'>
          <span>© {year} Syllabi · Free and open source</span>
          <span>Made by a student, for students</span>
        </div>
      </div>
    </footer>
  );
}
