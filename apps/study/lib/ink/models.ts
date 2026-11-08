// The ML Kit English handwriting model (~20 MB) as one app-wide store: Settings shows and starts the
// download, the board only turns auto-colour on once it is on the device.
import { useEffect, useSyncExternalStore } from 'react';

import { getInkModelStatus, nativeInkRecognizer } from './nativeRecognizer';

export type InkModelsState = 'unknown' | 'missing' | 'downloading' | 'ready' | 'failed' | 'unsupported';

export interface InkModelsSnapshot {
  state: InkModelsState;
  /** 0–1 while downloading. */
  progress: number;
}

let snapshot: InkModelsSnapshot = { state: nativeInkRecognizer ? 'unknown' : 'unsupported', progress: 0 };
let checking: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: InkModelsSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** Ask the device which models it has (once at a time; never while a download runs). */
export function refreshInkModels(): Promise<void> {
  if (!nativeInkRecognizer || snapshot.state === 'downloading') return Promise.resolve();
  checking ??= getInkModelStatus()
    .then((status) => {
      if (snapshot.state === 'downloading') return;
      const states = [status.en];

      if (states.every((s) => s === 'ready')) set({ state: 'ready', progress: 1 });
      else if (states.some((s) => s === 'downloading')) void downloadInkModels();
      else set({ state: 'missing', progress: 0 });
    })
    .finally(() => {
      checking = null;
    });

  return checking;
}

/** Download the model (joins a download already running). */
export async function downloadInkModels(): Promise<void> {
  if (!nativeInkRecognizer?.prepare || snapshot.state === 'ready') return;
  set({ state: 'downloading', progress: snapshot.state === 'downloading' ? snapshot.progress : 0 });

  try {
    await nativeInkRecognizer.prepare((fraction) =>
      set({ state: 'downloading', progress: Math.max(0, Math.min(1, fraction)) }),
    );
    set({ state: 'ready', progress: 1 });
  } catch {
    set({ state: 'failed', progress: 0 });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

const SERVER: InkModelsSnapshot = { state: 'unknown', progress: 0 };

/** The models' state; checks the device on first use. */
export function useInkModels(): InkModelsSnapshot {
  const value = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => SERVER,
  );

  useEffect(() => {
    if (snapshot.state === 'unknown') void refreshInkModels();
  }, []);

  return value;
}
