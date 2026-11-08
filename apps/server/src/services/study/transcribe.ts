import fs from "fs";
import path from "path";
import type { TranscriptSegment } from "@/models/study/transcript";
import { asrChunk } from "./asr";
import { Spend } from "./ai-models";
import { ffmpeg, probeDurationSec, MediaToolError } from "./media-tools";

/**
 * Audio file → transcript segments: cut into ≤ 10-min mono 16 kHz mp3 chunks (ffmpeg), ASR each
 * in order (one at a time — the job lane is already 1 per process), stitch with offsets.
 */
export const ASR_CHUNK_SEC = 600;
export const ASR_MAX_SEC = 4 * 3600;

/** Per-chunk clip-relative segments → one timeline (offset added, clamped to each chunk). */
export function stitchChunks(parts: { offset: number; durationSec: number; segments: TranscriptSegment[] }[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const p of [...parts].sort((a, b) => a.offset - b.offset)) {
    for (const s of p.segments) {
      const start = p.offset + Math.min(Math.max(0, s.start), p.durationSec);
      const end = p.offset + Math.min(Math.max(s.start, s.end), p.durationSec);
      out.push({ start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, text: s.text });
    }
  }
  return out;
}

export async function transcribeAudioFile(
  file: string,
  workDir: string,
  spend: Spend,
  opts: { signal?: AbortSignal; durationSec?: number | null } = {}
): Promise<{ segments: TranscriptSegment[]; durationSec: number }> {
  const duration = (await probeDurationSec(file, opts.signal)) ?? opts.durationSec ?? null;
  if (!duration) throw new MediaToolError("Could not read the audio duration", "AUDIO_UNREADABLE");
  if (duration > ASR_MAX_SEC) throw new MediaToolError(`Audio is longer than ${ASR_MAX_SEC / 3600} h`, "AUDIO_TOO_LONG");
  const n = Math.max(1, Math.ceil(duration / ASR_CHUNK_SEC - 0.02));
  const parts: { offset: number; durationSec: number; segments: TranscriptSegment[] }[] = [];
  for (let i = 0; i < n; i++) {
    const offset = i * ASR_CHUNK_SEC;
    const len = Math.min(ASR_CHUNK_SEC, duration - offset);
    if (len <= 0.5) break;
    const out = path.join(workDir, `asr-${String(i).padStart(3, "0")}.mp3`);
    await ffmpeg(["-ss", String(offset), "-t", String(len), "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "mp3", out], { signal: opts.signal });
    const audio = await fs.promises.readFile(out);
    const segments = await asrChunk(audio, "mp3", len, spend, opts.signal);
    await fs.promises.rm(out, { force: true });
    parts.push({ offset, durationSec: len, segments });
  }
  return { segments: stitchChunks(parts), durationSec: Math.round(duration) };
}

/** Plain text of a transcript, with a `[mm:ss]` marker about every minute (models + search context). */
export function transcriptText(segments: TranscriptSegment[]): string {
  let lastMark = -Infinity;
  const lines: string[] = [];
  for (const s of segments) {
    if (s.start - lastMark >= 60) {
      const m = Math.floor(s.start / 60);
      lines.push(`\n[${String(m).padStart(2, "0")}:${String(Math.floor(s.start % 60)).padStart(2, "0")}]`);
      lastMark = s.start;
    }
    lines.push(s.text);
  }
  return lines.join(" ").replace(/ \n/g, "\n").trim();
}
