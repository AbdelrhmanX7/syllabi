import Head from 'next/head';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';

import { LoadingRows } from '@/components/ui/primitives';
import { RequireAi } from '@/components/ui/AiOff';

const TutorHome = dynamic(() => import('@/features/tutor'), { ssr: false, loading: () => <LoadingRows rows={6} /> });

/** `/tutor/?classId=&id=` — the AI tutor; the feature keeps the query in step (shallow replace). */
export default function TutorPage() {
  const router = useRouter();
  const classId = typeof router.query.classId === 'string' ? router.query.classId : undefined;
  const conversationId = typeof router.query.id === 'string' ? router.query.id : undefined;

  return (
    <>
      <Head>
        <title>Tutor · Syllabi</title>
      </Head>
      <RequireAi>
        <TutorHome classId={classId} conversationId={conversationId} />
      </RequireAi>
    </>
  );
}
