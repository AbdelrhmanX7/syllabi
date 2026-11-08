import type { Canvas } from 'fabric';

import { translateObjects } from './boardObjects';
import { estimateHandStyle, inkSamplesFromObjects } from './handStyle';
import { planHandConceptMap } from './handConceptMap';
import { rememberHandMap } from './handConceptMapControl';
import { backdropLinesToScene, chooseHandMapPlacement } from './handConceptMapPlace';
import { detectInkLines } from './lassoGeometry';
import { buildTermsMapObjects } from './termsMapObjects';
import { playObjectReveal } from './writeOn';

import type { ContentLang } from './markdownBlocks';
import type { ConceptMap, SceneRect } from './types';

/**
 * Draw a ready concept map (the AI reference map) on the CURRENT page in hand-drawn ink: node text
 * written by the handwriting pipeline in the owner's hand (HandStyle read off the page's ink; the
 * default hand when the page has none), hand ellipses, bowed arrows with two-stroke heads, linking
 * phrases written along them. Placed where it covers nothing (handConceptMapPlace.ts): below
 * everything already on a notebook sheet (it grows down), centred, shrunk to its width; on a PDF /
 * slide page, in the page's blank space (its printed lines count as taken), smaller if need be. Every object is a plain pen Path tagged `wbAi`, added
 * in ONE tick = one undo step. The reveal plays when the map lands in view.
 */

export interface HandConceptInsertOptions {
  /** The pen colour, used when the page has no ink to read the owner's colour from. */
  penColor: string;
  penWidth: number;
  lang?: ContentLang;
  /** The notebook sheet's horizontal extent (scene units); absent = what is on screen. */
  sheet?: { left: number; right: number } | null;
  /** Bring a scene rect into view before the reveal (the editor's own clamped scroll). */
  scrollIntoView?: (rect: SceneRect) => void;
  /** Overlay host for the reveal; absent = no animation. */
  host?: HTMLElement | null;
  /** Still the page the map was meant for? Checked before the objects land. */
  isStillCurrent?: () => boolean;
  /**
   * A PDF / slide page: its rect (scene units) and its printed lines (scene rects) — not board
   * objects, so the map would otherwise be written over them. `lines` null = unread: the whole page
   * counts as taken.
   */
  backdrop?: { rect: SceneRect; lines: SceneRect[] | null } | null;
}

/**
 * A PDF / slide page's backdrop for {@link insertHandConceptMap}: its scene rect and its printed
 * lines, read off the page raster (downscaled; `detectInkLines`). No raster, a rotated page or a
 * tainted canvas → lines null (the whole page counts as taken: the map goes below it).
 */
export function readPageBackdrop(rect: SceneRect, image: HTMLImageElement | null): { rect: SceneRect; lines: SceneRect[] | null } {
  if (!image || !(image.naturalWidth || image.width)) return { rect, lines: null };

  try {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const scale = Math.min(1, 480 / Math.max(width, height));
    const small = document.createElement('canvas');

    small.width = Math.max(1, Math.round(width * scale));
    small.height = Math.max(1, Math.round(height * scale));
    const context = small.getContext('2d');

    if (!context) return { rect, lines: null };
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, small.width, small.height);
    context.drawImage(image, 0, 0, small.width, small.height);
    const pixels = context.getImageData(0, 0, small.width, small.height).data;

    return { rect, lines: backdropLinesToScene(detectInkLines(pixels, small.width, small.height, { mergeGap: 3 }), rect) };
  } catch {
    return { rect, lines: null };
  }
}

/** Default hand when the page has no ink: a comfortable notebook letter at zoom 1. */
const DEFAULT_LETTER_HEIGHT = 22;

/** Readable on white: the pen colour unless it is too light to read (yellow/white nibs). */
function readableInk(color: string): string {
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];

  if (!hex) return '#18204a';

  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);

  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.6 ? '#18204a' : color;
}

export async function insertHandConceptMap(canvas: Canvas, map: ConceptMap, options: HandConceptInsertOptions): Promise<boolean> {
  if (map.nodes.length === 0) return false;

  const vpt = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
  const zoom = vpt[0] || 1;
  const view = {
    left: -(vpt[4] ?? 0) / zoom,
    top: -(vpt[5] ?? 0) / zoom,
    width: canvas.getWidth() / zoom,
    height: canvas.getHeight() / zoom,
  };
  const existing = canvas.getObjects().filter((object) => object.visible !== false);
  const hand = estimateHandStyle(inkSamplesFromObjects(existing));
  const letterHeight = hand?.letterHeight && hand.letterHeight > 4 ? hand.letterHeight : DEFAULT_LETTER_HEIGHT;
  const region = options.sheet && options.sheet.right > options.sheet.left ? options.sheet : { left: view.left, right: view.left + view.width };
  const margin = letterHeight * 1.5;
  const maxWidth = Math.max(letterHeight * 10, region.right - region.left - margin * 2);
  const minLetterHeight = Math.min(letterHeight, 9);
  const occupied = existing
    .map((object) => object.getBoundingRect())
    .filter((rect) => Number.isFinite(rect.left + rect.top + rect.width + rect.height));
  const backdrop = options.backdrop ?? null;

  if (backdrop) occupied.push(...(backdrop.lines ?? [backdrop.rect]));
  // On a page: the full-size map, then smaller hands, until one fits the blank space.
  const pageWidth = backdrop ? Math.max(letterHeight * 10, backdrop.rect.width - margin * 2) : maxWidth;
  const plans = [planHandConceptMap(map, { letterHeight, maxWidth: Math.min(maxWidth, pageWidth), minLetterHeight })];

  if (backdrop) {
    for (const factor of [0.8, 0.65, 0.5]) {
      const smaller = letterHeight * factor;

      if (smaller < minLetterHeight || smaller >= plans[plans.length - 1]!.letterHeight) continue;
      plans.push(planHandConceptMap(map, { letterHeight: smaller, maxWidth: Math.min(maxWidth, pageWidth), minLetterHeight }));
    }
  }
  const spot = chooseHandMapPlacement({
    sizes: plans.map((candidate) => ({ width: candidate.width, height: candidate.height })),
    occupied,
    backdrop: backdrop?.rect ?? null,
    region,
    viewTop: Math.max(0, view.top),
    margin,
  });
  // Below the page (no blank space on it): the full-size map on the sheet's width.
  const plan = spot.onPage ? plans[spot.index]! : planHandConceptMap(map, { letterHeight, maxWidth, minLetterHeight });
  // The nib thins with the hand when the map had to shrink to fit the sheet.
  const shrink = Math.max(0.6, plan.letterHeight / letterHeight);
  const strokeWidth = (hand?.strokeWidth || Math.max(1.5, options.penWidth)) * shrink;
  const built = await buildTermsMapObjects(plan, {
    sources: new Map(),
    color: hand?.color ?? readableInk(options.penColor),
    strokeWidth,
    hand: hand ? { ...hand, letterHeight: plan.letterHeight, strokeWidth } : null,
    zoom,
    lang: options.lang,
    batch: `ai-${Date.now().toString(36)}`,
    lh: plan.letterHeight,
  });

  if (built.objects.length === 0) return false;
  // The map rides on its first part, so «Tidy» can lay it out again (handConceptMapControl.ts).
  rememberHandMap(built.objects, map);
  if (options.isStillCurrent && !options.isStillCurrent()) return false;

  const top = spot.top;
  const left = spot.onPage ? spot.left : Math.max(region.left + margin / 2, region.left + (region.right - region.left - plan.width) / 2);

  translateObjects(built.objects, left, top);

  const target: SceneRect = { left, top, width: plan.width, height: plan.height };

  options.scrollIntoView?.({ left: target.left, top: target.top - margin, width: target.width, height: Math.min(target.height, view.height) });

  const afterVpt = canvas.viewportTransform ?? vpt;
  const viewTop = -(afterVpt[5] ?? 0) / zoom;
  const viewBottom = viewTop + canvas.getHeight() / zoom;
  const inView = target.top < viewBottom && target.top + target.height > viewTop;
  const playback = options.host && inView ? playObjectReveal(canvas, options.host, built.steps) : null;

  if (playback) await playback.done;

  if (options.isStillCurrent && !options.isStillCurrent()) {
    playback?.dispose();

    return false;
  }

  // One tick: every add lands in the same idle snapshot → ONE undo step.
  canvas.add(...built.objects);
  canvas.renderAll();
  playback?.dispose();

  return true;
}
