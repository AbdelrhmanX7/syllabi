// Mirrors docs/study-app/CONTRACT.md — keep the two in lockstep.

export type ItemType = 'file' | 'page' | 'assignment' | 'quiz' | 'video' | 'link' | 'announcement';
export type SubmissionState = 'unsubmitted' | 'submitted' | 'graded' | 'missing' | 'late';

/**
 * `code` values the backend sends in `{ message, code }` error bodies (and in `CanvasStatus.lastError`).
 * Auth failures are different: a 401 is PLAIN TEXT ("jwt must be provided") and a confined-role 403 is
 * `{ message }` without a code — branch on the HTTP status for those.
 */
export type StudyErrorCode =
  | 'CANVAS_URL_INVALID'
  | 'CANVAS_TOKEN_INVALID'
  | 'INVALID_ID'
  | 'NOT_FOUND'
  | 'TOKEN_EXPIRING'
  | (string & {});

export interface CanvasStatus {
  connected: boolean;
  baseUrl: string | null;
  canvasUser: { id: number; name: string } | null;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
  syncing: boolean;
  lastError: { code: string; message: string } | null;
}

export interface StudyClass {
  id: string;
  /** null on a manual class. */
  canvasCourseId: number | null;
  /** 'manual' = made in the app (POST /classes), not mirrored from Canvas. Absent on an older backend = canvas. */
  source?: 'canvas' | 'manual';
  name: string;
  code: string;
  term: string;
  color: string;
  hidden?: boolean;
  grade: { score: number | null; letter: string | null; trend: -1 | 0 | 1 };
  counts: { due: number; overdue: number; unseen: number };
  /** P-CM: the latest real exam result + how many are recorded; absent when the class has none. */
  examResults?: ClassExamResultsSummary;
  /** When the class meets. Absent = an older backend; null = not known (not in the syllabus, not set). */
  meetings?: ClassMeetingTimes | null;
  /** Where `meetings` came from: his override, or the syllabus. */
  meetingsSource?: 'manual' | 'syllabus' | null;
}

/** `day` is 'Mon'…'Sun' (a 0–6 number from Sunday is read too); times are 24 h 'HH:MM'. */
export interface ClassMeetingSlot {
  day: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun' | number;
  start: string;
  /** null when the syllabus gives only a start time. */
  end: string | null;
}

export interface ClassMeetingTimes {
  slots: ClassMeetingSlot[];
  timeZone?: string | null;
}

export interface Item {
  id: string;
  classId: string;
  moduleId: string | null;
  type: ItemType;
  title: string;
  /** null for an item that did not come from Canvas (e.g. a PDF filed from the phone inbox). */
  canvasUrl: string | null;
  updatedAt: string;
  seenAt: string | null;
  /** The Canvas due date. Show and sort by `effectiveDueAt ?? dueAt` (lib/due.ts). */
  dueAt?: string | null;
  /** Due date after an announcement moved it (A plan, #576); the backend sends `dueAt` when nothing moved. */
  effectiveDueAt?: string | null;
  dueChangedBy?: { announcementItemId: string; postedAt: string | null; text: string } | null;
  points?: number | null;
  submission?: { state: SubmissionState; score: number | null };
  external?: { tool: string } | null;
  /** A `video` item embedded in a page: the page it came from (title "<page> — Video N"). */
  parentItemId?: string;
  /** `url` is a signed B2 link valid ~1 h — refetch the item when `expiresAt` has passed. */
  file?: { mime: string; size: number; version: number; url: string; expiresAt: string };
  video?: {
    provider: 'youtube';
    videoId: string;
    durationSec: number | null;
    transcriptStatus: 'none' | 'pending' | 'ready' | 'failed';
  };
  html?: string;
}

export interface ModuleNode {
  id: string;
  name: string;
  position: number;
  items: Item[];
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
  summary: string | null;
  keyPoints: string[];
}

export type TranscriptStatus = 'none' | 'pending' | 'ready' | 'failed';

/** `GET/PUT /videos/:itemId/transcript`. `source` says where the words came from. */
export interface VideoTranscript extends Transcript {
  itemId: string;
  transcriptStatus: TranscriptStatus;
  /** `captions` = YouTube's track (fetched on the tablet), `asr` = the backend's speech-to-text. */
  source: 'captions' | 'asr' | null;
  lang: string | null;
  durationSec: number | null;
  error: { code: string; message: string } | null;
  updatedAt: string;
}

/** Body of `PUT /videos/:itemId/transcript` — captions the device fetched from YouTube. */
export interface VideoTranscriptUpload {
  segments: TranscriptSegment[];
  source: 'captions';
  lang: string;
  durationSec?: number;
}

export interface WeakTopic {
  classId: string;
  topic: string;
  mastery: number;
}

export interface Today {
  due: Item[];
  overdue: Item[];
  unseen: Item[];
  announcements: Item[];
  review: { dueCount: number; newCount: number };
  weakTopics: WeakTopic[];
  classes: StudyClass[];
  /** P-CM: one row per class with a recorded exam result (its latest). */
  examResults?: TodayExamResult[];
}

export type PageKind = 'note' | 'pdf' | 'lecture' | 'solve';

/** The lecture a note page is for (`key` = 'L8', or 'W8' for a week with no lecture numbers). */
export interface PageLectureLink {
  number: number | null;
  key: string;
  /** `YYYY-MM-DD` the note was started (one note per meeting for a week entry). */
  date: string;
}

/** Notebook details (AI-made, owner-editable). Absent on a backend that has not shipped them. */
export type MathToolsMode = 'auto' | 'on' | 'off';
export type PageCoverColor = 'blue' | 'star' | 'green' | 'amber' | 'red' | 'slate';
export type MetaField = 'title' | 'description' | 'tags' | 'cover';
export type MetaEdited = Record<MetaField, boolean>;
export interface PageCover {
  kind: 'image' | 'color';
  color: PageCoverColor | null;
  /** Lucide icon name from the server's fixed list (lib/notebooks/cover-icons.tsx). */
  icon: string | null;
  by: 'ai' | 'user';
  updatedAt: string | null;
}

export interface Page {
  id: string;
  classId: string | null;
  itemId: string | null;
  lectureId: string | null;
  /** Lecture-note filing. Absent (not null) = a backend without the fields — the device keeps the link. */
  week?: number | null;
  moduleId?: string | null;
  lecture?: PageLectureLink | null;
  title: string;
  kind: PageKind;
  updatedAt: string;
  version: number;
  thumbUrl: string | null;
  /**
   * Typed body of a page Claude wrote through MCP `add_note_page` (board JSON stays empty until the
   * owner writes on it). The backend may name it either way; the shell reads both.
   */
  markdown?: string | null;
  text?: string | null;
  /** Someone the owner shared it with (Can edit) saved the current version. */
  editedBy?: { name: string; at: string | null } | null;
  /** Set when this is someone else's page shared with me to edit (sharing). */
  shared?: { role: 'editor'; ownerName: string } | null;
  /** Someone besides the owner may edit it: the board syncs live (changes in and out as they happen). */
  live?: boolean;
  description?: string | null;
  tags?: string[];
  cover?: PageCover | null;
  /** Signed link to the AI cover picture (expires hourly); null for a colour cover. */
  coverUrl?: string | null;
  mathTools?: MathToolsMode;
  /** Fields the owner edited: AI keeps away from them. */
  metaEdited?: MetaEdited;
  metaAiAt?: string | null;
  /** Content version AI last described; null = never. */
  metaAiVersion?: number | null;
  /** The class Library PDF this notebook writes on (one notebook per document). Absent on older backends. */
  libraryId?: string | null;
  /** Bookmarked board pages as of the last save, in page order. Absent on older backends. */
  bookmarks?: PageBookmarkRef[];
}

/** One bookmarked board page of a notebook (read from its board at each save). */
export interface PageBookmarkRef {
  /** The board page's own id (`&page=` on the notebook route opens it). */
  boardPageId: string;
  /** 0-based position when saved. */
  index: number;
  /** What the pager shows: «3», «3a». */
  pageLabel: string;
  /** The short name typed for it; null = none. */
  label: string | null;
  at: string;
}

/** `POST /pages/:id/describe`: the page as it is now, plus whether a cover picture is still being made. */
export type DescribedPage = Page & { coverPending?: boolean };

/** `GET /pages/:id/content`. Before the first commit `url` is null and `version` 0 — an empty page. */
export interface PageContentRef {
  url: string | null;
  version: number;
  /** When the signed `url` stops working. */
  expiresAt?: string | null;
}

export type QuestionSourceKind =
  | 'canvas_quiz'
  | 'derivita'
  | 'pdf'
  | 'slides'
  | 'video'
  | 'lecture'
  | 'photo'
  | 'manual'
  | 'ai_similar'
  | 'mock';

export type QuestionType = 'free' | 'mcq' | 'code_output' | 'code_write' | 'label_image' | 'matching' | 'fill_blank';
export type AttemptResult = 'right' | 'wrong' | 'partial';

export interface Question {
  id: string;
  classId: string;
  topic: string;
  subtopic: string | null;
  difficulty: 1 | 2 | 3 | 4 | 5;
  source: {
    kind: QuestionSourceKind;
    itemId: string | null;
    pageId: string | null;
    lectureId: string | null;
    ref: string | null;
  };
  type: QuestionType;
  /** Markdown with `$…$` / `$$…$$` LaTeX. */
  stem: string;
  imageUrl: string | null;
  choices?: string[];
  /** `matching` pairs (`[]` for other types). An open exam sends `right: null`; take options from `choices`. */
  pairs?: { left: string; right: string | null }[];
  answer: string;
  solutionSteps: string[];
  tags: string[];
  stats: { attempts: number; correct: number; lastResult: AttemptResult | null; mastery: number };
  srs: { dueAt: string; stability: number; difficulty: number; reps: number; lapses: number };
  createdAt: string;
  /** Someone the owner shared it with (Can edit) made the last change. */
  editedBy?: { name: string; at: string | null } | null;
  /** The owner's own: pinned under «Bookmarked» in Flashcards (never on a shared copy). */
  bookmarked?: boolean;
  /** The owner's handwritten note on the card (never on a shared copy). */
  note?: QuestionNote | null;
}

/**
 * Pen strokes written on a `w` × `h` CSS px pad. Each stroke: a colour token, a base width and a flat
 * `[x, y, pressure, …]` list. The server caps it at 64 KB.
 */
export interface QuestionNote {
  w: number;
  h: number;
  strokes: { c: 'ink' | 'blue' | 'red' | 'green'; w: number; pts: number[] }[];
}

export interface AttemptInput {
  inkPngB64?: string;
  typed?: string;
  choice?: number;
  code?: string;
  /** `matching` — left item → chosen right. */
  matches?: Record<string, string>;
  /** `fill_blank` — one entry per `___` in the stem, in order. */
  blanks?: string[];
  timeMs: number;
  reveal?: boolean;
  /** Flashcards: self-grade (1 Again, 2 Hard, 3 Good, 4 Easy); no grader runs. */
  selfRating?: 1 | 2 | 3 | 4;
}

export interface AttemptStep {
  line: number;
  latex: string;
  ok: boolean;
  note: string;
}

export interface AttemptVerdict {
  result: AttemptResult;
  steps: AttemptStep[];
  firstErrorStep: number | null;
  hint: string;
  solution: string | null;
}

export interface MasteryTopic {
  topic: string;
  mastery: number;
  attempts: number;
  dueCount: number;
}

/** One graded answer of a submitted exam (the `graded` SSE frame, kept on the exam). */
export interface ExamResult {
  questionId: string;
  result: AttemptResult;
  steps: AttemptStep[];
  firstErrorStep: number | null;
  hint: string | null;
  solution: string | null;
}

export interface Exam {
  id: string;
  classId: string;
  topics: string[];
  /** Questions requested at creation (`questions.length` once built). */
  count: number;
  questions: Question[];
  minutes: number;
  startedAt: string | null;
  submittedAt: string | null;
  /** Submitted after `startedAt + minutes`. */
  late: boolean;
  /** 0–100 once submitted. */
  score?: number | null;
  byTopic?: { topic: string; score: number }[];
  results?: ExamResult[];
}

/** `GET /exams?classId=` — the list row, without the questions. */
export interface ExamRow {
  id: string;
  classId: string;
  topics: string[];
  questionCount: number;
  minutes: number;
  startedAt: string | null;
  submittedAt: string | null;
  late: boolean;
  score: number | null;
}

export interface Lecture {
  id: string;
  classId: string;
  title: string;
  startedAt: string;
  durationSec: number;
  pageIds: string[];
  audio: { url: string; expiresAt: string; mime: string } | null;
  status: 'recording' | 'uploading' | 'processing' | 'ready' | 'failed';
  transcript?: { segments: TranscriptSegment[] };
  summary: string | null;
  keyPoints: string[];
  /** Questions the backend extracted into the bank from this lecture. */
  questionCount?: number;
  error?: { code: string; message: string } | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface McpKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Present only in the create response. */
  secret?: string;
}

export interface McpConnection {
  id: string;
  clientName: string;
  clientId: string;
  createdAt: string;
  lastUsedAt: string | null;
  scopes: string[];
}

export interface SearchResult {
  items: Item[];
  pages: Page[];
  questions: Question[];
  transcripts: { itemId: string | null; lectureId: string | null; start: number; text: string }[];
}

/* ------------------------------------------------------------------ P-CM: library, guide, exam results, lab kit */

export type LibraryKind = 'note' | 'pdf' | 'image';

/** `GET /classes/:id/library` row — a document imported from the class folder. */
export interface LibraryDoc {
  id: string;
  title: string;
  kind: LibraryKind;
  week: number | null;
  /** Path inside the class folder (e.g. `week-03/notes.md`). */
  path: string;
  updatedAt: string | null;
}

/** `GET /library/:id`. A PDF over the size cap is stored text-only: `fileStored: false`, no `url`. */
export interface LibraryDocDetail extends LibraryDoc {
  pages: number | null;
  fileStored: boolean;
  /** Signed download url (pdf / image) and its expiry. */
  url?: string;
  urlExpiresAt?: string;
  mime?: string;
  size?: number;
  /** Notes only: the markdown, image refs already rewritten to signed urls. */
  markdown?: string;
  /** Notes only: relPath → signed url of every file the note links. */
  assets?: Record<string, string>;
}

/** `GET /classes/:id/library/search?q&week` hit — one PDF page or one note slice. */
export interface LibraryHit {
  libraryId: string;
  title: string;
  kind: LibraryKind;
  week: number | null;
  /** 1-based PDF page, or the note's slice index. */
  page: number;
  score: number;
  text: string;
}

/** `GET/PUT /classes/:id/guide` — the class guide every AI call of the class reads. */
export interface ClassGuide {
  markdown: string;
  updatedAt: string | null;
}

/** `GET/PUT /classes/:id/exams-schedule` entry. `date` is `YYYY-MM-DD`. */
export interface ExamScheduleEntry {
  name: string;
  week: number | null;
  date: string | null;
  chapters: string[];
  topics: string[];
}

export interface ClassExamResultSection {
  name: string;
  score: number;
  max: number;
}

/** `GET/POST /classes/:id/exam-results`, `PATCH …/:resultId`. */
export interface ClassExamResult {
  id: string;
  name: string;
  date: string | null;
  score: number;
  maxScore: number;
  /** One decimal; null when maxScore is 0. */
  percent: number | null;
  chapters: string[];
  sections?: ClassExamResultSection[];
  notes?: string;
}

export interface ClassExamResultInput {
  name: string;
  date?: string | null;
  score: number;
  maxScore: number;
  chapters?: string[];
  sections?: ClassExamResultSection[];
  notes?: string | null;
}

export type ClassExamResultLatest = Pick<ClassExamResult, 'name' | 'date' | 'score' | 'maxScore' | 'percent'>;

export interface ClassExamResultsSummary {
  latest: ClassExamResultLatest;
  count: number;
}

export interface TodayExamResult extends ClassExamResultLatest {
  classId: string;
}
