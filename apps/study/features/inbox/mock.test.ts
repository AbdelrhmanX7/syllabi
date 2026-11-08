import type { DropToken, DropTokenCreated, InboxItem } from './types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inboxMockRoutes, mockInboxStream, resetMockInbox, samplePhotoDataUrl, simulateMockArrival } from './mock';

const json = <T>(method: string, path: string, body?: Record<string, unknown>) =>
  inboxMockRoutes.json(method, path, body)?.value as T;

test('not an inbox path → undefined', () => {
  assert.equal(inboxMockRoutes.json('GET', '/classes'), undefined);
  assert.equal(inboxMockRoutes.json('GET', '/inboxes'), undefined);
});

test('tokens: create returns the secret once; list never does; revoke', () => {
  resetMockInbox({ tokens: [], items: [] });
  const created = json<DropTokenCreated>('POST', '/inbox/tokens', { label: '  ' });

  assert.match(created.token, /^sk_drop_[a-z0-9]{32}$/);
  assert.equal(created.label, 'iPhone');
  const listed = json<DropToken[]>('GET', '/inbox/tokens');

  assert.equal(listed.length, 1);
  assert.ok(!('token' in listed[0]));
  json('DELETE', `/inbox/tokens/${created.id}`);
  assert.equal(json<DropToken[]>('GET', '/inbox/tokens').length, 0);
  assert.throws(() => json('DELETE', '/inbox/tokens/nope'), /not found/);
});

test('items: list, since, patch usedAt, delete', () => {
  resetMockInbox(null);
  const all = json<InboxItem[]>('GET', '/inbox');

  assert.equal(all.length, 3);
  assert.ok(all.every((it) => it.url.startsWith('data:image/svg+xml')));
  const newest = all[0].createdAt;

  assert.equal(json<InboxItem[]>('GET', `/inbox?since=${encodeURIComponent(newest)}`).length, 0);
  const patched = json<InboxItem>('PATCH', `/inbox/${all[0].id}`, { usedAt: '2026-10-05T12:00:00.000Z' });

  assert.equal(patched.usedAt, '2026-10-05T12:00:00.000Z');
  json('DELETE', `/inbox/${all[1].id}`);
  assert.equal(json<InboxItem[]>('GET', '/inbox').length, 2);
  assert.throws(() => json('PATCH', '/inbox/nope', {}), /not found/);
});

test('page queue: PATCH pageId files an item; GET ?pageId= lists the unused ones; GET by id', () => {
  resetMockInbox(null);
  const [a, b, c] = json<InboxItem[]>('GET', '/inbox');

  assert.equal(json<InboxItem[]>('GET', '/inbox?pageId=p1').length, 0);
  assert.equal(json<InboxItem>('PATCH', `/inbox/${a.id}`, { pageId: 'p1' }).pageId, 'p1');
  json('PATCH', `/inbox/${c.id}`, { pageId: 'p1', usedAt: null });
  json('PATCH', `/inbox/${b.id}`, { pageId: 'p2' });
  assert.deepEqual(
    json<InboxItem[]>('GET', '/inbox?pageId=p1').map((it) => it.id),
    [a.id, c.id],
  );
  // Used items leave the queue; a PATCH without pageId keeps it.
  json('PATCH', `/inbox/${a.id}`, { usedAt: '2026-10-18T12:00:00.000Z' });
  assert.equal(json<InboxItem>('GET', `/inbox/${a.id}`).pageId, 'p1');
  assert.deepEqual(
    json<InboxItem[]>('GET', '/inbox?pageId=p1').map((it) => it.id),
    [c.id],
  );
  json('PATCH', `/inbox/${c.id}`, { pageId: null });
  assert.equal(json<InboxItem[]>('GET', '/inbox?pageId=p1').length, 0);
  assert.equal(json<InboxItem>('GET', `/inbox/${b.id}`).id, b.id);
  assert.throws(() => json('GET', '/inbox/nope'), /not found/);
});

test('to-page: images are refused; PDFs need the live backend', () => {
  resetMockInbox(null);
  const [photo] = json<InboxItem[]>('GET', '/inbox');

  assert.throws(() => json('POST', `/inbox/${photo.id}/to-page`, { classId: 'c1' }), /Only PDFs/);
  assert.throws(() => json('POST', '/inbox/nope/to-page', { classId: 'c1' }), /not found/);
});

test('stream: opens at once and emits every new arrival until aborted', async () => {
  resetMockInbox({ tokens: [], items: [] });
  const controller = new AbortController();
  const got: string[] = [];
  let opened = false;
  const done = mockInboxStream({ onOpen: () => (opened = true), onItem: (it) => got.push(it.id) }, controller.signal);

  assert.ok(opened);
  const arrived = simulateMockArrival();

  assert.deepEqual(got, [arrived.id]);
  assert.equal(json<InboxItem[]>('GET', '/inbox')[0].id, arrived.id);
  controller.abort();
  await done;
  simulateMockArrival();
  assert.equal(got.length, 1);
});

test('sample photo is a well-formed SVG data URL', () => {
  const url = samplePhotoDataUrl({ title: 'A & B <c>', lines: ['x'], paper: '#fff', ink: '#000', note: null });
  const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1));

  assert.match(svg, /^<svg [^>]*width="1200"/);
  assert.match(svg, /A &amp; B &lt;c&gt;/);
});
