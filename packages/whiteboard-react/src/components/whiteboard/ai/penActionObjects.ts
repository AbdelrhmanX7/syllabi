import { Circle, FabricText, Group, Rect } from 'fabric';

import type { FabricObject } from 'fabric';

import { AI_OBJECT_PROP, objectsBounds, registerAiObjectPersistence } from './boardObjects';
import { buildHandwritingObjects } from './handwritingObjects';
import { CARD_PAD, CARD_PITCH } from './penActions';
import { BOARD_TEXT_FONT } from './rasterize';
import { penPath } from './termsMapObjects';
import { smoothPath } from './termsMap';

import type { AiObjectTag } from './boardObjects';
import type { HandStyle } from './handStyle';
import type { WriteOnStroke } from './handwritingObjects';
import type { ContentLang } from './markdownBlocks';
import type { ScenePt } from './penCoords';
import type { PenPlan, PenPrimitive } from './penActions';

/**
 * «Explain on my page» — the Fabric half: a {@link PenPlan} → board objects at their final scene
 * positions, plus the ordered reveal steps the write-on overlay plays before they land (in ONE tick =
 * one undo step; cancelling discards the overlay and nothing joins the board).
 *
 * - circle / underline / arrow / free stroke: plain pen Paths — no fill, the owner's colour and nib,
 *   round caps and joins, the same object a pen stroke is (a highlighter is the same path, wide and
 *   translucent);
 * - write: the handwriting pipeline («Match my handwriting»: the owner's slant, nib and colour at the plan's
 *   letter height), scaled to the planned box;
 * - pointer: a reveal step only — the dot and its note bubble never become objects.
 *
 * Every object carries `wbAi = {kind: 'pen-…', batch}`, so one turn is one batch.
 */

export interface PenBuildOptions {
  color: string;
  /** Pen width, scene units. */
  strokeWidth: number;
  hand: HandStyle | null;
  zoom: number;
  lang?: ContentLang;
  /** The turn id — every object of the turn carries it. */
  batch: string;
}

export type PenRevealStep =
  | { kind: 'stroke'; points: ScenePt[]; color: string; width: number; opacity: number; objects: FabricObject[] }
  | {
      kind: 'write';
      strokes: WriteOnStroke[];
      fill: string;
      strokeWidth: number;
      /** scene = built × scale + (dx, dy) — how the built paths were moved into the planned box. */
      transform: { scale: number; dx: number; dy: number };
      objects: FabricObject[];
    }
  /** A typed card: fades in. Colours are fixed (navy on cream) so it reads on white paper and on the dark board. */
  | { kind: 'chip'; box: { left: number; top: number; width: number; height: number }; lines: string[]; fontSize: number; rim: string; objects: FabricObject[] }
  /** A verdict badge: pops in. */
  | { kind: 'badge'; at: ScenePt; size: number; color: string; glyph: ScenePt[][]; objects: FabricObject[] }
  /** A typeset line (a worked step with real maths): its picture fades in where the object will sit. */
  | { kind: 'picture'; box: { left: number; top: number; width: number; height: number }; image: CanvasImageSource; objects: FabricObject[] }
  | { kind: 'pointer'; at: ScenePt; note?: string };

/** The card's fixed colours: navy on cream (≈15:1), readable on white paper and on the dark board alike. */
export const CARD_FILL = '#fbfaf6';
export const CARD_INK = '#18204a';

/** A badge's white glyph as polylines in scene units (✓ / ✗ / !). */
export function badgeGlyph(verdict: 'correct' | 'wrong' | 'warning', at: ScenePt, size: number): ScenePt[][] {
  const p = (fx: number, fy: number): ScenePt => ({ x: at.x + (fx - 0.5) * size, y: at.y + (fy - 0.5) * size });

  if (verdict === 'correct') return [[p(0.28, 0.53), p(0.44, 0.69), p(0.73, 0.33)]];
  if (verdict === 'wrong') return [[p(0.33, 0.33), p(0.67, 0.67)], [p(0.67, 0.33), p(0.33, 0.67)]];

  return [[p(0.5, 0.26), p(0.5, 0.58)], [p(0.5, 0.72), p(0.5, 0.74)]];
}

export interface PenBuild {
  objects: FabricObject[];
  /** In plan order — what the overlay plays, step by step. */
  steps: PenRevealStep[];
}

const HIGHLIGHTER_OPACITY = 0.35;

const tag = <T extends FabricObject>(object: T, value: AiObjectTag): T => {
  (object as unknown as Record<string, unknown>)[AI_OBJECT_PROP] = value;

  return object;
};

async function writeNote(primitive: Extract<PenPrimitive, { kind: 'write' }>, options: PenBuildOptions): Promise<Extract<PenRevealStep, { kind: 'write' }> | null> {
  const color = primitive.color ?? options.color;
  const style: HandStyle = {
    slantDeg: options.hand?.slantDeg ?? 0,
    strokeWidth: options.hand?.strokeWidth ?? options.strokeWidth,
    letterHeight: primitive.letterHeight,
    color,
    samples: options.hand?.samples ?? 0,
  };
  const built = await buildHandwritingObjects([{ type: 'paragraph', text: primitive.lines.join(' ') }], {
    zoom: options.zoom,
    color,
    withAnswers: false,
    // The plan already wrapped the text to the box (an estimate of the hand's widths): one planned
    // line is never broken, several get a little slack — the scale below fits the result to the box.
    widthPx: primitive.lines.length === 1 ? 4000 : Math.max(40, primitive.box.width * options.zoom * 1.12),
    batch: options.batch,
    lang: options.lang,
    style,
  });

  if (built.objects.length === 0) return null;

  const bounds = objectsBounds(built.objects);

  if (bounds.width <= 0 || bounds.height <= 0) return null;

  // One Group per written line: fit the line pitch to the planned letter height, never wider than the box.
  const lines = Math.max(1, built.objects.length);
  // Never larger than the planned box (it was placed in empty space — a spill covers the neighbours):
  // when the hand wraps into more lines than planned, the note shrinks instead of growing down.
  const scale = Math.max(
    0.3,
    Math.min(2.5, (primitive.letterHeight * 1.5 * lines) / bounds.height, primitive.box.height / bounds.height, (primitive.box.width * 1.02) / bounds.width),
  );
  const width = bounds.width * scale;
  const left = primitive.box.left;
  const top = primitive.box.top;

  for (const object of built.objects) {
    object.set({
      left: left + ((object.left ?? 0) - bounds.left) * scale,
      top: top + ((object.top ?? 0) - bounds.top) * scale,
      scaleX: (object.scaleX ?? 1) * scale,
      scaleY: (object.scaleY ?? 1) * scale,
    });
    object.setCoords();
    tag(object, { kind: 'pen-note', source: primitive.text, batch: options.batch, hand: true });
  }

  return {
    kind: 'write',
    strokes: built.strokes,
    fill: built.fill,
    strokeWidth: built.strokeWidth,
    transform: { scale, dx: left - bounds.left * scale, dy: top - bounds.top * scale },
    objects: built.objects,
  };
}

export async function buildPenActionObjects(plan: PenPlan, options: PenBuildOptions): Promise<PenBuild> {
  registerAiObjectPersistence();

  const objects: FabricObject[] = [];
  const steps: PenRevealStep[] = [];

  for (const primitive of plan.primitives) {
    switch (primitive.kind) {
      case 'pointer':
        steps.push({ kind: 'pointer', at: primitive.at, ...(primitive.note ? { note: primitive.note } : {}) });
        break;
      case 'stroke': {
        const color = primitive.color ?? options.color;
        const path = penPath(smoothPath(primitive.points), { color, strokeWidth: primitive.width });
        const opacity = primitive.tool === 'highlighter' ? HIGHLIGHTER_OPACITY : 1;

        if (opacity < 1) path.set({ opacity });

        tag(path, { kind: primitive.role === 'ink' ? 'pen-stroke' : 'pen-mark', source: primitive.role, batch: options.batch });
        objects.push(path);
        steps.push({ kind: 'stroke', points: primitive.points, color, width: primitive.width, opacity, objects: [path] });
        break;
      }
      case 'chip': {
        const rim = primitive.rim ?? options.color;
        const pad = primitive.fontSize * CARD_PAD;
        const text = new FabricText(primitive.lines.join('\n'), {
          originX: 'left',
          originY: 'top',
          left: primitive.box.left + pad,
          top: primitive.box.top + pad,
          fontSize: primitive.fontSize,
          fontWeight: 600,
          fontFamily: BOARD_TEXT_FONT,
          // Fabric's line pitch is fontSize × lineHeight × 1.13.
          lineHeight: CARD_PITCH / 1.13,
          fill: CARD_INK,
        });
        const room = primitive.box.width - pad * 2;

        // The plan's widths are an estimate: a wider real line is squeezed, never spilled.
        if ((text.width ?? 0) > room && (text.width ?? 0) > 0) text.set({ scaleX: room / (text.width ?? room) });

        const group = new Group(
          [
            new Rect({
              originX: 'left',
              originY: 'top',
              left: primitive.box.left,
              top: primitive.box.top,
              width: primitive.box.width,
              height: primitive.box.height,
              rx: primitive.fontSize * 0.4,
              ry: primitive.fontSize * 0.4,
              fill: CARD_FILL,
              stroke: rim,
              strokeWidth: Math.max(1, primitive.fontSize * 0.08),
            }),
            text,
          ],
          { originX: 'left', originY: 'top' },
        );

        tag(group, { kind: 'pen-note', source: primitive.text, batch: options.batch });
        objects.push(group);
        steps.push({ kind: 'chip', box: primitive.box, lines: primitive.lines, fontSize: primitive.fontSize, rim, objects: [group] });
        break;
      }
      case 'badge': {
        const glyph = badgeGlyph(primitive.verdict, primitive.at, primitive.size);
        const width = primitive.size * 0.11;
        const group = new Group(
          [
            new Circle({ originX: 'center', originY: 'center', left: primitive.at.x, top: primitive.at.y, radius: primitive.size / 2, fill: primitive.color, stroke: CARD_FILL, strokeWidth: Math.max(1, primitive.size * 0.07) }),
            ...glyph.map((points) => penPath(smoothPath(points), { color: '#ffffff', strokeWidth: width })),
          ],
          { originX: 'left', originY: 'top' },
        );

        tag(group, { kind: 'pen-mark', source: `mark:${primitive.verdict}`, batch: options.batch });
        objects.push(group);
        steps.push({ kind: 'badge', at: primitive.at, size: primitive.size, color: primitive.color, glyph, objects: [group] });
        break;
      }
      case 'write': {
        const step = await writeNote(primitive, options);

        if (!step) break;

        objects.push(...step.objects);
        steps.push(step);
        break;
      }
      default:
        break;
    }
  }

  return { objects, steps };
}
