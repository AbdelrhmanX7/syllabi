import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import Link from 'next/link';

/** The study shell has no toast helper, so the feature carries a small one. */

export type ToastTone = 'ok' | 'danger' | 'neutral';

export interface ToastMessage {
  id: number;
  text: string;
  tone: ToastTone;
  href?: string;
  hrefLabel?: string;
}

const AUTO_DISMISS_MS = 6_000;

export function useToast() {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const timer = useRef<number | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setToast(null);
  }, []);

  const show = useCallback((text: string, options: { tone?: ToastTone; href?: string; hrefLabel?: string } = {}) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setToast({
      id: Date.now(),
      text,
      tone: options.tone ?? 'neutral',
      href: options.href,
      hrefLabel: options.hrefLabel,
    });
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setToast(null);
    }, AUTO_DISMISS_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return { toast, show, dismiss };
}

export function Toast({ toast, onDismiss }: { toast: ToastMessage | null; onDismiss: () => void }) {
  if (!toast) return null;
  const Icon = toast.tone === 'ok' ? CheckCircle2 : toast.tone === 'danger' ? XCircle : Info;
  const tone = toast.tone === 'ok' ? 'text-st-ok' : toast.tone === 'danger' ? 'text-st-danger' : 'text-st-accent';

  return (
    <div
      key={toast.id}
      aria-live='polite'
      className='rounded-st-lg border-st-clay-edge bg-st-surface shadow-clay fixed bottom-[calc(1rem+var(--st-nav-offset,0px))] left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 border-2 px-4 py-3 text-sm'
      role='status'
    >
      <Icon className={`h-5 w-5 shrink-0 ${tone}`} />
      <span className='text-st-fg'>{toast.text}</span>
      {toast.href && (
        <Link className='text-st-accent shrink-0 font-medium underline underline-offset-2' href={toast.href}>
          {toast.hrefLabel ?? 'Open'}
        </Link>
      )}
      <button
        aria-label='Dismiss'
        className='text-st-muted hover:text-st-fg ml-1 shrink-0'
        type='button'
        onClick={onDismiss}
      >
        <X className='h-4 w-4' />
      </button>
    </div>
  );
}
