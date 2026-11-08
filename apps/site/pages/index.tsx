import Head from 'next/head';

import { ComingNext } from '~/sections/ComingNext';
import { ConnectAI } from '~/sections/ConnectAI';
import { Cta } from '~/sections/Cta';
import { Devices } from '~/sections/Devices';
import { Footer } from '~/sections/Footer';
import { Hero } from '~/sections/Hero';
import { Motion } from '~/sections/Motion';
import { Nav } from '~/sections/Nav';
import { Notebooks } from '~/sections/Notebooks';
import { Organize } from '~/sections/Organize';
import { SelfHost } from '~/sections/SelfHost';
import { Study } from '~/sections/Study';

const TITLE = 'Syllabi: your whole semester in one study app';
const DESCRIPTION =
  'Handwritten notes, an AI tutor, questions and flashcards that come back at the right time, lectures and a calendar of everything due. Free on the web and on Android tablets. Connect Claude or ChatGPT.';

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
        <link href='https://syllabi.studio/' rel='canonical' />
      </Head>
      <Nav />
      <Motion>
        <Hero />
        <Notebooks />
        <Study />
        <Organize />
        <ConnectAI />
        <Devices />
        <ComingNext />
        <SelfHost />
        <Cta />
      </Motion>
      <Footer />
    </>
  );
}
