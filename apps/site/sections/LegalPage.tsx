import type { ReactNode } from 'react';

import { Footer } from '~/sections/Footer';
import { Nav } from '~/sections/Nav';
import { Seo } from '~/sections/Seo';

export function LegalPage({
  title,
  path,
  updated,
  children,
}: {
  title: string;
  /** e.g. `/privacy/` */
  path: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <>
      <Seo description={`Syllabi ${title.toLowerCase()}, in plain words.`} path={path} title={`${title} · Syllabi`} />
      <Nav />
      <main className='mx-auto max-w-3xl px-4 py-8'>
        <h1 className='font-display text-st-fg text-3xl font-bold'>{title}</h1>
        <p className='text-st-muted mt-1 text-sm'>Last updated {updated}</p>
        <div className='text-st-fg mt-6 flex flex-col gap-4 leading-relaxed [&_a]:text-st-accent [&_a]:underline [&_h2]:font-display [&_h2]:mt-2 [&_h2]:text-xl [&_h2]:font-bold [&_ul]:list-disc [&_ul]:pl-5'>
          {children}
        </div>
      </main>
      <Footer />
    </>
  );
}
