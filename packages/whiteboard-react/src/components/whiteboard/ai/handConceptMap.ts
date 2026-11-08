import { withLevels } from './conceptMap';
import { branchesOf, CONCEPT_INKS_LIGHT, edgeBranch, mutedInk, nodeInk } from './conceptColors';
import { hashSeed, seededRandom } from './handwritingLayout';
import { layeredLayout } from './layeredLayout';
import { arrowHeadPoints, estimateTextWidth, handEllipsePoints, handLinePoints, smoothPath } from './termsMap';

import type { ScenePt, TermsMapPlan, TermsPrimitive } from './termsMap';
import type { ConceptMap } from './types';

/**
 * A ready concept map (the AI reference map: nodes, labelled edges) → the same hand-drawn DRAW PLAN
 * «Map my terms» uses (termsMap.ts): every node's text WRITTEN in the handwriting pipeline inside a
 * hand ellipse, arrows broken around their linking phrases, two-stroke heads, the title written on
 * top and underlined. Pure and seeded — the Fabric half is `buildTermsMapObjects`
 * (termsMapObjects.ts).
 *
 * Placement is the layered layout (layeredLayout.ts) fed the WRITTEN sizes: each node's box is its
 * ellipse (+ the root's second ring), each phrase gets its own chip in the layer between two ranks,
 * long links run through dummy points. So by construction no two ellipses touch, no phrase sits on
 * a node or on another phrase, and no arrow runs through a node it does not connect. Written text is
 * clamped to its box (`fit: 1`). The server's `bbox`es are not used: a 0..1 grid knows nothing about
 * how long the words are. Everything is linear in the letter height, so fitting a width is one
 * exact rescale.
 */

export interface HandConceptPlanOptions {
  /** The owner's letter height (HandStyle.letterHeight), scene units. Shrunk to fit `maxWidth`. */
  letterHeight: number;
  /** The width the map must fit (the notebook sheet minus margins), scene units. */
  maxWidth?: number;
  /** Never write smaller than this, even if the map then runs wider than `maxWidth`. */
  minLetterHeight?: number;
  /** Characters per written line inside a node before it wraps. */
  wrapChars?: number;
  /** …and in a linking phrase. */
  linkWrapChars?: number;
  /** Write the map's title above it. Default true. */
  title?: boolean;
  seed?: number;
}

export interface HandConceptPlan extends TermsMapPlan {
  /** The letter height the plan was drawn at (after fitting `maxWidth`). */
  letterHeight: number;
}

/** Markdown emphasis / code ticks off — the hand writes the words, not the markup. */
const plainText = (text: string) =>
  text
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Word wrap for a handwritten node: lines of at most `maxChars` (a longer single word stays whole). */
export function wrapHandText(text: string, maxChars = 16): string[] {
  const words = plainText(text).split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    if (!line) line = word;
    else if (Array.from(`${line} ${word}`).length <= maxChars) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);

  return lines.length ? lines : [''];
}

/** `from->to` — the link key the board tags a link's strokes and phrase with. */
export const handEdgeKey = (from: string, to: string) => `${from}->${to}`;

/** Points along a polyline, each leg a slightly bowed hand line (corners get rounded by `smoothPath`). */
function handPolyline(points: ScenePt[], random: () => number): ScenePt[] {
  const out: ScenePt[] = [];

  points.slice(1).forEach((q, index) => {
    const p = points[index]!;

    if (Math.hypot(q.x - p.x, q.y - p.y) < 0.5) return;
    const leg = handLinePoints(p, q, random);

    out.push(...(out.length ? leg.slice(1) : leg));
  });

  return out.length ? out : points.slice(0, 1);
}

const toward = (a: ScenePt, b: ScenePt, distance: number): ScenePt => {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;

  return { x: a.x + ((b.x - a.x) / length) * distance, y: a.y + ((b.y - a.y) / length) * distance };
};

function planAt(map: ConceptMap, lh: number, options: HandConceptPlanOptions): HandConceptPlan {
  const leveled = withLevels(map);
  const wrapChars = options.wrapChars ?? 16;
  const random = seededRandom(
    options.seed ?? hashSeed(JSON.stringify([leveled.nodes.map((node) => [node.id, node.text]), leveled.edges.map((edge) => [edge.from, edge.to, edge.label ?? ''])])),
  );
  const lineHeight = lh * 1.5;
  const linkHeight = lh * 0.8;
  const ring = lh * 0.35;
  const sized = leveled.nodes.map((node) => {
    const lines = wrapHandText(node.text, wrapChars);
    const width = Math.max(lh, ...lines.map((line) => estimateTextWidth(line, lh)));
    const height = lines.length * lineHeight;
    // The root gets the second ring a person draws round the main idea: its box makes room for it.
    const margin = (node.level ?? 0) === 0 ? ring : 0;

    return { node, lines, width, height, margin, rx: (width / 2) * 1.12 + lh * 0.6, ry: (height / 2) * 1.22 + lh * 0.5 };
  });
  const byId = new Map(sized.map((item) => [item.node.id, item]));
  // Ink by meaning: a hue per top-level branch (links and descendants inherit it), the root and title darker.
  const branchOf = branchesOf(leveled);
  const inkOf = (id: string) => nodeInk(CONCEPT_INKS_LIGHT, branchOf(id));
  const edges = leveled.edges.map((edge) => {
    const label = edge.label ? plainText(edge.label) : '';
    const lines = label ? wrapHandText(label, options.linkWrapChars ?? 14) : [];

    return {
      ...edge,
      label: label || undefined,
      lines,
      labelWidth: Math.max(0, ...lines.map((line) => estimateTextWidth(line, linkHeight))),
      labelHeight: lines.length ? linkHeight * 1.6 + (lines.length - 1) * linkHeight * 1.25 : 0,
    };
  });
  // A phrase chip = the phrase + the pen-lift gap above and below it where the shaft breaks.
  const chipPadX = lh * 0.25;
  const chipPadY = lh * 0.3;
  const layout = layeredLayout(
    sized.map((item) => ({ id: item.node.id, w: (item.rx + item.margin) * 2, h: (item.ry + item.margin) * 2 })),
    edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      label: edge.lines.length ? { w: edge.labelWidth + chipPadX * 2, h: edge.labelHeight + chipPadY * 2 } : null,
    })),
    { layerGap: lh * 0.9, nodeGap: lh * 1.2, mixedGap: lh * 0.9, pointGap: lh * 0.6, padding: 0, portSpread: 0.5, pointWidth: lh * 0.1 },
  );
  const rankOf = new Map(layout.nodes.map((node) => [node.id, node.rank]));

  const pad = lh * 0.5;
  const title = options.title === false ? '' : plainText(map.title ?? '');
  const titleHeight = lh * 1.3;
  const titleBlock = title ? titleHeight * 1.5 + lh * 1.6 : 0;
  const graphWidth = layout.width;
  const titleWidth = title ? estimateTextWidth(title, titleHeight) : 0;
  const width = Math.max(graphWidth, titleWidth) + pad * 2;
  const shiftX = pad + (width - pad * 2 - graphWidth) / 2;
  const shiftY = pad + titleBlock;
  const shift = (x: number, y: number): ScenePt => ({ x: x + shiftX, y: y + shiftY });
  const primitives: TermsPrimitive[] = [];
  const nodes: TermsMapPlan['nodes'] = new Map();

  if (title) {
    const box = { left: (width - titleWidth) / 2, top: pad, width: titleWidth, height: titleHeight * 1.5 };

    primitives.push({ kind: 'label', step: -1, role: 'title', text: title, box, textHeight: titleHeight, fit: 1, color: CONCEPT_INKS_LIGHT.root });
    primitives.push({
      kind: 'outline',
      step: -1,
      nodeId: '__title',
      d: smoothPath(handLinePoints({ x: box.left, y: box.top + box.height + lh * 0.25 }, { x: box.left + box.width, y: box.top + box.height + lh * 0.25 }, random)),
      dashed: false,
      color: CONCEPT_INKS_LIGHT.root,
    });
  }

  for (const placed of layout.nodes) {
    const item = byId.get(placed.id)!;
    const id = placed.id;
    const c = shift(placed.x + placed.w / 2, placed.y + placed.h / 2);
    const step = placed.rank * 2;

    nodes.set(id, { cx: c.x, cy: c.y, rx: item.rx, ry: item.ry, extra: false });
    primitives.push({ kind: 'outline', step, nodeId: id, d: smoothPath(handEllipsePoints(c.x, c.y, item.rx, item.ry, random)), dashed: false, color: inkOf(id) });

    if (item.margin > 0) {
      primitives.push({
        kind: 'outline',
        step,
        nodeId: id,
        d: smoothPath(handEllipsePoints(c.x, c.y, item.rx + lh * 0.3, item.ry + lh * 0.25, random)),
        dashed: false,
        focusRing: true,
        color: inkOf(id),
      });
    }

    item.lines.forEach((line, index) => {
      if (!line) return;

      primitives.push({
        kind: 'label',
        step,
        role: 'node',
        text: line,
        box: { left: c.x - item.width / 2, top: c.y - item.height / 2 + index * lineHeight, width: item.width, height: lineHeight },
        textHeight: lh,
        fit: 1,
        nodeId: id,
        color: inkOf(id),
      });
    });
  }

  // Where a course leaves / enters an ellipse: straight above / below the port the layout chose,
  // a pen-lift's gap off the outline.
  const onEllipse = (id: string, port: ScenePt): ScenePt => {
    const node = nodes.get(id)!;
    const dx = Math.max(-node.rx * 0.7, Math.min(node.rx * 0.7, port.x - node.cx));
    const dy = node.ry * Math.sqrt(Math.max(0, 1 - (dx / node.rx) ** 2)) + lh * 0.3;

    return { x: node.cx + dx, y: port.y > node.cy ? node.cy + dy : node.cy - dy };
  };

  // Each rank's band (its layer), so a course runs straight up / down out of its node's band before
  // it bends: a slant inside the band could clip a taller neighbour.
  const band = new Map<number, { top: number; bottom: number }>();

  for (const placed of layout.nodes) {
    const known = band.get(placed.rank);
    const top = placed.y + shiftY;
    const bottom = placed.y + placed.h + shiftY;

    band.set(placed.rank, known ? { top: Math.min(known.top, top), bottom: Math.max(known.bottom, bottom) } : { top, bottom });
  }
  const leaveBand = (id: string, port: ScenePt): ScenePt[] => {
    const at = onEllipse(id, port);
    const own = band.get(rankOf.get(id) ?? 0)!;

    return [at, { x: at.x, y: port.y > nodes.get(id)!.cy ? own.bottom : own.top }];
  };

  for (const laid of layout.edges) {
    const edge = edges[laid.index]!;
    const inner = laid.points.map(([x, y]) => shift(x, y));
    const course = [...leaveBand(edge.from, inner[0]!), ...inner.slice(1, -1), ...leaveBand(edge.to, inner[inner.length - 1]!).reverse()];
    const step = Math.min(rankOf.get(edge.from) ?? 0, rankOf.get(edge.to) ?? 0) * 2 + 1;
    const key = handEdgeKey(edge.from, edge.to);
    const ink = nodeInk(CONCEPT_INKS_LIGHT, edgeBranch(branchOf, edge.from, edge.to));
    // The shaft breaks where the phrase is written: up to the chip, pen up, on from below it.
    const legs: ScenePt[][] = [course];

    if (laid.labelBox && edge.lines.length) {
      const chip = { left: laid.labelBox.x + shiftX, top: laid.labelBox.y + shiftY, width: laid.labelBox.w, height: laid.labelBox.h };
      const cx = chip.left + chip.width / 2;
      const cut = course.findIndex((p, index) => {
        const q = course[index + 1];

        // (The chip fills its layer when it is the layer's tallest: compare with a hair of slack.)
        return (
          Boolean(q) &&
          Math.abs(p.x - cx) < 0.5 &&
          Math.abs(q!.x - cx) < 0.5 &&
          Math.min(p.y, q!.y) <= chip.top + 0.01 &&
          Math.max(p.y, q!.y) >= chip.top + chip.height - 0.01
        );
      });

      if (cut >= 0) {
        const down = course[cut + 1]!.y > course[cut]!.y;
        const enter = { x: cx, y: down ? chip.top : chip.top + chip.height };
        const leave = { x: cx, y: down ? chip.top + chip.height : chip.top };

        legs.splice(0, 1, [...course.slice(0, cut + 1), enter], [leave, ...course.slice(cut + 1)]);
      }

      const text = { left: cx - edge.labelWidth / 2, top: chip.top + chipPadY, width: edge.labelWidth };

      edge.lines.forEach((line, index) => {
        primitives.push({
          kind: 'label',
          step,
          role: 'link',
          text: line,
          box: { left: text.left, top: text.top + index * linkHeight * 1.25, width: text.width, height: linkHeight * 1.6 },
          textHeight: linkHeight,
          fit: 1,
          edge: key,
          color: mutedInk(ink),
        });
      });
    }

    const shafts = legs.map((leg) => smoothPath(handPolyline(leg, random)));
    const last = legs[legs.length - 1]!;
    const first = legs[0]!;
    const end = last[last.length - 1]!;
    const beforeEnd = last[last.length - 2] ?? first[0]!;
    const start = first[0]!;
    const afterStart = first[1] ?? end;
    const lastLength = Math.hypot(end.x - beforeEnd.x, end.y - beforeEnd.y);
    const firstLength = Math.hypot(afterStart.x - start.x, afterStart.y - start.y);
    const headSize = Math.max(lh * 0.5, Math.min(lh * 0.9, lastLength * 0.6));
    const arrow = edge.arrow ?? 'end';
    const heads: string[] = [];

    if (arrow !== 'none') heads.push(smoothPath(arrowHeadPoints(toward(end, beforeEnd, Math.min(lastLength, lh)), end, headSize, random)));
    if (arrow === 'both') heads.push(smoothPath(arrowHeadPoints(toward(start, afterStart, Math.min(firstLength, lh)), start, headSize, random)));

    primitives.push({ kind: 'arrow', step, from: edge.from, to: edge.to, d: shafts.join(' '), head: heads.join(' '), arrow, color: ink });
  }

  primitives.sort((x, y) => x.step - y.step);

  return { primitives, width, height: titleBlock + layout.height + pad * 2, nodes, letterHeight: lh };
}

/** The reference map → a hand-drawn plan, plan-local (top-left at 0, 0), fitted to `maxWidth`. */
export function planHandConceptMap(map: ConceptMap, options: HandConceptPlanOptions): HandConceptPlan {
  const lh = Math.max(1, options.letterHeight);
  const plan = planAt(map, lh, options);

  if (!options.maxWidth || plan.width <= options.maxWidth) return plan;

  // Everything scales with the letter height (the seeded wobble too), so one rescale fits exactly.
  // (A hair of rounding can remain: re-fit until it is in.)
  let fitted = plan;

  for (let attempt = 0; attempt < 4 && fitted.width > options.maxWidth; attempt += 1) {
    const next = Math.max(options.minLetterHeight ?? 1, fitted.letterHeight * (options.maxWidth / fitted.width) * (attempt ? 0.99 : 1));

    if (next >= fitted.letterHeight) break;
    fitted = planAt(map, next, options);
  }

  return fitted;
}
