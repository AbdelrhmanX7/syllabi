import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isMyNote, takesInboxItems } from './my-notes';

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

describe('takesInboxItems', () => {
  test('notes and PDF notebooks of their own (a shared copy) take phone images', () => {
    assert.equal(takesInboxItems({ kind: 'note', itemId: null }), true);
    assert.equal(takesInboxItems({ kind: 'pdf', itemId: null, libraryId: null }), true);
    assert.equal(takesInboxItems({ kind: 'pdf', itemId: null }), true);
  });

  test('a class item PDF, a Library PDF, lectures and solve pages do not', () => {
    assert.equal(takesInboxItems({ kind: 'pdf', itemId: 'i1' }), false);
    assert.equal(takesInboxItems({ kind: 'pdf', itemId: null, libraryId: 'l1' }), false);
    assert.equal(takesInboxItems({ kind: 'lecture', itemId: null }), false);
    assert.equal(takesInboxItems({ kind: 'solve', itemId: null }), false);
  });
});
