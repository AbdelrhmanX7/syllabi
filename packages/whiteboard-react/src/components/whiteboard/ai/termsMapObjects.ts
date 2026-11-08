import { Path, util } from 'fabric';

import type { FabricObject } from 'fabric';

import { AI_OBJECT_PROP, objectsBounds, registerAiObjectPersistence } from './boardObjects';
import { buildHandwritingObjects } from './handwritingObjects';

import type { AiObjectTag } from './boardObjects';
import type { HandStyle } from './handStyle';
import type { ContentLang } from './markdownBlocks';
import type { TermsMapPlan, TermsPrimitive } from './termsMap';

/**
 * «Map my terms» — the Fabric half: a {@link TermsMapPlan} → board objects, all at plan-local
 * coordinates (the caller moves them into place and adds them in one tick = one undo step).
 *
 * - ink-copy: clones of the owner's own strokes (the originals are never touched);
 * - outline / arrow: plain pen Paths — no fill, the owner's colour and nib, round caps and joins, the
 *   same object a pen stroke is, so the stroke eraser, selection and undo treat them as ink;
 * - label: the handwriting pipeline (traced Ruqaa outlines) in the owner's slant and colour.
 */

export interface TermsBuildOptions {
  /** Cluster id → the ORIGINAL objects of that cluster (cloned, never moved). */
  sources: ReadonlyMap<string, FabricObject[]>;
  color: string;
  /** Pen width, scene units. */
  strokeWidth: number;
  hand: HandStyle | null;
  zoom: number;
  lang?: ContentLang;
  batch: string;
  /** A hand-drawn concept map: its letter height rides on every part, so a dragged node's links can be redrawn. */
  lh?: number;
}

export interface TermsBuild {
  objects: FabricObject[];
  /** The objects grouped by plan step — the order the reveal draws them in. */
  steps: FabricObject[][];
}

const tag = <T extends FabricObject>(object: T, value: AiObjectTag): T => {
  (object as unknown as Record<string, unknown>)[AI_OBJECT_PROP] = value;

  return object;
};

/** A path the way the pencil brush commits one. */
export function penPath(d: string, { color, strokeWidth, dashed = false }: { color: string; strokeWidth: number; dashed?: boolean }): Path {
  return new Path(d, {
    fill: null,
    stroke: color,
    strokeWidth,
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    strokeMiterLimit: 10,
    strokeDashArray: dashed ? [strokeWidth * 3.2, strokeWidth * 3] : null,
  });
}

/** `M … M …` → one path per pen stroke (a person lifts the pen between them). */
const splitStrokes = (d: string) =>
  d
    .split(/(?=M )/)
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * The written height of a line that has both ascenders and descenders, at this letter height — what a
 * typical line measures. A word with neither («water», «convert») is much shorter than that, and
 * scaling every line to the same HEIGHT blew those words up past their neighbours (and out of their
 * ellipse). Cached per size: one probe, not one per word.
 */
const probeHeights = new Map<string, Promise<number>>();

function probeHeight(style: HandStyle, options: TermsBuildOptions): Promise<number> {
  const key = `${style.letterHeight}|${options.zoom}|${style.slantDeg}`;
  let known = probeHeights.get(key);

  if (!known) {
    known = buildHandwritingObjects([{ type: 'paragraph', text: 'Hgpd' }], {
      zoom: options.zoom,
      color: style.color,
      withAnswers: false,
      widthPx: 4000,
      batch: options.batch,
      lang: options.lang,
      style,
    }).then(
      (probe) => (probe.objects.length ? objectsBounds(probe.objects).height : 0),
      () => 0,
    );
    probeHeights.set(key, known);
  }

  return known;
}

async function writeLabel(primitive: Extract<TermsPrimitive, { kind: 'label' }>, options: TermsBuildOptions): Promise<FabricObject[]> {
  const style: HandStyle = {
    slantDeg: options.hand?.slantDeg ?? 0,
    strokeWidth: options.hand?.strokeWidth ?? options.strokeWidth,
    letterHeight: primitive.textHeight,
    color: primitive.color ?? options.color,
    samples: options.hand?.samples ?? 0,
  };
  const built = await buildHandwritingObjects([{ type: 'paragraph', text: primitive.text }], {
    zoom: options.zoom,
    color: primitive.color ?? options.color,
    withAnswers: false,
    // One line: the slot was sized for the whole phrase.
    widthPx: 4000,
    batch: options.batch,
    lang: options.lang,
    style,
  });

  if (built.objects.length === 0) return [];

  const bounds = objectsBounds(built.objects);

  if (bounds.width <= 0 || bounds.height <= 0) return [];

  const { box } = primitive;
  // Written text is ~1.5× its letter height from ascender to descender; never wider than its slot allows.
  const scale = Math.min((primitive.textHeight * 1.5) / Math.max(bounds.height, await probeHeight(style, options)), (box.width * (primitive.fit ?? 1.3)) / bounds.width);
  const width = bounds.width * scale;
  const height = bounds.height * scale;
  const left = box.left + (box.width - width) / 2;
  const top = box.top + (box.height - height) / 2;

  for (const object of built.objects) {
    object.set({
      left: left + ((object.left ?? 0) - bounds.left) * scale,
      top: top + ((object.top ?? 0) - bounds.top) * scale,
      scaleX: (object.scaleX ?? 1) * scale,
      scaleY: (object.scaleY ?? 1) * scale,
    });
    object.setCoords();
    tag(object, {
      kind: 'terms-label',
      source: primitive.text,
      batch: options.batch,
      hand: true,
      ...(primitive.nodeId ? { node: primitive.nodeId } : {}),
      ...(primitive.edge ? { edge: primitive.edge } : {}),
      ...(options.lh ? { lh: options.lh } : {}),
    });
  }

  return built.objects;
}

async function copyInk(primitive: Extract<TermsPrimitive, { kind: 'ink-copy' }>, options: TermsBuildOptions): Promise<FabricObject[]> {
  const out: FabricObject[] = [];

  for (const source of options.sources.get(primitive.clusterId) ?? []) {
    const clone = await source.clone();

    // Absolute transform (a member of an ActiveSelection reports group-relative left/top).
    util.applyTransformToObject(clone, source.calcTransformMatrix());
    clone.set({ left: (clone.left ?? 0) + primitive.dx, top: (clone.top ?? 0) + primitive.dy });
    clone.setCoords();
    out.push(tag(clone, { kind: 'terms-ink', source: primitive.nodeId, batch: options.batch }));
  }

  return out;
}

export async function buildTermsMapObjects(plan: TermsMapPlan, options: TermsBuildOptions): Promise<TermsBuild> {
  registerAiObjectPersistence();

  const byStep = new Map<number, FabricObject[]>();
  const objects: FabricObject[] = [];
  const add = (step: number, made: FabricObject[]) => {
    if (made.length === 0) return;

    byStep.set(step, [...(byStep.get(step) ?? []), ...made]);
    objects.push(...made);
  };

  for (const primitive of plan.primitives) {
    switch (primitive.kind) {
      case 'outline':
        add(primitive.step, [
          tag(penPath(primitive.d, { color: primitive.color ?? options.color, strokeWidth: options.strokeWidth, dashed: primitive.dashed }), {
            kind: 'terms-node',
            source: primitive.nodeId,
            batch: options.batch,
            ...(options.lh ? { lh: options.lh } : {}),
          }),
        ]);
        break;
      case 'arrow':
        add(
          primitive.step,
          [...splitStrokes(primitive.d), ...splitStrokes(primitive.head)].map((d) =>
            tag(penPath(d, { color: primitive.color ?? options.color, strokeWidth: options.strokeWidth }), {
              kind: 'terms-edge',
              source: `${primitive.from}->${primitive.to}`,
              batch: options.batch,
              ...(options.lh ? { lh: options.lh, arrow: primitive.arrow ?? 'end' } : {}),
            }),
          ),
        );
        break;
      case 'ink-copy':
        add(primitive.step, await copyInk(primitive, options));
        break;
      case 'label':
        add(primitive.step, await writeLabel(primitive, options));
        break;
      default:
        break;
    }
  }

  const steps = Array.from(byStep.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list);

  return { objects, steps };
}
