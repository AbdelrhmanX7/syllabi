// Settings + the native recognizer + the cloud client → the board's `autoColor` prop for one page.
import type { AutoColorConfig, InkCloudClassifier } from '@repo/whiteboard-react/auto-color';

import { useMemo } from 'react';

import { cloudInkClassifier, isInkCloudUnavailable } from './cloudClassify';
import { useInkModels } from './models';
import { nativeInkRecognizer } from './nativeRecognizer';
import { devicePhraseMemory } from './phrase-memory';
import { inkEnabledForPage, useInkSettings } from './settings';
import { useAiEnabled } from '@/hooks/useAiEnabled';

let cloudGone = false;

/**
 * The cloud classifier, asked until the backend says it has no such route (404/405/501): from then on
 * this app session is rules-only without another request. Any other failure is per call.
 */
export const sessionCloudClassifier: InkCloudClassifier = {
  async classify(lines, signal) {
    if (cloudGone) throw new Error('ink-classify unavailable');

    try {
      return await cloudInkClassifier.classify(lines, signal);
    } catch (error) {
      if (isInkCloudUnavailable(error)) cloudGone = true;
      throw error;
    }
  },
};

/** The board's `autoColor` for `pageId`, or null when it is off (or this device has no recognizer). */
export function useAutoColorConfig(pageId: string | null | undefined): AutoColorConfig | null {
  const settings = useInkSettings();
  const models = useInkModels();
  // The cloud pass is an AI call: only for accounts with AI.
  const aiOn = useAiEnabled();
  const cloudOn = aiOn && settings.engine === 'device+cloud';
  // Recognition needs both models on the device; until then the board writes as usual.
  const on = inkEnabledForPage(settings, pageId) && nativeInkRecognizer !== null && models.state === 'ready';

  return useMemo(() => {
    if (!on || !nativeInkRecognizer) return null;

    return {
      recognizer: nativeInkRecognizer,
      cloud: cloudOn ? sessionCloudClassifier : null,
      palette: settings.palette,
      memory: devicePhraseMemory(),
      debug: settings.debug,
      mode: settings.when,
    };
  }, [on, cloudOn, settings.palette, settings.debug, settings.when]);
}
