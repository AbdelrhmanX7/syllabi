import { CloudOff } from 'lucide-react';

import { Badge } from '@/components/ui/primitives';
import { useOnline, useOutboxCount } from '@/lib/offline/hooks';

/**
 * One calm line at the top of the shell while the server can't be reached. Flat on purpose: it sits
 * at the top edge of the scrolling main column, where a lipped chip's shadow would be cut.
 */
export function OfflineBar() {
  const online = useOnline();
  const waiting = useOutboxCount();

  if (online) return null;

  return (
    <div
      aria-live='polite'
      className='border-default-200 text-st-muted flex items-center gap-2 border-b px-4 py-1.5 text-sm md:px-6'
      role='status'
    >
      <Badge className='shrink-0' tone='warn'>
        <CloudOff aria-hidden className='h-3.5 w-3.5' />
        Offline
      </Badge>
      <span className='min-w-0'>
        {waiting > 0 ? `${waiting} change${waiting === 1 ? '' : 's'} will sync.` : 'Your changes will sync.'}
      </span>
    </div>
  );
}
