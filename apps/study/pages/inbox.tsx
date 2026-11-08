import dynamic from 'next/dynamic';

import { LoadingRows } from '@/components/ui/primitives';

const InboxPage = dynamic(() => import('@/features/inbox/InboxPage'), {
  ssr: false,
  loading: () => <LoadingRows rows={4} />,
});

export default function Inbox() {
  return <InboxPage />;
}
