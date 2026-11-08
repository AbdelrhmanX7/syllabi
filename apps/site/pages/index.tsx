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
import { Reminders } from '~/sections/Reminders';
import { Organize } from '~/sections/Organize';
import { SelfHost } from '~/sections/SelfHost';
import { Seo } from '~/sections/Seo';
import { Study } from '~/sections/Study';

const TITLE = 'Syllabi: free study and note-taking app for tablets';
const DESCRIPTION =
  'Take notes by hand, see everything due from Canvas, and practice with flashcards made from your notes, with a free AI tutor. Free on Android tablets and the web.';

// Structured data: what the app is (free, Android + web) so search results can show it as an app.
const JSON_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'SoftwareApplication',
      name: 'Syllabi',
      url: 'https://syllabi.studio/',
      applicationCategory: 'EducationalApplication',
      operatingSystem: 'Android, Web',
      description: DESCRIPTION,
      image: 'https://syllabi.studio/shots/today.png',
      downloadUrl: 'https://syllabi.studio/download/',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
    {
      '@type': 'Organization',
      name: 'Syllabi',
      url: 'https://syllabi.studio/',
      logo: 'https://syllabi.studio/apple-touch-icon.png',
      sameAs: ['https://github.com/AbdelrhmanX7/syllabi'],
    },
  ],
});

export default function Landing() {
  return (
    <>
      <Seo description={DESCRIPTION} path='/' title={TITLE} />
      <Head>
        <script dangerouslySetInnerHTML={{ __html: JSON_LD }} type='application/ld+json' />
      </Head>
      <Nav />
      <Motion>
        <Hero />
        <Reminders />
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
