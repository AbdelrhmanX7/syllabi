import { OPENROUTER_API_BASE } from "@/services/ai/openrouter-models";

/** OpenRouter's chat-completions endpoint, shared by the vision callers (whiteboard-ai/vision, study/ai-models). */
export const OPENROUTER_URL = `${OPENROUTER_API_BASE}/chat/completions`;
