import Head from 'next/head';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';

import { LoadingRows } from '@/components/ui/primitives';
import { SampleDataBanner } from '@/components/ui/SampleDataBanner';
import { useSampleRoute } from '@/lib/api/hooks';

const LibraryHome = dynamic(() => import('@/features/library'), {
  ssr: false,
  loading: () => <LoadingRows rows={6} />,
});

export default function LibraryPage() {
  const router = useRouter();
  const classId = typeof router.query.classId === 'string' ? router.query.classId : undefined;
  const isSample = useSampleRoute(`/classes/${classId ?? '_'}/library`);

  return (
    <>
      <Head>
        <title>Library · Syllabi</title>
      </Head>
      {isSample && <SampleDataBanner className='mb-5' what='library documents' />}
      <LibraryHome classId={classId} />
    </>
  );
}
