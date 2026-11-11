import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isMyNote } from './my-notes';

describe('isMyNote', () => {
  test('a notebook outside a class is listed', () => {
    assert.equal(isMyNote({ classId: null }), true);
  });

  test('a copy of a Library PDF notebook (kind pdf, no class) is listed', () => {
    assert.equal(isMyNote({ classId: null, kind: 'pdf' } as { classId: null }), true);
  });

  test('a notebook in a class is not (it shows under Class notebooks)', () => {
    assert.equal(isMyNote({ classId: 'c1' }), false);
    assert.equal(isMyNote({ classId: 'c1', kind: 'pdf' } as { classId: string }), false);
  });
});
