import React from 'react';

import type { ErrorInfo, ReactNode } from 'react';

import { Button } from '@repo/ui';
import { RefreshCw } from 'lucide-react';

import { wbDir, wbT, type WbLocale } from '../../i18n/strings';

export interface WhiteboardErrorBoundaryProps {
  children?: ReactNode;
  /** Render a custom fallback. Receives the caught error and a `reset` that clears the error state
   *  so the boundary re-renders its children (e.g. after the caller swaps the corrupt input). */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Called once when an error is caught — use it to best-effort flush in-flight work and/or log.
   *  Must not throw; any throw here is swallowed so the fallback still renders. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Optional label shown in the default fallback heading. Defaults to a board-level message. */
  title?: string;
  /** Optional descriptive line shown under the heading in the default fallback. */
  description?: string;
  /**
   * When any value in this array changes, a previously-caught error is cleared so the children
   * re-render. Use this to reset per-page error state on navigation WITHOUT a `key` remount —
   * remounting the whiteboard subtree disposes the freshly-loaded Fabric canvas (the loaded ink
   * lands on the disposed canvas and the replacement stays blank), so callers must reset, not remount.
   */
  resetKeys?: ReadonlyArray<unknown>;
  /** Kept for host compatibility; the default fallback is English. */
  locale?: WbLocale;
}

interface WhiteboardErrorBoundaryState {
  error: Error | null;
}

/**
 * Reusable React error boundary for the whiteboard editor. A corrupt `canvasJSON` or a broken PDF
 * asset throwing during render is caught here instead of white-screening the whole app. `onError`
 * fires first (callers flush in-flight ink + log), then a clean fallback with a retry button
 * renders. Must be a class component — React only surfaces render errors to class boundaries.
 */
export class WhiteboardErrorBoundary extends React.Component<
  WhiteboardErrorBoundaryProps,
  WhiteboardErrorBoundaryState
> {
  constructor(props: WhiteboardErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error: Error): WhiteboardErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      this.props.onError?.(error, info);
    } catch {
      // A failing onError (e.g. a flush that itself throws) must not re-crash the boundary.
    }
  }

  componentDidUpdate(prevProps: WhiteboardErrorBoundaryProps): void {
    // Only act while showing a fallback. Clearing the error here (instead of remounting via `key`)
    // lets the SAME child subtree re-render, so the live Fabric canvas is preserved across page
    // navigation while still recovering from a corrupt-page render error.
    if (this.state.error === null) return;

    const prev = prevProps.resetKeys ?? [];
    const next = this.props.resetKeys ?? [];
    const changed = prev.length !== next.length || next.some((value, index) => !Object.is(value, prev[index]));

    if (changed) {
      this.reset();
    }
  }

  reset(): void {
    this.setState({ error: null });
  }

  render(): ReactNode {
    const { error } = this.state;
    const { children, fallback, title, description, locale = 'en' } = this.props;

    if (!error) {
      return children;
    }

    if (fallback) {
      return fallback(error, this.reset);
    }

    return (
      <div className='text-ink flex h-full w-full items-center justify-center p-6 text-start' dir={wbDir(locale)}>
        <div className='rounded-sk-lg border-sk border-ink bg-paper shadow-sk-xl flex max-w-md flex-col items-center gap-4 px-6 py-7 text-center'>
          <div className='border-sk border-ink bg-citrine flex h-12 w-12 items-center justify-center rounded-full'>
            <RefreshCw className='h-5 w-5' />
          </div>
          <div>
            <p className='text-ink text-base font-semibold'>{title ?? wbT(locale, 'editor.crash.title')}</p>
            <p className='text-ink/65 mt-2 text-sm leading-6'>
              {description ?? wbT(locale, 'editor.boundary.description')}
            </p>
          </div>
          <Button
            className='border-sk border-ink bg-paper text-ink shadow-sk-sm'
            size='sm'
            variant='flat'
            onPress={this.reset}
          >
            {wbT(locale, 'editor.boundary.retry')}
          </Button>
        </div>
      </div>
    );
  }
}

export default WhiteboardErrorBoundary;
