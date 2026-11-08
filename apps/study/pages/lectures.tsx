import type { LectureRef } from '@/features/lecturenotes/lib/lectures';

import { useMemo } from 'react';
import Head from 'next/head';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';

import { LoadingRows } from '@/components/ui/primitives';

const LecturesHome = dynamic(() => import('@/features/lectures'), {
  ssr: false,
  loading: () => <LoadingRows rows={6} />,
});

export default function LecturesPage() {
  const router = useRouter();
  const classId = typeof router.query.classId === 'string' ? router.query.classId : undefined;
  const lectureId = typeof router.query.id === 'string' ? router.query.id : undefined;
  const t = typeof router.query.t === 'string' ? Number(router.query.t) : NaN;
  const startAtSec = Number.isFinite(t) && t > 0 ? t : undefined;
  // Today → «Record + notes»: `record=1&title=…&note=<lecture JSON>`.
  const recordTitle = router.query.record === '1' && typeof router.query.title === 'string' ? router.query.title : null;
  const note = typeof router.query.note === 'string' ? router.query.note : null;
  const record = useMemo(() => {
    if (!recordTitle) return null;
    try {
      return { title: recordTitle, note: note ? (JSON.parse(note) as LectureRef) : null };
    } catch {
      return { title: recordTitle, note: null };
    }
  }, [note, recordTitle]);

  return (
    <>
      <Head>
        <title>Lectures · Syllabi</title>
      </Head>
      <LecturesHome classId={classId} lectureId={lectureId} record={record} startAtSec={startAtSec} />
    </>
  );
}
