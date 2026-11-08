import { OPENROUTER_API_BASE } from "@/services/ai/openrouter-models";
import type { TranscriptSegment } from "@/models/study/transcript";
import { parseJsonLoose, Spend } from "./ai-models";

/**
 * English speech-to-text for the study module — the ONLY network call for audio, so tests mock
 * this one file. Same provider + key the platform's audio work already uses
 * (services/asr/asr-english-assist.service.ts): OpenRouter chat completions with an
 * `input_audio` part, `OPENROUTER_API_KEY`, cost reported by OpenRouter (`usage.cost`).
 *
 * Models are hardcoded (no env knobs): Gemini flash-lite first — audio at $0.30/M tokens
 * (~32 tokens/s ⇒ ~$0.006 per 10-min chunk of input) — then Gemini flash as the fallback.
 * The caller cuts audio into ≤ 10-min mono 16 kHz mp3 chunks (≈ 2.4 MB, well under the
 * request-size limit) and stitches the per-chunk timestamps (services/study/transcribe.ts).
 */
export const STUDY_ASR_MODELS = ["google/gemini-3.5-flash-lite", "google/gemini-3.5-flash"] as const;
const URL = `${OPENROUTER_API_BASE}/chat/completions`;
const TIMEOUT_MS = 240_000;

export const ASR_PROMPT = (clipSec: number) =>
  [
    `Transcribe this English lecture audio clip (${Math.round(clipSec)} s long) verbatim.`,
    'Return ONE JSON object: {"segments":[{"start":0.0,"end":4.2,"text":"..."}]}',
    "Rules:",
    "- start/end: seconds from the START OF THIS CLIP (numbers, one decimal). Segments in order, not overlapping, each one or two sentences and at most ~15 s.",
    "- text: exactly what is said, with normal punctuation and capitalisation. Say math the way it is spoken (\"x squared\", \"the integral of\"). Drop filler like \"um\".",
    "- Do not summarise, translate, or add commentary. Unclear words: best guess, never a placeholder.",
    '- Silence, music only, or no speech → {"segments":[]}.',
  ].join("\n");

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = v.trim().match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    return Number(v);
  }
  return NaN;
};

/**
 * Model segments → clean, clip-relative segments: times clamped to [0, clipSec] and made
 * monotonic. A reply with no usable timing (all zero / missing) is spread over the clip by text
 * length, so a transcript is never lost to bad timestamps.
 */
export function normaliseAsrSegments(raw: unknown, clipSec: number): TranscriptSegment[] {
  const list = Array.isArray(raw) ? raw : [];
  const segs = list
    .map((s: any) => ({ start: num(s?.start), end: num(s?.end), text: typeof s?.text === "string" ? s.text.replace(/\s+/g, " ").trim() : "" }))
    .filter((s) => s.text);
  if (!segs.length) return [];
  const timed = segs.filter((s) => Number.isFinite(s.start) && s.start >= 0);
  const spread = timed.length < segs.length || segs.every((s) => !s.start && !s.end);
  if (spread) {
    const total = segs.reduce((n, s) => n + s.text.length, 0) || 1;
    let t = 0;
    return segs.map((s) => {
      const d = (s.text.length / total) * clipSec;
      const out = { start: r1(t), end: r1(Math.min(clipSec, t + d)), text: s.text };
      t += d;
      return out;
    });
  }
  const out: TranscriptSegment[] = [];
  let prev = 0;
  for (const s of segs) {
    const start = Math.min(clipSec, Math.max(prev, s.start));
    let end = Number.isFinite(s.end) ? Math.min(clipSec, s.end) : start;
    if (end < start) end = start;
    out.push({ start: r1(start), end: r1(end), text: s.text });
    prev = start;
  }
  for (let i = 0; i < out.length - 1; i++) if (out[i].end > out[i + 1].start) out[i].end = out[i + 1].start;
  return out;
}
const r1 = (n: number) => Math.round(n * 10) / 10;

/** One audio chunk → clip-relative segments. Each model gets one try; throws when all failed. */
export async function asrChunk(audio: Buffer, format: "mp3" | "wav", clipSec: number, spend: Spend, signal?: AbortSignal): Promise<TranscriptSegment[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set — study ASR needs it");
  let lastError: unknown = null;
  for (const model of STUDY_ASR_MODELS) {
    if (signal?.aborted) throw new Error("aborted");
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetch(URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Study ASR" },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          usage: { include: true },
          max_tokens: 32_000,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: ASR_PROMPT(clipSec) },
                { type: "input_audio", input_audio: { data: audio.toString("base64"), format } },
              ],
            },
          ],
        }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, any> | null;
      const cost = Number(body?.usage?.cost);
      if (Number.isFinite(cost) && cost > 0) spend.audioCostUsd = (spend.audioCostUsd ?? 0) + cost;
      spend.models.push(`openrouter/${String(body?.model || model)}`);
      if (!res.ok) throw new Error(`openrouter ${res.status}: ${String(body?.error?.message ?? "").slice(0, 200)}`);
      const parsed = parseJsonLoose(String(body?.choices?.[0]?.message?.content ?? ""));
      if (!parsed || !Array.isArray(parsed.segments)) throw new Error("ASR reply was not the segments JSON");
      return normaliseAsrSegments(parsed.segments, clipSec);
    } catch (e) {
      lastError = e;
      if (signal?.aborted) throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new Error(`ASR failed: ${String((lastError as Error)?.message ?? lastError)}`);
}
