import Head from 'next/head';

import { Footer } from '~/sections/Footer';
import { Hero } from '~/sections/Hero';
import { Nav } from '~/sections/Nav';
import { Notebooks } from '~/sections/Notebooks';
import { Organize } from '~/sections/Organize';
import { SelfHost } from '~/sections/SelfHost';
import { Study } from '~/sections/Study';

const TITLE = 'Syllabi — the open-source study app for tablets';
const DESCRIPTION =
  'Handwritten notebooks, an AI tutor, spaced-repetition questions, lectures, concept maps and a calendar of everything due — for Android tablets and the web. MIT licensed, self-hostable.';

export default function Landing() {
  return (
    <>
      <Head>
        <title>{TITLE}</title>
        <meta content={DESCRIPTION} name='description' />
        <meta content='width=device-width, initial-scale=1' name='viewport' />
        <meta content={TITLE} property='og:title' />
        <meta content={DESCRIPTION} property='og:description' />
        <meta content='https://syllabi.studio/shots/today.png' property='og:image' />
      </Head>
      <Nav />
      <main>
        <Hero />
        <Notebooks />
        <Study />
        <Organize />
        <SelfHost />
      </main>
      <Footer />
    </>
  );
}
