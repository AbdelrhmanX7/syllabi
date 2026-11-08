import { JEV_DECISIONS_URL, JEV_MODEL } from "@/services/ai/jev-models";
import type { ClaudeTier } from "@/services/ai/claude";

/**
 * Picks the Claude tier for one request with ONE call to the small Jev router (OpenRouter
 * decisions endpoint, same request shape as services/study/ink-classify.ts): three yes/no
 * questions about the request. Leans cheap so the monthly credit reaches more people:
 *   clearly hard (multi-step reasoning / math / proof), said with confidence → opus
 *   simple and short (lookup, quick rewording, small classification) and not long → haiku
 *   anything else → sonnet
 * Only the feature name and the first part of the request are sent, never a whole course pack.
 * A failure, a garbled answer or the 3 s timeout → sonnet.
 */

export const ROUTER_TIMEOUT_MS = 3_000;
export const ROUTER_SNIPPET_CHARS = 2_500;
export const HARD_CONFIDENCE = 0.7;
export const SIMPLE_CONFIDENCE = 0.6;

const YES_NO = (yes: string, no: string) => ({
  yes: { what: yes, examples: [] as string[] },
  no: { what: no, examples: [] as string[] },
});

export function buildRouterRequest(feature: string, request: string): Record<string, unknown> {
  const snippet = request.length > ROUTER_SNIPPET_CHARS ? `${request.slice(0, ROUTER_SNIPPET_CHARS)}\n…(cut)` : request;
  return {
    model: JEV_MODEL,
    state: { feature, request: snippet },
    questions: {
      hard: {
        type: "choice",
        instructions: { question: "Is `request` a clearly hard problem that needs careful multi-step reasoning, such as a math proof, a long derivation, a tricky physics or programming problem, or grading a multi-step solution?" },
        criteria: YES_NO("clearly hard, multi-step reasoning is needed", "not especially hard"),
      },
      simple: {
        type: "choice",
        instructions: { question: "Is `request` a simple, short ask, such as a quick fact, a definition, rewording, a short summary or a small classification?" },
        criteria: YES_NO("simple and short", "not simple"),
      },
      long: {
        type: "choice",
        instructions: { question: "Does answering `request` need a long, careful written output (many questions, a full plan, a long explanation)?" },
        criteria: YES_NO("needs a long careful output", "a short or medium answer is enough"),
      },
    },
  };
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Yes-confidence of one answer (0 when it is "no" or off-contract). */
function yes(answers: unknown, key: string): number {
  const a = isObj(answers) ? answers[key] : undefined;
  if (!isObj(a) || a.choice !== "yes") return 0;
  const c = typeof a.confidence === "number" && Number.isFinite(a.confidence) ? a.confidence : 0;
  return Math.min(1, Math.max(0, c));
}

/** Answers → tier. Pure, so the mapping is tested without a network. */
export function tierFromAnswers(answers: unknown): ClaudeTier {
  if (yes(answers, "hard") >= HARD_CONFIDENCE) return "opus";
  if (yes(answers, "simple") >= SIMPLE_CONFIDENCE && yes(answers, "long") < 0.5) return "haiku";
  return "sonnet";
}

export interface RouteResult {
  tier: ClaudeTier;
  /** What the router call cost (OpenRouter reports it); 0 when it failed before an answer. */
  costUsd: number;
  /** The router model when it answered, else null (fell back to sonnet). */
  model: string | null;
}

export async function routeClaudeTier(
  feature: string,
  request: string,
  opts: { signal?: AbortSignal; apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<RouteResult> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) return { tier: "sonnet", costUsd: 0, model: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? ROUTER_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await (opts.fetchImpl ?? fetch)(JEV_DECISIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildRouterRequest(feature, request)),
      signal: ctrl.signal,
    });
    if (!res.ok) return { tier: "sonnet", costUsd: 0, model: null };
    const data: any = await res.json();
    return { tier: tierFromAnswers(data?.answers), costUsd: Number(data?.usage?.cost ?? 0) || 0, model: typeof data?.model === "string" ? data.model : JEV_MODEL };
  } catch {
    return { tier: "sonnet", costUsd: 0, model: null };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
