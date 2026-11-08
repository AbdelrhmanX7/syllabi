import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aplanMockRoutes, withAPlanToday } from './mock';

test('mock routes: grade-plan, a-plan, refresh, target PATCH; others pass through', () => {
  const plan = aplanMockRoutes('GET', ['classes', 'cls_demo_earth', 'grade-plan']);

  assert.equal((plan?.value as { current: { score: number } }).current.score, 87.31);
  assert.ok(aplanMockRoutes('GET', ['classes', 'cls_demo_math', 'a-plan']));
  assert.deepEqual(aplanMockRoutes('POST', ['classes', 'cls_demo_math', 'a-plan', 'refresh'])?.value, {
    status: 'building',
    started: true,
  });
  assert.ok(aplanMockRoutes('PATCH', ['classes', 'cls_demo_earth'], { targetLetter: 'B' }));
  assert.equal(aplanMockRoutes('PATCH', ['classes', 'cls_demo_earth'], { hidden: true }), null);
  assert.equal(aplanMockRoutes('GET', ['classes', 'cls_demo_earth', 'items']), null);
  assert.throws(() => aplanMockRoutes('GET', ['classes', 'cls_nope', 'a-plan']), /not found/);
});

test('withAPlanToday: status per known class, high announcements newest first', () => {
  const today = withAPlanToday({ classes: [{ id: 'cls_demo_earth' }, { id: 'cls_demo_math' }, { id: 'cls_other' }] });

  assert.deepEqual(
    today.aPlan?.map((row) => [row.classId, row.status]),
    [
      ['cls_demo_earth', 'at_risk'],
      ['cls_demo_math', 'at_risk'],
    ],
  );
  assert.ok(today.highAnnouncements!.length >= 2);
  assert.equal(today.highAnnouncements![0].itemId, 'itm_ann_calc_no_oh_friday');
});

test('mock PATCH targetLetter: scheme letter or null; anything else is a 400', () => {
  assert.deepEqual(aplanMockRoutes('PATCH', ['classes', 'cls_demo_earth'], { targetLetter: null })?.value, {
    id: 'cls_demo_earth',
    targetLetter: null,
  });
  assert.throws(() => aplanMockRoutes('PATCH', ['classes', 'cls_demo_earth'], { targetLetter: 'A+' }), /targetLetter/);
});
