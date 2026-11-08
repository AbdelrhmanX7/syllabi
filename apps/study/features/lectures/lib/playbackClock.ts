// The player's current second lives here, outside React state: the screen around it (the notes board
// above all) must not re-render on every poll. Only what shows the time subscribes, through a selector,
// so a 4 Hz tick re-renders a component only when its derived value (active cue, whole second) changes.
import { useCallback, useSyncExternalStore } from 'react';

export interface PlaybackClock {
  get(): number;
  set(sec: number): void;
  subscribe(listener: () => void): () => void;
}

export function createPlaybackClock(initialSec = 0): PlaybackClock {
  let sec = initialSec;
  const listeners = new Set<() => void>();

  return {
    get: () => sec,
    set(next) {
      if (!Number.isFinite(next) || next === sec) return;
      sec = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
}

const noSubscribe = () => () => undefined;

/** `select(currentSec)`; re-renders only when the selected value changes. A null clock reads `fallbackSec`. */
export function usePlaybackValue<T extends string | number | boolean>(
  clock: PlaybackClock | null | undefined,
  select: (sec: number) => T,
  fallbackSec = 0,
): T {
  const getSnapshot = useCallback(() => select(clock ? clock.get() : fallbackSec), [clock, select, fallbackSec]);

  return useSyncExternalStore(clock ? clock.subscribe : noSubscribe, getSnapshot, getSnapshot);
}
