/**
 * Board AI commands — the one door every trigger goes through: the toolbar, the selection chip, and
 * anything outside the editor (the «Pen buttons» page binds a pen button to `ai-lasso-once`).
 *
 * A pen-button handler (or any host code) calls `requestBoardAiCommand('ai-lasso-once')`; the mounted
 * editor's AI layer picks it up. No editor instance is needed, and nothing happens when the board
 * has no AI service (the layer is not mounted).
 */

export type BoardAiCommand =
  | 'ai-lasso-once'
  | 'ai-ask-selection'
  | 'ai-generate'
  | 'ai-analyze-page'
  | 'ai-remake-page'
  /** «Map my terms»: the selected handwritten terms → a concept map in the owner's own ink. */
  | 'ai-map-terms'
  /** «Explain on my page»: the AI marks the page (or the selection) up with a pen and a pointer. */
  | 'ai-pen-explain'
  /** Reopens the current page's «Ask AI» chat thread (no lasso needed). */
  | 'ai-chat'
  | 'ai-cancel';

/** CustomEvent name on `window`; `detail.command` is a {@link BoardAiCommand}. */
export const BOARD_AI_COMMAND_EVENT = 'wb-board-ai-command';

export interface BoardAiCommandDetail {
  command: BoardAiCommand;
}

export function requestBoardAiCommand(command: BoardAiCommand): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent<BoardAiCommandDetail>(BOARD_AI_COMMAND_EVENT, { detail: { command } }));
}

export function isBoardAiCommand(value: unknown): value is BoardAiCommand {
  return (
    value === 'ai-lasso-once' ||
    value === 'ai-ask-selection' ||
    value === 'ai-generate' ||
    value === 'ai-analyze-page' ||
    value === 'ai-remake-page' ||
    value === 'ai-map-terms' ||
    value === 'ai-pen-explain' ||
    value === 'ai-chat' ||
    value === 'ai-cancel'
  );
}
