import type { WbStringKey } from '../../../i18n/strings';
import type { BoardAiAskAction, BoardAiClassification } from './types';

/**
 * «What did you circle?» → which ask action to put first. The server's `suggestedAction` wins; a
 * classification without one falls back to its kind. Concept-map kinds point at the concept-map
 * review. Pure, so the routing is unit-tested without the panel.
 */
export const KIND_FOR_CLASS: Record<BoardAiClassification['kind'], Exclude<BoardAiAskAction, 'custom'> | null> = {
  question: 'solve',
  answer_to_check: 'check_answer',
  answer: 'check_answer',
  concept_map: 'concept_map',
  diagram: 'explain',
  handwriting_text: 'explain',
  text: 'explain',
  table: 'explain',
  figure: 'explain',
  other: null,
};

export const KIND_LABELS: Record<BoardAiClassification['kind'], WbStringKey> = {
  question: 'ai.kind.question',
  answer_to_check: 'ai.kind.answer_to_check',
  answer: 'ai.kind.answer',
  concept_map: 'ai.kind.concept_map',
  diagram: 'ai.kind.diagram',
  handwriting_text: 'ai.kind.handwriting_text',
  text: 'ai.kind.text',
  table: 'ai.kind.table',
  figure: 'ai.kind.figure',
  other: 'ai.kind.other',
};

/** The action a classification points at: the server's suggestion first, else its kind. */
export function suggestedAskAction(result: BoardAiClassification | null): Exclude<BoardAiAskAction, 'custom'> | null {
  if (!result) return null;

  switch (result.suggestedAction) {
    case 'solve':
    case 'explain':
    case 'check_answer':
      return result.suggestedAction;
    case 'concept_map_analyze':
    case 'concept_map_fix':
      return 'concept_map';
    case 'none':
      return null;
    default:
      return KIND_FOR_CLASS[result.kind] ?? null;
  }
}

