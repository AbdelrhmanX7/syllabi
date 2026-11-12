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
import { normalizeHighlighterWidth } from './penSizes';

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
    const pressure = typeof stored.pressure === 'boolean' ? stored.pressure : fallback.pressure;
    const highlighterOpacity =
      typeof stored.highlighterOpacity === 'number' && Number.isFinite(stored.highlighterOpacity)
        ? Math.min(0.6, Math.max(0.1, stored.highlighterOpacity))
        : fallback.highlighterOpacity;
    const highlighterWidth = normalizeHighlighterWidth(stored.highlighterWidth) ?? fallback.highlighterWidth;

    return {
      tool: value.tool,
      strokeSettings: {
        ...fallback,
        color,
        secondaryColor,
        width,
        opacity,
        ...(highlighterWidth !== undefined && { highlighterWidth }),
        ...(lineShape !== undefined && { lineShape }),
        ...(dashed !== undefined && { dashed }),
        ...(pressure !== undefined && { pressure }),
        ...(highlighterOpacity !== undefined && { highlighterOpacity }),
      },
    };
  } catch {
    return null;
  }
}

export function serializeBoardPenMemory(memory: BoardPenMemory): string {
  const { color, secondaryColor, width, highlighterWidth, highlighterOpacity, opacity, lineShape, dashed, pressure } = memory.strokeSettings;

  return JSON.stringify({ tool: memory.tool, strokeSettings: { color, secondaryColor, width, highlighterWidth, highlighterOpacity, opacity, lineShape, dashed, pressure } });
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
  /** The pen colour parked while the highlighter is out (its own colour is kept per device). */
  parkedPenColor: string | null = null,
): BoardPenMemory {
  // With the highlighter out the live colour is the highlighter's: remember the PEN's, or the board
  // reopens with a yellow pen.
  const settings = activeTool === 'highlighter' && parkedPenColor ? { ...strokeSettings, color: parkedPenColor } : strokeSettings;

  return { tool: isBoardPenTool(activeTool) ? activeTool : lastPenTool, strokeSettings: settings };
}

/**
 * A board reopening ON the highlighter: the remembered colour is the pen's, so the highlighter takes
 * its own (per device, `#ffd60a` by default) and the pen's is handed back as the colour to park.
 */
export function openBoardPen(memory: BoardPenMemory, storedHighlighterColor: string | null): BoardPenMemory & { parkedPenColor: string | null } {
  if (memory.tool !== 'highlighter') return { ...memory, parkedPenColor: null };

  return {
    tool: memory.tool,
    strokeSettings: { ...memory.strokeSettings, color: storedHighlighterColor || '#ffd60a' },
    parkedPenColor: memory.strokeSettings.color,
  };
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
