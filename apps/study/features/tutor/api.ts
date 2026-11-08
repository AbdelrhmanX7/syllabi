// `/ai/ask` + `/ai/conversations` — thin wrappers over the shared study transport. Live since BE #577
// (`LIVE_ROUTES` in lib/api/client.ts); force-mock answers them from ./mock.ts.
import type { AskRequest, TutorConversation, TutorConversationDetail } from './types';
import type { SseFrame } from '@/lib/api/http';

import { liveAskBody } from './lib/wire';

import { isMockRoute } from '@/lib/api/client';
import { studyGet, studySse } from '@/lib/api/http';

const enc = encodeURIComponent;

/**
 * SSE: `meta {conversationId}` → `delta {text}`… → `sources {sources:[…]}` → `done {quiz?}`. Fold the
 * frames with `reduceAskFrame` (lib/stream.ts); the promise resolves after `done`, rejects on `error`
 * and on the JSON 400/404 the backend answers before the stream opens.
 */
export const askTutor = (body: AskRequest, onFrame: (frame: SseFrame) => void, signal?: AbortSignal) =>
  studySse('/ai/ask', isMockRoute('/ai/ask', 'POST') ? body : liveAskBody(body), onFrame, signal);

export const listConversations = (classId?: string | null) =>
  studyGet<TutorConversation[]>(`/ai/conversations${classId ? `?classId=${enc(classId)}` : ''}`);

export const getConversation = (id: string) => studyGet<TutorConversationDetail>(`/ai/conversations/${enc(id)}`);
