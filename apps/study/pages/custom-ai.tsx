import dynamic from 'next/dynamic';

import { LoadingRows } from '@/components/ui/primitives';

/** `/custom-ai/` — the study buddy's experts, memory and answers (Settings → Custom AI, or the buddy's panel). */
const CustomAiPage = dynamic(() => import('@/features/buddy/CustomAiPage'), {
  ssr: false,
  loading: () => <LoadingRows rows={5} />,
});

export default function CustomAi() {
  return <CustomAiPage />;
}
