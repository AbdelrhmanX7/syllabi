// Question bank + review + mastery + mock exams — thin wrappers over the shared study transport.
// Paths mirror docs/study-app/CONTRACT.md («Question bank», «Mock exams»).

import type { SseFrame } from '@/lib/api/http';
import type {
  AttemptInput,
  AttemptVerdict,
  Exam,
  MasteryTopic,
  Question,
  QuestionSourceKind,
  StudyClass,
} from '@/lib/api/types';

import { studyDelete, studyGet, studyPatch, studyPost, studySse } from '@/lib/api/http';

export interface QuestionQuery {
  classId?: string;
  topic?: string;
  due?: boolean;
  source?: QuestionSourceKind;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export interface QuestionPage {
  items: Question[];
  next: string | null;
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const out = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    out.set(key, value === true ? '1' : String(value));
  }
  const text = out.toString();

  return text ? `?${text}` : '';
}

export const listClasses = () => studyGet<StudyClass[]>('/classes');

export const listQuestions = (query: QuestionQuery) =>
  studyGet<QuestionPage>(
    `/questions${qs({
      classId: query.classId,
      topic: query.topic,
      due: query.due,
      source: query.source,
      q: query.q,
      limit: query.limit,
      cursor: query.cursor,
    })}`,
  );

export const createQuestions = (questions: Partial<Question>[]) => studyPost<Question[]>('/questions', { questions });

export const patchQuestion = (id: string, patch: Partial<Question>) => studyPatch<Question>(`/questions/${id}`, patch);

export const deleteQuestion = (id: string) => studyDelete(`/questions/${id}`);

export const reviewNext = (classId?: string, limit = 20) =>
  studyGet<Question[]>(`/review/next${qs({ classId, limit })}`);

export const getMastery = (classId?: string) => studyGet<{ topics: MasteryTopic[] }>(`/mastery${qs({ classId })}`);

export interface AttemptDone {
  stats: Question['stats'];
  srs: Question['srs'];
}

export interface AttemptFrames {
  onReading?: (text: string) => void;
  onVerdict?: (verdict: AttemptVerdict) => void;
  onDone?: (done: AttemptDone) => void;
}

/** `POST /questions/:id/attempt` — resolves after `done`. */
export function attemptQuestion(id: string, input: AttemptInput, frames: AttemptFrames, signal?: AbortSignal) {
  return studySse(
    `/questions/${id}/attempt`,
    input,
    (frame: SseFrame) => {
      if (frame.event === 'reading') frames.onReading?.((frame.data as { text?: string })?.text ?? '');
      else if (frame.event === 'verdict') frames.onVerdict?.(frame.data as AttemptVerdict);
      else if (frame.event === 'done') frames.onDone?.(frame.data as AttemptDone);
    },
    signal,
  );
}

/** `POST /questions/:id/similar` — one `question` frame, then done. */
export function similarQuestion(id: string, onQuestion: (q: Question) => void, signal?: AbortSignal) {
  return studySse(
    `/questions/${id}/similar`,
    {},
    (frame) => {
      if (frame.event === 'question') onQuestion(frame.data as Question);
    },
    signal,
  );
}

export interface ExtractFrom {
  itemId?: string;
  pageId?: string;
  lectureId?: string;
  imagePngB64?: string;
  pageRange?: string;
}

/** `POST /questions/extract` — streams saved `question` frames; resolves with the `done` count. */
export async function extractQuestions(
  classId: string,
  from: ExtractFrom,
  onQuestion: (q: Question) => void,
  signal?: AbortSignal,
): Promise<number> {
  let count = 0;

  await studySse(
    '/questions/extract',
    { classId, from },
    (frame) => {
      if (frame.event === 'question') {
        count += 1;
        onQuestion(frame.data as Question);
      } else if (frame.event === 'done') {
        count = (frame.data as { count?: number })?.count ?? count;
      }
    },
    signal,
  );

  return count;
}

/* ------------------------------------------------------------------ mock exams (BE P5, #569) */

export interface CreateExamInput {
  classId: string;
  topics?: string[];
  scopeItemIds?: string[];
  /** `'class'` = build it in the class's real exam format (sections, counts, length); count/minutes optional then. */
  blueprint?: 'class';
  /** 1–50 */
  count?: number;
  /** 1–300 */
  minutes?: number;
}

/** While the exam is open the BE strips `answer` / `solutionSteps`; they come back on the results. */
export type ExamQuestion = Omit<Question, 'answer' | 'solutionSteps'> & {
  answer?: string;
  solutionSteps?: string[];
  /** Blueprint exams: the section this question belongs to — `{name, bonus?}` on the wire (#580). */
  section?: { name: string; bonus?: boolean } | string | null;
  /** Blueprint exams: points this question is worth. */
  points?: number | null;
};

/** Blueprint exams: how the paper is split. Shapes vary while the BE settles, so every field is optional but `name`. */
export interface ExamSection {
  name: string;
  /** Question ids in this section, in order. */
  questionIds?: string[];
  type?: string;
  count?: number;
  points?: number;
  bonus?: boolean;
}

export interface GradedFrame extends Partial<AttemptVerdict> {
  questionId: string;
  result: AttemptVerdict['result'];
}

export interface ExamSummary {
  /** 0–100, one decimal. (The pre-P5 mock sends 0..1 — `scoreFraction` copes with both.) */
  score: number;
  byTopic: { topic: string; score: number }[];
  /** Blueprint exams: per-section score (0–100 like `score`), on submit `done` and on GET. */
  bySection?: { section: string; score: number }[];
  late?: boolean;
}

/** `POST /exams` and `GET /exams/:id`. After submit the BE adds `score`, `byTopic`, `results`. */
export interface ExamDetail extends Partial<ExamSummary> {
  id: string;
  classId: string;
  topics: string[];
  count: number;
  minutes: number;
  /** Set on create — there is no /start. */
  startedAt: string | null;
  submittedAt: string | null;
  late?: boolean;
  questions: ExamQuestion[];
  results?: GradedFrame[];
  /** `'class'` when built from the class's real exam format. */
  blueprint?: string | null;
  sections?: ExamSection[];
  /** Blueprint create only: the scheduled exam it targets. */
  scope?: { name: string; date: string | null; chapters: string[]; topics: string[] } | null;
  /** Blueprint create only: sections the bank could not fill. */
  skipped?: { section: string; wanted: number; got: number; reason: string }[];
}

/** `GET /exams?classId=` rows. */
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

export const createExam = (input: CreateExamInput) => studyPost<ExamDetail>('/exams', input);
export const listExams = (classId?: string) => studyGet<(ExamRow | Exam)[]>(`/exams${qs({ classId })}`);
export const getExam = (id: string) => studyGet<ExamDetail>(`/exams/${id}`);

export interface ExamAnswer {
  questionId: string;
  inkPngB64?: string;
  typed?: string;
  choice?: number;
  code?: string;
  /** `matching` */
  matches?: Record<string, string>;
  /** `fill_blank` */
  blanks?: string[];
}

/**
 * `POST /exams/:id/submit` — `graded` per question in order (unanswered = wrong), then
 * `done { score, byTopic, late }`. 409 ALREADY_SUBMITTED / an error frame surface as the thrown
 * StudyApiError (code on it); the caller keeps its answers and may resubmit.
 */
export async function submitExam(
  id: string,
  answers: ExamAnswer[],
  onGraded: (graded: GradedFrame) => void,
  signal?: AbortSignal,
): Promise<ExamSummary> {
  let summary: ExamSummary = { score: 0, byTopic: [] };

  await studySse(
    `/exams/${id}/submit`,
    { answers },
    (frame) => {
      if (frame.event === 'graded') onGraded(frame.data as GradedFrame);
      else if (frame.event === 'done') summary = frame.data as ExamSummary;
    },
    signal,
  );

  return summary;
}
