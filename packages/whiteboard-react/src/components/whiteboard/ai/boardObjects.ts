import {
  BaseFabricObject,
  Ellipse,
  FabricImage,
  FabricText,
  Group,
  Line,
  Polygon,
  Rect,
  Textbox,
} from 'fabric';

import type { FabricObject } from 'fabric';

import { blocksToMarkdown, choiceLetters, CONTENT_LABELS, stripInlineMarkdown } from './markdownBlocks';
import type { ContentLang } from './markdownBlocks';
import { boundaryPoint, edgeKey, layoutFromBoxes, layoutGraph } from './graphLayout';
import { inlineMathToText, latexToText } from './latexText';
import { graphToMermaid, parseMermaidFlowchart } from './mermaidFlow';
import { BOARD_TEXT_FONT, ensureBoardFonts, renderMathImage, renderTableImage } from './rasterize';
import { toneInk } from './tones';
import { withLevels } from './conceptMap';
import { buildLabeledImage, buildTypeset } from './typesetObjects';
import { needsTypesetMath } from './typesetLayout';

import type { TypesetStyle, TypesetWeight } from './typesetObjects';

import type { LayoutPlacement } from './pageLayout';
import type { BoardAiBlock, ConceptMap, ConceptMapStyle, ConceptNodeShape, SceneRect } from './types';

/**
 * AI answer → ordinary board objects. Text is an editable Textbox; a display formula and a table
 * are images (their LaTeX / markdown source rides on the object); a diagram or concept map is real
 * shapes + text + arrows, grouped per node. Everything is built at the scene origin and translated
 * by the caller, then added in ONE tick so the idle snapshot records it as one undo step. Autosave,
 * sync, the object eraser and undo treat these like anything else the teacher drew.
 */

/** Custom prop persisted through `toJSON` — what the object came from, so it can be re-rendered. */
export const AI_OBJECT_PROP = 'wbAi';

export interface AiObjectTag {
  kind:
    | 'heading'
    | 'paragraph'
    | 'list'
    | 'math'
    | 'table'
    | 'question'
    | 'diagram-node'
    | 'diagram-edge'
    | 'concept-node'
    | 'concept-edge'
    | 'image'
    | 'marker'
    | 'remake-text'
    | 'remake-math'
    | 'remake-figure'
    | 'remake-lines'
    | 'remake-table'
    | 'image-label'
    /** «Map my terms»: a copy of the owner's own term strokes / an outline / an arrow / a written label. */
    | 'terms-ink'
    | 'terms-node'
    | 'terms-edge'
    | 'terms-label'
    /** «Explain on my page»: a circle / underline / arrow stroke, a free pen stroke, a written note. */
    | 'pen-mark'
    | 'pen-stroke'
    | 'pen-note';
  /** LaTeX for math, markdown for tables/questions, mermaid for diagrams. */
  source?: string;
  /** Groups the objects of one insertion. */
  batch?: string;
  /** Written by «Write it by hand»: traced handwriting paths, one Group per written line. */
  hand?: boolean;
  /**
   * A hand-drawn concept map's parts (handConceptMapControl.ts): the node a written label belongs
   * to, the link (`from->to`) a phrase / stroke belongs to, the map's letter height, a link's arrow
   * ends, and — on one object per map — the map itself (JSON) so «Tidy» can lay it out again.
   */
  node?: string;
  edge?: string;
  lh?: number;
  arrow?: 'none' | 'end' | 'both';
  map?: string;
}

/**
 * `toJSON` only keeps whitelisted props. Fabric concatenates the BASE class list with each
 * subclass's own, so registering on the base covers every object type — including the
 * `FabricImage` list `lockedImages` already owns.
 */
export function registerAiObjectPersistence(): void {
  const base = BaseFabricObject as unknown as { customProperties?: string[] };

  if (!base.customProperties?.includes(AI_OBJECT_PROP)) {
    base.customProperties = [...(base.customProperties ?? []), AI_OBJECT_PROP];
  }
}

const tag = <T extends FabricObject>(object: T, value: AiObjectTag): T => {
  (object as unknown as Record<string, unknown>)[AI_OBJECT_PROP] = value;

  return object;
};

const TOP_LEFT = { originX: 'left' as const, originY: 'top' as const };

export interface BuildOptions {
  /** Current canvas zoom — content is sized to look the same on screen at any zoom. */
  zoom: number;
  /** Text colour (the teacher's current pen colour by default). */
  color: string;
  /** Include MCQ answers / explanations on the board. */
  withAnswers: boolean;
  /** Column width in on-screen px. */
  widthPx?: number;
  /** Diagrams may be wider than the text column (on-screen px). */
  diagramWidthPx?: number;
  batch?: string;
  /** Kept for hosts that still pass a language; labels are always English («Answer»). */
  lang?: ContentLang;
}

/**
 * Plex weights on the board: Regular body, Medium question stems and labels, Semibold headings,
 * question numbers and the answer line. (Bold 700 is reserved for a page whose own text was bold.)
 */
export const BOARD_WEIGHT = { body: 400, medium: 500, heading: 600 } as const;

function textbox(text: string, unit: number, options: { size: number; bold?: boolean; weight?: TypesetWeight; color: string; width: number; align?: 'right' | 'center' | 'left' }) {
  return new Textbox(text, {
    ...TOP_LEFT,
    // An object cache is sized to Fabric's measured box and would clip any overhanging paint.
    objectCaching: false,
    width: options.width,
    fontSize: options.size * unit,
    fontFamily: BOARD_TEXT_FONT,
    fontWeight: options.weight ?? (options.bold ? BOARD_WEIGHT.heading : BOARD_WEIGHT.body),
    fill: options.color,
    textAlign: options.align ?? 'left',
    lineHeight: 1.3,
    editable: true,
    selectable: true,
    evented: true,
  });
}

/** Display text for a Textbox: inline markdown off, `$…$` → readable math. */
export const boardText = (markdown: string) => inlineMathToText(stripInlineMarkdown(markdown));

/** Moves a freshly built object (made in a frame whose origin is (0, 0)) by (dx, dy). */
function shift(object: FabricObject, dx: number, dy: number): void {
  object.set({ left: (object.left ?? 0) + dx, top: (object.top ?? 0) + dy });
  object.setCoords();
}

async function imageObject(dataUrl: string): Promise<FabricImage | null> {
  try {
    return await FabricImage.fromURL(dataUrl, { crossOrigin: 'anonymous' });
  } catch {
    return null;
  }
}

/** Stacks blocks top-to-bottom from (0, 0). Returns the objects, top-level, in z-order. */
export async function buildBlockObjects(blocks: BoardAiBlock[], baseOptions: BuildOptions): Promise<FabricObject[]> {
  // Re-pointed per block: a toned block (a `> [!wrong]` callout, tones.ts) is written in its ink.
  let options = baseOptions;

  registerAiObjectPersistence();
  await ensureBoardFonts();

  const unit = 1 / (options.zoom > 0 ? options.zoom : 1);
  const width = (options.widthPx ?? 540) * unit;
  const gap = 14 * unit;
  const objects: FabricObject[] = [];
  const batch = options.batch;
  let y = 0;

  const push = (object: FabricObject, height: number) => {
    objects.push(object);
    y += height + gap;
  };
  /** Prose → a Textbox, or a KaTeX-typeset group when a formula needs it; placed at the current y. */
  const prose = async (markdown: string, style: Omit<TypesetStyle, 'color'> & { color?: string }, kind: AiObjectTag['kind'], source = markdown) => {
    const built = await buildTypeset(markdown, { color: options.color, ...style }, width);

    shift(built.object, 0, y);
    tag(built.object, { kind, source, batch });
    push(built.object, built.height);
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;

    options = { ...baseOptions, color: toneInk(block.tone) ?? baseOptions.color };

    switch (block.type) {
      case 'heading': {
        const size = block.level && block.level >= 3 ? 24 : 30;

        await prose(block.text, { fontSize: size * unit, weight: BOARD_WEIGHT.heading, lineHeight: 1.3 }, 'heading');
        break;
      }
      case 'paragraph': {
        await prose(block.text, { fontSize: 22 * unit, weight: BOARD_WEIGHT.body, lineHeight: 1.3 }, 'paragraph');
        break;
      }
      case 'list': {
        const marker = (i: number) => (block.ordered ? `${i + 1}.` : '•');

        if (block.items.some((item) => needsTypesetMath(item))) {
          // A formula in an item: each item typeset on its own, the list still one source.
          for (let i = 0; i < block.items.length; i += 1) {
            await prose(`${marker(i)} ${block.items[i]}`, { fontSize: 22 * unit, weight: BOARD_WEIGHT.body, lineHeight: 1.3 }, 'list', i === 0 ? blocksToMarkdown([block]) : '');
            y -= gap * 0.6;
          }

          y += gap * 0.6;
          break;
        }

        const text = block.items.map((item, i) => `${marker(i)} ${boardText(item)}`).join('\n');
        const box = tag(textbox(text, unit, { size: 22, color: options.color, width }), {
          kind: 'list',
          source: blocksToMarkdown([block]),
          batch,
        });

        box.set({ top: y });
        push(box, box.height ?? 22 * unit);
        break;
      }
      case 'math': {
        const raster = await renderMathImage(block.text, { fontPx: 30, color: options.color });
        const image = raster ? await imageObject(raster.dataUrl) : null;

        if (image && raster) {
          // The PNG is 3× its CSS size; scale back to CSS px, then to scene units.
          const scale = Math.min((raster.width * unit) / (image.width || 1), width / (image.width || 1));
          const drawnWidth = (image.width || 0) * scale;

          image.set({ ...TOP_LEFT, left: (width - drawnWidth) / 2, top: y, scaleX: scale, scaleY: scale });
          tag(image, { kind: 'math', source: block.text, batch });
          push(image, (image.height || 0) * scale);
        } else {
          const box = tag(textbox(latexToText(block.text), unit, { size: 26, color: options.color, width, align: 'center' }), {
            kind: 'math',
            source: block.text,
            batch,
          });

          box.set({ top: y });
          push(box, box.height ?? 26 * unit);
        }

        break;
      }
      case 'table': {
        const raster = renderTableImage(block, { fontPx: 20, color: options.color });
        const image = raster ? await imageObject(raster.dataUrl) : null;

        if (image && raster) {
          const scale = Math.min((raster.width * unit) / (image.width || 1), width / (image.width || 1));

          image.set({ ...TOP_LEFT, left: width - (image.width || 0) * scale, top: y, scaleX: scale, scaleY: scale });
          tag(image, { kind: 'table', source: blocksToMarkdown([block]), batch });
          push(image, (image.height || 0) * scale);
        }

        break;
      }
      case 'question': {
        const card = await buildQuestionCard(block, index, unit, width, options);

        card.set({ top: y });
        push(card, card.height ?? 0);
        break;
      }
      case 'diagram': {
        const graph = parseMermaidFlowchart(block.mermaid);

        if (!graph) {
          const box = tag(textbox(block.mermaid, unit, { size: 16, color: options.color, width, align: 'left' }), {
            kind: 'paragraph',
            source: block.mermaid,
            batch,
          });

          box.set({ top: y });
          push(box, box.height ?? 0);
          break;
        }

        const parts = await buildGraphObjects(graph, null, {
          zoom: options.zoom,
          color: options.color,
          batch,
          kind: 'diagram',
          maxWidthPx: options.diagramWidthPx ?? (options.widthPx ?? 540) * 1.6,
          maxHeightPx: 640,
        });
        const bounds = objectsBounds(parts);

        translateObjects(parts, (width - bounds.width) / 2 - bounds.left, y - bounds.top);
        parts.forEach((part) => objects.push(part));
        y += bounds.height + gap;
        break;
      }
      case 'image': {
        const image = await imageObject(block.src);

        if (image) {
          const scale = Math.min(width / (image.width || 1), (420 * unit) / (image.height || 1));

          image.set({ ...TOP_LEFT, left: (width - (image.width || 0) * scale) / 2, top: y, scaleX: scale, scaleY: scale });
          tag(image, { kind: 'image', source: block.alt, batch });

          if (block.labels?.length) {
            // Labelled: picture + editable labels + leader lines move together.
            const group = await buildLabeledImage(image, block.labels, { color: options.color, unit });

            tag(group, { kind: 'image', source: block.alt, batch });
            push(group, (image.height || 0) * scale);
          } else {
            push(image, (image.height || 0) * scale);
          }
        }

        break;
      }
      default:
        break;
    }
  }

  return objects;
}

async function buildQuestionCard(
  block: Extract<BoardAiBlock, { type: 'question' }>,
  index: number,
  unit: number,
  width: number,
  options: BuildOptions,
): Promise<Group> {
  const labels = CONTENT_LABELS;
  const letters = choiceLetters();
  const pad = 16 * unit;
  const inner = width - pad * 2;
  const parts: FabricObject[] = [];
  let y = pad;
  const add = async (markdown: string, style: { size: number; weight: TypesetWeight; color?: string }) => {
    const built = await buildTypeset(markdown, { fontSize: style.size * unit, weight: style.weight, color: style.color ?? options.color, lineHeight: 1.3 }, inner);

    shift(built.object, pad, y);
    parts.push(built.object);
    y += built.height + 8 * unit;
  };

  await add(block.stem, { size: 22, weight: BOARD_WEIGHT.medium });

  if (block.choices?.length) {
    if (block.choices.some((choice) => needsTypesetMath(choice))) {
      for (let i = 0; i < block.choices.length; i += 1) {
        await add(`${letters[i] ?? i + 1}) ${block.choices[i]}`, { size: 20, weight: BOARD_WEIGHT.body });
        y -= 4 * unit;
      }
    } else {
      await add(block.choices.map((choice, i) => `${letters[i] ?? i + 1}) ${choice}`).join('\n'), { size: 20, weight: BOARD_WEIGHT.body });
    }
  }

  if (options.withAnswers) {
    const answer =
      block.answerIndex !== undefined && block.choices?.[block.answerIndex] !== undefined
        ? `${letters[block.answerIndex]}) ${block.choices[block.answerIndex]}`
        : (block.answer ?? '');

    if (answer) await add(`✓ ${labels.answer}: ${answer}`, { size: 20, weight: BOARD_WEIGHT.heading, color: '#18204a' });
    if (block.explanation) await add(block.explanation, { size: 18, weight: BOARD_WEIGHT.body, color: 'rgba(24, 32, 74, 0.72)' });
  }

  const height = y + pad - 8 * unit;
  const card = new Rect({
    ...TOP_LEFT,
    left: 0,
    top: 0,
    width,
    height,
    rx: 14 * unit,
    ry: 14 * unit,
    fill: '#fbfaf6',
    stroke: '#18204a',
    strokeWidth: 2 * unit,
  });
  const group = new Group([card, ...parts], { ...TOP_LEFT, left: 0, top: 0, subTargetCheck: false, objectCaching: false });

  return tag(group, {
    kind: 'question',
    source: blocksToMarkdown([block], { withAnswers: true }).replace(/^\*\*Q\d+:\*\*/, `**${labels.question}${index + 1}:**`),
    batch: options.batch,
  });
}

// ---------------------------------------------------------------------------
// Graphs: diagrams and concept maps
// ---------------------------------------------------------------------------

export interface GraphBuildOptions {
  zoom: number;
  color: string;
  batch?: string;
  kind: 'diagram' | 'concept';
  /** Shrink (never below 45%) so the whole graph fits this many on-screen px. */
  maxWidthPx?: number;
  maxHeightPx?: number;
}

interface MeasuredNode {
  id: string;
  text: string;
  shape: ConceptNodeShape;
  color: string;
  textWidth: number;
  textHeight: number;
  width: number;
  height: number;
  level?: number;
}

function measureNodes(map: ConceptMap, style: ConceptMapStyle | null, unit: number, fallbackColor: string): MeasuredNode[] {
  const fontSize = 20 * unit;
  const maxText = 190 * unit;

  return map.nodes.map((node) => {
    const text = boardText(node.text);
    const probe = new FabricText(text, { fontSize, fontFamily: BOARD_TEXT_FONT, fontWeight: node.level === 0 ? BOARD_WEIGHT.heading : BOARD_WEIGHT.body });
    const natural = Math.max(probe.width ?? 0, 24 * unit);
    const textWidth = Math.min(maxText, natural + 2 * unit);
    const wrapped = new Textbox(text, { width: textWidth, fontSize, fontFamily: BOARD_TEXT_FONT, fontWeight: node.level === 0 ? BOARD_WEIGHT.heading : BOARD_WEIGHT.body, lineHeight: 1.2 });
    const textHeight = wrapped.height ?? fontSize * 1.2;
    const shape: ConceptNodeShape = node.shape ?? style?.shape ?? 'rounded';
    const padX = 16 * unit;
    const padY = 10 * unit;
    const [width, height] =
      shape === 'ellipse'
        ? [textWidth * 1.42 + padX, textHeight * 1.42 + padY]
        : shape === 'diamond'
          ? [textWidth * 1.9 + padX, textHeight * 1.9 + padY]
          : shape === 'none'
            ? [textWidth + padX / 2, textHeight + padY / 2]
            : [textWidth + padX * 2, textHeight + padY * 2];
    const palette = style?.nodeColors?.length ? style.nodeColors : [fallbackColor];
    const color = node.color ?? palette[(node.level ?? 0) % palette.length] ?? fallbackColor;

    return { id: node.id, text, shape, color, textWidth, textHeight, width, height, level: node.level };
  });
}

/**
 * A diagram / concept map → objects: one Group per node (outline + text) and one Group per edge
 * (line + arrowheads + label). `style` null = diagram defaults in the teacher's pen colour.
 */
export async function buildGraphObjects(map: ConceptMap, style: ConceptMapStyle | null, options: GraphBuildOptions): Promise<FabricObject[]> {
  registerAiObjectPersistence();
  await ensureBoardFonts();

  const leveled = withLevels(map);
  const direction = style?.direction ?? map.direction ?? 'tb';
  const spacing = style?.spacing ?? 1;
  const build = (unit: number) => {
    const measured = measureNodes(leveled, style, unit, options.color);
    // A server-generated map comes laid out: place its boxes in a viewport-sized frame (scaled with
    // `unit` like everything else), and lay out ourselves only if a box is missing or two collide.
    const given = map.serverLayout
      ? layoutFromBoxes(
          measured.map((node) => ({
            id: node.id,
            width: node.width,
            height: node.height,
            level: node.level,
            bbox: leveled.nodes.find((source) => source.id === node.id)?.bbox,
          })),
          leveled.edges,
          { width: (options.maxWidthPx ?? 960) * unit, height: (options.maxHeightPx ?? 640) * unit },
        )
      : null;

    if (given) return { measured, layout: given };

    const layout = layoutGraph(
      measured.map((node) => ({ id: node.id, width: node.width, height: node.height, level: node.level })),
      leveled.edges,
      { direction, levelGap: 64 * unit * spacing, siblingGap: 26 * unit * spacing },
    );

    return { measured, layout };
  };

  let unit = 1 / (options.zoom > 0 ? options.zoom : 1);
  let { measured, layout } = build(unit);
  const limitW = (options.maxWidthPx ?? Infinity) / (options.zoom || 1);
  const limitH = (options.maxHeightPx ?? Infinity) / (options.zoom || 1);
  const fit = Math.min(1, limitW / (layout.bounds.width || 1), limitH / (layout.bounds.height || 1));

  if (fit < 0.98) {
    unit *= Math.max(0.45, fit);
    ({ measured, layout } = build(unit));
  }

  const byId = new Map(measured.map((node) => [node.id, node]));
  const strokeWidth = (style?.strokeWidth ?? 2.5) * unit;
  const edgeColor = style?.edgeColor ?? options.color;
  const source = options.kind === 'diagram' ? graphToMermaid({ ...leveled, direction }) : JSON.stringify({ ...leveled, direction });
  const nodeKind = options.kind === 'diagram' ? 'diagram-node' : 'concept-node';
  const edgeKind = options.kind === 'diagram' ? 'diagram-edge' : 'concept-edge';
  const objects: FabricObject[] = [];
  // Offset so the graph's top-left is (0, 0).
  const ox = -layout.bounds.left;
  const oy = -layout.bounds.top;

  // Edges first so nodes sit on top of line ends.
  leveled.edges.forEach((edge, edgeIndex) => {
    const a = layout.nodes.get(edge.from);
    const b = layout.nodes.get(edge.to);
    const na = byId.get(edge.from);
    const nb = byId.get(edge.to);

    if (!a || !b || !na || !nb) return;

    const start = boundaryPoint(a, a, b, na.shape);
    const end = boundaryPoint(b, b, a, nb.shape);
    const parts: FabricObject[] = [
      new Line([start.x + ox, start.y + oy, end.x + ox, end.y + oy], {
        stroke: edgeColor,
        strokeWidth,
        strokeLineCap: 'round',
        strokeDashArray: layout.treeEdges.has(edgeKey(edge.from, edge.to)) ? undefined : [8 * unit, 6 * unit],
      }),
    ];
    const arrow = edge.arrow ?? style?.arrow ?? 'end';
    const head = (tip: { x: number; y: number }, from: { x: number; y: number }) => {
      const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
      const size = Math.max(10 * unit, strokeWidth * 3.5);
      const spread = Math.PI / 7;

      return new Polygon(
        [
          { x: tip.x + ox, y: tip.y + oy },
          { x: tip.x + ox - size * Math.cos(angle - spread), y: tip.y + oy - size * Math.sin(angle - spread) },
          { x: tip.x + ox - size * Math.cos(angle + spread), y: tip.y + oy - size * Math.sin(angle + spread) },
        ],
        { fill: edgeColor, stroke: edgeColor, strokeWidth: unit },
      );
    };

    if (arrow === 'end' || arrow === 'both') parts.push(head(end, start));
    if (arrow === 'both') parts.push(head(start, end));

    if (edge.label) {
      const label = new Textbox(boardText(edge.label), {
        originX: 'center',
        originY: 'center',
        left: (start.x + end.x) / 2 + ox,
        top: (start.y + end.y) / 2 + oy,
        width: Math.min(160 * unit, Math.max(40 * unit, boardText(edge.label).length * 10 * unit)),
        fontSize: 16 * unit,
        fontFamily: BOARD_TEXT_FONT,
        fontWeight: BOARD_WEIGHT.medium,
        fill: edgeColor,
        textAlign: 'center',
        backgroundColor: 'rgba(255,255,255,0.92)',
      });

      parts.push(label);
    }

    objects.push(
      tag(new Group(parts, { ...TOP_LEFT }), {
        kind: edgeKind,
        source: edgeIndex === 0 ? source : undefined,
        batch: options.batch,
      }),
    );
  });

  for (const node of measured) {
    const placed = layout.nodes.get(node.id);

    if (!placed) continue;

    const cx = placed.x + ox;
    const cy = placed.y + oy;
    const common = { originX: 'center' as const, originY: 'center' as const, left: cx, top: cy };
    const outlineProps = { ...common, fill: 'rgba(255,255,255,0.92)', stroke: node.color, strokeWidth };
    const outline: FabricObject | null =
      node.shape === 'ellipse'
        ? new Ellipse({ ...outlineProps, rx: node.width / 2, ry: node.height / 2 })
        : node.shape === 'diamond'
          ? new Polygon(
              [
                { x: cx, y: cy - node.height / 2 },
                { x: cx + node.width / 2, y: cy },
                { x: cx, y: cy + node.height / 2 },
                { x: cx - node.width / 2, y: cy },
              ],
              { fill: 'rgba(255,255,255,0.92)', stroke: node.color, strokeWidth },
            )
          : node.shape === 'none'
            ? null
            : new Rect({
                ...outlineProps,
                width: node.width,
                height: node.height,
                rx: node.shape === 'rounded' ? Math.min(node.height / 2, 16 * unit) : 3 * unit,
                ry: node.shape === 'rounded' ? Math.min(node.height / 2, 16 * unit) : 3 * unit,
              });
    const label = new Textbox(node.text, {
      ...common,
      width: node.textWidth,
      fontSize: 20 * unit,
      fontFamily: BOARD_TEXT_FONT,
      fontWeight: node.level === 0 ? BOARD_WEIGHT.heading : BOARD_WEIGHT.body,
      fill: node.color,
      textAlign: 'center',
      lineHeight: 1.2,
    });

    objects.push(
      tag(new Group(outline ? [outline, label] : [label], { ...TOP_LEFT }), {
        kind: nodeKind,
        source: objects.length === 0 ? source : undefined,
        batch: options.batch,
      }),
    );
  }

  return objects;
}

// ---------------------------------------------------------------------------
// Markers («Mark the mistakes»)
// ---------------------------------------------------------------------------

/** A red ring around the wrong answer (when its box is known) + a ✗ and the right answer beside it. */
export function buildMarkerObjects(
  target: SceneRect,
  { zoom, correctAnswer, ring, batch }: { zoom: number; correctAnswer?: string; ring: boolean; batch?: string; lang?: ContentLang },
): FabricObject[] {
  registerAiObjectPersistence();

  const unit = 1 / (zoom > 0 ? zoom : 1);
  const red = '#e11d48';
  const parts: FabricObject[] = [];
  const pad = 6 * unit;

  if (ring) {
    parts.push(
      new Ellipse({
        originX: 'center',
        originY: 'center',
        left: target.left + target.width / 2,
        top: target.top + target.height / 2,
        rx: target.width / 2 + pad * 2,
        ry: target.height / 2 + pad * 2,
        fill: 'transparent',
        stroke: red,
        strokeWidth: 3 * unit,
      }),
    );
  }

  // The ✗ and the right answer go in the margin to the right of the line.
  const x = target.left + target.width + pad * 3;

  parts.push(
    new FabricText('✗', {
      ...TOP_LEFT,
      left: x,
      top: target.top - 4 * unit,
      fontSize: 34 * unit,
      fontWeight: BOARD_WEIGHT.heading,
      fontFamily: BOARD_TEXT_FONT,
      fill: red,
    }),
  );

  if (correctAnswer) {
    parts.push(
      new Textbox(`${CONTENT_LABELS.correct}: ${boardText(correctAnswer)}`, {
        ...TOP_LEFT,
        left: x,
        top: target.top + 34 * unit,
        width: 200 * unit,
        fontSize: 16 * unit,
        fontFamily: BOARD_TEXT_FONT,
        fontWeight: BOARD_WEIGHT.medium,
        fill: red,
        textAlign: 'left',
      }),
    );
  }

  return [tag(new Group(parts, { ...TOP_LEFT }), { kind: 'marker', source: correctAnswer, batch })];
}

// ---------------------------------------------------------------------------
// Placement helpers
// ---------------------------------------------------------------------------

export function objectsBounds(objects: FabricObject[]): SceneRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const object of objects) {
    object.setCoords();

    const rect = object.getBoundingRect();

    minX = Math.min(minX, rect.left);
    minY = Math.min(minY, rect.top);
    maxX = Math.max(maxX, rect.left + rect.width);
    maxY = Math.max(maxY, rect.top + rect.height);
  }

  if (!Number.isFinite(minX)) return { left: 0, top: 0, width: 0, height: 0 };

  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

export function translateObjects(objects: FabricObject[], dx: number, dy: number): void {
  for (const object of objects) {
    object.set({ left: (object.left ?? 0) + dx, top: (object.top ?? 0) + dy });
    object.setCoords();
  }
}

// ---------------------------------------------------------------------------
// Page remake («Make a similar page»)
// ---------------------------------------------------------------------------

/**
 * Placements → objects at their exact page positions. Text is an editable Textbox sized to its
 * block; math is KaTeX fitted inside its box (text fallback); figures are cut from `sourcePage` —
 * the snapshot the layout was read from, covering exactly the target rect — and placed unchanged.
 */
export async function buildLayoutObjects(
  placements: LayoutPlacement[],
  { sourcePage, sourceRect, color = '#18204a', batch }: { sourcePage: HTMLCanvasElement | null; sourceRect: SceneRect; color?: string; batch?: string },
): Promise<FabricObject[]> {
  registerAiObjectPersistence();
  await ensureBoardFonts();

  const objects: FabricObject[] = [];

  for (const placement of placements) {
    const { rect } = placement;

    switch (placement.kind) {
      case 'text': {
        const box = new Textbox(boardText(placement.text), {
          ...TOP_LEFT,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          fontSize: placement.fontSize,
          fontFamily: BOARD_TEXT_FONT,
          fontWeight: placement.bold ? BOARD_WEIGHT.heading : BOARD_WEIGHT.body,
          fill: placement.color ?? color,
          textAlign: placement.align,
            lineHeight: 1.2,
        });

        objects.push(tag(box, { kind: 'remake-text', source: placement.text, batch }));
        break;
      }
      case 'math': {
        const raster = await renderMathImage(placement.tex, { fontPx: Math.max(14, placement.fontSize), color: placement.color ?? color });
        const image = raster ? await imageObject(raster.dataUrl) : null;

        if (image && raster) {
          const scale = Math.min(rect.width / (image.width || 1), rect.height / (image.height || 1), placement.fontSize * 3 / (image.height || 1));
          image.set({ ...TOP_LEFT, left: rect.left, top: rect.top, scaleX: scale, scaleY: scale });
          objects.push(tag(image, { kind: 'remake-math', source: placement.tex, batch }));
        } else {
          const box = new Textbox(latexToText(placement.tex), {
            ...TOP_LEFT,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            fontSize: placement.fontSize,
            fontFamily: BOARD_TEXT_FONT,
            fill: placement.color ?? color,
            textAlign: 'left',
          });

          objects.push(tag(box, { kind: 'remake-math', source: placement.tex, batch }));
        }

        break;
      }
      case 'figure': {
        if (!sourcePage) break;

        const crop = document.createElement('canvas');
        const sx = placement.source.x * sourcePage.width;
        const sy = placement.source.y * sourcePage.height;
        const sw = Math.max(1, placement.source.w * sourcePage.width);
        const sh = Math.max(1, placement.source.h * sourcePage.height);

        crop.width = Math.round(sw);
        crop.height = Math.round(sh);
        crop.getContext('2d')?.drawImage(sourcePage, sx, sy, sw, sh, 0, 0, crop.width, crop.height);

        const image = await imageObject(crop.toDataURL('image/png'));

        if (image) {
          image.set({ ...TOP_LEFT, left: rect.left, top: rect.top, scaleX: rect.width / (image.width || 1), scaleY: rect.height / (image.height || 1) });
          objects.push(tag(image, { kind: 'remake-figure', batch }));
        }

        break;
      }
      case 'lines': {
        const gap = rect.height / placement.count;
        const lines: FabricObject[] = [];

        for (let index = 0; index < placement.count; index += 1) {
          const y = rect.top + gap * (index + 1) - gap * 0.2;

          lines.push(
            new Line([rect.left, y, rect.left + rect.width, y], {
              stroke: 'rgba(24, 32, 74, 0.45)',
              strokeWidth: Math.max(1, sourceRect.width / 900),
              strokeDashArray: [4, 4],
            }),
          );
        }

        objects.push(tag(new Group(lines, { ...TOP_LEFT }), { kind: 'remake-lines', batch }));
        break;
      }
      case 'table': {
        const raster = renderTableImage({ header: placement.header, rows: placement.rows }, { fontPx: 20, color });
        const image = raster ? await imageObject(raster.dataUrl) : null;

        if (image && raster) {
          const scale = Math.min(rect.width / (image.width || 1), rect.height / (image.height || 1));

          image.set({ ...TOP_LEFT, left: rect.left + rect.width - (image.width || 0) * scale, top: rect.top, scaleX: scale, scaleY: scale });
          objects.push(tag(image, { kind: 'remake-table', source: blocksToMarkdown([{ type: 'table', header: placement.header, rows: placement.rows }]), batch }));
        }

        break;
      }
      default:
        break;
    }
  }

  return objects;
}

/**
 * «Treat it as a picture»: the rebuilt page flattened onto white at `pixelWidth`, as a PNG file — imported as an
 * image PAGE, so it behaves like a PDF page (ink on top, eraser cannot touch it).
 */
export async function flattenObjectsToFile(objects: FabricObject[], rect: SceneRect, pixelWidth = 1654, name = 'remade-page.png'): Promise<File | null> {
  const { StaticCanvas } = await import('fabric');
  const scale = pixelWidth / rect.width;
  const element = document.createElement('canvas');
  const canvas = new StaticCanvas(element, {
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
    backgroundColor: '#ffffff',
    renderOnAddRemove: false,
  });

  canvas.setViewportTransform([scale, 0, 0, scale, -rect.left * scale, -rect.top * scale]);
  objects.forEach((object) => canvas.add(object));
  canvas.renderAll();

  const blob = await new Promise<Blob | null>((resolve) => canvas.getElement().toBlob((value) => resolve(value), 'image/png'));

  objects.forEach((object) => canvas.remove(object));
  canvas.dispose();

  return blob ? new File([blob], name, { type: 'image/png' }) : null;
}
