/**
 * Per-board pen memory: the pen-family tool a board was last used with plus that pen's stroke
 * settings, so reopening a board puts the teacher straight back on the same nib, colour and width.
 *
 * The device-wide stroke settings (`whiteboard-stroke-settings`) stay the fallback for a board that
 * was never opened on this device. A board left on eraser / hand / select still reopens on its last
 * PEN — the teacher opens a board to write.
 */

import type { StrokeSettings, WhiteboardTool } from '../types';

import { MAX_STROKE_WIDTH, MIN_STROKE_WIDTH } from '../types';

/** The tools a board can reopen on. Wider than PEN_FAMILY_TOOLS: the highlighter is a pen here. */
export const BOARD_PEN_TOOLS = ['pen', 'brush', 'marker', 'script', 'highlighter'] as const;
export type BoardPenTool = (typeof BOARD_PEN_TOOLS)[number];

export interface BoardPenMemory {
  tool: BoardPenTool;
  strokeSettings: StrokeSettings;
}

/** Quiet period before a change is written — a width slider drag is one write, not sixty. */
export const BOARD_PEN_SAVE_DEBOUNCE_MS = 400;

const STORAGE_KEY_PREFIX = 'whiteboard:board-pen';

export function isBoardPenTool(tool: unknown): tool is BoardPenTool {
  return typeof tool === 'string' && (BOARD_PEN_TOOLS as readonly string[]).includes(tool);
}

export function getBoardPenStorageKey(boardId: string): string {
  return `${STORAGE_KEY_PREFIX}:${boardId}`;
}

/**
 * Parse a stored entry. Missing / malformed fields fall back to `fallback` field by field; an entry
 * with no usable tool is ignored entirely (null).
 */
export function parseBoardPenMemory(raw: string | null | undefined, fallback: StrokeSettings): BoardPenMemory | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { tool?: unknown; strokeSettings?: Partial<StrokeSettings> } | null;
    if (!value || !isBoardPenTool(value.tool)) return null;
    const stored = value.strokeSettings ?? {};
    const color = typeof stored.color === 'string' && stored.color ? stored.color : fallback.color;
    const secondaryColor =
      typeof stored.secondaryColor === 'string' && stored.secondaryColor ? stored.secondaryColor : fallback.secondaryColor;
    const width =
      typeof stored.width === 'number' && Number.isFinite(stored.width)
        ? Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, stored.width))
        : fallback.width;
    const opacity =
      typeof stored.opacity === 'number' && Number.isFinite(stored.opacity)
        ? Math.min(1, Math.max(0, stored.opacity))
        : fallback.opacity;

    const lineShape = stored.lineShape === 'hold' || stored.lineShape === 'always' ? stored.lineShape : fallback.lineShape;
    const dashed = typeof stored.dashed === 'boolean' ? stored.dashed : fallback.dashed;

    return { tool: value.tool, strokeSettings: { ...fallback, color, secondaryColor, width, opacity, ...(lineShape !== undefined && { lineShape }), ...(dashed !== undefined && { dashed }) } };
  } catch {
    return null;
  }
}

export function serializeBoardPenMemory(memory: BoardPenMemory): string {
  const { color, secondaryColor, width, opacity, lineShape, dashed } = memory.strokeSettings;

  return JSON.stringify({ tool: memory.tool, strokeSettings: { color, secondaryColor, width, opacity, lineShape, dashed } });
}

/** What a board opens with: its own last pen, else the plain pen with the device-wide settings. */
export function resolveInitialBoardPen(raw: string | null | undefined, fallback: StrokeSettings): BoardPenMemory {
  return parseBoardPenMemory(raw, fallback) ?? { tool: 'pen', strokeSettings: fallback };
}

/**
 * The entry to save for the current editor state. Off a pen (eraser, hand, select, shapes…) the
 * remembered tool stays the last pen; the stroke settings are saved either way (the barrel COLOR
 * toggle flips them mid-erase too).
 */
export function nextBoardPenMemory(
  lastPenTool: BoardPenTool,
  activeTool: WhiteboardTool,
  strokeSettings: StrokeSettings,
): BoardPenMemory {
  return { tool: isBoardPenTool(activeTool) ? activeTool : lastPenTool, strokeSettings };
}

export function readBoardPenRaw(boardId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(getBoardPenStorageKey(boardId)) ?? null;
  } catch {
    return null;
  }
}

export function writeBoardPenMemory(boardId: string, memory: BoardPenMemory): void {
  try {
    globalThis.localStorage?.setItem(getBoardPenStorageKey(boardId), serializeBoardPenMemory(memory));
  } catch {
    // storage blocked / full — the board just reopens on the device-wide pen.
  }
}
