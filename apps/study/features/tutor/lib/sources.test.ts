import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatClock, sourceHref, transcriptHref } from './sources';

test('sourceHref per kind', () => {
  assert.equal(sourceHref({ kind: 'item', id: 'itm 1', title: 't', snippet: '' }), '/item/?id=itm%201');
  assert.equal(sourceHref({ kind: 'transcript', id: 'v', title: 't', snippet: '', t: 61.9 }), '/item/?id=v&t=61');
  assert.equal(sourceHref({ kind: 'transcript', id: 'v', title: 't', snippet: '' }), '/item/?id=v');
  assert.equal(sourceHref({ kind: 'page', id: 'pg', title: 't', snippet: '' }, 'cls'), '/notebook/?id=pg&classId=cls');
  assert.equal(sourceHref({ kind: 'library', id: 'x', title: 't', snippet: '' }, 'cls'), '/class/?id=cls&tab=library');
  assert.equal(sourceHref({ kind: 'library', id: 'x', title: 't', snippet: '' }), '/classes/');
  assert.equal(sourceHref({ kind: 'guide', id: 'c9', title: 't', snippet: '' }), '/class/?id=c9&tab=guide');
});

test('transcriptHref: an item opens VideoStudy, a lecture LecturePlayback, both at t', () => {
  assert.equal(transcriptHref('item', 'v', 61.9), '/item/?id=v&t=61');
  assert.equal(transcriptHref('lecture', 'l', 0), '/lectures/?id=l&t=0');
  assert.equal(transcriptHref('lecture', 'l'), '/lectures/?id=l');
});

test('formatClock', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(65), '1:05');
  assert.equal(formatClock(3725), '1:02:05');
});
