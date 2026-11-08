import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liveAskBody } from './wire';

const OID = '670000000000000000000001';
const OID2 = '670000000000000000000002';

test('liveAskBody keeps ObjectIds and floors videoAt.t', () => {
  assert.deepEqual(
    liveAskBody({
      classId: OID,
      conversationId: OID2,
      mode: 'quiz',
      question: 'q',
      context: { itemId: OID, videoAt: { itemId: OID, t: 75.8 }, text: 'sel' },
    }),
    {
      classId: OID,
      conversationId: OID2,
      mode: 'quiz',
      question: 'q',
      context: { text: 'sel', itemId: OID, videoAt: { itemId: OID, t: 75 } },
    },
  );
});

test('liveAskBody drops fixture / local ids (the backend would 400 the whole ask) and an emptied context', () => {
  assert.deepEqual(
    liveAskBody({
      classId: 'cls_demo_math',
      mode: 'explain',
      question: 'q',
      context: { pageId: 'local-1', lectureId: 'lec_1', videoAt: { itemId: 'itm_1', t: 3 } },
    }),
    { mode: 'explain', question: 'q' },
  );
  assert.deepEqual(liveAskBody({ mode: 'explain', question: '', context: { imagePngB64: 'AAAA', pageId: OID } }), {
    mode: 'explain',
    question: '',
    context: { imagePngB64: 'AAAA', pageId: OID },
  });
});
