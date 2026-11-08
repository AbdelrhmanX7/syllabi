import type { BoardDoc, LiveOps } from './live-merge';
import type { LiveStreamHandlers } from './live';

import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveSession, presenceLine, withoutPending } from './live';
import { applyOps } from './live-merge';

type Item = Record<string, unknown>;
const stroke = (oid: string, x = 0): Item => ({ oid, type: 'path', left: x, top: 0, path: [['M', x, 0]] });
const board = (items: Item[]): BoardDoc => ({
  id: 'd',
  pages: [{ id: 'p1', canvasJSON: JSON.stringify({ version: '7.2.0', objects: items }) }],
});
const ids = (doc: BoardDoc) => (JSON.parse(doc.pages[0].canvasJSON as string).objects as Item[]).map((o) => o.oid);

/** A fake host + server: `screen` is the editor's board, `server` the stored versions. */
function rig(start: Item[]) {
  const state = {
    screen: board(start),
    server: { version: 1, doc: board(start) },
    pushes: [] as LiveOps[],
    fetches: 0,
    handlers: null as LiveStreamHandlers | null,
  };
  const session = new LiveSession(
    {
      pageId: 'page',
      clientId: 'me-device',
      getLocal: () => state.screen,
      applyRemote: async (ops) => {
        state.screen = applyOps(state.screen, ops);

        return true;
      },
      push: async (ops) => {
        state.pushes.push(ops);
        const prevVersion = state.server.version;

        state.server = { version: prevVersion + 1, doc: applyOps(state.server.doc, ops) };

        return { prevVersion, version: state.server.version };
      },
      fetchLatest: async () => {
        state.fetches += 1;

        return state.server;
      },
      openStream: (handlers, signal) =>
        new Promise<void>((resolve) => {
          state.handlers = handlers;
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    },
    { version: 1, doc: board(start) },
  );

  return { state, session };
}

/** Someone else saves `ops` on the server and the stream tells us. */
async function theyPush(r: ReturnType<typeof rig>, ops: LiveOps, sendOps = true) {
  const prevVersion = r.state.server.version;

  r.state.server = { version: prevVersion + 1, doc: applyOps(r.state.server.doc, ops) };
  r.state.handlers!.onOps({
    prevVersion,
    version: r.state.server.version,
    ops: sendOps ? ops : null,
    by: { clientId: 'maya-device', userId: 'maya', name: 'Maya' },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
}

test('their strokes land on my screen in order, without re-reading the page', async () => {
  const r = rig([stroke('a')]);

  r.session.start();
  await theyPush(r, { items: [{ page: 'p1', put: [stroke('m1', 5)] }] });
  await theyPush(r, { items: [{ page: 'p1', put: [stroke('m2', 6)] }] });
  assert.deepEqual(ids(r.state.screen), ['a', 'm1', 'm2']);
  assert.equal(r.state.fetches, 0);
  assert.equal(r.session.version, 3);
  r.session.stop();
});

test('a gap in the versions (or a whole-board save) re-reads the page and shows what changed', async () => {
  const r = rig([stroke('a')]);

  r.session.start();
  // a version we never heard about
  r.state.server = { version: 2, doc: board([stroke('a'), stroke('lost', 3)]) };
  await theyPush(r, { items: [{ page: 'p1', del: ['a'] }] });
  assert.equal(r.state.fetches, 1);
  assert.deepEqual(ids(r.state.screen), ['lost']);
  await theyPush(r, { items: [{ page: 'p1', put: [stroke('w')] }] }, false);
  assert.deepEqual(ids(r.state.screen), ['lost', 'w']);
  r.session.stop();
});

test('my change goes out as only the difference; the base moves along', async () => {
  const r = rig([stroke('a')]);

  r.session.start();
  await r.session.flushNow();
  r.state.pushes.length = 0; // the start-up check sends nothing
  r.state.screen = board([stroke('a'), stroke('mine', 8)]);
  r.session.noteLocalChange();
  await r.session.flushNow();
  assert.deepEqual(r.state.pushes, [{ items: [{ page: 'p1', put: [stroke('mine', 8)] }] }]);
  assert.equal(r.session.version, 2);
  assert.equal(r.state.fetches, 0);
  // nothing new: nothing sent
  r.session.noteLocalChange();
  await r.session.flushNow();
  assert.equal(r.state.pushes.length, 1);
  r.session.stop();
});

test('their save between my base and my push: re-read once, theirs on screen, mine kept', async () => {
  const r = rig([stroke('a')]);

  r.session.start();
  // Maya's save the stream has not delivered yet
  r.state.server = { version: 2, doc: board([stroke('a'), stroke('m', 4)]) };
  r.state.screen = board([stroke('a'), stroke('mine', 8)]);
  r.session.noteLocalChange();
  await r.session.flushNow();
  assert.equal(r.state.fetches, 1);
  assert.deepEqual(new Set(ids(r.state.screen)), new Set(['a', 'm', 'mine']));
  assert.deepEqual(new Set(ids(r.state.server.doc)), new Set(['a', 'm', 'mine']));
  assert.equal(r.session.version, 3);
  // the late event for version 2 is ignored
  r.state.handlers!.onOps({ prevVersion: 1, version: 2, ops: { items: [{ page: 'p1', put: [stroke('m', 4)] }] }, by: { clientId: 'x-device', userId: 'x', name: 'X' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(r.session.version, 3);
  r.session.stop();
});

test('their change never overwrites an item I changed and have not sent yet', async () => {
  const r = rig([stroke('a', 0)]);

  r.session.start();
  await r.session.flushNow();
  r.state.screen = board([stroke('a', 50)]); // I moved it; the batch has not gone out
  r.session.noteLocalChange();
  await theyPush(r, { items: [{ page: 'p1', put: [stroke('a', 99), stroke('m', 1)] }] });
  const left = (JSON.parse(r.state.screen.pages[0].canvasJSON as string).objects as Item[]).find((o) => o.oid === 'a')!.left;

  assert.equal(left, 50);
  assert.ok(ids(r.state.screen).includes('m'));
  await r.session.flushNow();
  // and mine wins on the server, arriving later
  const onServer = (JSON.parse(r.state.server.doc.pages[0].canvasJSON as string).objects as Item[]).find((o) => o.oid === 'a')!.left;

  assert.equal(onServer, 50);
  r.session.stop();
});

test('withoutPending keeps everything when nothing is pending', () => {
  const ops: LiveOps = { items: [{ page: 'p1', del: ['a'] }] };

  assert.equal(withoutPending(ops, null), ops);
  assert.equal(withoutPending(ops, { items: [{ page: 'p1', put: [stroke('a')] }] }), null);
});

test('presence line: plain first names, never me, never my own other device', () => {
  const me = { clientId: 'c1', userId: 'u1' };

  assert.equal(presenceLine([{ clientId: 'c1', userId: 'u1', name: 'Me' }], me), null);
  assert.equal(presenceLine([{ clientId: 'c9', userId: 'u1', name: 'Me' }], me), null);
  assert.equal(presenceLine([{ clientId: 'c2', userId: 'u2', name: 'Maya Lee' }], me), 'Maya is here too');
  assert.equal(
    presenceLine(
      [
        { clientId: 'c2', userId: 'u2', name: 'Maya' },
        { clientId: 'c3', userId: 'u2', name: 'Maya' },
        { clientId: 'c4', userId: 'u3', name: 'Sam' },
      ],
      me,
    ),
    'Maya and Sam are here too',
  );
  assert.equal(
    presenceLine(
      ['a', 'b', 'c'].map((n, i) => ({ clientId: `x${i}`, userId: n, name: n.toUpperCase() })),
      me,
    ),
    'A and 2 others are here too',
  );
});

test('opened offline (no base): catches up three-way against the version this device last had', async () => {
  const v1 = board([stroke('a'), stroke('b', 2)]);
  const state = {
    screen: board([stroke('a'), stroke('b', 2), stroke('mine', 9)]),
    server: { version: 2, doc: board([stroke('a'), stroke('m', 4)]) }, // Maya erased b, drew m
    pushes: [] as LiveOps[],
  };
  const session = new LiveSession(
    {
      pageId: 'page',
      clientId: 'me-device',
      getLocal: () => state.screen,
      applyRemote: async (ops) => {
        state.screen = applyOps(state.screen, ops);

        return true;
      },
      push: async (ops) => {
        state.pushes.push(ops);
        const prevVersion = state.server.version;

        state.server = { version: prevVersion + 1, doc: applyOps(state.server.doc, ops) };

        return { prevVersion, version: state.server.version };
      },
      fetchLatest: async () => state.server,
      fetchVersion: async (version) => (version === 1 ? v1 : null),
      lastVersion: 1,
      openStream: (_handlers, signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    },
    null,
  );

  session.start();
  await session.flushNow();
  assert.deepEqual(new Set(ids(state.screen)), new Set(['a', 'm', 'mine']));
  assert.deepEqual(new Set(ids(state.server.doc)), new Set(['a', 'm', 'mine']));
  session.stop();
});
