import { randomUUID } from "crypto";
import { Types } from "mongoose";
import { IStudyInboxItem, StudyInboxItem } from "@/models/study/inbox";
import { publicUrlFor } from "@/compat/s3";
import { getStudyObject, putStudyObject } from "./storage";

/**
 * A question's `imageUrl` is a plain url the quiz screen puts in an <img>, so it must not expire
 * (a signed url dies in an hour). The picture is COPIED out of the owner's inbox — which the owner
 * may clear — to its own key and served by its public url, like the other long-lived study images.
 */
export class QuestionImageError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** `study/<userId>/question-images/<uuid>.<ext>` — a fresh uuid per copy, never overwritten. */
export const questionImageKey = (userId: string, ext: string) => `study/${userId}/question-images/${randomUUID()}.${ext}`;

export async function copyInboxImageToQuestion(userId: Types.ObjectId, inboxId: string): Promise<string> {
  const item = await StudyInboxItem.findOne({ _id: inboxId, userId, deletedAt: null }, { key: 1, kind: 1, contentType: 1 }).lean<IStudyInboxItem>();
  if (!item) throw new QuestionImageError("NOT_FOUND", "Inbox item not found (use the id from list_inbox / the upload result)");
  if (item.kind !== "image") throw new QuestionImageError("NOT_AN_IMAGE", "That inbox item is not an image");
  const ext = /\.([a-z0-9]+)$/i.exec(item.key)?.[1]?.toLowerCase() ?? "jpg";
  const key = questionImageKey(String(userId), ext);
  await putStudyObject(key, await getStudyObject(item.key), item.contentType);
  return publicUrlFor(key);
}
