import dynamic from 'next/dynamic';
import Head from 'next/head';

import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingRows } from '@/components/ui/primitives';
import { hwT } from '@/features/handwriting';

// Canvas + IndexedDB: client-only.
const CalibrationSheet = dynamic(() => import('@/features/handwriting').then((mod) => mod.CalibrationSheet), {
  ssr: false,
  loading: () => <LoadingRows rows={4} />,
});

/** `/handwriting/` — the My handwriting calibration sheet (Settings → My handwriting → Continue the sheet). */
export default function HandwritingPage() {
  return (
    <>
      <Head>
        <title>{hwT('pageTitle')}</title>
      </Head>
      <PageHeader back='/settings/' subtitle={hwT('subtitle')} title={hwT('title')} />
      <CalibrationSheet />
    </>
  );
}
