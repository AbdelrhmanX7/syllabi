import { isPenFamilyTool } from '../types';

import type { WhiteboardTool } from '../types';

/**
 * Tools that draw with the pen's colour: the pen and its nibs, the highlighter, shapes and lines, text.
 * A colour (or width) picked from the pen shortcuts applies to these as they are.
 */
const COLOUR_TOOLS: ReadonlySet<WhiteboardTool> = new Set<WhiteboardTool>([
  'pen',
  'brush',
  'marker',
  'script',
  'highlighter',
  'line',
  'arrow',
  'rect',
  'circle',
  'triangle',
  'text',
]);

export const takesPenColour = (tool: WhiteboardTool): boolean => COLOUR_TOOLS.has(tool) || isPenFamilyTool(tool);

/**
 * The tool to be on after a colour or width is picked from the pen shortcuts (the floating button / the
 * S Pen side-button menu). Picking a colour only changes the colour: a tool that draws in colour stays
 * (the highlighter stays the highlighter, the brush stays the brush). From a tool without colour (eraser,
 * select, pan…) it goes back to the last drawing tool used, and only falls back to the plain pen when
 * there has been none.
 */
export function resolveQuickPenTool(currentTool: WhiteboardTool, lastDrawingTool: WhiteboardTool | null | undefined): WhiteboardTool {
  if (takesPenColour(currentTool)) return currentTool;

  return lastDrawingTool && takesPenColour(lastDrawingTool) ? lastDrawingTool : 'pen';
}
