/**
 * ML Kit Digital Ink recognizer for the Android shell — the page half of InkRecognizer.kt.
 *
 * The activity installs `window.StudyInkNative`; every call returns at once and the outcome arrives as
 * a `study-ink-native` CustomEvent `{requestId, type: 'progress' | 'result' | 'error', …}`. On the web
 * and desktop the bridge is absent: `available()` resolves false and nothing else is attempted.
 *
 * Candidates follow the shared contract: the English model's list, best first, each tagged with its
 * model's `lang` ('en'). Nothing is merged, de-duplicated or re-scored here.
 * Syllabi is English only: a request naming any other language is narrowed to English.
 * `score` is ML Kit's own (lower = better) and is absent for the text models, which do not score.
 */
import type { InkCandidate, InkPoint, InkRecognizer, InkRecognizeRequest } from '@repo/whiteboard-react/auto-color';

export const NATIVE_INK_EVENT = 'study-ink-native';
export const DEFAULT_INK_LANGS = ['en'];

export interface StudyInkNativeBridge {
  isAvailable(): boolean;
  ensureModels(requestId: string, langsJson: string): boolean;
  modelStatus?(requestId: string, langsJson: string): boolean;
  recognize(requestId: string, requestJson: string): boolean;
}

declare global {
  interface Window {
    StudyInkNative?: StudyInkNativeBridge;
  }
}

interface NativeCandidate {
  text: string;
  score?: number;
}

interface NativeEventDetail {
  requestId: string;
  type: 'progress' | 'result' | 'error';
  fraction?: number;
  lang?: string;
  code?: string;
  message?: string;
  results?: { lang: string; candidates: NativeCandidate[]; ms?: number }[];
  errors?: Record<string, string>;
  models?: Record<string, boolean>;
}

export class InkRecognizerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InkRecognizerError';
  }
}

export interface NativeRecognizerOptions {
  /** Where the bridge lives; defaults to `window.StudyInkNative`. */
  getBridge?: () => StudyInkNativeBridge | undefined;
  /** Where `study-ink-native` events are dispatched; defaults to `window`. */
  target?: EventTarget;
  /** Languages `prepare()` downloads. */
  langs?: string[];
  /** Native waits up to 10 s per language, and the first call also loads the model. */
  recognizeTimeoutMs?: number;
  /** Idle timeout: re-armed by each per-model progress event (native allows 300 s per model). */
  prepareTimeoutMs?: number;
  maxResults?: number;
}

export type InkModelState = 'ready' | 'missing' | 'downloading';
export type InkModelStatus = { en: InkModelState };

export interface NativeInkRecognizer extends InkRecognizer {
  prepare(onProgress?: (fraction: number) => void): Promise<void>;
  /** Per-language model state, asked of the device (no download). */
  modelStatus(): Promise<InkModelStatus>;
}

/** Native per-language results → contract candidates: each model's list in its own order, tagged with its lang. */
export function toCandidates(
  results: { lang: string; candidates: NativeCandidate[] }[],
  order: string[],
): InkCandidate[] {
  const rank = (lang: string) => {
    const index = order.indexOf(lang);

    return index < 0 ? order.length : index;
  };
  const out: InkCandidate[] = [];

  for (const { lang, candidates } of [...results].sort((x, y) => rank(x.lang) - rank(y.lang))) {
    for (const candidate of candidates ?? []) {
      if (typeof candidate?.text !== 'string' || !candidate.text.trim()) continue;
      out.push(
        typeof candidate.score === 'number' && Number.isFinite(candidate.score)
          ? { text: candidate.text, score: candidate.score, lang }
          : { text: candidate.text, lang },
      );
    }
  }

  return out;
}

/** Strokes → `[[x, y, t, x, y, t, …], …]`, times relative to the first point and rounded to ms. */
export function flattenStrokes(strokes: InkPoint[][]): number[][] {
  const t0 = strokes.find((s) => s.length > 0)?.[0]?.t ?? 0;

  return strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => {
      const flat = new Array<number>(stroke.length * 3);

      stroke.forEach((p, i) => {
        flat[i * 3] = Math.round(p.x * 100) / 100;
        flat[i * 3 + 1] = Math.round(p.y * 100) / 100;
        flat[i * 3 + 2] = Math.max(0, Math.round(p.t - t0));
      });

      return flat;
    });
}

let sequence = 0;
const nextRequestId = (kind: string) => `${kind}-${Date.now().toString(36)}-${(sequence++).toString(36)}`;

const abortError = () => {
  if (typeof DOMException !== 'undefined') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');

  error.name = 'AbortError';

  return error;
};

export function createNativeInkRecognizer(options: NativeRecognizerOptions = {}): NativeInkRecognizer {
  const getBridge = options.getBridge ?? (() => (typeof window === 'undefined' ? undefined : window.StudyInkNative));
  const getTarget = () => options.target ?? (typeof window === 'undefined' ? undefined : window);
  const langs = options.langs ?? DEFAULT_INK_LANGS;
  const recognizeTimeoutMs = options.recognizeTimeoutMs ?? 12_000;
  const prepareTimeoutMs = options.prepareTimeoutMs ?? 6 * 60_000;
  const maxResults = options.maxResults ?? 5;
  let prepared: Promise<void> | null = null;
  const progressListeners = new Set<(fraction: number) => void>();
  const downloading = new Set<string>();

  /** Send one request and wait for its terminal event. */
  const call = (
    kind: string,
    send: (bridge: StudyInkNativeBridge, requestId: string) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
    onProgress?: (detail: NativeEventDetail) => void,
  ) =>
    new Promise<NativeEventDetail>((resolve, reject) => {
      const bridge = getBridge();
      const target = getTarget();

      if (!bridge || !target) {
        reject(new InkRecognizerError('unavailable', 'StudyInkNative bridge is not present'));

        return;
      }
      if (signal?.aborted) {
        reject(abortError());

        return;
      }
      const requestId = nextRequestId(kind);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        target.removeEventListener(NATIVE_INK_EVENT, onEvent);
        signal?.removeEventListener('abort', onAbort);
        if (timer !== undefined) clearTimeout(timer);
      };
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      const onEvent = (event: Event) => {
        const detail = (event as CustomEvent<NativeEventDetail>).detail;

        if (!detail || detail.requestId !== requestId) return;
        if (detail.type === 'progress') {
          // The timeout is an IDLE timeout: every progress event (one per downloaded model) re-arms it.
          arm();
          onProgress?.(detail);

          return;
        }
        cleanup();
        if (detail.type === 'error')
          reject(new InkRecognizerError(detail.code ?? 'failed', detail.message ?? 'ink recognition failed'));
        else resolve(detail);
      };

      target.addEventListener(NATIVE_INK_EVENT, onEvent);
      signal?.addEventListener('abort', onAbort, { once: true });
      function arm() {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          cleanup();
          reject(new InkRecognizerError('timeout', `${kind} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }

      arm();
      let accepted = false;

      try {
        accepted = send(bridge, requestId);
      } catch (error) {
        cleanup();
        reject(new InkRecognizerError('failed', error instanceof Error ? error.message : String(error)));

        return;
      }
      if (!accepted) {
        cleanup();
        reject(new InkRecognizerError('rejected', `${kind} was refused by the native bridge`));
      }
    });

  const recognizer: NativeInkRecognizer = {
    id: 'mlkit',

    async available() {
      try {
        return getBridge()?.isAvailable() === true;
      } catch {
        return false;
      }
    },

    prepare(onProgress) {
      if (onProgress) progressListeners.add(onProgress);
      if (!prepared) {
        const report = (fraction: number) => progressListeners.forEach((listener) => listener(fraction));

        langs.forEach((lang) => downloading.add(lang));
        prepared = call(
          'models',
          (bridge, id) => bridge.ensureModels(id, JSON.stringify(langs)),
          prepareTimeoutMs,
          undefined,
          (detail) => {
            if (detail.lang) downloading.delete(detail.lang);
            if (typeof detail.fraction === 'number') report(detail.fraction);
          },
        ).then(
          () => {
            report(1);
          },
          (error: unknown) => {
            // A failed download may be retried by the next prepare().
            prepared = null;
            throw error;
          },
        );
        prepared
          .finally(() => {
            downloading.clear();
            progressListeners.clear();
          })
          .catch(() => undefined);
      }

      return prepared;
    },

    async modelStatus() {
      const status: InkModelStatus = { en: 'missing' };
      const bridge = getBridge();

      if (!bridge?.modelStatus) return status;
      const detail = await call('status', (b, id) => b.modelStatus!(id, JSON.stringify(['en'])), 10_000);

      status.en = detail.models?.en ? 'ready' : downloading.has('en') ? 'downloading' : 'missing';

      return status;
    },

    async recognize(req: InkRecognizeRequest, signal?: AbortSignal) {
      const strokes = flattenStrokes(req.strokes);

      if (strokes.length === 0) return [];
      const narrowed = req.langs.filter((lang) => langs.includes(lang));
      const requestLangs = narrowed.length > 0 ? narrowed : langs;
      const payload = {
        strokes,
        langs: requestLangs,
        maxResults,
        ...(req.preContext ? { preContext: req.preContext.slice(-20) } : {}),
        ...(req.writingArea && req.writingArea.width > 0 && req.writingArea.height > 0
          ? { writingArea: { width: req.writingArea.width, height: req.writingArea.height } }
          : {}),
      };
      const detail = await call(
        'ink',
        (bridge, id) => bridge.recognize(id, JSON.stringify(payload)),
        recognizeTimeoutMs,
        signal,
      );

      return toCandidates(detail.results ?? [], requestLangs);
    },
  };

  return recognizer;
}

/**
 * The app-wide ML Kit recognizer, or null where there is no `window.StudyInkNative` (web, desktop, SSR).
 * The activity installs the bridge before the page's first script runs, so a module-load check is exact.
 */
export const nativeInkRecognizer: NativeInkRecognizer | null =
  typeof window !== 'undefined' && window.StudyInkNative ? createNativeInkRecognizer() : null;

/** The English model's state on this device; 'missing' off Android or when the bridge cannot answer. */
export async function getInkModelStatus(): Promise<InkModelStatus> {
  if (!nativeInkRecognizer) return { en: 'missing' };
  try {
    return await nativeInkRecognizer.modelStatus();
  } catch {
    return { en: 'missing' };
  }
}
