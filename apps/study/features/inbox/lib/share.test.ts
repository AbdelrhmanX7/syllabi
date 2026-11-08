import type { ShareBridge } from './share';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { base64ToBytes, parsePending, readSharedFile, sharedFileName } from './share';

const entry = (id: string, mime: string, receivedAt: number, name = `${id}.jpg`) => ({
  id,
  name,
  mime,
  bytes: 3,
  receivedAt,
});

test('parsePending: oldest first, images + PDFs only, malformed dropped', () => {
  const json = JSON.stringify([
    entry('b', 'image/jpeg', 20),
    entry('a', 'IMAGE/PNG', 10),
    entry('c', 'application/pdf', 30, 'notes.pdf'),
    entry('d', 'text/plain', 5),
    { name: 'no id' },
    null,
    'x',
  ]);

  assert.deepEqual(
    parsePending(json).map((file) => [file.id, file.mime]),
    [
      ['a', 'image/png'],
      ['b', 'image/jpeg'],
      ['c', 'application/pdf'],
    ],
  );
  assert.deepEqual(parsePending('not json'), []);
  assert.deepEqual(parsePending('{"id":"a"}'), []);
});

test('base64ToBytes', () => {
  assert.deepEqual(Array.from(base64ToBytes('AAEC/w==')), [0, 1, 2, 255]);
});

test('sharedFileName adds an extension when the provider gave none', () => {
  assert.equal(sharedFileName({ name: 'IMG_1234.HEIC', mime: 'image/heic' }), 'IMG_1234.HEIC');
  assert.equal(sharedFileName({ name: 'Screenshot', mime: 'image/jpeg' }), 'Screenshot.jpg');
  assert.equal(sharedFileName({ name: 'shared', mime: 'application/pdf' }), 'shared.pdf');
  assert.equal(sharedFileName({ name: 'drawing', mime: 'image/svg+xml' }), 'drawing.svg');
});

test('readSharedFile: bytes + type through the bridge; a vanished file is a readable error', () => {
  const bridge: ShareBridge = {
    pending: () => '[]',
    read: (id) => (id === 'ok' ? 'AAEC' : ''),
    remove: () => true,
  };
  const file = readSharedFile(bridge, { id: 'ok', name: 'photo', mime: 'image/png', bytes: 3, receivedAt: 0 });

  assert.equal(file.name, 'photo.png');
  assert.equal(file.type, 'image/png');
  assert.equal(file.size, 3);
  assert.throws(
    () => readSharedFile(bridge, { id: 'gone', name: 'x.jpg', mime: 'image/jpeg', bytes: 1, receivedAt: 0 }),
    /no longer on this tablet/,
  );
});
