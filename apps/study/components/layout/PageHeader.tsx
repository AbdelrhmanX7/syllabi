import type { ReactNode } from 'react';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/router';

export function PageHeader({
  title,
  eyebrow,
  subtitle,
  actions,
  back,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Show a back arrow; a string navigates there, `true` goes back in history. */
  back?: string | boolean;
}) {
  const router = useRouter();

  return (
    // Phones: actions wrap under the title (full width); sm and up keep them beside it.
    <header className='mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-4'>
      <div className='flex min-w-0 items-start gap-3'>
        {back && (
          <button
            aria-label='Back'
            className='border-st-clay-edge bg-st-surface text-st-fg hover:bg-st-accent-soft shadow-clay mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 transition-transform active:translate-y-[3px] active:shadow-none'
            type='button'
            onClick={() => (typeof back === 'string' ? router.push(back) : router.back())}
          >
            <ArrowLeft className='h-5 w-5' />
          </button>
        )}
        <div className='min-w-0'>
          {eyebrow && <div className='text-st-muted mb-1 text-xs font-semibold uppercase tracking-wide'>{eyebrow}</div>}
          <h1 className='text-st-fg font-display text-2xl font-bold tracking-tight [overflow-wrap:anywhere]'>{title}</h1>
          {subtitle && <div className='text-st-muted mt-1 text-sm'>{subtitle}</div>}
        </div>
      </div>
      {actions && <div className='flex min-w-0 flex-wrap items-center gap-2'>{actions}</div>}
    </header>
  );
}
