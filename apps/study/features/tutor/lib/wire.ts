// What the live `/ai/ask` accepts. The backend 400s («classId must be an id») on any id that is not a
// Mongo ObjectId, before the stream opens — a mock/fixture id (sample class, local page) must not
// cost the student the whole question, so such ids are dropped and the backend retrieves without them.
import type { AskRequest, TutorContext } from '../types';

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

export const isObjectId = (value: unknown): value is string => typeof value === 'string' && OBJECT_ID.test(value);

export function liveContext(context: TutorContext): TutorContext {
  const { itemId, pageId, lectureId, videoAt, ...rest } = context;
  const t = Number(videoAt?.t);

  return {
    ...rest,
    ...(isObjectId(itemId) ? { itemId } : {}),
    ...(isObjectId(pageId) ? { pageId } : {}),
    ...(isObjectId(lectureId) ? { lectureId } : {}),
    ...(videoAt && isObjectId(videoAt.itemId) && Number.isFinite(t) && t >= 0
      ? { videoAt: { itemId: videoAt.itemId, t: Math.floor(t) } }
      : {}),
  };
}

export function liveAskBody({ classId, conversationId, context, ...rest }: AskRequest): AskRequest {
  const wired = context ? liveContext(context) : null;

  return {
    ...rest,
    ...(isObjectId(classId) ? { classId } : {}),
    ...(isObjectId(conversationId) ? { conversationId } : {}),
    ...(wired && Object.keys(wired).length ? { context: wired } : {}),
  };
}
