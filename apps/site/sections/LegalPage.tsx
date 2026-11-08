import Head from 'next/head';
import type { ReactNode } from 'react';

import { Footer } from '~/sections/Footer';
import { Nav } from '~/sections/Nav';

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <>
      <Head>
        <title>{`${title} · Syllabi`}</title>
        <meta content='width=device-width, initial-scale=1' name='viewport' />
      </Head>
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
