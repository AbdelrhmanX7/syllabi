import type { BackendSettings } from '@/lib/backend-settings';
import type { ResolvedMode } from '@/lib/api/client';

import { useEffect, useState, useSyncExternalStore } from 'react';

import { getResolvedMode, subscribeResolvedMode } from '@/lib/api/client';
import {
  getBackendSettingsServerSnapshot,
  getBackendSettingsSnapshot,
  subscribeBackendSettings,
} from '@/lib/backend-settings';

export function useBackendSettings(): BackendSettings {
  return useSyncExternalStore(subscribeBackendSettings, getBackendSettingsSnapshot, getBackendSettingsServerSnapshot);
}

/** Which transport is answering right now (`null` before the first call settles). */
export function useResolvedMode(): ResolvedMode | null {
  const [mode, setMode] = useState<ResolvedMode | null>(() => getResolvedMode());

  useEffect(() => {
    setMode(getResolvedMode());

    return subscribeResolvedMode(setMode);
  }, []);

  return mode;
}
