import type OpenAI from "openai";
import { deepseekFlashModel, getDeepSeekClient } from "@/services/ai/config";
import { messageCostUsd } from "@/services/ai-chat/cost";
import type { AiChatUsage } from "@/models/ai-chat-message";
import type { Spend } from "./ai-models";
import { claudeForSpend, type ClaudeChoice } from "./ai-claude";

/**
 * Streaming DeepSeek flash text call (sibling of `textJson` in ./ai-models, kept in its own
 * file so tests mock it alone). `aiText.generateContent` has no streaming path, so this talks
 * to the OpenAI-compatible DeepSeek client directly with `stream: true` and reads the final
 * usage chunk (`stream_options.include_usage`) for the spend. Reasoning deltas are not
 * forwarded — only `content`.
 */
export async function textStream(
  system: string,
  user: string,
  spend: Spend,
  onDelta: (text: string) => void,
  opts: { signal?: AbortSignal; maxTokens?: number; claude?: ClaudeChoice } = {}
): Promise<string> {
  if (spend.route !== "premium") {
    // Non-premium: Claude (router-picked tier); DeepSeek only when Claude is unavailable and
    // nothing was streamed yet — see ./ai-claude.
    return claudeForSpend(spend, {
      kind: "text",
      choice: opts.claude ?? "auto",
      system,
      user,
      maxTokens: opts.maxTokens ?? 4096,
      signal: opts.signal,
      onDelta,
      deepseek: () => deepseekStream(system, user, spend, onDelta, opts),
    });
  }
  return deepseekStream(system, user, spend, onDelta, opts);
}

async function deepseekStream(system: string, user: string, spend: Spend, onDelta: (text: string) => void, opts: { signal?: AbortSignal; maxTokens?: number }): Promise<string> {
  const model = deepseekFlashModel();
  const params: OpenAI.ChatCompletionCreateParamsStreaming = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: opts.maxTokens ?? 4096,
    stream: true,
    stream_options: { include_usage: true },
  };
  const stream = await getDeepSeekClient().chat.completions.create(params, { signal: opts.signal });
  let full = "";
  let usageRaw: any = null;
  let served = model;
  try {
    for await (const chunk of stream) {
      if (chunk.model) served = chunk.model;
      if (chunk.usage) usageRaw = chunk.usage;
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) {
        full += text;
        onDelta(text);
      }
    }
  } finally {
    const u = usageRaw;
    const usage: AiChatUsage | null = u
      ? {
          prompt_tokens: u.prompt_tokens,
          completion_tokens: u.completion_tokens,
          prompt_cache_hit_tokens: u.prompt_cache_hit_tokens,
          prompt_cache_miss_tokens: u.prompt_cache_miss_tokens,
          reasoning_tokens: u.completion_tokens_details?.reasoning_tokens,
        }
      : null;
    spend.textCostUsd += messageCostUsd(usage, String(served), new Date());
    spend.models.push(String(served));
  }
  return full;
}
