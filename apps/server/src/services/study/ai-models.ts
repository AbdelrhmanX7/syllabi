import type OpenAI from "openai";
import { callVision, WHITEBOARD_VISION_MODELS } from "@/services/whiteboard-ai/vision";
import { deepseekFlashModel, getDeepSeekClient } from "@/services/ai/config";
import { messageCostUsd } from "@/services/ai-chat/cost";
import type { AiChatUsage } from "@/models/ai-chat-message";
import { OPENROUTER_URL } from "@/services/ai-chat/openrouter-vision";
import { guidedSystem } from "./class-guide";

/**
 * The ONLY places the study module touches a model, so tests mock this one file.
 * Same plumbing as the whiteboard teacher AI: vision = `callVision` over the hardcoded
 * WHITEBOARD_VISION_MODELS chain (gpt-6.1-sol → gpt-5.6-sol via OpenRouter, cost reported by
 * OpenRouter); text = DeepSeek flash (`deepseekFlashModel()`, read at call time) in
 * json_object mode, cost derived with the chat billing table. Concept maps alone run their
 * text steps on STUDY_CM_TEXT_MODELS via OpenRouter first (`openRouterTextJson`, chained with
 * DeepSeek flash by ./cm-text). No env knobs.
 */
export const STUDY_VISION_MODELS = WHITEBOARD_VISION_MODELS;
const VISION_TIMEOUT_MS = 120_000;
/** Concept-map text chain (reference / grade / predict / notes digest): these first, then DeepSeek flash. */
export const STUDY_CM_TEXT_MODELS = ["openai/gpt-6.1-sol"] as const;
// A ~75k-token turn plus reasoning; the SSE pings keep the stream open meanwhile.
const CM_TEXT_TIMEOUT_MS = 300_000;

/** Running spend of one request, written to `study_ai_usages` when it settles. */
export interface Spend {
  models: string[];
  visionCostUsd: number;
  textCostUsd: number;
  /** ASR (services/study/asr.ts) — audio-input model calls via OpenRouter. */
  audioCostUsd?: number;
  /** generate_image — image model calls via OpenRouter /images. */
  imageCostUsd?: number;
}
export const newSpend = (): Spend => ({ models: [], visionCostUsd: 0, textCostUsd: 0, audioCostUsd: 0, imageCostUsd: 0 });
export const spendTotal = (s: Spend) => s.visionCostUsd + s.textCostUsd + (s.audioCostUsd ?? 0) + (s.imageCostUsd ?? 0);

export async function visionCall(
  image: Buffer | readonly Buffer[],
  mime: string,
  prompt: string,
  spend: Spend,
  opts: { signal?: AbortSignal; json?: boolean; timeoutMs?: number; deadlineMs?: number; reasoning?: Record<string, unknown> } = {}
): Promise<string> {
  try {
    const v = await callVision(image, mime, prompt, {
      signal: opts.signal,
      json: opts.json,
      timeoutMs: opts.timeoutMs ?? VISION_TIMEOUT_MS,
      deadlineMs: opts.deadlineMs,
      reasoning: opts.reasoning,
      models: STUDY_VISION_MODELS,
    });
    spend.visionCostUsd += v.costUsd;
    spend.models.push(...v.tried.slice(0, -1).map((m) => `openrouter/${m}`), v.model);
    return v.raw;
  } catch (e: any) {
    spend.visionCostUsd += Number(e?.costUsd) || 0;
    if (Array.isArray(e?.tried)) spend.models.push(...e.tried.map((m: string) => `openrouter/${m}`));
    throw e;
  }
}

/** One DeepSeek flash JSON call → parsed object (null when the reply was not JSON). */
export async function textJson(system: string, user: string, spend: Spend, opts: { signal?: AbortSignal; maxTokens?: number; disableThinking?: boolean } = {}): Promise<any> {
  const model = deepseekFlashModel();
  const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages: [
      { role: "system", content: guidedSystem(system) },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    max_tokens: opts.maxTokens ?? 8192,
    // Extraction-style calls: reasoning can eat the whole max_tokens budget and leave an empty reply.
    ...(opts.disableThinking ? ({ thinking: { type: "disabled" } } as object) : {}),
  };
  const res = await getDeepSeekClient().chat.completions.create(params, { signal: opts.signal });
  const u: any = res.usage;
  const usage: AiChatUsage | null = u
    ? {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        prompt_cache_hit_tokens: u.prompt_cache_hit_tokens,
        prompt_cache_miss_tokens: u.prompt_cache_miss_tokens,
        reasoning_tokens: u.completion_tokens_details?.reasoning_tokens,
      }
    : null;
  spend.textCostUsd += messageCostUsd(usage, String(res.model || model), new Date());
  spend.models.push(String(res.model || model));
  return parseJsonLoose(String(res.choices?.[0]?.message?.content ?? ""));
}

const usd = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * One OpenRouter JSON call per model of STUDY_CM_TEXT_MODELS, in order, until one answers with
 * parseable JSON → `{out, model}` (`model` = `openrouter/<id that answered>`). Throws when every
 * model failed (HTTP error incl. quota 402/429, timeout, a reply that is not JSON) — the caller
 * falls back to DeepSeek. Each tried model lands in `spend.models`; OpenRouter reports the cost.
 */
export async function openRouterTextJson(
  system: string,
  user: string,
  spend: Spend,
  opts: { signal?: AbortSignal; maxTokens?: number; timeoutMs?: number } = {}
): Promise<{ out: any; model: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  let lastError: unknown = null;
  for (const model of STUDY_CM_TEXT_MODELS) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const signal = AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(opts.timeoutMs ?? CM_TEXT_TIMEOUT_MS)]);
    const slot = spend.models.push(`openrouter/${model}`) - 1;
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          max_tokens: opts.maxTokens ?? 8192,
          usage: { include: true }, // without it OpenRouter omits usage.cost
          messages: [
            { role: "system", content: guidedSystem(system) },
            { role: "user", content: user },
          ],
        }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, any> | null;
      spend.textCostUsd += usd(body?.usage?.cost);
      if (!res.ok) throw new Error(`openrouter ${res.status}: ${String(body?.error?.message ?? "").slice(0, 200)}`);
      const out = parseJsonLoose(String(body?.choices?.[0]?.message?.content ?? ""));
      if (!out || typeof out !== "object") throw new Error("openrouter: reply was not JSON");
      const answered = `openrouter/${String(body?.model || model)}`;
      spend.models[slot] = answered;
      return { out, model: answered };
    } catch (e) {
      lastError = e;
      if (opts.signal?.aborted) throw e;
    }
  }
  throw new Error(`concept-map text chain failed: ${String((lastError as Error)?.message ?? lastError)}`);
}

/** Image generation chain for the MCP `generate_image` tool: flare (fast tier) first, then sunburst. */
export const STUDY_IMAGE_MODELS = ["openai/gpt-image-2.5-flare", "openai/gpt-image-2.5-sunburst"] as const;
export const STUDY_IMAGE_URL = "https://openrouter.ai/api/v1/images";
/** Per model — two attempts must still fit inside an MCP client's patience. */
const IMAGE_TIMEOUT_MS = 85_000;
export const IMAGE_SIZES = { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" } as const;
export type ImageShape = keyof typeof IMAGE_SIZES;

/**
 * One generated image → `{image, model}` (`model` = `openrouter/<id that answered>`). Tries
 * STUDY_IMAGE_MODELS in order; a non-2xx reply, a reply without image bytes or a per-model timeout
 * moves on, a caller abort does not. Every attempt lands in `spend.models`; OpenRouter reports cost.
 */
export async function imageGen(prompt: string, shape: ImageShape, spend: Spend, opts: { signal?: AbortSignal } = {}): Promise<{ image: Buffer; model: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  let lastError: unknown = null;
  for (const model of STUDY_IMAGE_MODELS) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const signal = AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(IMAGE_TIMEOUT_MS)]);
    const slot = spend.models.push(`openrouter/${model}`) - 1;
    try {
      const res = await fetch(STUDY_IMAGE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({ model, prompt, size: IMAGE_SIZES[shape], n: 1 }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, any> | null;
      spend.imageCostUsd = (spend.imageCostUsd ?? 0) + usd(body?.usage?.cost);
      if (!res.ok) throw new Error(`openrouter ${res.status}: ${String(body?.error?.message ?? "").slice(0, 200)}`);
      const b64 = body?.data?.[0]?.b64_json;
      if (typeof b64 !== "string" || !b64) throw new Error("openrouter: reply carried no image");
      const answered = `openrouter/${model}`;
      spend.models[slot] = answered;
      return { image: Buffer.from(b64, "base64"), model: answered };
    } catch (e) {
      lastError = e;
      if (opts.signal?.aborted) throw e;
    }
  }
  throw new Error(`image generation failed: ${String((lastError as Error)?.message ?? lastError)}`);
}

export function parseJsonLoose(raw: string): any {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}
