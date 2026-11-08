import Head from 'next/head';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';

import { LoadingRows } from '@/components/ui/primitives';

const BankHome = dynamic(() => import('@/features/bank'), { ssr: false, loading: () => <LoadingRows rows={6} /> });

export default function BankPage() {
  const router = useRouter();
  const classId = typeof router.query.classId === 'string' ? router.query.classId : undefined;
  // `?topic=` (concept-map and A-plan links) preselects the topic chip in the bank browser.
  const topic =
    typeof router.query.topic === 'string' && router.query.topic.trim() ? router.query.topic.trim() : undefined;

  // `?mock=1&topics=a&topics=b` (exam countdown; a single comma list works too) opens the mock-exam
  // setup prefilled, `&blueprint=class` with «Real exam format» on; `?review=1` opens a drill.
  const rawTopics = router.query.topics;
  const topicList = (Array.isArray(rawTopics) ? rawTopics : (rawTopics ?? '').split(','))
    .map((t) => t.trim())
    .filter(Boolean);
  const topicsParam = topicList.join('|');
  const mock = router.query.mock === '1' ? { topics: topicList, blueprint: router.query.blueprint === 'class' } : null;
  const review = router.query.review === '1';

  if (!router.isReady) return <LoadingRows rows={6} />;

  return (
    <>
      <Head>
        <title>Question Bank · Syllabi</title>
      </Head>
      <BankHome
        key={`${classId ?? ''}|${mock ? `mock:${topicsParam}:${String(router.query.blueprint ?? '')}` : review ? 'review' : ''}`}
        classId={classId}
        initialMock={mock}
        initialReview={review}
        initialTopic={topic}
      />
    </>
  );
}
