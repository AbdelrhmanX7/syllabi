// Pure helpers over conversation lists and transcripts: how a finished stream lands in the cached
// detail, how a new conversation enters the list, what a thread is called.
import type {
  TutorConversation,
  TutorConversationDetail,
  TutorMessage,
  TutorMode,
  TutorQuizScore,
  TutorQuizTurn,
} from '../types';

export const TITLE_MAX = 56;

/** The first line of the first question, trimmed to a list-friendly length. */
export function conversationTitle(question: string, fallback = 'New chat'): string {
  const line = question.replace(/\s+/g, ' ').trim();

  if (!line) return fallback;
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX);
  const atWord = cut.lastIndexOf(' ');

  return `${(atWord > TITLE_MAX * 0.6 ? cut.slice(0, atWord) : cut).trim()}…`;
}

/** Upsert by id, newest `updatedAt` first. The incoming row wins over the stale one. */
export function mergeConversation(list: TutorConversation[], incoming: TutorConversation): TutorConversation[] {
  const rest = list.filter((row) => row.id !== incoming.id);

  return [...rest, incoming].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The list row for a detail (no messages, a live count). The server's detail has no `updatedAt`. */
export const conversationRow = ({ messages, quiz: _quiz, ...rest }: TutorConversationDetail): TutorConversation => ({
  ...rest,
  updatedAt: rest.updatedAt ?? messages[messages.length - 1]?.createdAt ?? rest.createdAt ?? new Date(0).toISOString(),
  messageCount: messages.length,
});

/** A thread's mode is its latest turn's (the server keeps no conversation-level mode). */
export function threadMode(
  detail: Pick<TutorConversationDetail, 'messages' | 'mode'> | null | undefined,
): TutorMode | null {
  const last = detail?.messages?.[detail.messages.length - 1];

  return last?.mode ?? detail?.mode ?? null;
}

/** The score a cached thread shows after a quiz turn's `done {quiz}`. */
export function applyQuizTurn(detail: TutorConversationDetail, turn: TutorQuizTurn): TutorConversationDetail {
  const score: TutorQuizScore = { asked: turn.asked, right: turn.right, partial: turn.partial, wrong: turn.wrong };

  return { ...detail, mode: 'quiz', quiz: score };
}

export function appendMessages(detail: TutorConversationDetail, ...messages: TutorMessage[]): TutorConversationDetail {
  const last = messages[messages.length - 1];
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant');

  return {
    ...detail,
    messages: [...detail.messages, ...messages],
    updatedAt: last?.createdAt ?? detail.updatedAt,
    messageCount: detail.messages.length + messages.length,
    ...(assistant ? { preview: previewOf(assistant.text) } : {}),
  };
}

/** A one-line, markdown-stripped preview. */
export function previewOf(markdown: string, max = 120): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

/** A brand-new thread built client-side after the first `meta` frame, before the list refetches. */
export function newConversation(
  id: string,
  classId: string | null,
  question: string,
  mode: TutorMode,
  now = new Date().toISOString(),
): TutorConversationDetail {
  return {
    id,
    classId,
    title: conversationTitle(question),
    mode,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    messages: [],
  };
}

/** The question a quiz turn answers: the last assistant message, if the thread is in quiz mode. */
export function pendingQuizQuestion(messages: TutorMessage[]): TutorMessage | null {
  const last = messages[messages.length - 1];

  return last && last.role === 'assistant' ? last : null;
}
