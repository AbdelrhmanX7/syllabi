// Small async loader over React Query: status + data + reload, the latest deps winning. With a
// `cacheKey` the data is kept in the shared query cache under ['study', 'load', cacheKey, ...deps] —
// which the device saves for offline (lib/offline/persist) — so the screen opens with the last data it
// showed, offline too. Without one it is a per-component cache (not saved).

import { useCallback, useId, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { NEEDS_INTERNET_MESSAGE } from '@/lib/api/errors';

export interface LoadState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  setData: (updater: T | ((current: T | null) => T)) => void;
}

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong';

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[], enabled = true, cacheKey?: string): LoadState<T> {
  const id = useId();
  const queryClient = useQueryClient();
  const loaderRef = useRef(loader);

  loaderRef.current = loader;
  const queryKey = ['study', 'load', cacheKey ?? `:${id}`, ...deps.map((dep) => dep ?? null)];
  const query = useQuery({
    queryKey,
    queryFn: () => loaderRef.current(),
    enabled,
    // Like the loader this replaced: no refresh of its own under an open screen (a review queue
    // stepping by index, «load more» pages). `reload()` is the way to ask again.
    refetchOnReconnect: false,
    // A per-component load goes with its component.
    ...(cacheKey ? {} : { gcTime: 0 }),
  });
  const keyRef = useRef(queryKey);

  keyRef.current = queryKey;

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: keyRef.current, exact: true });
  }, [queryClient]);
  const setData = useCallback(
    (updater: T | ((current: T | null) => T)) => {
      queryClient.setQueryData<T>(keyRef.current, (current) =>
        typeof updater === 'function' ? (updater as (c: T | null) => T)(current ?? null) : updater,
      );
    },
    [queryClient],
  );
  const data = (query.data ?? null) as T | null;
  // Offline with nothing saved yet: say why it is empty instead of loading forever.
  const offlineEmpty = data === null && query.isPending && query.fetchStatus === 'paused';

  return {
    data,
    loading: enabled && data === null && query.fetchStatus === 'fetching',
    // Last data shown wins over a failed refresh.
    error: offlineEmpty ? NEEDS_INTERNET_MESSAGE : data === null && query.error ? errorText(query.error) : null,
    reload,
    setData,
  };
}
