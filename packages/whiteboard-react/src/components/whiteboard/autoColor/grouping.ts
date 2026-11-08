/**
 * Stroke grouping: fresh pen strokes → lines → words, from geometry alone.
 *
 * - A stroke joins a LINE when its vertical centre sits within 0.9 × the letter height (1.3 for a dot) of
 *   the line's centre and it is horizontally within reach of the line (a new line under an old one is a new line).
 * - Within a line it joins a WORD when the horizontal gap to the word's box is under 0.32 × letter height
 *   (a first, tight cut; {@link InkGrouper.settleLine} re-cuts the line); a stroke that bridges two words
 *   merges them (a long bar, a connecting stroke).
 * - A long flat stroke under words is an UNDERLINE and a big closed stroke round them is a BOX: both are
 *   decorations, kept out of the words (an underline would otherwise glue the whole line into one word)
 *   and used as layout cues.
 *
 * {@link InkGrouper.settleLine} then RE-CUTS a whole line from all its strokes before it is recognised,
 * with the line's settled letter height (the incremental pass decides with the first strokes' size,
 * which is the dash of an arrow or a dot): letters closer than {@link WORD_GAP} × letter height are one
 * word, dots / colons / i-dots / t-crosses join their word, a colon closes its word (nothing after it
 * joins across it) and a leading dash / arrow bullet is a word of its own.
 *
 * Pure data, no Fabric, no timers: the controller owns the pen-lift pause and decides when dirty
 * words are recognised.
 */
import type { InkBox, InkDecorationKind, InkDirection, InkStrokeInput } from './model';

/** Word gap, × the line's median letter height: letters of one word are closer than this. */
export const WORD_GAP = 0.8;
/** A colon / full stop attaches to the word before it when within this × letter height. */
const MARK_REACH = 1.5;
/** A line with fewer letter strokes than this has no size of its own yet. */
const YOUNG_LINE = 3;

export interface InkGroupState {
  id: string;
  lineId: string;
  /** Writing order. */
  strokeIds: string[];
  box: InkBox;
  /** Changed since it was last recognised. */
  dirty: boolean;
  /** Last recognised text (filled by the controller). */
  text: string;
  /** Ends with a colon (two stacked dots), set by {@link InkGrouper.settleLine}. */
  colon?: boolean;
  /** A list bullet at the line start (dash / arrow shape), set by {@link InkGrouper.settleLine}. */
  bullet?: boolean;
}

export interface InkDecorationState {
  strokeId: string;
  kind: InkDecorationKind;
  box: InkBox;
}

export interface InkLineState {
  id: string;
  /** Words, in writing order. */
  groups: InkGroupState[];
  decorations: InkDecorationState[];
  box: InkBox;
  /** Running centre of the line's letters (decorations and dots excluded). */
  centerY: number;
  /** Median height of the line's letter strokes. */
  height: number;
  letterHeights: number[];
  letterCenters: number[];
  updatedAt: number;
}

export interface InkGrouperOptions {
  /** Height used before any line exists (scene units). Default 36 (≈ 9.5 mm ruling at 96 dpi). */
  fallbackLineHeight?: number;
  /** Lines kept for joining (older ones are forgotten). Default 12. */
  maxLines?: number;
}

export interface AddStrokeResult {
  lineId: string;
  /** null for a decoration. */
  groupId: string | null;
  decoration: InkDecorationKind | null;
  /** A different line than the previous stroke's: the previous line can be flushed now. */
  lineChanged: boolean;
  previousLineId: string | null;
}

const width = (box: InkBox) => box.right - box.left;
const height = (box: InkBox) => box.bottom - box.top;

export function unionBox(a: InkBox, b: InkBox): InkBox {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

export function boxOfPoints(points: ReadonlyArray<{ x: number; y: number }>): InkBox {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const p of points) {
    if (p.x < left) left = p.x;
    if (p.x > right) right = p.x;
    if (p.y < top) top = p.y;
    if (p.y > bottom) bottom = p.y;
  }

  return Number.isFinite(left) ? { left, top, right, bottom } : { left: 0, top: 0, right: 0, bottom: 0 };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;

  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Horizontal gap between two boxes (0 when they overlap in x). */
export function horizontalGap(a: InkBox, b: InkBox): number {
  return Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
}

/**
 * Is this stroke an underline or a box, given the line height around it? Pure geometry:
 * - underline: long (≥ 2.5 × line height and ≥ 5 × its own height) and flat (≤ 0.35 × line height);
 * - box: big in both axes (≥ 2 × lh wide, ≥ 1.2 × lh tall) and closed (ends meet within 25 % of the
 *   diagonal) — a circle or a frame drawn round a word.
 */
export function classifyDecoration(stroke: InkStrokeInput, lineHeight: number): InkDecorationKind | null {
  const w = width(stroke.box);
  const h = height(stroke.box);

  if (w >= 2.5 * lineHeight && h <= 0.35 * lineHeight && w >= 5 * Math.max(h, 1)) return 'underline';

  if (w >= 2 * lineHeight && h >= 1.2 * lineHeight && stroke.points.length >= 8) {
    const first = stroke.points[0];
    const last = stroke.points[stroke.points.length - 1];
    const diag = Math.hypot(w, h);

    if (Math.hypot(first.x - last.x, first.y - last.y) <= 0.25 * diag) return 'box';
  }

  return null;
}

/**
 * Writing direction of a run of strokes: in left → right writing the strokes START further right as the
 * word goes on, and the pen travels rightwards inside the long strokes. Returns null when the evidence
 * is too weak (one dot, a vertical bar).
 */
export function writingDirection(strokes: ReadonlyArray<Pick<InkStrokeInput, 'points' | 'box'>>): InkDirection | null {
  let vote = 0;
  let scale = 0;

  for (let index = 0; index < strokes.length; index += 1) {
    const stroke = strokes[index];
    const pts = stroke.points;

    if (pts.length >= 2) {
      // In-stroke travel, weighted by how horizontal the stroke is.
      const dx = pts[pts.length - 1].x - pts[0].x;

      vote += dx;
      scale += Math.abs(dx);
    }

    if (index > 0) {
      // Successive stroke starts: a new letter / word part begins beside the last.
      const prev = strokes[index - 1].box;
      const cur = stroke.box;
      const step = (cur.left + cur.right) / 2 - (prev.left + prev.right) / 2;

      vote += step * 1.5;
      scale += Math.abs(step) * 1.5;
    }
  }

  if (scale === 0) return null;
  const ratio = vote / scale;

  if (ratio <= -0.2) return 'rtl';
  if (ratio >= 0.2) return 'ltr';

  return null;
}

/**
 * The live grouping state of one board. Strokes are added in commit order; removing a stroke (erased,
 * undone) drops it from its word.
 */
export class InkGrouper {
  readonly lines: InkLineState[] = [];
  private readonly strokes = new Map<string, InkStrokeInput>();
  private readonly strokeGroup = new Map<string, string>();
  private readonly fallbackLineHeight: number;
  private readonly maxLines: number;
  private lastLineId: string | null = null;
  private seq = 0;

  constructor(options: InkGrouperOptions = {}) {
    this.fallbackLineHeight = options.fallbackLineHeight ?? 36;
    this.maxLines = options.maxLines ?? 12;
  }

  stroke(id: string): InkStrokeInput | undefined {
    return this.strokes.get(id);
  }

  line(id: string): InkLineState | undefined {
    return this.lines.find((line) => line.id === id);
  }

  group(id: string): InkGroupState | undefined {
    for (const line of this.lines) {
      const found = line.groups.find((group) => group.id === id);

      if (found) return found;
    }

    return undefined;
  }

  groupOfStroke(strokeId: string): InkGroupState | undefined {
    const id = this.strokeGroup.get(strokeId);

    return id ? this.group(id) : undefined;
  }

  /** Median line height over the remembered lines (the page's handwriting size). */
  pageLineHeight(): number {
    // Lines with a few letters only: their size is still the first strokes' (an arrow's dash, a dot).
    const heights = this.lines.filter((line) => line.letterHeights.length >= YOUNG_LINE).map((line) => line.height);

    return heights.length > 0 ? median(heights) : this.fallbackLineHeight;
  }

  private nextId(prefix: string): string {
    this.seq += 1;

    return `${prefix}${this.seq}`;
  }

  private findLine(stroke: InkStrokeInput): InkLineState | null {
    const cy = (stroke.box.top + stroke.box.bottom) / 2;
    const pageHeight = this.pageLineHeight();
    let best: InkLineState | null = null;
    let bestDistance = Infinity;

    // Newest first: the line being written wins a tie with the one above it.
    for (let index = this.lines.length - 1; index >= 0; index -= 1) {
      const line = this.lines[index];
      // A young line is measured with the page's size: its own is still its first stroke's.
      const lh = Math.max(line.height, pageHeight * (line.letterHeights.length < YOUNG_LINE ? 1 : 0.6));
      const distance = Math.abs(cy - line.centerY);
      const reach = Math.max(4 * lh, width(line.box) * 0.25);
      const nearX = horizontalGap(line.box, stroke.box) <= reach;
      // A letter's part (a P's bowl, a t's stem) sits off the band's centre by up to ~0.9 × letter height;
      // a small mark (an i-dot, a hamza, a comma) further still. Lines are ≥ 1.8 letter heights apart.
      const small = height(stroke.box) < 0.35 * lh && width(stroke.box) < 0.6 * lh;
      const tolerance = (small ? 1.3 : 0.9) * lh;

      // Or it lies mostly inside the band the line's letters already cover (a P's bowl, a t's cross,
      // written while the line's size is still its first strokes').
      const letters = line.groups.length > 0 ? line.groups.map((group) => group.box).reduce(unionBox) : line.box;
      const overlapY = Math.min(letters.bottom, stroke.box.bottom) - Math.max(letters.top, stroke.box.top);
      const inside = height(stroke.box) <= 1.5 * height(letters) && overlapY >= 0.6 * Math.max(1, height(stroke.box));

      if (nearX && (distance <= tolerance || inside) && distance < bestDistance) {
        best = line;
        bestDistance = distance;
      }
    }

    return best;
  }

  addStroke(stroke: InkStrokeInput): AddStrokeResult {
    this.strokes.set(stroke.id, stroke);
    const previousLineId = this.lastLineId;
    let line = this.findLine(stroke);
    const lh = line ? Math.max(line.height, this.pageLineHeight() * 0.6) : this.pageLineHeight();
    const decoration = classifyDecoration(stroke, lh);

    if (decoration && line === null) {
      // A decoration under / round the latest line belongs to it.
      line = this.lineForDecoration(stroke) ?? null;
    }

    if (!line) {
      line = {
        id: this.nextId('l'),
        groups: [],
        decorations: [],
        box: { ...stroke.box },
        centerY: (stroke.box.top + stroke.box.bottom) / 2,
        height: Math.max(height(stroke.box), this.fallbackLineHeight * 0.3),
        letterHeights: [],
        letterCenters: [],
        updatedAt: stroke.endedAt,
      };
      this.lines.push(line);

      if (this.lines.length > this.maxLines) this.forgetLine(this.lines[0]);
    }

    line.updatedAt = stroke.endedAt;
    line.box = unionBox(line.box, stroke.box);
    this.lastLineId = line.id;
    const lineChanged = previousLineId !== null && previousLineId !== line.id;

    if (decoration) {
      line.decorations.push({ strokeId: stroke.id, kind: decoration, box: { ...stroke.box } });
      // The words it marks are re-classified (their cue changed); their ink is unchanged.
      for (const group of line.groups) {
        if (horizontalGap(group.box, stroke.box) === 0) group.dirty = true;
      }

      return { lineId: line.id, groupId: null, decoration, lineChanged, previousLineId };
    }

    this.noteLetter(line, stroke);
    const xHeight = 0.4 * Math.max(line.height, this.pageLineHeight() * 0.6);
    const near = line.groups.filter((group) => horizontalGap(group.box, stroke.box) < 0.8 * xHeight);
    let group: InkGroupState;

    if (near.length === 0) {
      group = { id: this.nextId('g'), lineId: line.id, strokeIds: [], box: { ...stroke.box }, dirty: true, text: '' };
      line.groups.push(group);
    } else {
      group = near[0];

      // A stroke that bridges words merges them (writing order kept by stroke time).
      for (const other of near.slice(1)) {
        group.strokeIds.push(...other.strokeIds);
        group.box = unionBox(group.box, other.box);
        other.strokeIds.forEach((id) => this.strokeGroup.set(id, group.id));
        line.groups.splice(line.groups.indexOf(other), 1);
      }

      group.strokeIds.sort((a, b) => (this.strokes.get(a)?.startedAt ?? 0) - (this.strokes.get(b)?.startedAt ?? 0));
    }

    group.strokeIds.push(stroke.id);
    group.box = unionBox(group.box, stroke.box);
    group.dirty = true;
    this.strokeGroup.set(stroke.id, group.id);

    return { lineId: line.id, groupId: group.id, decoration: null, lineChanged, previousLineId };
  }

  /** The stroke is gone (erased / undone): drop it; an empty word or line disappears. */
  removeStroke(strokeId: string): void {
    this.strokes.delete(strokeId);
    const groupId = this.strokeGroup.get(strokeId);

    this.strokeGroup.delete(strokeId);

    for (const line of this.lines) {
      line.decorations = line.decorations.filter((decoration) => decoration.strokeId !== strokeId);

      if (!groupId) continue;
      const group = line.groups.find((candidate) => candidate.id === groupId);

      if (!group) continue;
      group.strokeIds = group.strokeIds.filter((id) => id !== strokeId);

      if (group.strokeIds.length === 0) line.groups.splice(line.groups.indexOf(group), 1);
      else group.dirty = true;
    }

    for (const line of [...this.lines]) {
      if (line.groups.length === 0 && line.decorations.length === 0) this.lines.splice(this.lines.indexOf(line), 1);
    }
  }

  /**
   * Re-cut a line into words from all of its strokes, with the line's settled letter height. Words
   * whose strokes did not change keep their id, text and dirty flag; any other word is new (dirty).
   */
  settleLine(line: InkLineState): void {
    const strokes = line.groups.flatMap((group) => this.groupStrokes(group));

    if (strokes.length === 0) return;
    const lh = Math.max(line.height, this.pageLineHeight() * 0.6);
    // Reading-forward coordinates (left → right): «lead» is where a box starts, «trail» where it ends.
    const lead = (box: InkBox) => box.left;
    const trail = (box: InkBox) => box.right;
    const isMark = (stroke: InkStrokeInput) => height(stroke.box) < 0.35 * lh && width(stroke.box) < 0.5 * lh;
    let marks = strokes.filter(isMark);
    let bodies = strokes.filter((stroke) => !isMark(stroke));

    if (bodies.length === 0) {
      bodies = marks;
      marks = [];
    }

    // Colons: two marks stacked one above the other.
    const colons: InkStrokeInput[][] = [];
    const paired = new Set<string>();

    for (const a of marks) {
      if (paired.has(a.id)) continue;
      const ax = (a.box.left + a.box.right) / 2;
      const b = marks.find((other) => {
        if (other === a || paired.has(other.id)) return false;
        const bx = (other.box.left + other.box.right) / 2;
        const upper = other.box.top < a.box.top ? other : a;
        const lower = upper === a ? other : a;
        const gap = lower.box.top - upper.box.bottom;

        return Math.abs(ax - bx) <= 0.4 * lh && gap >= 0.08 * lh && gap <= 1.1 * lh;
      });

      if (!b) continue;
      // A real colon stands in the space after its word; dots over / under a letter body (i, j, ÷)
      // are not one.
      const pair = unionBox(a.box, b.box);

      if (bodies.some((stroke) => horizontalGap(stroke.box, pair) === 0)) continue;
      paired.add(a.id);
      paired.add(b.id);
      colons.push([a, b]);
    }

    const units: InkStrokeInput[][] = [...colons, ...marks.filter((mark) => !paired.has(mark.id)).map((mark) => [mark])];
    const colonBoxes = colons.map((pair) => unionBox(pair[0].box, pair[1].box));

    // A leading bullet: a short flat stroke at mid-height (a dash, an arrow's shaft or a one-stroke
    // arrow), plus the strokes on top of it (the arrow head).
    bodies.sort((a, b) => lead(a.box) - lead(b.box));
    const bullet = new Set<string>();
    const head = bodies[0];

    if (head && bodies.length > 1) {
      const h = height(head.box);
      const w = width(head.box);
      const cy = (head.box.top + head.box.bottom) / 2;

      // Not a T's bar: nothing tall crosses it.
      const crossed = bodies.some((stroke) => stroke !== head && height(stroke.box) > 0.8 * lh && horizontalGap(stroke.box, head.box) === 0);
      // Not a short dotted letter body (an i or a j): a dash or an arrow has no dots over / under its middle.
      const dotted = marks.some((mark) => {
        const mx = (mark.box.left + mark.box.right) / 2;

        return mx >= head.box.left + 0.15 * w && mx <= head.box.right - 0.15 * w;
      });

      if (h <= 0.5 * lh && w >= 0.35 * lh && w >= 1.5 * h && Math.abs(cy - line.centerY) <= 0.35 * lh && !crossed && !dotted) {
        bullet.add(head.id);

        for (const stroke of [...bodies.slice(1), ...marks]) {
          if (height(stroke.box) <= 0.8 * lh && horizontalGap(stroke.box, head.box) <= 0.1 * lh && lead(stroke.box) >= lead(head.box)) {
            bullet.add(stroke.id);
          }
        }

        // Only a bullet when a word follows it.
        if (bodies.every((stroke) => bullet.has(stroke.id))) bullet.clear();
      }
    }

    interface Cluster {
      strokes: InkStrokeInput[];
      box: InkBox;
      colon: boolean;
      bullet: boolean;
    }
    const clusters: Cluster[] = [];

    if (bullet.size > 0) {
      const own = strokes.filter((stroke) => bullet.has(stroke.id));

      clusters.push({ strokes: own, box: own.map((s) => s.box).reduce(unionBox), colon: false, bullet: true });
    }

    let current: Cluster | null = null;

    for (const stroke of bodies) {
      if (bullet.has(stroke.id)) continue;
      const blocked = (cluster: Cluster) =>
        colonBoxes.some((colon) => lead(colon) >= trail(cluster.box) - 0.15 * lh && trail(colon) <= lead(stroke.box) + 0.15 * lh);

      if (current && lead(stroke.box) - trail(current.box) < WORD_GAP * lh && !blocked(current)) {
        current.strokes.push(stroke);
        current.box = unionBox(current.box, stroke.box);
      } else {
        current = { strokes: [stroke], box: { ...stroke.box }, colon: false, bullet: false };
        clusters.push(current);
      }
    }

    // Dots, colons, i-dots and t-crosses join a word: the one under them, else the one before them
    // (a colon / full stop follows its word), else — not a colon — a near one after them.
    for (const unit of units) {
      if (unit.some((stroke) => bullet.has(stroke.id))) continue;
      const box = unit.map((s) => s.box).reduce(unionBox);
      const isColon = unit.length === 2;
      const words = clusters.filter((cluster) => !cluster.bullet);
      const over = words
        .filter((cluster) => horizontalGap(cluster.box, box) <= 0.1 * lh)
        .sort((a, b) => Math.abs(lead(a.box) + trail(a.box) - lead(box) - trail(box)) - Math.abs(lead(b.box) + trail(b.box) - lead(box) - trail(box)))[0];
      const before = words
        .filter((cluster) => trail(cluster.box) <= lead(box) + 0.1 * lh && lead(box) - trail(cluster.box) <= MARK_REACH * lh)
        .sort((a, b) => trail(b.box) - trail(a.box))[0];
      const after = isColon
        ? undefined
        : words.filter((cluster) => lead(cluster.box) >= trail(box) && lead(cluster.box) - trail(box) < WORD_GAP * lh).sort((a, b) => lead(a.box) - lead(b.box))[0];
      const target = over ?? before ?? after;

      if (target) {
        target.strokes.push(...unit);
        target.box = unionBox(target.box, box);
        // A colon over the second half of its word closes it.
        if (isColon && (lead(box) + trail(box)) / 2 >= (lead(target.box) + trail(target.box)) / 2) target.colon = true;
      } else {
        clusters.push({ strokes: [...unit], box, colon: isColon, bullet: false });
      }
    }

    // Map the clusters onto the old words: same strokes = same word (keeps its text); else reuse the
    // id of the word it overlaps most, as a dirty word.
    const used = new Set<string>();
    const next: InkGroupState[] = [];

    for (const cluster of clusters) {
      cluster.strokes.sort((a, b) => a.startedAt - b.startedAt);
      const ids = cluster.strokes.map((stroke) => stroke.id);
      const key = [...ids].sort().join(',');
      let same: InkGroupState | undefined;
      let best: InkGroupState | undefined;
      let bestOverlap = 0;

      for (const group of line.groups) {
        if (used.has(group.id)) continue;
        if ([...group.strokeIds].sort().join(',') === key) {
          same = group;
          break;
        }

        const overlap = group.strokeIds.filter((id) => ids.includes(id)).length;

        if (overlap > bestOverlap) {
          best = group;
          bestOverlap = overlap;
        }
      }

      const reuse = same ?? best;
      const id = reuse ? reuse.id : this.nextId('g');

      used.add(id);
      next.push(
        same
          ? Object.assign(same, { strokeIds: ids, box: cluster.box, colon: cluster.colon, bullet: cluster.bullet })
          : { id, lineId: line.id, strokeIds: ids, box: cluster.box, dirty: true, text: '', colon: cluster.colon, bullet: cluster.bullet },
      );
    }

    next.sort((a, b) => (this.strokes.get(a.strokeIds[0])?.startedAt ?? 0) - (this.strokes.get(b.strokeIds[0])?.startedAt ?? 0));

    for (const group of next) for (const id of group.strokeIds) this.strokeGroup.set(id, group.id);
    line.groups.splice(0, line.groups.length, ...next);
  }

  /** Words of a line ordered in READING order (left → right; notes are English-only). */
  readingOrder(line: InkLineState, _dir: InkDirection | null): InkGroupState[] {
    const groups = [...line.groups];

    groups.sort((a, b) => a.box.left - b.box.left);

    return groups;
  }

  /** Writing direction of a whole line (word order + in-word travel). */
  lineDirection(line: InkLineState): InkDirection | null {
    const strokes: InkStrokeInput[] = [];

    for (const group of line.groups) {
      for (const id of group.strokeIds) {
        const stroke = this.strokes.get(id);

        if (stroke) strokes.push(stroke);
      }
    }

    strokes.sort((a, b) => a.startedAt - b.startedAt);

    return writingDirection(strokes);
  }

  groupStrokes(group: InkGroupState): InkStrokeInput[] {
    return group.strokeIds.map((id) => this.strokes.get(id)).filter((s): s is InkStrokeInput => Boolean(s));
  }

  private noteLetter(line: InkLineState, stroke: InkStrokeInput): void {
    const h = height(stroke.box);
    const lh = Math.max(line.height, this.fallbackLineHeight * 0.3);

    // Dots and diacritics do not set the line's size or centre.
    if (line.letterHeights.length > 0 && h < 0.3 * lh) return;

    line.letterHeights.push(h);
    line.letterCenters.push((stroke.box.top + stroke.box.bottom) / 2);

    if (line.letterHeights.length > 40) {
      line.letterHeights.shift();
      line.letterCenters.shift();
    }

    line.height = Math.max(median(line.letterHeights), this.fallbackLineHeight * 0.3);
    line.centerY = median(line.letterCenters);
  }

  private lineForDecoration(stroke: InkStrokeInput): InkLineState | undefined {
    for (let index = this.lines.length - 1; index >= 0; index -= 1) {
      const line = this.lines[index];
      const lh = Math.max(line.height, this.pageLineHeight() * 0.6);
      const overlapsX = horizontalGap(line.box, stroke.box) === 0;
      // An underline sits just under the letters; a box surrounds the line's centre.
      const under = stroke.box.top >= line.centerY && stroke.box.top <= line.centerY + 1.4 * lh;
      const around = stroke.box.top <= line.centerY && stroke.box.bottom >= line.centerY;

      if (overlapsX && (under || around)) return line;
    }

    return undefined;
  }

  private forgetLine(line: InkLineState): void {
    for (const group of line.groups) {
      for (const id of group.strokeIds) {
        this.strokes.delete(id);
        this.strokeGroup.delete(id);
      }
    }

    for (const decoration of line.decorations) this.strokes.delete(decoration.strokeId);
    this.lines.splice(this.lines.indexOf(line), 1);
  }
}
