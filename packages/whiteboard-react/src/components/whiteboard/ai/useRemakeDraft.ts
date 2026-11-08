import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { endEffect, hasOverlayText, remakeDraftReducer } from './remakeDraft';
import { makeSoftSnapshot } from './RemakeDraftOverlay';
import { useAiRun } from './useAiRun';

import type { DraftPicture } from './RemakeDraftOverlay';
import type { RemakeDraft, RemakeDraftRequest } from './remakeDraft';
import type { BoardAiService, RemakeImageResult, RemakePartialPicture, RemakePartialQuestions } from './types';
import { useWbStrings } from '../../../i18n/context';

/** What the draft flow needs from the editor (a subset of `BoardAiEditorBridge`). */
export interface RemakeDraftBridge {
  getPageId: () => string | null;
  insertDraftPageAfterCurrent: () => Promise<string | null>;
  setDraftPageImage: (pageId: string, file: File) => Promise<boolean>;
  keepDraftPage: (pageId: string) => void;
  removeDraftPage: (pageId: string, returnToPageId: string | null) => Promise<void>;
  switchToPageId: (pageId: string) => Promise<void>;
  hasPage: (pageId: string) => boolean;
}

/**
 * Writes an overlay result's text onto the draft page (which must be on screen) and returns the page
 * + text as one picture for the dissolve to reveal — null when nothing was placed or no picture was
 * given (the page was opened later, no reveal).
 */
export type PlaceOverlay = (args: {
  pageId: string;
  result: Pick<RemakeImageResult, 'layout'>;
  request: RemakeDraftRequest;
  picture: DraftPicture | null;
  /**
   * Compose only — nothing is written to the board, the page need not be on screen. The text is laid
   * out over `picture` as if it were the page (the streamed `questions` preview).
   */
  preview?: boolean;
}) => Promise<DraftPicture | null>;

interface Source {
  /** What is sent to /remake-page: the original at full detail. */
  image: Blob;
  imageSize: { width: number; height: number };
  /** The original, soft — what the dissolve reveals while the new page is made. */
  content: DraftPicture;
}

const loadPicture = async (blob: Blob): Promise<DraftPicture | null> => {
  const url = URL.createObjectURL(blob);

  try {
    const image = new Image();

    image.decoding = 'async';
    image.src = url;
    await image.decode();

    return { source: image, width: image.naturalWidth, height: image.naturalHeight, url };
  } catch {
    URL.revokeObjectURL(url);

    return null;
  }
};

const canvasPicture = (canvas: HTMLCanvasElement): DraftPicture => ({ source: canvas, width: canvas.width, height: canvas.height, url: canvas.toDataURL('image/jpeg', 0.8) });

/**
 * The page the questions preview is written on: the soft original at the page's own proportions (up
 * to 1200 px wide so the text stays crisp), washed further toward paper so the new words read over
 * the old ones.
 */
function previewBase(content: DraftPicture, size: { width: number; height: number }): DraftPicture | null {
  if (typeof document === 'undefined') return null;

  const width = Math.max(1, Math.min(1200, size.width || content.width));
  const height = Math.max(1, Math.round((width * (size.height || content.height)) / Math.max(1, size.width || content.width)));
  const canvas = document.createElement('canvas');

  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');

  if (!context) return null;

  context.drawImage(content.source as CanvasImageSource, 0, 0, width, height);
  context.globalAlpha = 0.5;
  context.fillStyle = '#fbfaf6';
  context.fillRect(0, 0, width, height);
  context.globalAlpha = 1;

  return { source: canvas, width, height, url: '' };
}

/** The early `image` frame (+ the early questions) as a result the draft can land before verification. */
export function provisionalResult(picture: RemakePartialPicture, questions: RemakePartialQuestions | null): RemakeImageResult {
  return {
    src: picture.src,
    width: picture.width,
    height: picture.height,
    newQuestions: questions?.newQuestions ?? [],
    // Verification has not run yet: the final `result` frame replaces this (see the 'final' action).
    verification: { ok: true, mismatches: [] },
    ...(questions?.layout ? { layout: questions.layout } : {}),
  };
}

/**
 * «Similar copy» as a draft page: owns the stream, the placeholder page's life, and what the dissolve
 * overlay shows. The stream outlives the panel and keeps going while the teacher works elsewhere.
 */
export function useRemakeDraft({
  service,
  bridge,
  currentPageId,
  snapshotOriginal,
  notify,
  placeOverlay,
}: {
  service: BoardAiService;
  bridge: RemakeDraftBridge;
  currentPageId: string | null;
  /** The current page, uncropped, at full detail. */
  snapshotOriginal: () => Promise<{ blob: Blob; canvas: HTMLCanvasElement } | null>;
  notify: (text: string) => void;
  /** Overlay mode (`result.layout`): writes the questions on the text-free page. Absent = picture only. */
  placeOverlay?: PlaceOverlay;
}) {
  const { t } = useWbStrings();
  const [draft, dispatch] = useReducer(remakeDraftReducer, null);
  const { state, run, cancel } = useAiRun();
  const sourceRef = useRef<Source | null>(null);
  const [next, setNext] = useState<DraftPicture | null>(null);
  const [busy, setBusy] = useState(false);
  const draftRef = useRef(draft);
  const currentRef = useRef(currentPageId);
  const startingRef = useRef(false);
  /** An overlay result that landed while the teacher was on another page: written when they open it. */
  const pendingOverlayRef = useRef<{ pageId: string; run: number; result: RemakeImageResult } | null>(null);
  /** The run whose picture is being (or has been) landed — an early `image` frame lands before `result`. */
  const landingRef = useRef<number | null>(null);
  /** The final `result` that arrived while its run's early picture was still landing. */
  const finalRef = useRef<{ run: number; result: RemakeImageResult } | null>(null);
  /** The latest streamed `questions` frame, per run — the text when the picture came FIRST. */
  const questionsRef = useRef<{ run: number; questions: RemakePartialQuestions } | null>(null);
  /** The run whose real overlay text is on the page (or owed to it) — never written twice. */
  const textPlacedRef = useRef<number | null>(null);

  draftRef.current = draft;
  currentRef.current = currentPageId;

  const onPage = Boolean(draft && currentPageId === draft.pageId);

  const go = useCallback(
    (request: RemakeDraftRequest, source: Source) => {
      if (!service.remakePageImage) return;

      void run(
        (signal) => service.remakePageImage!({ image: source.image, imageSize: source.imageSize, ...request }, signal),
        { expect: 'image' },
      );
    },
    [run, service],
  );

  const end = useCallback(
    async (outcome: 'keep' | 'discard' | 'cancel' | 'error' | 'no-changes', message?: string) => {
      const current = draftRef.current;

      if (!current) return;

      const effect = endEffect(outcome);

      dispatch({ type: 'end' });
      pendingOverlayRef.current = null;
      setNext((picture) => {
        if (picture) URL.revokeObjectURL(picture.url);

        return null;
      });

      if (effect.removePage) {
        await bridge.removeDraftPage(current.pageId, effect.returnToOriginal ? current.originalPageId : null);
      } else {
        bridge.keepDraftPage(current.pageId);
      }

      sourceRef.current = null;

      if (message) notify(message);
    },
    [bridge, notify],
  );

  const start = useCallback(
    async (request: RemakeDraftRequest): Promise<boolean> => {
      if (!service.remakePageImage || startingRef.current) return false;

      if (draftRef.current) {
        notify(t('ai.remake.busy'));

        return false;
      }

      startingRef.current = true;

      try {
        const originalPageId = bridge.getPageId();
        const original = await snapshotOriginal();

        if (!original) return false;

        const content = canvasPicture(makeSoftSnapshot(original.canvas, original.canvas.width, original.canvas.height));
        const pageId = await bridge.insertDraftPageAfterCurrent();

        if (!pageId) return false;

        const source: Source = { image: original.blob, imageSize: { width: original.canvas.width, height: original.canvas.height }, content };

        sourceRef.current = source;
        landingRef.current = null;
        finalRef.current = null;
        questionsRef.current = null;
        textPlacedRef.current = null;
        dispatch({ type: 'start', pageId, originalPageId, request, now: Date.now() });
        go(request, source);

        return true;
      } finally {
        startingRef.current = false;
      }
    },
    [bridge, go, notify, service, snapshotOriginal],
  );

  // Status lines → stages.
  useEffect(() => {
    const current = draftRef.current;

    if (current && state.status === 'running') dispatch({ type: 'status', run: current.run, line: state.statusLine, now: Date.now() });
  }, [state.statusLine, state.status]);

  // Streamed `questions` (optional): the new text, over the blurred original, while the page is cleaned.
  useEffect(() => {
    const questions = state.remakeQuestions;
    const current = draftRef.current;
    const source = sourceRef.current;

    if (!questions || !current) return;

    questionsRef.current = { run: current.run, questions };

    // The picture came first (BE #564 often sends `image` before `questions`): write the text on the
    // landed page now. Still landing → `landResult` picks the text up from `questionsRef`.
    if (landingRef.current === current.run) {
      if (current.phase !== 'generating' && placeOverlay && hasOverlayText(questions) && textPlacedRef.current !== current.run) {
        const result = { ...(current.result ?? provisionalResult({ src: '', width: 0, height: 0 }, questions)), ...questions };

        textPlacedRef.current = current.run;

        if (currentRef.current === current.pageId) void placeOverlay({ pageId: current.pageId, result, request: current.request, picture: null });
        else pendingOverlayRef.current = { pageId: current.pageId, run: current.run, result };
      }

      return;
    }

    if (current.phase !== 'generating' || current.questionsReady) return;

    dispatch({ type: 'questions', run: current.run, now: Date.now() });

    if (!placeOverlay || !source || !hasOverlayText(questions)) return;

    const base = previewBase(source.content, source.imageSize);

    if (!base) return;

    void placeOverlay({ pageId: current.pageId, result: questions, request: current.request, picture: base, preview: true }).then((preview) => {
      const now = draftRef.current;

      // Too late (the picture already landed, or another run): the real page wins.
      if (!preview || !now || now.run !== current.run || now.phase !== 'generating' || landingRef.current === current.run) return;

      setNext((picture) => {
        if (picture?.url.startsWith('blob:')) URL.revokeObjectURL(picture.url);

        return preview;
      });
    });
  }, [placeOverlay, state.remakeQuestions]);

  /**
   * The final `result` after an early picture landed: verification for the review card — and, when the
   * early frames carried no text but the result does, the text written now.
   */
  const applyFinal = useCallback(
    (landed: RemakeDraft, result: RemakeImageResult) => {
      dispatch({ type: 'final', run: landed.run, result });

      if (!placeOverlay || textPlacedRef.current === landed.run || !hasOverlayText(result)) return;

      textPlacedRef.current = landed.run;

      if (currentRef.current === landed.pageId) void placeOverlay({ pageId: landed.pageId, result, request: landed.request, picture: null });
      else pendingOverlayRef.current = { pageId: landed.pageId, run: landed.run, result };
    },
    [placeOverlay],
  );

  const landResult = useCallback(
    async (result: RemakeImageResult) => {
      const current = draftRef.current;

      if (!current || current.phase !== 'generating' || landingRef.current === current.run) return;

      landingRef.current = current.run;

      if (result.noChanges || !result.src) {
        await end('no-changes', result.noChanges ? t('ai.remake.noErrors') : t('ai.remake.makeFailed'));

        return;
      }

      let blob: Blob | null = null;

      try {
        blob = await (await fetch(result.src)).blob();
      } catch {
        blob = null;
      }

      // The teacher deleted the draft page by hand meanwhile: nothing to land on.
      if (!bridge.hasPage(current.pageId)) {
        dispatch({ type: 'end' });

        return;
      }

      if (!blob || blob.size === 0) {
        await end('error', t('ai.remake.fetchFailed'));

        return;
      }

      const type = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png';
      const file = new File([blob], `remade-page.${type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png'}`, { type });
      const picture = await loadPicture(blob);

      // Downloaded NOW and stored in the page (an image page keeps its picture locally), so the draft
      // works offline and outlives the URL. Locked background, like a PDF page.
      if (!(await bridge.setDraftPageImage(current.pageId, file))) {
        if (picture) URL.revokeObjectURL(picture.url);
        await end('error', t('ai.remake.placeFailed'));

        return;
      }

      if (draftRef.current?.run !== current.run) return;

      let shown = picture;
      // The text: in this result, or in a `questions` frame that came while the picture was landing.
      const streamed = questionsRef.current?.run === current.run ? questionsRef.current.questions : null;
      const withText = hasOverlayText(result) ? result : streamed && hasOverlayText(streamed) ? { ...result, ...streamed } : null;

      // Overlay mode: the picture has no question text — the board writes it, in Plex + KaTeX.
      if (withText && placeOverlay && textPlacedRef.current !== current.run) {
        textPlacedRef.current = current.run;

        if (currentRef.current === current.pageId) {
          const composed = await placeOverlay({ pageId: current.pageId, result: withText, request: current.request, picture });

          if (composed) {
            if (picture) URL.revokeObjectURL(picture.url);
            shown = composed;
          }
        } else {
          pendingOverlayRef.current = { pageId: current.pageId, run: current.run, result: withText };
        }

        if (draftRef.current?.run !== current.run) return;
      }

      setNext((previous) => {
        if (previous && previous !== shown && previous.url.startsWith('blob:')) URL.revokeObjectURL(previous.url);

        return shown;
      });
      dispatch({ type: 'result', run: current.run, result, onPage: currentRef.current === current.pageId });

      // The final `result` (verification) came in while an early picture was landing.
      const final = finalRef.current;

      if (final && final.run === current.run) {
        finalRef.current = null;
        applyFinal({ ...current, result }, final.result);
      }
    },
    [applyFinal, bridge, end, placeOverlay],
  );

  // An overlay page that finished off-screen gets its text when the teacher arrives on it.
  useEffect(() => {
    const pending = pendingOverlayRef.current;

    if (!draft || !onPage || !pending || pending.pageId !== draft.pageId || pending.run !== draft.run || !placeOverlay) return;

    pendingOverlayRef.current = null;
    void placeOverlay({ pageId: pending.pageId, result: pending.result, request: draft.request, picture: null });
  }, [draft, onPage, placeOverlay]);

  // Streamed `image` (optional): land the picture now; verification follows in `result`.
  useEffect(() => {
    const picture = state.remakePicture;
    const current = draftRef.current;

    if (!picture || !current || current.phase !== 'generating') return;

    void landResult(provisionalResult(picture, state.remakeQuestions));
    // Once per picture frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.remakePicture]);

  // The stream finished, failed, or ended without a picture.
  useEffect(() => {
    const current = draftRef.current;

    if (!current) return;

    // An early picture already landed (or is landing): the final frame only brings verification, and
    // a late stream error cannot take away a page that already exists.
    if (landingRef.current === current.run) {
      if (state.status === 'done' && state.remakeImage && state.remakePicture) {
        if (current.phase === 'generating') finalRef.current = { run: current.run, result: state.remakeImage };
        else applyFinal(current, state.remakeImage);
      }

      return;
    }

    if (current.phase !== 'generating') return;

    if (state.status === 'done') {
      if (state.remakeImage) void landResult(state.remakeImage);
      else void end('error', t('ai.remake.makeFailed'));
    } else if (state.status === 'error') {
      void end('error', state.error ?? t('ai.genericError'));
    }
    // Once per stream outcome.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  // Leaving the page mid-reveal: the reveal is over; arriving on a ready page: the toast is not owed.
  useEffect(() => {
    if (!draft) return;

    if (draft.phase === 'revealing' && !onPage) dispatch({ type: 'revealed' });
    if (draft.readyElsewhere && onPage) dispatch({ type: 'opened' });
  }, [draft, onPage]);

  const cancelDraft = useCallback(() => {
    cancel();
    void end('cancel');
  }, [cancel, end]);

  const keep = useCallback(async () => {
    setBusy(true);

    try {
      await end('keep', t('ai.remake.kept'));
    } finally {
      setBusy(false);
    }
  }, [end]);

  const discard = useCallback(async () => {
    setBusy(true);

    try {
      await end('discard');
    } finally {
      setBusy(false);
    }
  }, [end]);

  const retry = useCallback(() => {
    const current = draftRef.current;
    const source = sourceRef.current;

    if (!current || !source) return;

    setNext((picture) => {
      if (picture) URL.revokeObjectURL(picture.url);

      return null;
    });
    pendingOverlayRef.current = null;
    landingRef.current = null;
    finalRef.current = null;
    questionsRef.current = null;
    textPlacedRef.current = null;
    dispatch({ type: 'retry', now: Date.now() });
    go(current.request, source);
  }, [go]);

  /** «Back to the original page»: the draft keeps generating; the «Ready» toast calls the teacher back. */
  const backToOriginal = useCallback(() => {
    const current = draftRef.current;

    if (!current?.originalPageId || !bridge.hasPage(current.originalPageId)) return;

    void bridge.switchToPageId(current.originalPageId);
  }, [bridge]);

  const open = useCallback(() => {
    const current = draftRef.current;

    if (!current) return;

    dispatch({ type: 'opened' });
    void bridge.switchToPageId(current.pageId);
  }, [bridge]);

  return {
    draft,
    onPage,
    statusLine: state.statusLine,
    content: sourceRef.current?.content ?? null,
    next,
    busy,
    start,
    cancel: cancelDraft,
    keep,
    discard,
    retry,
    open,
    backToOriginal,
    revealed: () => dispatch({ type: 'revealed' }),
    dismissToast: () => dispatch({ type: 'opened' }),
  };
}
