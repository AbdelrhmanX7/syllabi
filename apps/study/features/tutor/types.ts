// The tutor contract, live since BE #577: `POST /study/ai/ask` SSE + `GET /study/ai/conversations(/:id)`.
// Mirrors services/study/tutor/ask.ts + models/study/conversation.ts; docs/study-app/CONTRACT.md has the prose.

export type TutorMode = 'explain' | 'quiz';

/** What the question is about — any subset; the backend retrieves around it. */
export interface TutorContext {
  /** A picture (lasso, pen-pad answer, photo) — base64 PNG, no `data:` prefix. */
  imagePngB64?: string;
  /** Selected / pasted text. */
  text?: string;
  itemId?: string;
  pageId?: string;
  lectureId?: string;
  /** A moment in a video item (seconds). */
  videoAt?: { itemId: string; t: number };
}

export type TutorSourceKind = 'library' | 'item' | 'transcript' | 'page' | 'guide';

export interface TutorSource {
  kind: TutorSourceKind;
  /** item id / page id / library doc id — what the chip navigates to. */
  id: string;
  title: string;
  snippet: string;
  week?: number;
  /** `transcript`: the moment the snippet starts (seconds). The wire sends `null` when absent. */
  t?: number;
}

export type TutorRole = 'user' | 'assistant';

export interface TutorMessage {
  role: TutorRole;
  /** Markdown with `$…$` / `$$…$$` LaTeX. */
  text: string;
  sources?: TutorSource[];
  createdAt: string;
  /** A user turn's attachments, when the backend echoes them (the UI keeps its own copy while streaming). */
  context?: TutorContext;
  mode?: TutorMode;
}

/** A list row: `GET /ai/conversations?classId=` → `{id, title, classId, updatedAt}[]`, newest first. */
export interface TutorConversation {
  id: string;
  classId: string | null;
  title: string;
  updatedAt: string;
  /** Client-side extras (the mock and the cache after a stream fill them; the server does not). */
  mode?: TutorMode;
  createdAt?: string;
  messageCount?: number;
  /** The last assistant line — the list's preview. */
  preview?: string;
}

export type TutorQuizResult = 'right' | 'partial' | 'wrong';

/** The running score of a quiz conversation. */
export interface TutorQuizScore {
  /** Questions asked so far — the one being waited on included. */
  asked: number;
  right: number;
  partial: number;
  wrong: number;
}

/** `done {quiz}` after a quiz turn: the score, the question just asked, and the verdict on the reply (if any). */
export interface TutorQuizTurn extends TutorQuizScore {
  /** The bank question now pending; null for a generated one. */
  questionId: string | null;
  questionKind: 'bank' | 'free';
  graded?: {
    result: TutorQuizResult;
    correctAnswer: string;
    /** Bank questions only: the row the attempt was recorded on. */
    questionId?: string;
  };
}

/** `GET /ai/conversations/:id` → `quiz`: null unless a question is waiting for an answer. */
export interface TutorConversationQuiz extends TutorQuizScore {
  pending: { kind: 'bank' | 'free'; stem: string; choices: string[] };
}

/** `GET /ai/conversations/:id` → `{id, title, classId, messages, quiz}`. */
export interface TutorConversationDetail extends Omit<TutorConversation, 'updatedAt'> {
  updatedAt?: string;
  messages: TutorMessage[];
  quiz?: TutorConversationQuiz | TutorQuizScore | null;
}

/** Body of `POST /ai/ask`. */
export interface AskRequest {
  classId?: string;
  conversationId?: string;
  mode: TutorMode;
  context?: TutorContext;
  question: string;
}

/** One quick prompt chip for a class. */
export interface QuickPrompt {
  label: string;
  question: string;
  /** Switches the composer to this mode before sending; absent = keep the current one. */
  mode?: TutorMode;
  /** Opens the pen pad (the prompt wants handwriting, e.g. «Check my steps»). */
  pen?: boolean;
}
