import Head from 'next/head';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';

import { LoadingRows } from '@/components/ui/primitives';

const SharedHome = dynamic(() => import('@/features/share'), {
  ssr: false,
  loading: () => <LoadingRows rows={4} />,
});

/** `/shared/` — Shared with me; `/shared/?id=<shareId or link token>` — the read-only view + «Make a copy». */
export default function SharedPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';

  return (
    <>
      <Head>
        <title>Shared · Syllabi</title>
      </Head>
      {router.isReady ? <SharedHome key={id} id={id} /> : <LoadingRows rows={4} />}
    </>
  );
}
