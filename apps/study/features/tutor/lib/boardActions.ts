import type { PenPlanRequest, PenPlanResult } from '@repo/whiteboard-react';

import { BoardAiHttpError, FALLBACK, quotaMessage } from './whiteboardAi';

import { AI_QUOTA_CODE, AI_QUOTA_MESSAGE, SERVER_RESTARTING_CODE, SERVER_RESTARTING_MESSAGE } from '@/lib/api/errors';

/**
 * «Explain on my page» transport — `POST /study/ai/board-actions` (requested on the Study thread;
 * contract in the handoff): multipart `image` (JPEG of the visible page, ≤ 1600 px) + `json` =
 * `{question, lang, clusters: [{id, box}]}` with boxes 0..1 of the page → `200 {actions, say?}`.
 * `400 {message}` on bad input, `429` on quota. Until the backend ships it the route answers 404,
 * which is surfaced as a calm «not available yet» (`code: 'NOT_AVAILABLE'`), never as a failure.
 */

/** The error code the board reads as «the server has no such tool yet». */
export const NOT_AVAILABLE_CODE = 'NOT_AVAILABLE';

export const PEN_UNAVAILABLE_MESSAGE = 'Explaining on the page is not available yet — coming soon.';

export interface BoardActionsJson {
  question: string;
  /** Always 'en': Syllabi is English only. */
  lang: 'en';
  clusters: Array<{ id: string; box: { x: number; y: number; w: number; h: number } }>;
  /** The contract version the caller draws (2 = verdict marks + notes placed by the app). */
  v?: 2;
}

/** The `json` multipart field: the editor's clusters (`bbox`) become the contract's `box`; `lang` is always English. */
export function boardActionsJson(request: Pick<PenPlanRequest, 'question' | 'lang' | 'clusters' | 'v'>): BoardActionsJson {
  return {
    question: (request.question ?? '').trim(),
    lang: 'en',
    clusters: request.clusters.map((cluster) => ({ id: cluster.id, box: { ...cluster.bbox } })),
    ...(request.v === 2 ? { v: 2 as const } : {}),
  };
}

export interface BoardActionsAccess {
  /** The Study backend origin (no `/study`, no trailing slash). */
  baseUrl: string;
  headers: Record<string, string>;
}

const UNAVAILABLE = new Set([404, 405, 501]);

export async function postBoardActions(
  access: BoardActionsAccess,
  image: Blob,
  json: BoardActionsJson,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<PenPlanResult> {
  const form = new FormData();

  form.append('image', image, image.type === 'image/png' ? 'page.png' : 'page.jpg');
  form.append('json', JSON.stringify(json));

  const url = `${access.baseUrl.replace(/\/+$/, '').replace(/\/study$/, '')}/study/ai/board-actions`;
  let response: Response;

  try {
    response = await fetchImpl(url, { method: 'POST', headers: { ...access.headers, Accept: 'application/json' }, body: form, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new BoardAiHttpError(0, FALLBACK.network);
  }

  if (UNAVAILABLE.has(response.status)) throw new BoardAiHttpError(response.status, PEN_UNAVAILABLE_MESSAGE, NOT_AVAILABLE_CODE);
  if (response.status === 401) throw new BoardAiHttpError(401, FALLBACK.sessionExpired);
  if (response.status === 403) throw new BoardAiHttpError(403, FALLBACK.signedOut);

  if (!response.ok) {
    let parsed: { message?: unknown; code?: unknown; retryAfterSec?: unknown } = {};

    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      /* not JSON */
    }

    if (parsed.code === SERVER_RESTARTING_CODE) throw new BoardAiHttpError(response.status, SERVER_RESTARTING_MESSAGE, SERVER_RESTARTING_CODE);
    if (response.status === 402 || parsed.code === AI_QUOTA_CODE) throw new BoardAiHttpError(response.status, AI_QUOTA_MESSAGE, AI_QUOTA_CODE);

    if (response.status === 429) {
      const retryAfter = Number(parsed.retryAfterSec ?? response.headers.get('Retry-After'));

      throw new BoardAiHttpError(429, quotaMessage(Number.isFinite(retryAfter) ? retryAfter : null));
    }

    throw new BoardAiHttpError(
      response.status,
      typeof parsed.message === 'string' && parsed.message.trim() ? parsed.message.trim() : FALLBACK.server,
      typeof parsed.code === 'string' ? parsed.code : undefined,
    );
  }

  const body = (await response.json().catch(() => null)) as unknown;

  if (!body || typeof body !== 'object') throw new BoardAiHttpError(response.status, FALLBACK.server);

  // The editor validates the actions themselves (`parsePenPlan`); this is only the envelope.
  return body as PenPlanResult;
}
