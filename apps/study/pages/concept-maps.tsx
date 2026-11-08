import Head from 'next/head';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';

import { LoadingRows } from '@/components/ui/primitives';
import { SampleDataBanner } from '@/components/ui/SampleDataBanner';
import { useSampleRoute } from '@/lib/api/hooks';

const ConceptMapsHome = dynamic(() => import('@/features/conceptmaps'), {
  ssr: false,
  loading: () => <LoadingRows rows={6} />,
});

export default function ConceptMapsPage() {
  const router = useRouter();
  const classId = typeof router.query.classId === 'string' ? router.query.classId : undefined;
  const isSample = useSampleRoute('/concept-maps');

  return (
    <>
      <Head>
        <title>Concept Maps · Syllabi</title>
      </Head>
      {isSample && <SampleDataBanner className='mb-5' what='class data' />}
      <ConceptMapsHome classId={classId} />
    </>
  );
}
