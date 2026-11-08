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

test('share mock: roles per person, change with PATCH roles, the link stays view-only', async () => {
  const { share } = await call('POST', '/share', { resourceType: 'deck', resourceId: 'cls_1', topic: 'Cells', title: 'Cells', emails: ['e@x.io'], role: 'editor' });

  assert.equal(share.people[0].role, 'editor');
  await assert.rejects(call('POST', '/share', { resourceType: 'deck', resourceId: 'cls_1', role: 'boss' }));
  const lowered = (await call('PATCH', `/share/${share.id}`, { roles: [{ email: 'e@x.io', role: 'viewer' }], addEmails: ['v@x.io'], link: true })).share;

  assert.deepEqual(
    lowered.people.map((p: { email: string; role: string }) => [p.email, p.role]),
    [
      ['e@x.io', 'viewer'],
      ['v@x.io', 'viewer'],
    ],
  );
  assert.equal(lowered.link.role, 'viewer');
  await call('DELETE', `/share/${share.id}`);
});

test('share mock: Can edit on the demo deck and map saves to the shared item', async () => {
  const items = (await call('GET', '/share/with-me')).items;
  const roles = Object.fromEntries(items.map((i: { resourceType: string; role: string }) => [i.resourceType, i.role]));

  assert.deepEqual(roles, { notebook: 'viewer', deck: 'editor', questions: 'viewer', conceptMap: 'editor' });
  const deck = await call('GET', '/share/view/shr_demo_deck');

  assert.equal(deck.share.role, 'editor');
  const classId = deck.share.resourceId;
  const first = deck.content.questions[0];
  const edited = await call('PATCH', `/questions/${first.id}`, { stem: 'Hydroxyl group (–OH)' });

  assert.equal(edited.stem, 'Hydroxyl group (–OH)');
  await assert.rejects(call('PATCH', `/questions/${first.id}`, { topic: 'Other' }));
  const added = await call('POST', '/questions', { questions: [{ classId, topic: 'Functional groups', stem: 'Ester', answer: 'R–COO–R', tags: ['flashcard'] }] });

  assert.equal(added[0].stem, 'Ester');
  await call('DELETE', `/questions/${deck.content.questions[1].id}`);
  const after = await call('GET', '/share/view/shr_demo_deck');

  assert.equal(after.content.questions.length, 4);
  assert.equal(after.content.questions[0].stem, 'Hydroxyl group (–OH)');
  assert.equal(after.share.editedBy.name, 'You');
  // Not a demo id: left to the normal mock.
  assert.equal(shareMockRoutes.json('PATCH', '/questions/q_mine', { stem: 'x' }), undefined);
  assert.equal(shareMockRoutes.json('POST', '/questions', { questions: [{ classId: 'cls_mine', stem: 'x' }] }), undefined);

  const map = await call('GET', '/share/view/shr_demo_map');
  const saved = await call('PATCH', `/concept-maps/${map.share.resourceId}`, { promptTerms: ['interphase', 'mitosis'] });

  assert.deepEqual(saved.promptTerms, ['interphase', 'mitosis']);
  await assert.rejects(call('PATCH', `/concept-maps/${map.share.resourceId}`, { score: 10 }));
  assert.deepEqual((await call('GET', '/share/view/shr_demo_map')).content.promptTerms, ['interphase', 'mitosis']);
  // The viewer-only items have no ids to write with.
  assert.equal((await call('GET', '/share/view/shr_demo_questions')).share.resourceId, undefined);
});

test('share mock: shared with me has one invented item per type, each opens', async () => {
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
