// Lecture notes: «New lecture note» (class page), «Class today» (Today), notes shown by week (class
// modules, library, concept map cards) and «Attach to lecture…» (notebook header).
import type { WhiteboardDocument } from '@repo/whiteboard-core';

import { createBlankWhiteboardDocument } from '@repo/whiteboard-core';

export { LectureNoteSheet } from './components/LectureNoteSheet';
export { AttachToLectureButton, MapLectureNotes, WeekNotes } from './components/NoteLinks';
export { recordHref, TodayLectures } from './components/TodayLectures';
export { attachPageToLecture, usePageLecture } from './hooks';
export type { LectureRef } from './lib/lectures';
export { readLectureNoteMeta, readLectureNoteMeta as pageLecture, useLectureNoteMetas } from './store';

/** The first document of a lecture note: lined paper (the Settings spacing is applied by the opener). */
export function lectureNoteSeed(pageId: string, title: string): () => Promise<WhiteboardDocument | null> {
  return async () => createBlankWhiteboardDocument({ id: pageId, title, backgroundType: 'lined' });
}
