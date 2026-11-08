import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

/**
 * The Claude client for non-premium accounts (auth/ai-access.ts): one message per call through the
 * server's own Anthropic key (ANTHROPIC_API_KEY). Thinking is left to the model (adaptive by
 * default on these models; `thinking` is never sent, nor temperature / top_p / top_k / prefill),
 * depth is set with `output_config.effort`. The fixed system prompt is sent first and marked for
 * prompt caching. Only `text` blocks are read. A refusal or a cut-off reply is an error.
 * No server-side fallbacks beta: the model that ran is the model billed, so the cost math stays exact.
 */

export type ClaudeTier = "haiku" | "sonnet" | "opus";
export type ClaudeEffort = "low" | "medium" | "high";

export const CLAUDE_MODELS: Record<ClaudeTier, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

/** Default effort per tier: cheap and quick for haiku, careful for opus. */
export const CLAUDE_EFFORT: Record<ClaudeTier, ClaudeEffort> = { haiku: "low", sonnet: "medium", opus: "high" };

/** USD per 1M tokens. Haiku costs more past 100K prompt tokens. Cache reads 10% of input, cache writes 125%. */
export const CLAUDE_PRICES: Record<string, { input: number; output: number; longInput?: number; longOutput?: number; longAbove?: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longInput: 0.5, longOutput: 2.5, longAbove: 100_000 },
};
export const CACHE_READ_FACTOR = 0.1;
export const CACHE_WRITE_FACTOR = 1.25;

export interface ClaudeUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Cost of one reply from its `usage`. Unknown model → priced as opus (never under-counts). */
export function claudeCostUsd(model: string, usage: ClaudeUsageLike | null | undefined): number {
  if (!usage) return 0;
  const p = CLAUDE_PRICES[model] ?? CLAUDE_PRICES["claude-opus-5-5"];
  const input = n(usage.input_tokens);
  const read = n(usage.cache_read_input_tokens);
  const write = n(usage.cache_creation_input_tokens);
  const output = n(usage.output_tokens);
  const long = p.longAbove !== undefined && input + read + write > p.longAbove;
  const inRate = (long ? p.longInput ?? p.input : p.input) / 1e6;
  const outRate = (long ? p.longOutput ?? p.output : p.output) / 1e6;
  return input * inRate + read * inRate * CACHE_READ_FACTOR + write * inRate * CACHE_WRITE_FACTOR + output * outRate;
}

/** A Claude failure with a code the app understands (services/study/ai-errors.ts maps them). */
export class ClaudeError extends Error {
  constructor(public code: string, message: string, public costUsd = 0) {
    super(message);
    this.name = "ClaudeError";
  }
}

export const AI_BUDGET_CODE = "AI_BUDGET";
export const AI_BUDGET_MESSAGE = "The AI is resting until next month.";
export const AI_DAILY_LIMIT_CODE = "AI_DAILY_LIMIT";
export const AI_DAILY_LIMIT_MESSAGE = "You've used a lot of AI today — try again tomorrow.";

// ─── client (injectable for tests) ──────────────────────────────────────────────────────

/** The slice of the SDK this module uses, so tests can hand in a fake. */
export interface ClaudeClientLike {
  messages: {
    stream(body: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal; maxRetries?: number; timeout?: number }): {
      on(event: "text", cb: (delta: string) => void): unknown;
      finalMessage(): Promise<Anthropic.Message>;
    };
  };
}

let client: ClaudeClientLike | null = null;
let testClient: ClaudeClientLike | null = null;

export function setClaudeClientForTests(c: ClaudeClientLike | null): void {
  testClient = c;
}

function getClient(): ClaudeClientLike {
  if (testClient) return testClient;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 }) as unknown as ClaudeClientLike;
  return client;
}

// ─── images ─────────────────────────────────────────────────────────────────────────────

export const IMAGE_MAX_EDGE = 1568;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * One image as a Claude block: long side ≤ 1568 px (more is downscaled by the API anyway, so the
 * extra pixels are pure cost) and re-encoded as JPEG q80, which also keeps it under the size cap.
 * A buffer sharp cannot read is sent as is when its type is one Claude takes.
 */
export async function toClaudeImage(image: Buffer, mime: string): Promise<Anthropic.ImageBlockParam> {
  try {
    const out = await sharp(image).rotate().resize(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 80 }).toBuffer();
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: out.toString("base64") } };
  } catch {
    const type = IMAGE_TYPES.has(mime) ? (mime as "image/png") : "image/png";
    return { type: "image", source: { type: "base64", media_type: type, data: image.toString("base64") } };
  }
}

// ─── one call ───────────────────────────────────────────────────────────────────────────

export interface ClaudeCallOptions {
  tier: ClaudeTier;
  /** Fixed per-feature prompt (cached). Per-request content goes in `user`. */
  system: string;
  user: string;
  images?: { data: Buffer; mime: string }[];
  maxTokens: number;
  effort?: ClaudeEffort;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** Calls with a hard deadline set 0. */
  maxRetries?: number;
  timeoutMs?: number;
  /** Ask for one JSON object (prompted; the caller parses it loosely). */
  json?: boolean;
}

export interface ClaudeResult {
  text: string;
  model: string;
  costUsd: number;
  usage: ClaudeUsageLike | null;
}

export const JSON_ONLY = "Reply with exactly one JSON object and nothing else: no prose before or after it, no code fences.";

/** Thinking shares max_tokens with the reply; a small budget would leave the reply empty. */
export const claudeMaxTokens = (requested: number, effort: ClaudeEffort) => {
  const floor = effort === "low" ? 2_048 : effort === "medium" ? 4_096 : 8_192;
  return Math.min(64_000, Math.max(floor, Math.round(requested * (effort === "low" ? 1.5 : 2))));
};

const textOf = (m: Anthropic.Message) =>
  m.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

export async function claudeCall(o: ClaudeCallOptions): Promise<ClaudeResult> {
  const model = CLAUDE_MODELS[o.tier];
  const effort = o.effort ?? CLAUDE_EFFORT[o.tier];
  const images = await Promise.all((o.images ?? []).map((i) => toClaudeImage(i.data, i.mime)));
  const system = o.json ? `${o.system}\n\n${JSON_ONLY}` : o.system;
  const body: Anthropic.MessageStreamParams = {
    model,
    max_tokens: claudeMaxTokens(o.maxTokens, effort),
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [...images, { type: "text", text: o.user || "(empty)" }] }],
    output_config: { effort },
  };
  const stream = getClient().messages.stream(body, {
    signal: o.signal,
    ...(o.maxRetries !== undefined ? { maxRetries: o.maxRetries } : {}),
    ...(o.timeoutMs ? { timeout: o.timeoutMs } : {}),
  });
  if (o.onDelta) stream.on("text", o.onDelta);
  let msg: Anthropic.Message;
  try {
    msg = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.APIError && /credit balance/i.test(String(e.message))) throw new ClaudeError(AI_BUDGET_CODE, AI_BUDGET_MESSAGE);
    throw e;
  }
  const served = String(msg.model || model);
  const costUsd = claudeCostUsd(served, msg.usage);
  if (msg.stop_reason === "refusal") throw new ClaudeError("AI_REFUSED", "The AI couldn't help with that one — try asking another way.", costUsd);
  const text = textOf(msg);
  if (msg.stop_reason === "max_tokens" && !text.trim()) throw new ClaudeError("AI_FAILED", "The AI ran out of room — try again", costUsd);
  return { text, model: served, costUsd, usage: msg.usage };
}
