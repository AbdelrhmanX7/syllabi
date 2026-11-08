import type { WbLocale } from '../../../i18n/strings';
import type { BoardAiAskAction, BoardAiBlock } from './types';

/**
 * «Ask AI» as a chat: every finished answer is one turn of a thread kept per board page, so the
 * teacher can close the panel, reload, come back and read or continue it. The transports take one
 * prompt, so a follow-up carries the earlier turns as text inside that prompt (see
 * {@link chatContextPrompt}) — no conversation endpoint is assumed.
 */

export interface AskChatTurn {
  id: string;
  /** Epoch ms the answer finished. */
  at: number;
  /** What was asked: a chip action, or `custom` with the typed question in `question`. */
  action: BoardAiAskAction;
  question: string;
  /** «Quote» / «Explain more»: the part of an earlier answer this turn asked about (clipped). */
  quote?: string;
  /** What the AI read off the circled picture — the only record of it once the picture is gone. */
  transcript?: string;
  /** The answer as markdown (what follow-ups quote back). */
  text: string;
  blocks: BoardAiBlock[];
}

/** The slice of `Storage` the thread needs — tests pass a Map-backed fake. */
export interface ChatStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export const CHAT_MAX_TURNS = 40;
/**
 * The whole follow-up prompt (history + question) stays within this: the whiteboard AI routes
 * (`/whiteboard/ai/ask`, `/whiteboard/ai/generate`) reject a prompt over 2000 characters, and the
 * package cannot tell which route a host's transport calls.
 */
export const CHAT_PROMPT_MAX = 2000;
/** A typed follow-up question is capped at this (the composer's `maxLength`). */
export const CHAT_QUESTION_MAX = 600;
/** One earlier answer is quoted back at most this long. */
const ANSWER_QUOTE_MAX = 500;
const TRANSCRIPT_QUOTE_MAX = 300;
/** A quoted part of an answer («Quote» / «Explain more») rides along at most this long. */
export const CHAT_REF_MAX = 300;
/** An earlier turn's quote, inside the history. */
const HISTORY_REF_MAX = 120;

export function chatStorageKey(boardId: string | null | undefined, pageId: string | null | undefined): string {
  return `wb-ai-chat:${boardId || 'board'}:${pageId || 'page'}`;
}

/** Inline (`data:`) pictures are dropped before saving — one would eat the whole storage quota. */
export function storableBlocks(blocks: BoardAiBlock[]): BoardAiBlock[] {
  return blocks.filter((block) => block.type !== 'image' || !block.src.startsWith('data:'));
}

const isTurn = (value: unknown): value is AskChatTurn => {
  if (!value || typeof value !== 'object') return false;

  const turn = value as Partial<AskChatTurn>;

  return typeof turn.id === 'string' && typeof turn.action === 'string' && typeof turn.text === 'string' && Array.isArray(turn.blocks);
};

export function readChat(storage: ChatStorage | null | undefined, key: string): AskChatTurn[] {
  try {
    const raw = storage?.getItem(key);

    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed.filter(isTurn).map((turn) => {
          const { quote, ...rest } = turn;

          return { ...rest, question: turn.question ?? '', at: Number(turn.at) || 0, ...(typeof quote === 'string' && quote.trim() ? { quote } : {}) };
        })
      : [];
  } catch {
    return [];
  }
}

/**
 * Saves the newest {@link CHAT_MAX_TURNS} turns. A full storage drops the oldest half and tries again,
 * so the latest answers survive. Returns what was actually kept.
 */
export function writeChat(storage: ChatStorage | null | undefined, key: string, turns: AskChatTurn[]): AskChatTurn[] {
  let kept = turns.slice(-CHAT_MAX_TURNS).map((turn) => ({ ...turn, blocks: storableBlocks(turn.blocks) }));

  if (!storage) return kept;

  for (;;) {
    try {
      if (kept.length === 0) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(kept));

      return kept;
    } catch {
      if (kept.length <= 1) {
        try {
          storage.removeItem(key);
        } catch {
          /* storage unavailable */
        }

        return kept;
      }

      kept = kept.slice(Math.ceil(kept.length / 2));
    }
  }
}

/**
 * Adds a finished answer to the thread: appended, or — a retried / re-read answer — put in place of
 * the turn it re-asked, so «Retry» does not repeat the question in the thread. A turn no longer there
 * (cleared meanwhile) means append.
 */
export function placeTurn(turns: AskChatTurn[], turn: AskChatTurn, replaceId?: string | null): AskChatTurn[] {
  const index = replaceId ? turns.findIndex((existing) => existing.id === replaceId) : -1;

  if (index < 0) return [...turns, turn];

  const next = turns.slice();

  next[index] = turn;

  return next;
}

export function clearChat(storage: ChatStorage | null | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const DEFAULT_QUESTIONS: Record<Exclude<BoardAiAskAction, 'custom'>, string> = {
  solve: 'Solve what I circled.',
  explain: 'Explain what I circled.',
  check_answer: 'Check my answer in what I circled.',
  concept_map: 'Read my concept map.',
};

/** The question a turn asked, as words (a chip turn has no typed text). */
export function turnQuestion(turn: Pick<AskChatTurn, 'action' | 'question'>, _locale?: WbLocale): string {
  if (turn.question.trim()) return turn.question.trim();

  return turn.action === 'custom' ? '' : DEFAULT_QUESTIONS[turn.action];
}

/** «Short / Detailed»: how long the answers should be. Short is the default — the board wants compact. */
export type AnswerLength = 'short' | 'detailed';

const LENGTH_KEY = 'wb-ai-answer-length';

export function readAnswerLength(storage: ChatStorage | null | undefined): AnswerLength {
  try {
    return storage?.getItem(LENGTH_KEY) === 'detailed' ? 'detailed' : 'short';
  } catch {
    return 'short';
  }
}

export function writeAnswerLength(storage: ChatStorage | null | undefined, length: AnswerLength): void {
  try {
    storage?.setItem(LENGTH_KEY, length);
  } catch {
    /* convenience */
  }
}

const BREVITY = 'Keep it short: only the key steps and the final answer, in a few lines. Do not restate the question.';

/** The follow-ups the panel words itself (a new circled picture with nothing typed, «Summarize», «Explain more»). */
const CANNED = {
  ink: 'Check what I wrote next in what I circled, and continue.',
  summarize: 'Summarize your last answer in 3–5 short bullet points.',
  expand: 'Explain this part in more detail.',
};

/** A newly circled picture: the typed text is the question, else «check what I wrote next». */
export const inkFollowUpQuestion = (typed: string, _locale?: WbLocale) => typed.trim() || CANNED.ink;
export const summarizeQuestion = (_locale?: WbLocale) => CANNED.summarize;
export const expandQuestion = (_locale?: WbLocale) => CANNED.expand;

/** A selection from an answer as a one-line reference: whitespace folded, clipped. */
export const clipRef = (text: string, max = CHAT_REF_MAX) => clip(text.replace(/\s+/g, ' ').trim(), max);

const refLine = (quote: string, max: number) => `About this part: "${clipRef(quote, max)}"`;

export interface FollowUpOptions {
  /** «Quote» / «Explain more»: the part of an answer the question is about. */
  quote?: string | null;
  /** «Short»: a brevity instruction closes the prompt (its room comes out of the history). */
  short?: boolean;
}

/**
 * The one prompt a follow-up sends: the earlier turns that fit (newest first, then put back in
 * order) and the new question — with its quoted part and the brevity line, when set — never longer
 * than `max`. No earlier turns = the question as is.
 */
export function chatContextPrompt(turns: AskChatTurn[], question: string, _locale?: WbLocale, max = CHAT_PROMPT_MAX, options: FollowUpOptions = {}): string {
  const SEP = '\n\n';
  const brief = options.short ? `${SEP}${BREVITY}` : '';
  const typed = question.trim();
  const ref = options.quote?.trim() ? refLine(options.quote, CHAT_REF_MAX) : '';
  const asked = clip(ref && typed ? `${ref}\n${clip(typed, CHAT_QUESTION_MAX)}` : ref || clip(typed, CHAT_QUESTION_MAX), Math.max(0, max - brief.length - 1));
  const lines = { q: 'Me', ref: 'About', read: 'What I circled (as read)', a: 'You' };
  const head = 'We are continuing a conversation about my notebook page. Earlier turns, oldest first:';
  const tail = 'My follow-up question:';
  // Room left for the quoted turns once the frame, the question and the brevity line are in.
  let room = max - (head.length + SEP.length + SEP.length + tail.length + 1 + asked.length + brief.length);
  const picked: string[] = [];

  for (let index = turns.length - 1; index >= 0 && room > 0; index -= 1) {
    const turn = turns[index];
    const parts = [`${lines.q}: ${clip(turnQuestion(turn), CHAT_QUESTION_MAX)}`];

    if (turn.quote?.trim()) parts.push(`${lines.ref}: ${clipRef(turn.quote, HISTORY_REF_MAX)}`);
    if (turn.transcript?.trim()) parts.push(`${lines.read}: ${clip(turn.transcript.trim(), TRANSCRIPT_QUOTE_MAX)}`);
    parts.push(`${lines.a}: ${clip(turn.text.trim(), ANSWER_QUOTE_MAX)}`);

    const entry = parts.join('\n');
    const cost = entry.length + (picked.length > 0 ? SEP.length : 0);

    if (cost <= room) {
      picked.unshift(entry);
      room -= cost;
      continue;
    }

    // The newest turn always rides along, clipped to what is left (when that is still useful).
    if (picked.length === 0 && room > 120) picked.unshift(clip(entry, room - 1));
    break;
  }

  if (picked.length === 0) return `${asked}${brief}`;

  return `${head}${SEP}${picked.join(SEP)}${SEP}${tail} ${asked}${brief}`;
}

/**
 * The prompt «Ask AI» sends with a picture. A typed question, a chip on a page whose thread
 * already has turns, a quote or «Short» all go through {@link chatContextPrompt} — the backend reads
 * `prompt` as the instructions for any action. A bare chip on a fresh thread sends none, as before.
 */
export function askPrompt(
  turns: AskChatTurn[],
  action: BoardAiAskAction,
  typed: string,
  locale: WbLocale | undefined,
  options: FollowUpOptions = {},
  max = CHAT_PROMPT_MAX,
): string | undefined {
  if (action !== 'custom' && turns.length === 0 && !options.short && !options.quote?.trim() && !typed.trim()) return undefined;

  const question = typed.trim() || turnQuestion({ action, question: '' }, locale);

  return chatContextPrompt(turns, question, locale, max, options);
}

export const newTurnId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
