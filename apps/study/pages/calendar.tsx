import Head from 'next/head';

import { PageHeader } from '@/components/layout/PageHeader';
import { CalendarView } from '@/features/calendar';

export default function CalendarPage() {
  return (
    <>
      <Head>
        <title>Calendar · Syllabi</title>
      </Head>
      <PageHeader title='Calendar' />
      <CalendarView />
    </>
  );
}
