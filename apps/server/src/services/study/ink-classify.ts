import { Types } from "mongoose";
import { StudyPerfQuota } from "@/models/study/perf";
import { logger } from "@/services/logger.service";
import { JEV_DECISIONS_URL, JEV_MODEL } from "@/services/ai/jev-models";

/**
 * Ink line classification for the study notebook (POST /study/ai/ink-classify): each recognised
 * handwriting line → heading | term | definition | formula | example | keypoint | plain, via ONE
 * Jev decisions call (OpenRouter) per request. Criteria copied from the FE bench
 * (an offline ink-colour benchmark). A line that fails or comes back garbled
 * is plain/0 — one bad line never fails the batch.
 */

export const INK_CLASSES = ["heading", "term", "definition", "formula", "example", "keypoint", "plain"] as const;
export type InkClass = (typeof INK_CLASSES)[number];
export interface InkResult {
  cls: InkClass;
  confidence: number;
}

export const INK_MAX_LINES = 20;
export const INK_TEXT_MAX = 300;
export const INK_LANG_MAX = 8;
export const INK_TIMEOUT_MS = 8_000;
export const INK_RETRY_BACKOFF_MS = 300;
export const INK_QUOTA = { requestsPerMinute: 60, linesPerDay: 2_000 } as const;

const JEV_CRITERIA = {
  heading: { what: "a title / lesson / chapter / unit line", examples: ["Lesson 1: Cell division", "Chapter 2: Cells"] },
  term: { what: 'the word or short phrase being defined, often ends with ":" or "="', examples: ["Cell:", "Mitosis ="] },
  definition: { what: "the explanation text that defines the term in the same line", examples: ["the basic unit of a living thing", "movement of water across a membrane"] },
  formula: { what: "an equation, law, chemical equation or a number with a unit", examples: ["F = m × a", "30 km/h"] },
  example: { what: "an example, or text introduced by e.g. / for example / ex:", examples: ["Example: bees", "e.g. dogs"] },
  "key-point": { what: "an emphasised must-remember note (important, note, !!, Remember)", examples: ["Important: don't forget the units", "!! comes in the exam"] },
  plain: { what: "ordinary narration or reminders that are none of the above", examples: ["review the textbook", "the class started late"] },
};
/** Upstream choice key → our class. `key-point` is the only one renamed. */
const CHOICE_TO_CLASS: Record<string, InkClass> = {
  heading: "heading",
  term: "term",
  definition: "definition",
  formula: "formula",
  example: "example",
  "key-point": "keypoint",
  plain: "plain",
};
const PLAIN: InkResult = { cls: "plain", confidence: 0 };

export interface InkCues {
  relHeight?: number;
  underlined?: boolean;
  boxed?: boolean;
  indent?: number;
  lineIndex?: number;
}
export interface InkLine {
  text: string;
  lang: string;
  cues?: InkCues;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const CUE_TYPES: Record<keyof InkCues, (v: unknown) => boolean> = {
  relHeight: (v) => typeof v === "number" && Number.isFinite(v),
  indent: (v) => typeof v === "number" && Number.isFinite(v),
  lineIndex: (v) => Number.isInteger(v),
  underlined: (v) => typeof v === "boolean",
  boxed: (v) => typeof v === "boolean",
};

/** Body → lines (trimmed, text cut to 300), or the 400 reason. Unknown cue keys are dropped; a known one of the wrong type is a 400. */
export function parseInkBody(body: unknown): { lines: InkLine[] } | { error: string } {
  const raw = isObj(body) ? body.lines : undefined;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > INK_MAX_LINES) return { error: `lines must be an array of 1..${INK_MAX_LINES}` };
  const lines: InkLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i];
    if (!isObj(l) || typeof l.text !== "string") return { error: `lines[${i}].text must be a string` };
    if (l.lang !== undefined && (typeof l.lang !== "string" || l.lang.length > INK_LANG_MAX)) return { error: `lines[${i}].lang must be a string of at most ${INK_LANG_MAX} chars` };
    const line: InkLine = { text: l.text.trim().slice(0, INK_TEXT_MAX), lang: (l.lang as string | undefined) ?? "" };
    if (l.cues !== undefined) {
      if (!isObj(l.cues)) return { error: `lines[${i}].cues must be an object` };
      const cues: InkCues = {};
      for (const k of Object.keys(CUE_TYPES) as (keyof InkCues)[]) {
        const v = l.cues[k];
        if (v === undefined) continue;
        if (!CUE_TYPES[k](v)) return { error: `lines[${i}].cues.${k} has the wrong type` };
        (cues as any)[k] = v;
      }
      line.cues = cues;
    }
    lines.push(line);
  }
  return { lines };
}

/** Indices of the lines that go upstream (non-empty text). */
export const sentIndices = (lines: InkLine[]) => lines.flatMap((l, i) => (l.text ? [i] : []));

/** The decisions request. `line_<i>` / `g<i>` use the ORIGINAL line index, so skipped empty lines never shift the mapping. */
export function buildInkRequest(lines: InkLine[], sent: number[]): Record<string, unknown> {
  const state: Record<string, string> = {
    full_note: sent.map((i) => lines[i].text).join("\n"),
  };
  const questions: Record<string, unknown> = {};
  for (const i of sent) {
    state[`line_${i}`] = lines[i].text;
    questions[`g${i}`] = {
      type: "choice",
      instructions: {
        question: `What kind of study-note content is \`line_${i}\`? Use \`full_note\` for context (a term is followed by its definition in the next/same line).`,
      },
      criteria: JEV_CRITERIA,
    };
  }
  return { model: JEV_MODEL, state, questions };
}

/** Answers → one result per ORIGINAL line, in order. Anything off-contract is plain/0. */
export function parseInkAnswers(answers: unknown, lineCount: number, sent: number[]): InkResult[] {
  const out: InkResult[] = Array.from({ length: lineCount }, () => ({ ...PLAIN }));
  const a = isObj(answers) ? answers : {};
  for (const i of sent) {
    const g = a[`g${i}`];
    if (!isObj(g) || typeof g.choice !== "string") continue;
    const cls = Object.prototype.hasOwnProperty.call(CHOICE_TO_CLASS, g.choice) ? CHOICE_TO_CLASS[g.choice] : undefined;
    const conf = typeof g.confidence === "number" ? g.confidence : NaN;
    if (!cls || !Number.isFinite(conf)) continue;
    out[i] = { cls, confidence: Math.min(1, Math.max(0, conf)) };
  }
  return out;
}

export class InkUpstreamError extends Error {
  constructor(
    /** Never carries the upstream body — it can echo the note text. */
    message: string,
    readonly status: number | null
  ) {
    super(message);
  }
}

export interface InkCallOptions {
  apiKey?: string;
  timeoutMs?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
}

const retryable = (s: number) => s === 429 || s >= 500;

/** One decisions call; exactly one retry on 429/5xx after a short backoff. Throws InkUpstreamError. */
export async function callInkDecisions(body: Record<string, unknown>, opts: InkCallOptions = {}): Promise<{ answers: unknown; costUsd: number; model: string }> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) throw new InkUpstreamError("OPENROUTER_API_KEY not set", null);
  const doFetch = opts.fetchImpl ?? fetch;
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? INK_TIMEOUT_MS);
    let status: number;
    let text: string;
    try {
      const res = await doFetch(JEV_DECISIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: payload,
        signal: ctrl.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      throw new InkUpstreamError(ctrl.signal.aborted ? "timeout" : "network error", null);
    } finally {
      clearTimeout(timer);
    }
    if (status >= 200 && status < 300) {
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new InkUpstreamError("bad json", status);
      }
      return { answers: data?.answers, costUsd: Number(data?.usage?.cost ?? 0) || 0, model: typeof data?.model === "string" ? data.model : JEV_MODEL };
    }
    if (attempt === 0 && retryable(status)) {
      await new Promise((r) => setTimeout(r, opts.backoffMs ?? INK_RETRY_BACKOFF_MS));
      continue;
    }
    throw new InkUpstreamError(`HTTP ${status}`, status);
  }
}

// ─── quota (fixed windows, counters in study_perf_quotas under an `ink:` key prefix) ───

const bump = async (user: Types.ObjectId, key: string, inc: number, expireAt: Date) => {
  const run = () => StudyPerfQuota.findOneAndUpdate({ user, key }, { $inc: { count: inc }, $setOnInsert: { expireAt } }, { upsert: true, new: true }).lean();
  try {
    return await run();
  } catch (e: any) {
    if (e?.code === 11000) return run();
    throw e;
  }
};

export const inkMinuteKey = (now: number) => `ink:m:${Math.floor(now / 60_000)}`;
export const inkDayKey = (now: number) => `ink:d:${Math.floor(now / 86_400_000)}`;

/**
 * ≤60 requests per user per UTC minute, ≤2,000 classified (non-empty) lines per user per UTC day.
 * A day-rejected request's lines are given back. FAIL-OPEN like the perf quota.
 * Returns the Retry-After seconds when over quota, else null.
 */
export const checkInkQuota = async (user: Types.ObjectId, lines: number, now = Date.now()): Promise<number | null> => {
  try {
    const minute = Math.floor(now / 60_000);
    const day = Math.floor(now / 86_400_000);
    const m = await bump(user, inkMinuteKey(now), 1, new Date((minute + 2) * 60_000));
    if ((m?.count ?? 0) > INK_QUOTA.requestsPerMinute) return Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000));
    if (!lines) return null;
    const d = await bump(user, inkDayKey(now), lines, new Date((day + 2) * 86_400_000));
    if ((d?.count ?? 0) > INK_QUOTA.linesPerDay) {
      await StudyPerfQuota.updateOne({ user, key: inkDayKey(now) }, { $inc: { count: -lines } });
      return Math.max(1, Math.ceil(((day + 1) * 86_400_000 - now) / 1000));
    }
    return null;
  } catch (e) {
    await logger.error("study ink quota check failed (fail-open)", e as Error, { user: String(user) });
    return null;
  }
};
