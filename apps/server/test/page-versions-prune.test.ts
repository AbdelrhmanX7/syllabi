import { test } from "node:test";
import assert from "node:assert/strict";
import { datedVersions, versionsToKeep } from "../src/services/study/page-versions-prune";

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const MIN = 60_000;

test("a long session saving every few seconds keeps few versions", () => {
  // 200 saves over the last 50 minutes, one every 15 s.
  const versions = Array.from({ length: 200 }, (_, i) => ({ version: i + 1, at: NOW - (200 - i) * 15_000 }));
  const keep = versionsToKeep(versions, 200, NOW);
  assert.ok(keep.size <= 10 + 12, `kept ${keep.size}`);
  for (let v = 191; v <= 200; v++) assert.ok(keep.has(v), "the newest 10 stay");
});

test("older versions thin to one per hour, then one per day, then nothing", () => {
  const versions = [
    { version: 1, at: NOW - 40 * 24 * 60 * MIN }, // 40 days: gone
    { version: 2, at: NOW - 5 * 24 * 60 * MIN }, // day slot
    { version: 3, at: NOW - 5 * 24 * 60 * MIN + MIN }, // same day, newer: kept instead of 2
    { version: 4, at: NOW - 3 * 60 * MIN },
    { version: 5, at: NOW - 3 * 60 * MIN + MIN },
  ];
  const keep = versionsToKeep(versions, 30, NOW); // current far ahead so "newest 10" doesn't cover these
  assert.ok(!keep.has(1));
  assert.ok(!keep.has(2) && keep.has(3));
  assert.ok(keep.has(5));
  assert.ok(keep.has(30));
});

test("unlogged versions take the date of the next newer logged one", () => {
  const log = [{ version: 3, at: new Date(NOW - 10 * MIN) }] as never;
  const dated = datedVersions(4, log, NOW);
  assert.deepEqual(
    dated.map((d) => [d.version, d.at]),
    [
      [4, NOW],
      [3, NOW - 10 * MIN],
      [2, NOW - 10 * MIN],
      [1, NOW - 10 * MIN],
    ]
  );
});
