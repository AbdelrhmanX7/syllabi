import { OPENROUTER_URL } from "@/services/ai-chat/openrouter-vision";

const TIMEOUT_MS = 60_000;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * The models every whiteboard read goes through (crops, pages, verification), in order.
 * Whiteboard-only and hardcoded: the /ai chat crop reader keeps its own setting (chosen there on
 * an arrow-direction bake-off this one has not re-run).
 *
 * Measured 2026-10-04 on the whiteboard fixtures, gpt-6.1-sol vs the previous gpt-5.6-sol (and
 * gpt-6-luna): handwriting crop 4/4 vs 3/4 (5.6 once "corrected" a 15 to 12); page verdicts 2/2 both;
 * typo hunt 3/3 vs 1/3 with 0 false flags on a clean strip; marks check equal; ~5× cheaper per
 * crop and ~2× faster. Luna failed the typo/literal roles (false spelling flags on correct words), so it is
 * not used here. 5.6-sol stays as the fallback.
 */
export const WHITEBOARD_VISION_MODELS = ["openai/gpt-6.1-sol", "openai/gpt-5.6-sol"] as const;
export const cropModels = (): string[] => [...WHITEBOARD_VISION_MODELS];

type Fetch = typeof fetch;

export interface VisionCall {
  raw: string;
  model: string;
  costUsd: number;
  /** Every model tried, in order, including the ones that failed. */
  tried: string[];
}

/**
 * One image (or several, all in the same user turn) + one instruction through the crop-reader
 * chain: each model gets one try, the next is the fallback. Throws only when all of them failed (with `costUsd` + `tried` attached).
 * `json` asks for `json_object` output — the caller's prompt must spell out the shape.
 */
export async function callVision(
  image: Buffer | readonly Buffer[],
  mimeType: string,
  instruction: string,
  opts: {
    signal?: AbortSignal;
    fetchImpl?: Fetch;
    json?: boolean;
    timeoutMs?: number;
    models?: readonly string[];
    /** OpenRouter `reasoning` param, e.g. `{ enabled: false }` for a fast classification. */
    reasoning?: Record<string, unknown>;
    /** Image detail; "high" by default — "low" is enough for a gist. */
    detail?: "low" | "high";
    /**
     * Total budget across the whole chain (ms). Each attempt gets min(timeoutMs, time left) and
     * no further model is tried once it is spent; the throw then carries `timedOut: true`.
     * Unset (the whiteboard default) = no overall cap, each model gets the full `timeoutMs`.
     */
    deadlineMs?: number;
  } = {}
): Promise<VisionCall> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set — the whiteboard reader needs it");
  const doFetch = opts.fetchImpl ?? fetch;
  const images = Buffer.isBuffer(image) ? [image] : image;
  const tried: string[] = [];
  let costUsd = 0;
  let lastError: unknown = null;
  let timedOut = false;
  const endAt = opts.deadlineMs !== undefined ? Date.now() + opts.deadlineMs : Infinity;

  for (const model of opts.models ?? cropModels()) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const left = endAt - Date.now();
    // Under ~50 ms left (timer jitter) a further model has no chance — stop.
    if (left < 50) {
      timedOut = true;
      break;
    }
    tried.push(model);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let fired = false;
    timedOut = false;
    const timer = setTimeout(() => {
      fired = true;
      controller.abort();
    }, Math.min(opts.timeoutMs ?? TIMEOUT_MS, left));
    timer.unref?.();
    try {
      const res = await doFetch(OPENROUTER_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: 0,
          ...(opts.json ? { response_format: { type: "json_object" } } : {}),
          ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: instruction },
                ...images.map((b) => ({ type: "image_url", image_url: { url: `data:${mimeType};base64,${b.toString("base64")}`, detail: opts.detail ?? "high" } })),
              ],
            },
          ],
        }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, any> | null;
      costUsd += num(body?.usage?.cost);
      if (!res.ok) throw new Error(`openrouter ${res.status}: ${String(body?.error?.message ?? "").slice(0, 200)}`);
      const raw = String(body?.choices?.[0]?.message?.content ?? "").trim();
      if (opts.json && !raw) throw new Error("openrouter: empty json body");
      return { raw, model: `openrouter/${String(body?.model || model)}`, costUsd, tried };
    } catch (error) {
      lastError = error;
      timedOut = fired;
      if (opts.signal?.aborted) throw error;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw Object.assign(new Error(`vision failed: ${String((lastError as Error)?.message ?? lastError)}`), { costUsd, tried, timedOut });
}
