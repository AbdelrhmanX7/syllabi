import Head from 'next/head';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';

import { LoadingRows } from '@/components/ui/primitives';
import { SampleDataBanner } from '@/components/ui/SampleDataBanner';
import { useSampleRoute } from '@/lib/api/hooks';

const FlashcardsHome = dynamic(() => import('@/features/flashcards'), {
  ssr: false,
  loading: () => <LoadingRows rows={6} />,
});

export default function FlashcardsPage() {
  const router = useRouter();
  const classId = typeof router.query.classId === 'string' ? router.query.classId : undefined;
  const make =
    router.query.make === 'page' || router.query.make === 'library' || router.query.make === 'lecture'
      ? router.query.make
      : undefined;
  const isSample = useSampleRoute('/questions');

  return (
    <>
      <Head>
        <title>Flashcards · Syllabi</title>
      </Head>
      {isSample && <SampleDataBanner className='mb-5' what='flashcards and reviews' />}
      <FlashcardsHome key={make ?? 'home'} classId={classId} make={make} />
    </>
  );
}
