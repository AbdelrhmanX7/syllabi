import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isCheckDue,
  isSnoozed,
  isUpdateAvailable,
  parseBuildStamp,
  parseFeed,
  parseSnooze,
  SNOOZE_MS,
  snoozeFor,
} from './update-check';

const FEED = {
  app: 'studio.syllabi.app',
  version: '0.1.0',
  versionCode: 399721,
  sha: '0a934889',
  url: 'https://syllabi-studio.s3.eu-central-003.backblazeb2.com/study/study-0.1.0-0a934889-arm64.apk',
  sha256: '0370D8D04B1B28F8DBF75FDA8012D70BD04402A79E0402B9DD1D818C3F9F3297',
  size: 13464677,
  publishedAt: '2026-10-05T14:04:28.645Z',
};

test('parses the published feed', () => {
  const feed = parseFeed(FEED);

  assert.ok(feed);
  assert.equal(feed.versionCode, 399721);
  assert.equal(feed.sha256, FEED.sha256.toLowerCase());
  assert.equal(feed.notes, undefined);
  assert.equal(parseFeed({ ...FEED, notes: '  Faster sync  ' })?.notes, 'Faster sync');
});

test('rejects a feed for another app, another host or a bad checksum', () => {
  assert.equal(parseFeed(null), null);
  assert.equal(parseFeed({ ...FEED, app: 'com.example.other' }), null);
  assert.equal(parseFeed({ ...FEED, url: 'https://evil.example/study.apk' }), null);
  assert.equal(parseFeed({ ...FEED, sha256: 'abc' }), null);
  assert.equal(parseFeed({ ...FEED, versionCode: 'x' }), null);
  assert.equal(parseFeed({ ...FEED, versionCode: -1 }), null);
});

test('an update is only a strictly greater versionCode of a known build', () => {
  const feed = parseFeed(FEED);

  assert.equal(isUpdateAvailable(feed, 399720), true);
  assert.equal(isUpdateAvailable(feed, 399721), false);
  assert.equal(isUpdateAvailable(feed, 400000), false);
  assert.equal(isUpdateAvailable(feed, null), false);
  assert.equal(isUpdateAvailable(feed, 0), false);
  assert.equal(isUpdateAvailable(null, 1), false);
});

test('Later snoozes 24 h, but a newer release breaks through', () => {
  const feed = parseFeed(FEED)!;
  const now = 1_000_000;
  const snooze = snoozeFor(feed, now);

  assert.equal(snooze.until, now + SNOOZE_MS);
  assert.equal(isSnoozed(snooze, feed, now + 1), true);
  assert.equal(isSnoozed(snooze, feed, now + SNOOZE_MS - 1), true);
  assert.equal(isSnoozed(snooze, feed, now + SNOOZE_MS), false);
  assert.equal(isSnoozed(snooze, { ...feed, versionCode: feed.versionCode + 1 }, now + 1), false);
  assert.equal(isSnoozed(null, feed, now), false);
});

test('snooze survives a storage round trip and ignores junk', () => {
  const snooze = { versionCode: 5, until: 10 };

  assert.deepEqual(parseSnooze(JSON.stringify(snooze)), snooze);
  assert.equal(parseSnooze(null), null);
  assert.equal(parseSnooze('{'), null);
  assert.equal(parseSnooze('{"versionCode":"a"}'), null);
});

test('checks are due after the interval, on first run, and after a clock jump back', () => {
  assert.equal(isCheckDue(null, 5), true);
  assert.equal(isCheckDue(0, 1000, 1000), true);
  assert.equal(isCheckDue(0, 999, 1000), false);
  assert.equal(isCheckDue(5000, 10, 1000), true);
});

test('build stamp parts', () => {
  assert.deepEqual(parseBuildStamp('0.1.0 · 0a934889 · 20261005-1600'), { version: '0.1.0', sha: '0a934889' });
  assert.deepEqual(parseBuildStamp(''), { version: '', sha: '' });
});
