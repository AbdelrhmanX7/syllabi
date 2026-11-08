import { Types } from "mongoose";
import { StudyTranscript } from "@/models/study/transcript";

/**
 * Search's `transcripts` bucket: `[{itemId|lectureId, start, text}]` — the matching SEGMENTS
 * (so the FE can seek to `start`), newest transcript first, segment order within one, `limit`
 * in total. `rx` is the caller's already-escaped `{ $regex, $options }`.
 */
export async function searchTranscripts(userId: Types.ObjectId, rx: { $regex: string; $options: string }, limit = 20) {
  const rows = await StudyTranscript.aggregate([
    { $match: { userId, "segments.text": rx } },
    { $sort: { updatedAt: -1, _id: 1 } },
    { $limit: limit },
    { $project: { itemId: 1, lectureId: 1, segments: 1 } },
    { $unwind: { path: "$segments", includeArrayIndex: "i" } },
    { $match: { "segments.text": rx } },
    { $limit: limit },
  ]);
  return rows.map((r: any) => ({
    itemId: r.itemId ? String(r.itemId) : null,
    lectureId: r.lectureId ? String(r.lectureId) : null,
    start: r.segments.start,
    text: r.segments.text,
  }));
}
