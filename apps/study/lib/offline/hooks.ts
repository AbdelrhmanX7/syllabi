import { useEffect, useState, useSyncExternalStore } from 'react';

import { currentScope, outbox } from './jobs';
import { isOnline, subscribeOnline } from './network';

const subscribe = (notify: () => void) => subscribeOnline(() => notify());

/** Whether the server can be reached (true during SSR / hydration, so the markup matches). */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}

/** How many changes of this session wait to be sent. */
export function useOutboxCount(): number {
  const [count, setCount] = useState(0);

  useEffect(
    () =>
      outbox.subscribe((jobs) => {
        const scope = currentScope();

        setCount(jobs.filter((job) => job.scope === scope).length);
      }),
    [],
  );

  return count;
}
