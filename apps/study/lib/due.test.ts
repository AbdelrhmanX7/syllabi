import assert from 'node:assert/strict';
import { test } from 'node:test';

import { effectiveDue, sortByEffectiveDue } from './due';

test('effectiveDue prefers the announcement-moved date', () => {
  assert.equal(
    effectiveDue({ dueAt: '2026-10-05T07:00:00Z', effectiveDueAt: '2026-10-09T07:00:00Z' }),
    '2026-10-09T07:00:00Z',
  );
  assert.equal(effectiveDue({ dueAt: '2026-10-05T07:00:00Z', effectiveDueAt: null }), '2026-10-05T07:00:00Z');
  assert.equal(effectiveDue({ dueAt: '2026-10-05T07:00:00Z' }), '2026-10-05T07:00:00Z');
  assert.equal(effectiveDue({}), null);
});

test('sortByEffectiveDue orders by the moved date; undated last both ways; input untouched', () => {
  const items = [
    { id: 'moved-later', dueAt: '2026-10-05T07:00:00Z', effectiveDueAt: '2026-10-10T07:00:00Z' },
    { id: 'undated', dueAt: null },
    { id: 'plain', dueAt: '2026-10-07T07:00:00Z' },
    { id: 'moved-earlier', dueAt: '2026-10-12T07:00:00Z', effectiveDueAt: '2026-10-06T07:00:00Z' },
  ];

  assert.deepEqual(
    sortByEffectiveDue(items).map((item) => item.id),
    ['moved-earlier', 'plain', 'moved-later', 'undated'],
  );
  assert.deepEqual(
    sortByEffectiveDue(items, 'desc').map((item) => item.id),
    ['moved-later', 'plain', 'moved-earlier', 'undated'],
  );
  assert.equal(items[0].id, 'moved-later');
});
