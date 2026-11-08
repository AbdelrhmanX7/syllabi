import type { WbLocale } from '../../../i18n/strings';

import { describeTypeViolation } from './pageLayout';
import type { TypeViolation } from './pageLayout';
import type { BoardAiAskAction } from './types';

/** Re-ask from the teacher's corrected reading: the instruction that wraps the corrected text. */
export function reaskPrompt(action: BoardAiAskAction, customPrompt: string | undefined, corrected: string, _locale?: WbLocale): string {
  const verb =
    action === 'explain'
      ? 'Explain'
      : action === 'check_answer'
        ? "Check the student's answer in"
        : action === 'custom'
          ? (customPrompt ?? 'Answer')
          : 'Solve step by step';

  return `${verb} this writing from the board (the teacher corrected the reading):\n${corrected}`;
}

/** The re-ask instruction when a remade layout changed question types. */
export function typeCorrectionPrompt(violations: TypeViolation[], _locale?: WbLocale): string {
  return `These questions changed type from the original; restore the same type and the same number of choices: ${violations
    .map((violation) => describeTypeViolation(violation))
    .join('; ')}`;
}
