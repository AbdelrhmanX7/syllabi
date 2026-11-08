/**
 * Text-AI provider configuration (env-driven).
 *
 *   AI_PROVIDER        "deepseek" (default) | "gemini" — only reported; the study module calls DeepSeek.
 *   DEEPSEEK_API_KEY   required for text features (tutor, concept maps, question generation, ...)
 *   DEEPSEEK_BASE_URL  default https://api.deepseek.com (any OpenAI-compatible endpoint works)
 *   DEEPSEEK_MODEL     default "deepseek-v4-flash"
 */
import OpenAI from "openai";

export type AiProvider = "gemini" | "deepseek";

export function getAiProvider(): AiProvider {
  return (process.env.AI_PROVIDER || "").trim().toLowerCase() === "gemini" ? "gemini" : "deepseek";
}

export function isDeepSeek(): boolean {
  return getAiProvider() === "deepseek";
}

export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

export function deepseekFlashModel(): string {
  return (process.env.DEEPSEEK_MODEL || "").trim() || DEFAULT_DEEPSEEK_MODEL;
}

export function deepseekProModel(): string {
  return (process.env.DEEPSEEK_MODEL_PRO || "").trim() || deepseekFlashModel();
}

let deepSeekClient: OpenAI | null = null;

export function getDeepSeekClient(): OpenAI {
  if (!deepSeekClient) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set (needed for the study module's text AI features).");
    deepSeekClient = new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL });
  }
  return deepSeekClient;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
