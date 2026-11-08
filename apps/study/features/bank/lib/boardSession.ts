// The open board exam, kept on the device so it survives an app restart (the board itself syncs as a
// `solve` notebook page). Light on purpose: the bank home reads it without loading the board engine.
import type { Question } from '@/lib/api/types';

const STORE_KEY = 'study.boardExam.v1';

export interface BoardSession {
  pageId: string;
  title: string;
  classId: string | null;
  startedAt: number;
  questions: Question[];
}

export function readBoardSession(): BoardSession | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);

    return raw ? (JSON.parse(raw) as BoardSession) : null;
  } catch {
    return null;
  }
}

export function writeBoardSession(session: BoardSession | null) {
  try {
    if (session) localStorage.setItem(STORE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Storage full / blocked: the session just will not resume after a restart.
  }
}
