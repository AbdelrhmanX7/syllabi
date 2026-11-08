/**
 * OpenRouter model catalogue — `GET https://openrouter.ai/api/v1/models`.
 *
 * Public (no key needed) and free. Shared by the model probe (is this id real, and does
 * it take audio?) and the ASR English-assist model picker. Callers own any caching.
 */

export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODELS_URL = `${OPENROUTER_API_BASE}/models`;

/** The subset of a catalogue row this codebase reads. Pricing values arrive as STRINGS. */
export interface OpenRouterModelRow {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: Record<string, unknown>;
}

/** Throws on a non-2xx or a body without a `data` array. */
export async function fetchOpenRouterModels(signal?: AbortSignal): Promise<OpenRouterModelRow[]> {
  const res = await fetch(OPENROUTER_MODELS_URL, { signal });
  if (!res.ok) throw new Error(`GET ${OPENROUTER_MODELS_URL} → HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (!body || !Array.isArray(body.data)) throw new Error(`GET ${OPENROUTER_MODELS_URL} → no data array`);
  return (body.data as OpenRouterModelRow[]).filter((m) => m && typeof m.id === "string");
}

export const acceptsImageInput = (m: OpenRouterModelRow): boolean =>
  Array.isArray(m.architecture?.input_modalities) && m.architecture!.input_modalities!.includes("image");

export const producesImageOutput = (m: OpenRouterModelRow): boolean =>
  Array.isArray(m.architecture?.output_modalities) && m.architecture!.output_modalities!.includes("image");

export const producesTextOutput = (m: OpenRouterModelRow): boolean =>
  Array.isArray(m.architecture?.output_modalities) && m.architecture!.output_modalities!.includes("text");

export const acceptsAudioInput =(m: OpenRouterModelRow): boolean =>
  Array.isArray(m.architecture?.input_modalities) && m.architecture!.input_modalities!.includes("audio");
