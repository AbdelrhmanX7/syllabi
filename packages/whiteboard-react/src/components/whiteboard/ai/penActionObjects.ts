import type { FabricObject } from 'fabric';

import { AI_OBJECT_PROP, objectsBounds, registerAiObjectPersistence } from './boardObjects';
import { buildHandwritingObjects } from './handwritingObjects';
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
  | { kind: 'pointer'; at: ScenePt; note?: string };

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
  const style: HandStyle = {
    slantDeg: options.hand?.slantDeg ?? 0,
    strokeWidth: options.hand?.strokeWidth ?? options.strokeWidth,
    letterHeight: primitive.letterHeight,
    color: options.color,
    samples: options.hand?.samples ?? 0,
  };
  const built = await buildHandwritingObjects([{ type: 'paragraph', text: primitive.lines.join(' ') }], {
    zoom: options.zoom,
    color: options.color,
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
  const scale = Math.max(0.4, Math.min(2.5, Math.min((primitive.letterHeight * 1.5 * lines) / bounds.height, (primitive.box.width * 1.08) / bounds.width)));
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
        const path = penPath(smoothPath(primitive.points), { color: options.color, strokeWidth: primitive.width });
        const opacity = primitive.tool === 'highlighter' ? HIGHLIGHTER_OPACITY : 1;

        if (opacity < 1) path.set({ opacity });

        tag(path, { kind: primitive.role === 'ink' ? 'pen-stroke' : 'pen-mark', source: primitive.role, batch: options.batch });
        objects.push(path);
        steps.push({ kind: 'stroke', points: primitive.points, color: options.color, width: primitive.width, opacity, objects: [path] });
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
