// Pure reducer for one `/ai/ask` stream: frames in, the growing answer out. Tolerant of the
// whiteboard-AI spellings too (`text` frames with a string body, `done {content}`), so a backend
// that reuses the teacher pipeline streams fine without a client change.
import type { TutorQuizResult, TutorQuizScore, TutorQuizTurn, TutorSource, TutorSourceKind } from '../types';
import type { SseFrame } from '@/lib/api/http';

import { isSampleData } from '@/lib/api/sample';

export interface AskStreamState {
  conversationId: string | null;
  text: string;
  sources: TutorSource[];
  done: boolean;
  error: string | null;
  /** Any frame carried the mock's `__sample` marker. */
  sample: boolean;
  /** Quiz mode: `done {quiz}` — the score after this turn and the verdict on the reply. */
  quiz: TutorQuizTurn | null;
}

export const EMPTY_STREAM: AskStreamState = {
  conversationId: null,
  text: '',
  sources: [],
  done: false,
  error: null,
  sample: false,
  quiz: null,
};

const SOURCE_KINDS: TutorSourceKind[] = ['library', 'item', 'transcript', 'page', 'guide'];

/** One wire source → ours; null when it has no id or title (nothing to tap). */
export function parseSource(value: unknown): TutorSource | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id : raw.id !== undefined && raw.id !== null ? String(raw.id) : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';

  if (!id || !title) return null;
  const kind = (SOURCE_KINDS as string[]).includes(String(raw.kind)) ? (raw.kind as TutorSourceKind) : 'item';
  const week = Number(raw.week);
  // The wire writes `t: null` on non-transcript sources — null must not become «0:00».
  const rawT = raw.t ?? raw.start;
  const t = rawT === null || rawT === undefined || rawT === '' ? NaN : Number(rawT);

  return {
    kind,
    id,
    title,
    snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
    ...(Number.isFinite(week) && week > 0 ? { week } : {}),
    ...(Number.isFinite(t) && t >= 0 ? { t } : {}),
  };
}

function textOf(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const body = data as { text?: unknown; delta?: unknown; content?: unknown };

    if (typeof body.text === 'string') return body.text;
    if (typeof body.delta === 'string') return body.delta;
    if (typeof body.content === 'string') return body.content;
  }

  return '';
}

const count = (value: unknown) => {
  const n = Number(value);

  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const RESULTS: TutorQuizResult[] = ['right', 'partial', 'wrong'];

/** `done.quiz` → ours; null when the frame has none (explain mode). */
export function parseQuizTurn(value: unknown): TutorQuizTurn | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const graded = raw.graded as Record<string, unknown> | null | undefined;
  const result = graded && (RESULTS as unknown[]).includes(graded.result) ? (graded.result as TutorQuizResult) : null;

  return {
    asked: count(raw.asked),
    right: count(raw.right),
    partial: count(raw.partial),
    wrong: count(raw.wrong),
    questionId: typeof raw.questionId === 'string' && raw.questionId ? raw.questionId : null,
    questionKind: raw.questionKind === 'bank' ? 'bank' : 'free',
    ...(result
      ? {
          graded: {
            result,
            correctAnswer: typeof graded?.correctAnswer === 'string' ? graded.correctAnswer : '',
            ...(typeof graded?.questionId === 'string' ? { questionId: graded.questionId } : {}),
          },
        }
      : {}),
  };
}

export interface QuizScoreView {
  /** Replies graded so far (the pending question is not one yet). */
  answered: number;
  right: number;
  partial: number;
  wrong: number;
  /** 0–100; a partial counts half. Null before the first graded reply. */
  percent: number | null;
  /** «2.5 / 3» style; whole numbers stay whole. */
  label: string;
}

/** The running score line for a quiz thread. */
export function quizScore(score: TutorQuizScore | null | undefined): QuizScoreView | null {
  if (!score) return null;
  const right = count(score.right);
  const partial = count(score.partial);
  const wrong = count(score.wrong);
  const answered = right + partial + wrong;
  const points = right + partial / 2;

  return {
    answered,
    right,
    partial,
    wrong,
    percent: answered ? Math.round((points / answered) * 100) : null,
    label: `${Number.isInteger(points) ? points : points.toFixed(1)} / ${answered}`,
  };
}

export function reduceAskFrame(state: AskStreamState, frame: SseFrame): AskStreamState {
  const sample = state.sample || isSampleData(frame.data);

  switch (frame.event) {
    case 'meta': {
      const id = (frame.data as { conversationId?: unknown } | null)?.conversationId;

      return { ...state, sample, conversationId: typeof id === 'string' && id ? id : state.conversationId };
    }
    case 'delta':
    case 'text':
      return { ...state, sample, text: state.text + textOf(frame.data) };
    case 'sources': {
      const list = Array.isArray(frame.data)
        ? frame.data
        : Array.isArray((frame.data as { sources?: unknown } | null)?.sources)
          ? (frame.data as { sources: unknown[] }).sources
          : [];
      const sources = list.map(parseSource).filter((source): source is TutorSource => source !== null);

      return { ...state, sample, sources: sources.length ? sources : state.sources };
    }
    case 'done': {
      // A `done {content}` with the whole answer (teacher pipeline) wins over nothing; never over deltas.
      const content = textOf(frame.data);
      const id = (frame.data as { conversationId?: unknown } | null)?.conversationId;
      const quiz = parseQuizTurn((frame.data as { quiz?: unknown } | null)?.quiz);

      return {
        ...state,
        sample,
        done: true,
        text: state.text || content,
        conversationId: typeof id === 'string' && id ? id : state.conversationId,
        quiz: quiz ?? state.quiz,
      };
    }
    case 'error': {
      const message =
        typeof frame.data === 'string'
          ? frame.data
          : ((frame.data as { message?: unknown } | null)?.message as string | undefined) ||
            'The tutor could not answer.';

      return { ...state, sample, done: true, error: String(message) };
    }
    case 'status':
    case 'thinking':
    default:
      return sample === state.sample ? state : { ...state, sample };
  }
}

/** Fold a whole frame list (tests, replays). */
export const reduceAskFrames = (frames: SseFrame[], initial: AskStreamState = EMPTY_STREAM) =>
  frames.reduce(reduceAskFrame, initial);
