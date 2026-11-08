import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OPENROUTER_API_BASE } from "@/services/ai/openrouter-models";
import { ffmpeg, MediaToolError, probeDurationSec } from "./media-tools";
import { STUDY_ASR_MODELS } from "./asr";

/**
 * Voice dictation for the Ask-AI box: one short recording (≤ 120 s / 5 MB) → plain text.
 * Same provider, key and models as the lecture ASR (services/study/asr.ts) — OpenRouter chat
 * completions with an `input_audio` part, `OPENROUTER_API_KEY`, no new config. The recording
 * (Chrome webm/opus, Android mp4/aac) is normalised to mono 16 kHz mp3 first, the format the
 * audio models accept. This file and `asr.ts` are the only audio network calls, so tests mock
 * `transcribeDictation`.
 */
export const DICTATION_MAX_BYTES = 5 * 1024 * 1024;
export const DICTATION_MAX_SEC = 120;
const TIMEOUT_MS = 30_000;
const OPENROUTER_URL = `${OPENROUTER_API_BASE}/chat/completions`;


export class DictationError extends Error {
  /** Billed spend + models already tried when this error was raised (a billed reply can still fail to parse). */
  public costUsd = 0;
  public models: string[] = [];
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const ACCEPTED_AUDIO = /^audio\/(webm|mp4|x-m4a|m4a|aac|mpeg|mp3|ogg|wav|x-wav|wave)\b/i;

export const DICTATION_PROMPT = [
  "Transcribe this English voice recording verbatim.",
  "Do not translate, summarise or answer. Normal punctuation; drop filler like \"um\".",
  'Return ONE JSON object: {"text":"..."}. Silence or no speech → {"text":""}.',
].join("\n");

export interface DictationResult {
  text: string;
  model: string;
  costUsd: number;
  durationSec: number;
}

const toMp3 = async (audio: Buffer): Promise<{ mp3: Buffer; durationSec: number }> => {
  const dir = await mkdtemp(path.join(tmpdir(), "study-dictation-"));
  try {
    const input = path.join(dir, "in.bin");
    const out = path.join(dir, "out.mp3");
    await writeFile(input, audio);
    const durationSec = await probeDurationSec(input);
    if (durationSec !== null && durationSec > DICTATION_MAX_SEC + 1) {
      throw new DictationError(413, "PAYLOAD_TOO_LARGE", `Recording is longer than ${DICTATION_MAX_SEC} s`);
    }
    try {
      await ffmpeg(["-t", String(DICTATION_MAX_SEC + 1), "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "mp3", out], { timeoutMs: 20_000 });
    } catch (e) {
      if (e instanceof MediaToolError && e.code === "AUDIO_UNREADABLE") throw new DictationError(415, "UNSUPPORTED_AUDIO", "Couldn't read that recording");
      throw e;
    }
    // The conversion is capped at MAX+1 s, so a decoded length past MAX means the recording was
    // overlong — also when the container carried no duration (WebM from MediaRecorder).
    const outSec = await probeDurationSec(out);
    if (outSec !== null && outSec > DICTATION_MAX_SEC + 0.5) {
      throw new DictationError(413, "PAYLOAD_TOO_LARGE", `Recording is longer than ${DICTATION_MAX_SEC} s`);
    }
    const mp3 = await readFile(out);
    return { mp3, durationSec: durationSec ?? outSec ?? 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Recording bytes → text. Each model gets one try; throws DictationError (502 / 402) when all fail. */
export async function transcribeDictation(audio: Buffer, signal?: AbortSignal): Promise<DictationResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new DictationError(503, "AI_UNAVAILABLE", "OPENROUTER_API_KEY is not set — dictation needs it");
  const { mp3, durationSec } = await toMp3(audio);
  const data = mp3.toString("base64");
  let lastError = "";
  let quota = false;
  let costUsd = 0;
  const tried: string[] = [];
  for (const model of STUDY_ASR_MODELS) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Study dictation" },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          usage: { include: true },
          max_tokens: 4000,
          messages: [{ role: "user", content: [{ type: "text", text: DICTATION_PROMPT }, { type: "input_audio", input_audio: { data, format: "mp3" } }] }],
        }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, any> | null;
      // Billed the moment the provider answers, whether or not the reply is usable.
      const cost = Number(body?.usage?.cost);
      if (Number.isFinite(cost) && cost > 0) costUsd += cost;
      tried.push(`openrouter/${String(body?.model || model)}`);
      if (!res.ok) {
        if (res.status === 402) quota = true;
        throw new Error(`openrouter ${res.status}: ${String(body?.error?.message ?? "").slice(0, 200)}`);
      }
      const raw = String(body?.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      let text: string;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.text !== "string") throw new Error("no text");
        text = parsed.text;
      } catch {
        throw new Error("reply was not the text JSON");
      }
      return { text: text.replace(/\s+/g, " ").trim(), model: tried[tried.length - 1], costUsd, durationSec };
    } catch (e) {
      lastError = String((e as Error)?.message ?? e);
      if (signal?.aborted) break;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  const err = quota
    ? new DictationError(402, "AI_QUOTA", "AI credits ran out — the account needs a top-up")
    : new DictationError(502, "AI_UPSTREAM", `Couldn't transcribe the recording this time — try again (${lastError.slice(0, 120)})`);
  err.costUsd = costUsd;
  err.models = tried;
  throw err;
}
