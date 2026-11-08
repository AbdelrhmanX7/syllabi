import { useEffect } from 'react';
import { useRouter } from 'next/router';

const MESSAGE = 'You have unsaved changes. Leave anyway?';

/** Warns before a tab close / reload or an in-app route change while `dirty`. */
export function useUnsavedGuard(dirty: boolean): void {
  const router = useRouter();

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = MESSAGE;
    };
    const onRouteChange = (url: string) => {
      if (url === router.asPath || window.confirm(MESSAGE)) return;
      router.events.emit('routeChangeError');
      // Next has no cancel API; throwing aborts the transition (the documented workaround).
      throw new Error('Route change aborted: unsaved changes');
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    router.events.on('routeChangeStart', onRouteChange);

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      router.events.off('routeChangeStart', onRouteChange);
    };
  }, [dirty, router]);
}

export const confirmDiscard = (dirty: boolean) => !dirty || window.confirm('Discard your unsaved changes?');
