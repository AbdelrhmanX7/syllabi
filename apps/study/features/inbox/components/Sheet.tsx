import type { ReactNode } from 'react';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * A modal sheet: bottom-anchored on narrow screens, centred card on the tablet. Esc / backdrop close.
 * Portalled to <body>: board chrome clusters are `pointer-events-none` stacking contexts.
 */
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div aria-modal className='fixed inset-0 z-[60] flex items-end justify-center sm:items-center' role='dialog'>
      <button aria-label='Close' className='st-fade-in absolute inset-0 bg-st-shadow/40' type='button' onClick={onClose} />
      <div
        className={`st-sheet-in bg-st-surface border-st-clay-edge shadow-clay relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-t-3xl border-2 sm:rounded-3xl ${wide ? 'max-w-4xl' : 'max-w-xl'}`}
      >
        <div className='border-st-line flex items-center gap-3 border-b px-5 py-3'>
          <div className='min-w-0 flex-1'>
            <h2 className='text-st-fg text-base font-semibold'>{title}</h2>
            {subtitle && <p className='text-st-muted truncate text-xs'>{subtitle}</p>}
          </div>
          <button
            aria-label='Close'
            className='text-st-muted hover:bg-st-raised flex h-10 w-10 items-center justify-center rounded-full'
            type='button'
            onClick={onClose}
          >
            <X className='h-5 w-5' />
          </button>
        </div>
        <div className='flex-1 overflow-y-auto px-5 py-4'>{children}</div>
        {footer && <div className='border-st-line border-t px-5 py-3'>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
