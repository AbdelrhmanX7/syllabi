import assert from 'node:assert/strict';
import { test } from 'node:test';

import { wbT } from '../../../i18n/strings';
import { KIND_LABELS, suggestedAskAction } from './classifyRouting';

test('classification → the action shown first (server suggestion wins, kind is the fallback)', () => {
  assert.equal(suggestedAskAction(null), null);
  assert.equal(suggestedAskAction({ kind: 'question', confidence: 0.9, suggestedAction: 'solve' }), 'solve');
  assert.equal(suggestedAskAction({ kind: 'answer_to_check', confidence: 0.9, suggestedAction: 'check_answer' }), 'check_answer');
  assert.equal(suggestedAskAction({ kind: 'concept_map', confidence: 0.9, suggestedAction: 'concept_map_fix' }), 'concept_map');
  assert.equal(suggestedAskAction({ kind: 'concept_map', confidence: 0.9 }), 'concept_map', 'concept maps surface the map actions');
  assert.equal(suggestedAskAction({ kind: 'table', confidence: 0.9 }), 'explain');
  assert.equal(suggestedAskAction({ kind: 'other', confidence: 0.9, suggestedAction: 'none' }), null);
  assert.equal(wbT('en', KIND_LABELS.answer_to_check), 'Student\'s answer');
});
