import type { ReactNode } from 'react';

import { Sparkles } from 'lucide-react';

import { AI_NOT_ENABLED_MESSAGE } from '@/lib/api/errors';
import { useAiEnabled } from '@/hooks/useAiEnabled';

/** The plain line a hidden AI page shows when opened directly. */
export function AiOffNote() {
  return (
    <p className='text-st-muted flex items-center gap-2 px-1 py-6 text-sm' role='status'>
      <Sparkles aria-hidden className='h-4 w-4 shrink-0' />
      {AI_NOT_ENABLED_MESSAGE}
    </p>
  );
}

/** Renders `children` only for accounts with AI; others see the plain line (or `fallback`). */
export function RequireAi({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  const ai = useAiEnabled();

  if (!ai) return <>{fallback === undefined ? <AiOffNote /> : fallback}</>;

  return <>{children}</>;
}

/** Renders `children` only for accounts with AI, else nothing (buttons, links, chips). */
export function IfAi({ children }: { children: ReactNode }) {
  return useAiEnabled() ? <>{children}</> : null;
}
