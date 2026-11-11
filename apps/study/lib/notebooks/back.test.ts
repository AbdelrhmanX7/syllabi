import assert from 'node:assert/strict';
import { test } from 'node:test';

import { notebookBackTarget, withFrom } from './back';
import { bookmarkHref } from './bookmarks';

test('back from a notebook opened on the Notes page returns to Notes, even for a class notebook', () => {
  const href = bookmarkHref({ id: 'n1', classId: 'c1' }, { boardPageId: 'x' }, 'notes');

  assert.equal(href, '/notebook/?id=n1&page=x&classId=c1&from=notes');
  const from = new URLSearchParams(href.split('?')[1]).get('from');

  assert.equal(notebookBackTarget({ classId: 'c1' }, from, true), '/notes/');
});

test('without a known from: shared → Shared, class → its class, else history or home', () => {
  assert.equal(notebookBackTarget({ shared: { ownerName: 'A' }, classId: null }, null, true), '/shared/');
  assert.equal(notebookBackTarget({ classId: 'c 1' }, null, true), '/class/?id=c%201');
  assert.equal(notebookBackTarget({ classId: null }, null, true), 'history');
  assert.equal(notebookBackTarget({ classId: null }, null, false), '/');
  // Never a path out of the url.
  assert.equal(notebookBackTarget({ classId: 'c1' }, '/evil', true), '/class/?id=c1');
  assert.equal(notebookBackTarget({ classId: 'c1' }, 'constructor', true), '/class/?id=c1');
});

test('withFrom', () => {
  assert.equal(withFrom('/notebook/?id=a', 'notes'), '/notebook/?id=a&from=notes');
  assert.equal(withFrom('/notebook/?id=a'), '/notebook/?id=a');
});
