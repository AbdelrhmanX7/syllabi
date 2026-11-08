import type { ReactNode } from 'react';

import { Chip } from '@repo/ui';
import { WifiOff } from 'lucide-react';

import { useOnline } from '@/lib/offline/hooks';

/** Stands in for an AI / online-only action while offline: says why it isn't there, nothing to tap. */
export function NeedsInternet({ label, className }: { label?: string; className?: string }) {
  return (
    <Chip
      className={className}
      size='sm'
      startContent={<WifiOff aria-hidden className='h-3.5 w-3.5' />}
      title='Needs internet'
      variant='flat'
    >
      {label ? `${label} · needs internet` : 'Needs internet'}
    </Chip>
  );
}

/** `children` online; offline, the «Needs internet» chip (or `fallback`) in their place. */
export function IfOnline({ children, label, fallback }: { children: ReactNode; label?: string; fallback?: ReactNode }) {
  const online = useOnline();

  if (online) return <>{children}</>;

  return <>{fallback === undefined ? <NeedsInternet label={label} /> : fallback}</>;
}
