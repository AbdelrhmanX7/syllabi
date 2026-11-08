import type { PlanInput } from './plan';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_REMINDERS, planReminders, reminderId } from './plan';
import { parseReminderSettings } from './settings';
import { newsToShow } from './news';

// Local times throughout, so the tests pass in any time zone.
const NOW = new Date(2026, 10, 10, 9, 0).getTime(); // Tue Nov 10 2026, 09:00
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const iso = (d: number, h: number, m = 0) => new Date(at(d, h, m)).toISOString();

const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  settings: { due: true, flashcards: false, leads: ['evening', 180] },
  items: [],
  cards: [],
  custom: [],
  now: NOW,
  ...over,
});

const item = (id: string, dueISO: string, extra: Partial<PlanInput['items'][number]> = {}) => ({
  id,
  classId: 'c1',
  type: 'assignment' as const,
  title: `Essay ${id}`,
  dueAt: dueISO,
  ...extra,
});

test('a deadline gets the evening-before and 3-hours-before reminders, linking to the item', () => {
  const plan = planReminders(base({ items: [item('a', iso(12, 23, 59))], classLabels: { c1: 'CS 101' } }));

  assert.deepEqual(
    plan.map((r) => r.at),
    [at(11, 18), at(12, 20, 59)],
  );
  assert.equal(plan[0]!.url, '/item/?id=a');
  assert.equal(plan[0]!.title, 'Essay a');
  assert.match(plan[0]!.body, /^CS 101 · Due tomorrow at 11:59/);
  assert.match(plan[1]!.body, /Due today at 11:59/);
  assert.ok(plan.every((r) => r.id >= 1 && r.id <= 0x7fffffff));
});

test('handed-in, past, undated and non-assignment items are skipped; effectiveDue wins', () => {
  const plan = planReminders(
    base({
      items: [
        item('done', iso(12, 23), { submission: { state: 'submitted', score: null } }),
        item('graded', iso(12, 23), { submission: { state: 'graded', score: 9 } }),
        item('past', iso(9, 23)),
        item('undated', null as unknown as string),
        { ...item('page', iso(12, 23)), type: 'page' as const },
        item('moved', iso(11, 12), { effectiveDueAt: iso(13, 12) }),
      ],
    }),
  );

  assert.deepEqual(
    plan.map((r) => r.key),
    ['due:moved:evening', 'due:moved:180'],
  );
  assert.equal(plan[0]!.at, at(12, 18));
});

test('reminder times already passed are dropped (only the 3-hour one is left for a deadline tonight)', () => {
  const plan = planReminders(base({ items: [item('x', iso(10, 15))] }));

  assert.deepEqual(
    plan.map((r) => r.at),
    [at(10, 12)],
  );
});

test('lead choice: 1 hour + 1 day before; near-duplicates collapse into one', () => {
  const one = planReminders(
    base({ settings: { due: true, flashcards: false, leads: [60, 1440] }, items: [item('q', iso(14, 10))] }),
  );

  assert.deepEqual(
    one.map((r) => r.at),
    [at(13, 10), at(14, 9)],
  );
  // Due at 18:10: «1 day before» (17:10 the day before) is within 30 min of «evening before» → one ping.
  const two = planReminders(
    base({ settings: { due: true, flashcards: false, leads: ['evening', 1440] }, items: [item('r', iso(14, 18, 10))] }),
  );

  assert.equal(two.length, 1);
});

test('flashcards: one 5 PM reminder per day with cards due by then, counting new cards', () => {
  const plan = planReminders(
    base({
      settings: { due: false, flashcards: true, leads: [] },
      cards: [{ srs: null }, { srs: { dueAt: iso(10, 8) } }, { srs: { dueAt: iso(12, 9) } }],
    }),
  );
  const first = plan.slice(0, 3);

  assert.deepEqual(
    first.map((r) => r.at),
    [at(10, 17), at(11, 17), at(12, 17)],
  );
  assert.deepEqual(
    first.map((r) => r.body),
    ['2 cards ready to review.', '2 cards ready to review.', '3 cards ready to review.'],
  );
  assert.equal(first[0]!.url, '/flashcards/');
  assert.equal(planReminders(base({ settings: { due: false, flashcards: true, leads: [] }, cards: [] })).length, 0);
});

test('own reminders: once, daily and weekly expand inside the 14-day window', () => {
  const plan = planReminders(
    base({
      settings: { due: false, flashcards: false, leads: [] },
      custom: [
        { id: 'once', text: 'Call the lab', at: '2026-11-11T08:30', repeat: 'none' },
        { id: 'old', text: 'Gone', at: '2026-11-01T08:30', repeat: 'none' },
        { id: 'week', text: 'Gym', at: '2026-10-01T07:00', repeat: 'weekly' },
      ],
    }),
  );

  assert.deepEqual(
    plan.filter((r) => r.title === 'Call the lab').map((r) => r.at),
    [at(11, 8, 30)],
  );
  assert.equal(plan.filter((r) => r.title === 'Gone').length, 0);
  // Oct 1 2026 is a Thursday → Nov 12 and 19 fall inside the window (it ends Nov 24, 09:00).
  assert.deepEqual(
    plan.filter((r) => r.title === 'Gym').map((r) => r.at),
    [at(12, 7), at(19, 7)],
  );
  assert.equal(plan[0]!.url, undefined);

  const daily = planReminders(
    base({
      settings: { due: false, flashcards: false, leads: [] },
      custom: [{ id: 'd', text: 'Read', at: '2025-01-01T21:00', repeat: 'daily' }],
    }),
  );

  assert.equal(daily.length, 14);
  assert.equal(daily[0]!.at, at(10, 21));
});

test('capped at 30, soonest first; ids are stable per key', () => {
  const items = Array.from({ length: 40 }, (_, i) => item(`i${i}`, iso(11 + (i % 10), 12 + (i % 5))));
  const plan = planReminders(base({ items }));

  assert.equal(plan.length, MAX_REMINDERS);
  assert.ok(plan.every((r, i) => i === 0 || plan[i - 1]!.at <= r.at));
  assert.equal(reminderId('due:a:evening'), reminderId('due:a:evening'));
  assert.notEqual(reminderId('due:a:evening'), reminderId('due:a:180'));
});

test('stored settings: defaults off, junk ignored field by field', () => {
  assert.equal(parseReminderSettings(null).enabled, false);
  assert.equal(parseReminderSettings('{nope').enabled, false);
  const parsed = parseReminderSettings(
    JSON.stringify({
      enabled: true,
      leads: [60, 'soon', 'evening'],
      custom: [{ id: 'a', text: 'x', at: '2026-11-11T08:30', repeat: 'hourly' }, { id: 'b', text: 'y', at: 'tomorrow' }],
    }),
  );

  assert.equal(parsed.enabled, true);
  assert.deepEqual(parsed.leads, ['evening', 60]);
  assert.deepEqual(parsed.custom, [{ id: 'a', text: 'x', at: '2026-11-11T08:30', repeat: 'none' }]);
});

test('team messages: new, unexpired, valid ones only; in-app paths only', () => {
  const feed = {
    messages: [
      { id: 'a', title: 'New: share notes', body: 'Try it', url: '/library/' },
      { id: 'seen', title: 'Old news' },
      { id: 'expired', title: 'Was', until: '2026-11-01T00:00:00Z' },
      { id: 'evil', title: 'Hi', url: 'https://example.com' },
      { title: 'no id' },
      'junk',
    ],
  };
  const out = newsToShow(feed, ['seen'], NOW);

  assert.deepEqual(
    out.map((m) => [m.id, m.url]),
    [
      ['a', '/library/'],
      ['evil', undefined],
    ],
  );
  assert.deepEqual(newsToShow(null, [], NOW), []);
  assert.deepEqual(newsToShow({ messages: 'x' }, [], NOW), []);
});
