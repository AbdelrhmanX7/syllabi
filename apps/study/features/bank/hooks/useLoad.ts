// Minimal async loader (no React Query dependency on the shell): status + data + reload, with the
// latest call winning and unmount ignored.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface LoadState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  setData: (updater: T | ((current: T | null) => T)) => void;
}

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong';

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[], enabled = true): LoadState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const loaderRef = useRef(loader);

  loaderRef.current = loader;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);

      return;
    }
    const mine = (seq.current += 1);

    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((value) => {
        if (seq.current !== mine) return;
        setDataState(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (seq.current !== mine) return;
        setError(errorText(err));
        setLoading(false);
      });
  }, [...deps, tick, enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback((updater: T | ((current: T | null) => T)) => {
    setDataState((current) => (typeof updater === 'function' ? (updater as (c: T | null) => T)(current) : updater));
  }, []);

  return { data, loading, error, reload, setData };
}
