const REPO = 'https://github.com/AbdelrhmanX7/syllabi';

const LINKS = [
  { label: 'GitHub', href: REPO },
  { label: 'Releases', href: `${REPO}/releases` },
  { label: 'License', href: `${REPO}/blob/master/LICENSE` },
  { label: 'Support', href: 'https://buymeacoffee.com/AbdelrhmanX7' },
  { label: 'Sponsor', href: 'https://github.com/sponsors/AbdelrhmanX7' },
  { label: 'syllabi.studio', href: 'https://syllabi.studio' },
];

export function Footer() {
  return (
    <footer className='border-st-line border-t'>
      <div className='text-st-muted mx-auto flex max-w-6xl flex-col gap-3 px-4 py-5 text-sm sm:flex-row sm:items-center sm:justify-between'>
        <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
          <img alt='' className='h-6 w-6 shrink-0' height={24} src='/logo-mark.svg' width={24} />
          <span className='font-display text-st-fg font-bold'>Syllabi</span>
          <span>MIT licensed · open source</span>
        </div>
        <nav aria-label='Footer'>
          <ul className='flex flex-wrap items-center gap-x-5 gap-y-1'>
            {LINKS.map((link) => (
              <li key={link.label}>
                <a
                  className='hover:text-st-fg rounded-sm underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-st-accent'
                  href={link.href}
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
