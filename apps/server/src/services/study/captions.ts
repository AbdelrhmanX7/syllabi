import type { TranscriptSegment } from "@/models/study/transcript";

/**
 * YouTube captions → transcript segments. Pure functions (unit-tested).
 *
 * Auto captions "roll": in VTT every cue repeats the line before it and short 10 ms cues repeat
 * the new line again; json3 auto captions overlap in time. `dedupeRolling` drops, word-level, the
 * longest prefix of each cue that the text emitted so far already ends with — so the rolling
 * overlap disappears while genuinely new words always survive. `mergeSegments` then joins the
 * caption fragments into sentence-ish segments (≤ 15 s) the FE can show and seek to.
 */

/** Which ONE track to fetch: manual English beats auto; auto prefers the original ASR track. */
export function chooseCaptionTrack(info: { subtitles: string[]; autoCaptions: string[] }): { lang: string; auto: boolean } | null {
  const manual = info.subtitles.filter((l) => /^en([-_][A-Za-z]{2,4})?$/i.test(l));
  const m = manual.find((l) => l === "en") ?? manual.find((l) => /^en-US$/i.test(l)) ?? manual.find((l) => /^en-GB$/i.test(l)) ?? manual[0];
  if (m) return { lang: m, auto: false };
  const a = info.autoCaptions.find((l) => l === "en-orig") ?? info.autoCaptions.find((l) => l === "en");
  return a ? { lang: a, auto: true } : null;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const clean = (t: string) =>
  t
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_m, e) => ENT[e] ?? " ")
    .replace(/\s+/g, " ")
    .trim();

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** json3 (`events[].segs[].utf8`, ms times). Append-only newline events are skipped. */
export function parseJson3(raw: string): TranscriptSegment[] {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: TranscriptSegment[] = [];
  for (const ev of Array.isArray(j?.events) ? j.events : []) {
    if (!Array.isArray(ev?.segs)) continue;
    const text = clean(ev.segs.map((s: any) => String(s?.utf8 ?? "")).join(""));
    if (!text) continue;
    const start = Number(ev.tStartMs) / 1000;
    const dur = Number(ev.dDurationMs) / 1000;
    if (!Number.isFinite(start)) continue;
    out.push({ start: r3(start), end: r3(start + (Number.isFinite(dur) && dur > 0 ? dur : 0)), text });
  }
  return out;
}

const vttTime = (t: string) => {
  const m = t.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
};

/** WebVTT cues (tags such as `<c>` and `<00:00:01.200>` stripped). */
export function parseVtt(raw: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const block of raw.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->");
    const start = vttTime(a);
    const end = vttTime((b ?? "").trim().split(/\s+/)[0] ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const text = clean(lines.slice(at + 1).join(" "));
    if (text) out.push({ start: r3(start), end: r3(end), text });
  }
  return out;
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
const MAX_OVERLAP = 60;

/** Drop the rolling repeat at the head of every cue (see file comment). */
export function dedupeRolling(segs: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let tail: string[] = []; // normalised words emitted so far (last MAX_OVERLAP)
  for (const s of [...segs].sort((x, y) => x.start - y.start)) {
    const words = s.text.split(/\s+/).filter(Boolean);
    const nw = words.map(norm);
    let k = Math.min(nw.length, tail.length, MAX_OVERLAP);
    for (; k > 0; k--) {
      let ok = true;
      for (let i = 0; i < k && ok; i++) ok = tail[tail.length - k + i] === nw[i];
      if (ok) break;
    }
    const fresh = words.slice(k);
    if (!fresh.length || !fresh.some((w) => norm(w))) continue;
    out.push({ start: s.start, end: s.end, text: fresh.join(" ") });
    tail = [...tail, ...nw.slice(k)].slice(-MAX_OVERLAP);
  }
  // Overlapping auto-caption timings: a segment ends no later than the next one starts.
  for (let i = 0; i < out.length - 1; i++) if (out[i].end > out[i + 1].start) out[i].end = Math.max(out[i].start, out[i + 1].start);
  return out;
}

/** Join fragments into segments of ≥ `minSec` (or a sentence end), never longer than `maxSec`. */
export function mergeSegments(segs: TranscriptSegment[], minSec = 6, maxSec = 15): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let cur: TranscriptSegment | null = null;
  for (const s of segs) {
    if (cur && s.end - cur.start <= maxSec && !(cur.end - cur.start >= minSec) && !(/[.?!]$/.test(cur.text) && cur.end - cur.start >= 2)) {
      cur.text = `${cur.text} ${s.text}`;
      cur.end = Math.max(cur.end, s.end);
      continue;
    }
    if (cur) out.push(cur);
    cur = { ...s };
  }
  if (cur) out.push(cur);
  return out;
}

export function captionsToSegments(raw: string, format: "json3" | "vtt"): TranscriptSegment[] {
  return mergeSegments(dedupeRolling(format === "json3" ? parseJson3(raw) : parseVtt(raw)));
}
