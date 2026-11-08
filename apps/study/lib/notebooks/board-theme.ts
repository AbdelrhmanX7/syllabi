// Settings → Notebook paper → «Board»: paper (white, the default), dark (a dark board, ink painted
// light), or follow the app's light/dark theme. Per device, like the other Settings stores. A view
// setting only — the ink and every export stay as written (whiteboard-react utils/darkBoard).
import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';

export type BoardThemeSetting = 'paper' | 'dark' | 'app';

const STORAGE_KEY = 'study_board_theme';

let snapshot: BoardThemeSetting | null = null;
const listeners = new Set<() => void>();

const isSetting = (value: unknown): value is BoardThemeSetting =>
  value === 'paper' || value === 'dark' || value === 'app';

export function readBoardThemeSetting(): BoardThemeSetting {
  if (snapshot !== null) return snapshot;
  if (typeof window === 'undefined') return 'paper';

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    snapshot = isSetting(raw) ? raw : 'paper';
  } catch {
    snapshot = 'paper';
  }

  return snapshot;
}

export function saveBoardThemeSetting(value: BoardThemeSetting): void {
  snapshot = value;

  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // private mode / quota — the in-memory snapshot still applies for this session
  }

  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function useBoardThemeSetting(): BoardThemeSetting {
  return useSyncExternalStore(subscribe, readBoardThemeSetting, () => 'paper');
}

/** The theme the notebook board paints with right now. */
export function useBoardTheme(): 'light' | 'dark' {
  const setting = useBoardThemeSetting();
  const { resolvedTheme } = useTheme();

  if (setting === 'dark') return 'dark';
  if (setting === 'app') return resolvedTheme === 'dark' ? 'dark' : 'light';

  return 'light';
}
