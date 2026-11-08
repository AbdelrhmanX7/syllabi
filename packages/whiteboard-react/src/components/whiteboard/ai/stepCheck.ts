import { extractJsonObject } from './markdownBlocks';

import type { SceneRect, TermCluster } from './types';

/**
 * «Check this page» as a STEP checker — the pure half.
 *
 * The page's handwriting is grouped into LINES (one line = one step of a worked solution). The
 * lines go to the vision model as tagged ink groups (`POST /study/ai/board-actions`, the only route
 * where the model sees the picture AND answers with positions), with a question that asks for one
 * `point_at` per step whose note starts with the line tag and a verdict token:
 *
 *   {"type":"point_at","at":{"x":…,"y":…},"note":"[3] WRONG: d/dx ln(3x) = 1/x, not 3/x"}
 *
 * and a `say` laid out as «CORRECT: … MISTAKES: … MISSING: … NOTE: …» (the server collapses
 * newlines, so the sections are found by their labels). This module builds that request and reads
 * the reply back into steps anchored to real ink lines, plus panel sections. The model's point is
 * only a fallback: a note that names its line is anchored to that line's real box.
 */

export type StepVerdict = 'correct' | 'wrong' | 'warning';

export interface StepLine {
  /** `L1`…`Ln`, top → bottom. */
  id: string;
  /** Union of the line's ink, scene units. */
  rect: SceneRect;
}

export interface CheckedStep {
  lineId: string;
  /** 1-based line number (the tag the model saw). */
  n: number;
  verdict: StepVerdict;
  note: string;
}

export interface StepCheckSections {
  correct: string[];
  mistakes: string[];
  missing: string[];
  info: string[];
}

export interface StepCheckResult {
  steps: CheckedStep[];
  sections: StepCheckSections;
}

/** The server keeps at most this many actions — one per step. */
export const STEP_CHECK_MAX_MARKS = 12;
/** Ink groups the request carries; a page with more lines keeps its first ones. */
export const STEP_CHECK_MAX_LINES = 60;

const SEVERITY: Record<StepVerdict, number> = { wrong: 3, warning: 2, correct: 1 };

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

const verticalOverlap = (a: SceneRect, b: SceneRect) => Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);

const union = (a: SceneRect, b: SceneRect): SceneRect => {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);

  return { left, top, width: Math.max(a.left + a.width, b.left + b.width) - left, height: Math.max(a.top + a.height, b.top + b.height) - top };
};

/**
 * Word/term clusters (or raw stroke boxes) → written LINES, top to bottom. Two boxes share a line
 * when they overlap vertically by at least `minOverlap` of the shorter one — a tall fraction or an
 * integral sign joins the line it sits in, a superscript joins its base, the next line down does not.
 */
export function groupInkLines(rects: SceneRect[], { minOverlap = 0.3 }: { minOverlap?: number } = {}): StepLine[] {
  const boxes = rects.filter((rect) => rect.width > 0 && rect.height > 0).sort((a, b) => a.top + a.height / 2 - (b.top + b.height / 2));
  const lines: SceneRect[] = [];

  for (const box of boxes) {
    let best = -1;
    let bestRatio = 0;

    lines.forEach((line, index) => {
      const ratio = verticalOverlap(line, box) / Math.max(1e-6, Math.min(line.height, box.height));

      if (ratio >= minOverlap && ratio > bestRatio) {
        best = index;
        bestRatio = ratio;
      }
    });

    if (best >= 0) lines[best] = union(lines[best]!, box);
    else lines.push({ ...box });
  }

  // A merge can grow a line into its neighbour: settle until no two lines still qualify.
  let merged = true;

  while (merged) {
    merged = false;

    outer: for (let i = 0; i < lines.length; i += 1) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const a = lines[i]!;
        const b = lines[j]!;

        if (verticalOverlap(a, b) / Math.max(1e-6, Math.min(a.height, b.height)) >= minOverlap) {
          lines[i] = union(a, b);
          lines.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  return lines
    .sort((a, b) => a.top - b.top)
    .map((rect, index) => ({ id: `L${index + 1}`, rect }));
}

const round4 = (value: number) => Math.round(value * 10000) / 10000;

/**
 * Lines → the request's ink groups, normalised to `region` (the picture actually sent). A line is
 * clipped to the region, so every box satisfies the server's `x + w ≤ 1` rule; one wholly outside
 * is dropped.
 */
export function linesToClusters(lines: StepLine[], region: SceneRect): TermCluster[] {
  if (region.width <= 0 || region.height <= 0) return [];

  const out: TermCluster[] = [];

  for (const line of lines.slice(0, STEP_CHECK_MAX_LINES)) {
    const x0 = Math.max(0, (line.rect.left - region.left) / region.width);
    const y0 = Math.max(0, (line.rect.top - region.top) / region.height);
    const x1 = Math.min(1, (line.rect.left + line.rect.width - region.left) / region.width);
    const y1 = Math.min(1, (line.rect.top + line.rect.height - region.top) / region.height);

    if (x1 - x0 < 0.001 || y1 - y0 < 0.001) continue;

    const x = round4(x0);
    const y = round4(y0);

    out.push({ id: line.id, bbox: { x, y, w: Math.max(0.001, Math.min(round4(x1 - x0), 1 - x)), h: Math.max(0.001, Math.min(round4(y1 - y0), 1 - y)) } });
  }

  return out;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** The `question` the step check sends (≤ 2000 chars, the server's limit). */
export function stepCheckQuestion(lineCount: number): string {

  return [
    'TASK: grade my handwritten solution STEP BY STEP. Do not explain the topic, do not draw.',
    `The image is my page: a printed/typed question and my handwritten working. Each INK GROUP tag (1..${lineCount}) is ONE handwritten line = one step, top to bottom.`,
    'Grade ONLY the handwriting; the printed text is the question. Redo every step yourself (derivatives, chain/product/quotient rule, ln, inverse trig, tangent lines, algebra, signs, final answer).',
    'Return ONLY point_at actions, ONE per step, mistakes first, then warnings, then correct steps (at most 12):',
    '{"type":"point_at","at":{"x":<right end of the line>,"y":<line centre>},"note":"[<tag>] <VERDICT>: <reason>"}',
    'VERDICT is exactly OK, WRONG or WARN. OK = the step is right. WRONG = the error is ON this line (say what is wrong and give the correct expression). WARN = incomplete, unjustified, a skipped step, or a slip carried from an earlier error.',
    'Example: "[3] WRONG: d/dx ln(3x) = 1/x, not 3/x". Keep each reason under 100 characters; math as plain text (x^2, sin^-1(x), sqrt(x)).',
    'Mark the FIRST line where the work goes wrong as WRONG; later lines that only carry the error forward are WARN.',
    '`say` is one line in exactly this form: "CORRECT: <what is right>. MISTAKES: <each mistake: line, what, why>. MISSING: <what is not done yet, or none>. NOTE: <one tip>."',
    'Write the reasons in English; keep the tokens OK/WRONG/WARN/CORRECT/MISTAKES/MISSING/NOTE exactly as written.',
    'If there is no handwritten working, return no actions and say "MISSING: no handwritten working on this page."',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------

const VERDICT_TOKENS: Array<[RegExp, StepVerdict]> = [
  [/^(?:✗|✘|×|❌|(?:wrong|incorrect|error|mistake)(?![a-z]))/i, 'wrong'],
  [/^(?:!|⚠️?|(?:warn(?:ing)?|incomplete|missing|partial)(?![a-z]))/i, 'warning'],
  [/^(?:✓|✔|✅|(?:okay|ok|correct|right)(?![a-z]))/i, 'correct'],
];

/**
 * One note → `{tag, verdict, reason}`. Accepts «[3] WRONG: …», «3) wrong - …», «L3 OK …», «WRONG [3]: …»
 * and a bare verdict with no tag. Null when no verdict token is found.
 */
export function parseStepNote(note: string): { tag: number | null; verdict: StepVerdict; reason: string } | null {
  let rest = note.replace(/\s+/g, ' ').trim();
  let tag: number | null = null;
  const lead = rest.match(/^(?:\[\s*L?(\d{1,3})\s*\]|L(\d{1,3})\b|(?:line|step)\s*(\d{1,3})\b|(\d{1,3})\s*[).:\]-])\s*[:\-–]?\s*/i);

  if (lead) {
    tag = Number(lead[1] ?? lead[2] ?? lead[3] ?? lead[4]);
    rest = rest.slice(lead[0].length);
  }

  for (const [pattern, verdict] of VERDICT_TOKENS) {
    const match = rest.match(pattern);

    if (!match) continue;

    rest = rest.slice(match[0].length).trim();

    // «WRONG [3]: …» — the tag after the verdict.
    if (tag === null) {
      const late = rest.match(/^\[\s*L?(\d{1,3})\s*\]\s*/i);

      if (late) {
        tag = Number(late[1]);
        rest = rest.slice(late[0].length);
      }
    }

    return { tag, verdict, reason: rest.replace(/^[\s:\-–—.,]+/, '').trim() };
  }

  return null;
}

/** The line whose vertical band holds `y` (page 0..1), else the nearest one. */
export function nearestLine(lines: StepLine[], region: SceneRect, y: number): number {
  if (lines.length === 0) return -1;

  const sceneY = region.top + y * region.height;
  let best = 0;
  let bestDistance = Infinity;

  lines.forEach((line, index) => {
    const top = line.rect.top;
    const bottom = line.rect.top + line.rect.height;
    const distance = sceneY < top ? top - sceneY : sceneY > bottom ? sceneY - bottom : 0;

    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });

  return best;
}

const SECTION_LABELS: Array<[string, keyof StepCheckSections]> = [
  ['CORRECT', 'correct'],
  ['MISTAKES?|ERRORS?', 'mistakes'],
  ['MISSING|INCOMPLETE', 'missing'],
  ['NOTE|TIPS?|INFO', 'info'],
];

const NOTHING = /^(?:none|nothing|n\/a|-|—|no mistakes?)\.?$/i;

const splitItems = (text: string): string[] =>
  text
    .split(/\s*(?:;|•|\s\|\s)\s*/)
    .map((item) => item.replace(/^[\s,.\-–—]+|[\s,]+$/g, '').trim())
    .filter((item) => item && !NOTHING.test(item));

/** `say` → the four panel sections. Text before any label is info. */
export function parseStepSections(say: string | undefined): StepCheckSections {
  const sections: StepCheckSections = { correct: [], mistakes: [], missing: [], info: [] };
  const text = (say ?? '').replace(/\s+/g, ' ').trim();

  if (!text) return sections;

  const marks: Array<{ at: number; end: number; key: keyof StepCheckSections }> = [];

  // The labels as asked (upper case) first — «(correct: 1/x)» inside a mistake is not a section.
  // A reply that wrote them in another case is read case-insensitively.
  for (const flags of ['g', 'gi']) {
    for (const [label, key] of SECTION_LABELS) {
      const global = new RegExp(`(?<![A-Za-z])(?:${label})\\s*:`, flags);
      let match: RegExpExecArray | null;

      while ((match = global.exec(text))) {
        const at = match.index;
        const end = at + match[0].length;

        if (!marks.some((mark) => at < mark.end && end > mark.at)) marks.push({ at, end, key });
      }
    }

    if (marks.length > 0) break;
  }

  marks.sort((a, b) => a.at - b.at);

  const head = text.slice(0, marks[0]?.at ?? text.length).trim();

  if (head) sections.info.push(...splitItems(head));

  marks.forEach((mark, index) => {
    const body = text.slice(mark.end, marks[index + 1]?.at ?? text.length).trim();

    sections[mark.key].push(...splitItems(body));
  });

  return sections;
}

/**
 * The service's reply (`{actions, say}`, or a string holding it) → steps anchored to `lines`.
 * Every action that carries text (point_at note, write text, arrow label) is read; its line is the
 * tag it names, else the line under its point. One step per line — the most severe verdict wins and
 * its reason leads. Steps come back mistakes first, then warnings, then correct ones, each group
 * top to bottom. Null when the reply is not an object at all.
 */
export function parseStepCheck(input: unknown, lines: StepLine[], region: SceneRect): StepCheckResult | null {
  const value = typeof input === 'string' ? extractJsonObject(input) : input;

  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const actions = Array.isArray(record.actions) ? record.actions : [];
  const byLine = new Map<number, CheckedStep>();

  for (const raw of actions) {
    if (!raw || typeof raw !== 'object') continue;

    const action = raw as Record<string, unknown>;
    const text = [action.note, action.text, action.label].find((part): part is string => typeof part === 'string' && part.trim().length > 0);

    if (!text) continue;

    const parsed = parseStepNote(text);

    if (!parsed) continue;

    let index = parsed.tag !== null && parsed.tag >= 1 && parsed.tag <= lines.length ? parsed.tag - 1 : -1;

    if (index < 0) {
      const clusterId = (action.to as Record<string, unknown> | undefined)?.clusterId ?? (action.target as Record<string, unknown> | undefined)?.clusterId;
      const named = typeof clusterId === 'string' ? lines.findIndex((line) => line.id === clusterId) : -1;

      index = named;
    }

    if (index < 0) {
      const at = (action.at ?? action.to) as Record<string, unknown> | undefined;
      const y = Number(at?.y);

      if (at && Number.isFinite(y)) index = nearestLine(lines, region, Math.max(0, Math.min(1, y)));
    }

    if (index < 0 || !lines[index]) continue;

    const existing = byLine.get(index);
    const step: CheckedStep = { lineId: lines[index]!.id, n: index + 1, verdict: parsed.verdict, note: parsed.reason };

    if (!existing) {
      byLine.set(index, step);
    } else if (SEVERITY[step.verdict] > SEVERITY[existing.verdict]) {
      byLine.set(index, { ...step, note: [step.note, existing.verdict === 'correct' ? '' : existing.note].filter(Boolean).join(' · ') });
    } else if (step.note && step.verdict === existing.verdict && !existing.note.includes(step.note)) {
      byLine.set(index, { ...existing, note: [existing.note, step.note].filter(Boolean).join(' · ') });
    }
  }

  const steps = Array.from(byLine.values()).sort((a, b) => SEVERITY[b.verdict] - SEVERITY[a.verdict] || a.n - b.n);
  const say = typeof record.say === 'string' ? record.say : undefined;

  return { steps, sections: parseStepSections(say) };
}

/** Counts per verdict, for the panel's one-line summary. */
export function stepCounts(steps: CheckedStep[]): Record<StepVerdict, number> {
  const counts: Record<StepVerdict, number> = { correct: 0, wrong: 0, warning: 0 };

  for (const step of steps) counts[step.verdict] += 1;

  return counts;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export interface StepMarkPlacement {
  lineId: string;
  verdict: StepVerdict;
  /** Top-left of the glyph, scene units. */
  left: number;
  top: number;
  /** Glyph size, scene units. */
  size: number;
  /** Which side of the line the mark sits on. */
  side: 'end' | 'start';
}

/**
 * Where each step's mark goes: in the margin just past the END of its line (its right side),
 * vertically centred on it, sized to the line. A line that runs to the page edge takes
 * its mark on the other side. Marks never stack: one that would overlap the previous mark in the
 * same column is pushed down below it.
 */
export function placeStepMarks(
  steps: CheckedStep[],
  lines: StepLine[],
  page: SceneRect,
  { gap, minSize = 14, maxSize = 44 }: { gap?: number; minSize?: number; maxSize?: number } = {},
): StepMarkPlacement[] {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const placements: StepMarkPlacement[] = [];
  const pageRight = page.left + page.width;

  const ordered = [...steps].sort((a, b) => a.n - b.n);

  for (const step of ordered) {
    const line = byId.get(step.lineId);

    if (!line) continue;

    const size = Math.max(minSize, Math.min(maxSize, line.rect.height * 0.8));
    const space = gap ?? size * 0.5;
    const endLeft = line.rect.left + line.rect.width + space;
    const fitsEnd = endLeft + size <= pageRight;
    const startLeft = line.rect.left - space - size;
    const fitsStart = startLeft >= page.left;
    let side: 'end' | 'start' = 'end';
    let left = endLeft;

    if (!fitsEnd && fitsStart) {
      side = 'start';
      left = startLeft;
    } else if (!fitsEnd) {
      // Neither margin is free: tuck it inside the page edge at the line's end.
      left = pageRight - size;
    }

    let top = line.rect.top + line.rect.height / 2 - size / 2;

    for (const previous of placements) {
      const sameColumn = Math.abs(previous.left - left) < size;

      if (sameColumn && top < previous.top + previous.size && top + size > previous.top) top = previous.top + previous.size + 2;
    }

    placements.push({ lineId: step.lineId, verdict: step.verdict, left, top, size, side });
  }

  return placements;
}

// ---------------------------------------------------------------------------
// Capture region
// ---------------------------------------------------------------------------

/**
 * The scene rect «Check this page» captures: the CURRENT page's sheet when the board is in the
 * continuous (stacked) layout — never the union of every hydrated page's ink, which is what the
 * export bounds are there — else the paged layout's export bounds.
 */
export function checkCaptureRegion(sheet: SceneRect | null | undefined, exportBounds: SceneRect | null | undefined): SceneRect | null {
  const usable = (rect: SceneRect | null | undefined): rect is SceneRect => Boolean(rect && rect.width > 0 && rect.height > 0);

  if (usable(sheet)) return sheet;
  if (usable(exportBounds)) return exportBounds;

  return null;
}

/**
 * A pixel box found in a raster of `region` (rendered `pixelWidth` px wide) → the scene rect it
 * covers. Used to crop the capture to its written part and keep the anchoring exact.
 */
export function pixelBoxToScene(region: SceneRect, pixelWidth: number, box: { x: number; y: number; width: number; height: number }): SceneRect {
  const scale = pixelWidth / region.width;

  return { left: region.left + box.x / scale, top: region.top + box.y / scale, width: box.width / scale, height: box.height / scale };
}
