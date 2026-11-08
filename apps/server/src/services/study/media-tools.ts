import { execFile } from "child_process";
import fs from "fs";
import path from "path";

/**
 * The ONLY place the study module shells out to yt-dlp / ffmpeg / ffprobe, so tests mock this
 * one file. Prod has `/usr/local/bin/yt-dlp` + `/usr/bin/ffmpeg`; dev resolves them on PATH.
 * Every call takes argv (execFile, never a shell) and a hard timeout.
 */

const YT_DLP = fs.existsSync("/usr/local/bin/yt-dlp") ? "/usr/local/bin/yt-dlp" : "yt-dlp";
const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export class MediaToolError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

function run(bin: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer ?? 8 << 20, signal: opts.signal, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr ?? "") }));
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** yt-dlp stderr → a stable error code. Datacenter IPs get the "confirm you're not a bot" wall. */
export function ytDlpError(e: any): MediaToolError {
  const msg = String(e?.stderr || e?.message || e);
  const line = msg.split("\n").reverse().find((l) => /ERROR:/.test(l)) ?? msg.split("\n").filter(Boolean).pop() ?? "yt-dlp failed";
  if (/confirm you.?re not a bot|sign in to confirm/i.test(msg)) return new MediaToolError("YouTube blocked this server (sign-in / bot check)", "YOUTUBE_BLOCKED");
  if (/HTTP Error 429|Too Many Requests/i.test(msg)) return new MediaToolError("YouTube rate-limited this server (429)", "YOUTUBE_RATE_LIMITED");
  if (/Video unavailable|Private video|has been removed|members-only|not available/i.test(msg)) return new MediaToolError(line.replace(/^.*ERROR:\s*/, "").slice(0, 200), "VIDEO_UNAVAILABLE");
  if (e?.code === "ENOENT") return new MediaToolError("yt-dlp is not installed on this server", "TOOL_MISSING");
  return new MediaToolError(line.replace(/^.*ERROR:\s*/, "").slice(0, 200), "YTDLP_FAILED");
}

const COMMON = ["--no-playlist", "--no-warnings", "--no-progress", "--socket-timeout", "30"];

export interface YtInfo {
  durationSec: number | null;
  /** Manual subtitle languages ("en-US", …). */
  subtitles: string[];
  /** Automatic caption languages ("en", "en-orig", "en-en-US", …). */
  autoCaptions: string[];
}

export async function ytDlpInfo(videoId: string, signal?: AbortSignal): Promise<YtInfo> {
  if (!YOUTUBE_ID_RE.test(videoId)) throw new MediaToolError("Invalid YouTube id", "VIDEO_UNAVAILABLE");
  try {
    const { stdout } = await run(YT_DLP, [...COMMON, "--skip-download", "--dump-single-json", "--", videoId], { timeoutMs: 90_000, signal, maxBuffer: 128 << 20 });
    const j = JSON.parse(stdout);
    const d = Number(j?.duration);
    return {
      durationSec: Number.isFinite(d) && d > 0 ? Math.round(d) : null,
      subtitles: Object.keys(j?.subtitles ?? {}),
      autoCaptions: Object.keys(j?.automatic_captions ?? {}),
    };
  } catch (e) {
    if (e instanceof SyntaxError) throw new MediaToolError("yt-dlp returned unreadable metadata", "YTDLP_FAILED");
    throw ytDlpError(e);
  }
}

/** Download exactly ONE subtitle track (json3 preferred, vtt fallback) → its file, or null. */
export async function ytDlpSubtitle(videoId: string, lang: string, auto: boolean, dir: string, signal?: AbortSignal): Promise<{ file: string; format: "json3" | "vtt" } | null> {
  if (!YOUTUBE_ID_RE.test(videoId)) throw new MediaToolError("Invalid YouTube id", "VIDEO_UNAVAILABLE");
  try {
    await run(
      YT_DLP,
      [...COMMON, "--skip-download", auto ? "--write-auto-subs" : "--write-subs", "--sub-langs", lang, "--sub-format", "json3/vtt", "-o", path.join(dir, "subs.%(ext)s"), "--", videoId],
      { timeoutMs: 90_000, signal }
    );
  } catch (e) {
    throw ytDlpError(e);
  }
  const names = await fs.promises.readdir(dir);
  const pick = names.find((n) => n.startsWith("subs.") && n.endsWith(".json3")) ?? names.find((n) => n.startsWith("subs.") && n.endsWith(".vtt"));
  return pick ? { file: path.join(dir, pick), format: pick.endsWith(".json3") ? "json3" : "vtt" } : null;
}

/** Best audio-only stream → a file in `dir`. */
export async function ytDlpAudio(videoId: string, dir: string, signal?: AbortSignal): Promise<string> {
  if (!YOUTUBE_ID_RE.test(videoId)) throw new MediaToolError("Invalid YouTube id", "VIDEO_UNAVAILABLE");
  try {
    await run(YT_DLP, [...COMMON, "-f", "bestaudio/best", "-o", path.join(dir, "audio.%(ext)s"), "--", videoId], { timeoutMs: 30 * 60_000, signal });
  } catch (e) {
    throw ytDlpError(e);
  }
  const name = (await fs.promises.readdir(dir)).find((n) => n.startsWith("audio.") && !n.endsWith(".part"));
  if (!name) throw new MediaToolError("yt-dlp produced no audio file", "YTDLP_FAILED");
  return path.join(dir, name);
}

export async function ffmpeg(args: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  try {
    await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { timeoutMs: opts.timeoutMs ?? 20 * 60_000, signal: opts.signal });
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new MediaToolError("ffmpeg is not installed on this server", "TOOL_MISSING");
    throw new MediaToolError(`ffmpeg failed: ${String(e?.stderr || e?.message || e).trim().split("\n").pop()?.slice(0, 200)}`, "AUDIO_UNREADABLE");
  }
}

/** Container duration in seconds (ffprobe), null when it cannot be read. */
export async function probeDurationSec(file: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { timeoutMs: 60_000, signal });
    const d = Number(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}
