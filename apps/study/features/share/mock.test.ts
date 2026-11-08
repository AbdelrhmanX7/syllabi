import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shareMockRoutes } from './mock';

const call = async (method: string, path: string, body?: Record<string, unknown>) =>
  (await shareMockRoutes.json(method, path, body)?.value) as any;

test('share mock: not its path → undefined', () => {
  assert.equal(shareMockRoutes.json('GET', '/pages', undefined), undefined);
});

test('share mock: create, add people, link, remove, stop', async () => {
  const ref = { resourceType: 'notebook', resourceId: 'pg_1', title: 'Cell notes' };

  assert.equal((await call('GET', '/share/mine?resourceType=notebook&resourceId=pg_1')).share, null);
  const { share } = await call('POST', '/share', { ...ref, emails: ['A@x.io', 'b@x.io', 'a@x.io'] });

  assert.equal(share.title, 'Cell notes');
  assert.deepEqual(share.people.map((p: { email: string }) => p.email), ['a@x.io', 'b@x.io']);
  await assert.rejects(call('POST', '/share', { ...ref, emails: ['nope'] }));

  const linked = (await call('PATCH', `/share/${share.id}`, { link: true, removeEmails: ['b@x.io'] })).share;

  assert.match(linked.link.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(linked.people.map((p: { email: string }) => p.email), ['a@x.io']);
  assert.equal((await call('GET', '/share/mine?resourceType=notebook&resourceId=pg_1')).share.id, share.id);
  // The link opens the owner's own share.
  assert.equal((await call('GET', `/share/view/${linked.link.token}`)).share.isOwner, true);

  await call('DELETE', `/share/${share.id}`);
  assert.equal((await call('GET', '/share/mine?resourceType=notebook&resourceId=pg_1')).share, null);
  await assert.rejects(call('GET', `/share/view/${linked.link.token}`));
});

test('share mock: shared with me has one invented item per type, each opens read-only', async () => {
  const { items } = await call('GET', '/share/with-me');

  assert.deepEqual(items.map((i: { resourceType: string }) => i.resourceType).sort(), ['conceptMap', 'deck', 'notebook', 'questions']);
  for (const item of items) {
    const view = await call('GET', `/share/view/${item.id}`);

    assert.equal(view.share.isOwner, false);
    assert.equal(view.share.ownerName, item.ownerName);
  }
  const notebook = await call('GET', '/share/view/shr_demo_notebook');

  assert.ok(notebook.content.contentUrl.startsWith('data:application/json,'));
  assert.ok(JSON.parse(decodeURIComponent(notebook.content.contentUrl.slice('data:application/json,'.length))).pages.length);
});
