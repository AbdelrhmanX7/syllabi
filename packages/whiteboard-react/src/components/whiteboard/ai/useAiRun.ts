import { useCallback, useEffect, useRef, useState } from 'react';

import { useWbLocale } from '../../../i18n/context';
import { userFacingError, wbT, type WbLocale } from '../../../i18n/strings';

import { parseConceptMapAnalysis } from './conceptMap';
import { markdownToBlocks } from './markdownBlocks';
import { parsePageAnalysis } from './pageAnalysis';
import { parsePageLayout } from './pageLayout';

import type { PageLayout } from './pageLayout';

import type { BoardAiBlock, BoardAiStreamEvent, ConceptMapAnalysis, PageAnalysis, RemakeImageResult, RemakePartialPicture, RemakePartialQuestions } from './types';

export interface AiRunState {
  status: 'idle' | 'running' | 'done' | 'error';
  statusLine: string | null;
  thinking: boolean;
  /** What the AI read off the picture, when the transport reports it. */
  transcript: string | null;
  text: string;
  blocks: BoardAiBlock[];
  analysis: PageAnalysis | null;
  concept: ConceptMapAnalysis | null;
  layout: PageLayout | null;
  remakeImage: RemakeImageResult | null;
  /** /remake-page frames that arrive before the result (optional on the wire). */
  remakeQuestions: RemakePartialQuestions | null;
  remakePicture: RemakePartialPicture | null;
  error: string | null;
}

export const IDLE_RUN: AiRunState = {
  status: 'idle',
  statusLine: null,
  thinking: false,
  transcript: null,
  text: '',
  blocks: [],
  analysis: null,
  concept: null,
  layout: null,
  remakeImage: null,
  remakeQuestions: null,
  remakePicture: null,
  error: null,
};

export const errorMessage = (error: unknown, locale: WbLocale = 'en'): string => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return wbT(locale, 'ai.offline');

  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';

  // The host's service speaks English, so its message stands.
  return message || wbT(locale, 'ai.genericError');
};

/**
 * Drives one AI stream into panel state. Text chunks are folded into blocks at most once per frame
 * (the parser is cheap, React re-rendering a long answer per token is not). Starting a new run
 * aborts the previous one; unmounting aborts too.
 */
export function useAiRun() {
  const locale = useWbLocale();
  const [state, setState] = useState<AiRunState>(IDLE_RUN);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState((current) => (current.status === 'running' ? { ...current, status: current.text ? 'done' : 'idle' } : current));
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(IDLE_RUN);
  }, []);

  /**
   * `expect` says what the answer IS: markdown blocks (default), or a JSON page analysis / concept
   * map. A transport that sends the structured frame (`analysis` / `concept_map`) wins; one that only
   * streams text (the guest chat) gets its fenced JSON parsed here when the stream ends.
   */
  const run = useCallback(async (
    start: (signal: AbortSignal) => AsyncIterable<BoardAiStreamEvent> | Promise<AsyncIterable<BoardAiStreamEvent>>,
    { expect = 'blocks' }: { expect?: 'blocks' | 'analysis' | 'concept' | 'layout' | 'image' } = {},
  ) => {
    controllerRef.current?.abort();

    const controller = new AbortController();

    controllerRef.current = controller;
    setState({ ...IDLE_RUN, status: 'running' });

    let text = '';
    let resultBlocks: BoardAiBlock[] | null = null;
    let structured = false;
    const showBlocks = expect === 'blocks';
    let frame: number | null = null;
    const flush = () => {
      frame = null;

      if (controller.signal.aborted) return;
      setState((current) => ({ ...current, text, blocks: showBlocks ? (resultBlocks ?? markdownToBlocks(text)) : [] }));
    };

    try {
      const stream = await start(controller.signal);

      for await (const event of stream) {
        if (controller.signal.aborted) return;

        switch (event.type) {
          case 'status':
            setState((current) => ({ ...current, statusLine: event.data }));
            break;
          case 'thinking':
            setState((current) => (current.thinking ? current : { ...current, thinking: true }));
            break;
          case 'transcript':
            setState((current) => ({ ...current, transcript: event.data }));
            break;
          case 'text':
            text += event.data;

            if (frame === null) {
              frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flush) : (setTimeout(flush, 16) as unknown as number);
            }

            break;
          case 'result':
            resultBlocks = Array.isArray(event.data?.blocks) ? event.data.blocks : null;

            // Shown at once: /image sends the picture first and its labels in a second result.
            if (showBlocks && resultBlocks) flush();
            break;
          case 'analysis': {
            // Raw endpoint shape (array boxes, nulls) → the normalised one every consumer expects.
            const analysis = parsePageAnalysis(event.data);

            if (analysis) {
              structured = true;
              setState((current) => ({ ...current, analysis }));
            }

            break;
          }
          case 'concept_map': {
            // Raw endpoint shape ({graph, fixes}, enum directions) → ours.
            const concept = parseConceptMapAnalysis(event.data) ?? event.data;

            structured = true;
            setState((current) => ({ ...current, concept }));
            break;
          }
          case 'remake_image':
            structured = true;
            setState((current) => ({ ...current, remakeImage: event.data }));
            break;
          case 'remake_questions':
            setState((current) => ({ ...current, remakeQuestions: event.data }));
            break;
          case 'remake_picture':
            structured = true;
            setState((current) => ({ ...current, remakePicture: event.data }));
            break;
          case 'layout': {
            const layout = parsePageLayout(event.data);

            if (layout) {
              structured = true;
              setState((current) => ({ ...current, layout }));
            }

            break;
          }
          case 'error':
            throw new Error(event.data);
          default:
            break;
        }
      }

      if (controller.signal.aborted) return;

      if (!showBlocks && !structured) {
        const analysis = expect === 'analysis' ? parsePageAnalysis(text) : null;
        const concept = expect === 'concept' ? parseConceptMapAnalysis(text) : null;
        const layout = expect === 'layout' ? parsePageLayout(text) : null;

        if (!analysis && !concept && !layout) throw userFacingError(wbT(locale, 'ai.unparsable'));

        setState((current) => ({ ...current, status: 'done', statusLine: null, thinking: false, text, analysis, concept, layout }));

        return;
      }

      setState((current) => ({
        ...current,
        status: 'done',
        statusLine: null,
        thinking: false,
        text,
        blocks: showBlocks ? (resultBlocks ?? markdownToBlocks(text)) : [],
      }));
    } catch (error) {
      if (controller.signal.aborted) return;

      setState((current) => ({
        ...current,
        status: 'error',
        statusLine: null,
        thinking: false,
        text,
        blocks: showBlocks ? (resultBlocks ?? markdownToBlocks(text)) : [],
        error: errorMessage(error, locale),
      }));
    } finally {
      if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [locale]);

  return { state, run, cancel, reset, setState };
}

/** `navigator.onLine`, live. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));

  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);

    window.addEventListener('online', update);
    window.addEventListener('offline', update);

    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return online;
}

/** The offline sentence, in the UI language. */
export function useOfflineReason(): string {
  return wbT(useWbLocale(), 'ai.offline');
}
