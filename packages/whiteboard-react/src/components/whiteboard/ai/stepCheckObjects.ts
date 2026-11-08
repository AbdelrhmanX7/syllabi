import { Circle, FabricText, Group, Line } from 'fabric';

import type { FabricObject } from 'fabric';

import { AI_OBJECT_PROP, BOARD_WEIGHT, registerAiObjectPersistence } from './boardObjects';
import { BOARD_TEXT_FONT } from './rasterize';
import { TONE_INK } from './tones';

import type { AiObjectTag } from './boardObjects';
import type { StepLine, StepMarkPlacement, StepVerdict } from './stepCheck';
import type { BoardAiTone } from './types';

/**
 * «Check this page» marks — the Fabric half of stepCheck.ts. One mark per checked step: a round,
 * flat-tinted badge with ✓ / ✗ / ! in the margin at the end of the line, and under a wrong or
 * incomplete line a thin underline in the same colour, so the exact step is unmistakable. Added as
 * ordinary AI objects (one undo step; eraser and select work on them like on any insert).
 */

/** A step verdict in the answer view's semantic tones (tones.ts). */
export const STEP_TONE: Record<StepVerdict, BoardAiTone> = { correct: 'success', wrong: 'wrong', warning: 'warning' };

/** Board ink = the tones' ink; the badge fill is the matching soft tint (a canvas has no CSS tokens). */
export const STEP_TONES: Record<StepVerdict, { ink: string; tint: string; glyph: string }> = {
  correct: { ink: TONE_INK.success, tint: '#dcfce7', glyph: '✓' },
  wrong: { ink: TONE_INK.wrong, tint: '#fee2e2', glyph: '✗' },
  warning: { ink: TONE_INK.warning, tint: '#fef3c7', glyph: '!' },
};

const TOP_LEFT = { originX: 'left' as const, originY: 'top' as const };

const tagged = <T extends FabricObject>(object: T, value: AiObjectTag): T => {
  (object as unknown as Record<string, unknown>)[AI_OBJECT_PROP] = value;

  return object;
};

/** A ✓/✗/! mark a step check placed (by its tag — survives reloads and rehydration). */
export function isStepMark(object: unknown): boolean {
  const tag = (object as Record<string, unknown> | null)?.[AI_OBJECT_PROP] as AiObjectTag | undefined;

  return Boolean(tag && tag.kind === 'marker' && typeof tag.source === 'string' && tag.source.startsWith('step:'));
}

export function buildStepMarkObjects(placements: StepMarkPlacement[], lines: StepLine[], { batch }: { batch: string }): FabricObject[] {
  registerAiObjectPersistence();

  const byId = new Map(lines.map((line) => [line.id, line]));
  const objects: FabricObject[] = [];

  for (const mark of placements) {
    const tone = STEP_TONES[mark.verdict];
    const line = byId.get(mark.lineId);
    const parts: FabricObject[] = [
      new Circle({
        ...TOP_LEFT,
        left: mark.left,
        top: mark.top,
        radius: mark.size / 2,
        fill: tone.tint,
        stroke: tone.ink,
        strokeWidth: Math.max(1, mark.size * 0.06),
      }),
      new FabricText(tone.glyph, {
        originX: 'center',
        originY: 'center',
        left: mark.left + mark.size / 2,
        top: mark.top + mark.size / 2 + mark.size * 0.03,
        fontSize: mark.size * 0.7,
        fontWeight: BOARD_WEIGHT.heading,
        fontFamily: BOARD_TEXT_FONT,
        fill: tone.ink,
      }),
    ];

    if (line && mark.verdict !== 'correct') {
      const y = line.rect.top + line.rect.height + Math.max(2, mark.size * 0.08);

      parts.push(
        new Line([line.rect.left, y, line.rect.left + line.rect.width, y], {
          stroke: tone.ink,
          strokeWidth: Math.max(1.5, mark.size * 0.07),
          strokeLineCap: 'round',
          ...(mark.verdict === 'warning' ? { strokeDashArray: [mark.size * 0.25, mark.size * 0.18] } : {}),
          opacity: 0.85,
        }),
      );
    }

    objects.push(tagged(new Group(parts, { ...TOP_LEFT }), { kind: 'marker', source: `step:${mark.lineId}:${mark.verdict}`, batch }));
  }

  return objects;
}
