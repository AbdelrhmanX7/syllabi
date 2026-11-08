import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifySendError } from './classify';

import { StudyApiError } from '@/lib/api/errors';

test('network failures and server hiccups retry; refusals drop', () => {
  assert.equal(classifySendError(new TypeError('Failed to fetch')), 'retry');
  assert.equal(classifySendError(new StudyApiError(503, 'down')), 'retry');
  assert.equal(classifySendError(new StudyApiError(429, 'slow down')), 'retry');
  assert.equal(classifySendError(new StudyApiError(401, 'Not signed in', 'NO_SESSION')), 'retry');
  assert.equal(classifySendError(new StudyApiError(0, 'Needs internet', 'OFFLINE')), 'retry');
  assert.equal(classifySendError(new StudyApiError(404, 'gone')), 'drop');
  assert.equal(classifySendError(new StudyApiError(400, 'bad')), 'drop');
  assert.equal(classifySendError(new StudyApiError(403, 'no')), 'drop');
});

test('temporary page ids and records', async () => {
  const { isLocalPageId, localPageRecord } = await import('./local-pages');

  assert.equal(isLocalPageId('local-abc'), true);
  assert.equal(isLocalPageId('65f0c0ffee'), false);
  assert.equal(isLocalPageId(null), false);
  const page = localPageRecord('local-1', { classId: null, title: 'Note · Nov 8', kind: 'note' }, new Date(0));

  assert.deepEqual(page, {
    id: 'local-1',
    classId: null,
    itemId: null,
    lectureId: null,
    title: 'Note · Nov 8',
    kind: 'note',
    updatedAt: '1970-01-01T00:00:00.000Z',
    version: 0,
    thumbUrl: null,
  });
});
