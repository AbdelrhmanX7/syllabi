// The board editor's AI service for Study notebooks — the same `BoardAiService` the whiteboard app
// builds (apps/whiteboard/lib/board-ai), on Study's credentials:
//
//   - Board tools (generate, page check, concept maps, classify, picture, image remake) call the
//     backend's EXISTING `/whiteboard/ai/*` routes directly (lib/whiteboardAi.ts — a port of the
//     whiteboard app's teacher transport), `Authorization: Bearer <study admin JWT>`, `lang: 'en'`.
//     They are not under `/study`, so they bypass the study transport.
//   - A lasso «ask» is a tutor question with the picture as context: `/study/ai/ask` (BE #577 —
//     class-scoped retrieval, streamed into the editor's own panel), carrying what the board sits
//     beside: the page, plus the item / video moment / lecture the mount passes in `context`.
//   - «Explain on my page» (pen + pointer actions) is `POST /study/ai/board-actions` (multipart,
//     lib/boardActions.ts) — until the backend ships it the route is NOT in `LIVE_ROUTES`, so the
//     canned plan in mock.ts (`/board-ai/board-actions`) answers; a live 404 reads «not available yet».
//   - Force-mock mode (Settings) keeps everything on the mock (`/board-ai/*` + `/ai/ask` in mock.ts).
import type { BoardResultKind } from './lib/boardFrames';
import type { AskRequest, TutorContext } from './types';
import type {
  BoardAiAnalyzeRequest,
  BoardAiAskRequest,
  BoardAiCapabilities,
  BoardAiGenerateRequest,
  BoardAiService,
  BoardAiStreamEvent,
  ConceptMapAnalyzeRequest,
  ConceptMapGenerateRequest,
  PenPlanRequest,
  PenPlanResult,
  RemakePageRequest,
  TermsMapRequest,
} from '@repo/whiteboard-react';

import { useMemo, useRef } from 'react';

import { boardActionsJson, postBoardActions } from './lib/boardActions';
import { conceptStyleWire, toBoardAiEvent } from './lib/boardFrames';
import { blobToB64, downscaleBlob } from './lib/image';
import { boardAskQuestion, withAnswerToneHint } from './lib/prompts';
import { sseIterable } from './lib/sseIterable';
import { BoardAiHttpError, createWhiteboardAi, FALLBACK } from './lib/whiteboardAi';
import { liveAskBody } from './lib/wire';

import { getHandwritingBank, putHandwritingBank } from '@/features/handwriting/api';
import { isMockRoute } from '@/lib/api/client';
import { studyPost, studySse } from '@/lib/api/http';
import { isValidAdminToken, readSessionToken } from '@/lib/auth';
import { getBackendSettingsSnapshot, getStudyBackendBaseUrl } from '@/lib/backend-settings';
import { useAiEnabled } from '@/hooks/useAiEnabled';

export interface StudyBoardAiOptions {
  /** The notebook page the board shows — `boardId` for the whiteboard routes, retrieval context for the tutor. */
  pageId?: string | null;
  /** The page's class — scopes the tutor's retrieval to that class's items, transcripts and notes. */
  classId?: string | null;
  /**
   * What else the board is about, read at ask time: the PDF item it annotates (`itemId`), the video
   * moment beside it (`videoAt`), the lecture being recorded (`lectureId`).
   */
  context?: () => Omit<TutorContext, 'imagePngB64' | 'pageId'>;
}

/** Pictures above this go through a JPEG downscale first (the backend caps the body at ~4 MB). */
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

export const STUDY_BOARD_AI_LABEL = 'Study tutor';

const SAMPLE_ONLY = 'Not available in sample mode.';

/** Settings → force-mock: the whole board AI answers from the mock. */
export const isForceMock = () => getBackendSettingsSnapshot().mockMode === 'mock';

/** The Study session as whiteboard-route credentials; null when signed out / expired. */
export function resolveStudyAccess(): { baseUrl: string; headers: Record<string, string> } | null {
  const token = readSessionToken();

  if (!token || !isValidAdminToken(token)) return null;

  return { baseUrl: getStudyBackendBaseUrl(), headers: { Authorization: `Bearer ${token}` } };
}

async function pictureB64(image: Blob): Promise<string> {
  const source = image.size > MAX_IMAGE_BYTES ? ((await downscaleBlob(image)) ?? image) : image;

  return blobToB64(source);
}

export function createStudyBoardAi({ pageId, classId, context }: StudyBoardAiOptions = {}): BoardAiService {
  const live = createWhiteboardAi({
    resolveAccess: resolveStudyAccess,
    downscale: downscaleBlob,
    boardContext: () => (pageId ? { boardId: pageId } : {}),
  });
  const scope = () => ({
    ...(classId ? { classId } : {}),
    ...(pageId ? { pageId } : {}),
  });

  /** One STUDY SSE route (mock, or the live tutor) → the editor's frame stream. */
  async function* studyStream(
    path: string,
    body: unknown,
    kind: BoardResultKind,
    signal: AbortSignal,
  ): AsyncGenerator<BoardAiStreamEvent> {
    let ended = false;

    for await (const frame of sseIterable((onFrame, s) => studySse(path, body, onFrame, s), signal)) {
      const event = toBoardAiEvent(frame, kind);

      if (!event) continue;
      yield event;
      if (event.type === 'done' || event.type === 'error') {
        ended = true;

        return;
      }
    }

    if (!ended && !signal.aborted) yield { type: 'done' };
  }

  return {
    label: STUDY_BOARD_AI_LABEL,
    ask: async function* (request: BoardAiAskRequest, signal: AbortSignal) {
      const imagePngB64 = await pictureB64(request.image);
      const body: AskRequest = {
        ...(classId ? { classId } : {}),
        mode: 'explain',
        context: { ...context?.(), imagePngB64, ...(pageId ? { pageId } : {}) },
        question: withAnswerToneHint(boardAskQuestion(request.action, request.prompt)),
      };

      // Through askTutor's wire rules (non-ObjectId ids dropped on the live route).
      yield* studyStream('/ai/ask', isForceMock() ? body : liveAskBody(body), 'blocks', signal);
    },
    generate: async function* (request: BoardAiGenerateRequest, signal: AbortSignal) {
      if (!isForceMock()) {
        yield* live.generate(request, signal);

        return;
      }
      yield* studyStream(
        '/board-ai/generate',
        { ...scope(), prompt: request.prompt, kind: request.kind },
        'blocks',
        signal,
      );
    },
    analyzePage: async function* (request: BoardAiAnalyzeRequest, signal: AbortSignal) {
      if (!isForceMock()) {
        yield* live.analyzePage(request, signal);

        return;
      }
      yield* studyStream(
        '/board-ai/analyze-page',
        { ...scope(), imagePngB64: await pictureB64(request.image) },
        'analysis',
        signal,
      );
    },
    analyzeConceptMap: async function* (request: ConceptMapAnalyzeRequest, signal: AbortSignal) {
      if (!isForceMock()) {
        yield* live.analyzeConceptMap(request, signal);

        return;
      }
      yield* studyStream(
        '/board-ai/concept-map/analyze',
        { ...scope(), imagePngB64: await pictureB64(request.image) },
        'concept',
        signal,
      );
    },
    generateConceptMap: async function* (request: ConceptMapGenerateRequest, signal: AbortSignal) {
      if (!isForceMock()) {
        yield* live.generateConceptMap(request, signal);

        return;
      }
      yield* studyStream(
        '/board-ai/concept-map/generate',
        { ...scope(), topic: request.topic, style: conceptStyleWire(request.style) },
        'conceptGenerate',
        signal,
      );
    },
    remakePage: async function* (request: RemakePageRequest, signal: AbortSignal) {
      if (!isForceMock()) {
        yield* live.remakePage(request, signal);

        return;
      }
      yield* studyStream('/board-ai/remake-page', { ...scope(), mode: request.mode }, 'layout', signal);
    },
    // «Map my terms»: picture + the client's ink clusters → structure only (the board draws it).
    // Live: the Study route `/study/ai/concept-map/from-terms`; force-mock: `/board-ai/...`.
    mapTerms: async function* (request: TermsMapRequest, signal: AbortSignal) {
      const body = {
        ...scope(),
        imagePngB64: await pictureB64(request.image),
        imageSize: request.imageSize,
        clusters: request.clusters,
        ...(request.hint ? { hint: request.hint } : {}),
        lang: 'en',
      };

      yield* studyStream(
        isForceMock() ? '/board-ai/concept-map/from-terms' : '/ai/concept-map/from-terms',
        body,
        'termsMap',
        signal,
      );
    },
    // «Explain on my page»: the page JPEG + ink clusters + question → a one-shot plan the board
    // executes. Mock (hybrid until the backend lands the route, or forced): the canned plan; live:
    // multipart to /study/ai/board-actions, a 404 surfacing as «not available yet».
    penPlan: async (request: PenPlanRequest, signal: AbortSignal): Promise<PenPlanResult> => {
      const json = boardActionsJson(request);

      if (isMockRoute('/ai/board-actions', 'POST')) {
        return (await studyPost<unknown>('/board-ai/board-actions', { ...scope(), ...json })) as PenPlanResult;
      }

      const access = resolveStudyAccess();

      if (!access) throw new BoardAiHttpError(401, FALLBACK.signedOut);

      const image = request.image.size > MAX_IMAGE_BYTES ? ((await downscaleBlob(request.image)) ?? request.image) : request.image;

      return postBoardActions(access, image, json, signal, fetch, request.questionImage ?? null);
    },
    remakePageImage: async function* (request: RemakePageRequest, signal: AbortSignal) {
      if (isForceMock()) throw new Error(SAMPLE_ONLY);
      yield* live.remakePageImage(request, signal);
    },
    classify: (image, signal, context) =>
      isForceMock() ? Promise.resolve(null) : live.classify(image, signal, context),
    generateImage: async function* (request, signal) {
      if (isForceMock()) throw new Error(SAMPLE_ONLY);
      yield* live.generateImage(request, signal);
    },
    // The whiteboard routes exist on the server; the mock has none of the optional ones.
    capabilities: (): BoardAiCapabilities =>
      isForceMock()
        ? { classify: false, generateImage: false, remakeImage: false }
        : { classify: true, generateImage: true, remakeImage: true },
    getCatalog: () => Promise.resolve(null),
    // My handwriting: the owner's glyph bank, through the Study transport (mock / live by the route table).
    getGlyphBank: () => getHandwritingBank(),
    putGlyphBank: (bank, version) => putHandwritingBank(bank, version),
  };
}

/**
 * The service for one notebook page. Pass it to `WhiteboardEditor`'s `boardAi` prop (via
 * `NotebookBoard` / lectures `NotebookPage`); a new page or class builds a new service.
 * Undefined for an account without AI: the board then shows none of its AI buttons.
 */
export function useStudyBoardAi(
  pageId?: string | null,
  classId?: string | null,
  context?: StudyBoardAiOptions['context'],
): BoardAiService | undefined {
  const aiOn = useAiEnabled();
  // Read at ask time through a ref, so a fresh closure each render (a video's moving second) does not
  // rebuild the service.
  const contextRef = useRef(context);

  contextRef.current = context;

  const service = useMemo(
    () => createStudyBoardAi({ pageId, classId, context: () => contextRef.current?.() ?? {} }),
    [pageId, classId],
  );

  return aiOn ? service : undefined;
}

export { FALLBACK as BOARD_AI_FALLBACK };
