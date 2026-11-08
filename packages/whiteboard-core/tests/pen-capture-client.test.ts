import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';

import type { WhiteboardApiBodyEncoder, WhiteboardApiPenCaptureBatch } from '../src/remote/client';

import { WhiteboardApiClient } from '../src/remote/client';

const API_KEY = `wb_${'a'.repeat(64)}`;
const BASE_URL = 'https://api.example.com/api';

interface RecordedRequest {
  body: BodyInit | null | undefined;
  headers: Headers;
  method: string;
  url: URL;
}

function createMockClient(): { client: WhiteboardApiClient; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    requests.push({
      body: init?.body,
      headers: new Headers(init?.headers),
      method: init?.method ?? 'GET',
      url: new URL(rawUrl),
    });

    return new Response(JSON.stringify({ received: 2 }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  };

  return { client: new WhiteboardApiClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetcher }), requests };
}

/** A batch shaped exactly as the board's uploader builds one, with two contacts to de-duplicate on. */
function batch(): WhiteboardApiPenCaptureBatch {
  return {
    schema: 'wb-contact-capture/v1',
    session: {
      sessionId: 'sess-7',
      deviceLabel: 'Studio 1',
      createdAt: '2026-08-20T18:00:00.000Z',
      nativeVersion: '0.1.140',
      jsBuild: 'dev',
      devicePixelRatio: 1.5,
      screenW: 1920,
      screenH: 1080,
      maxTouchPoints: 10,
      rulebook: 'height-aware',
      bands: { smallHeadMaxWidth: 8, bigHeadMaxWidth: 18, fingerMinWidth: 22 },
      touchInputMode: 'pen',
      dualTipEnabled: true,
    },
    contacts: [
      { contactId: 'c1', frames: [{ t: 0, w: 6, h: 9 }] },
      { contactId: 'c2', frames: [{ t: 8, w: 7, h: 9 }] },
    ],
  };
}

/** The app's real encoder, in the shape the board supplies it — node:zlib standing in for CompressionStream. */
const gzipEncoder: WhiteboardApiBodyEncoder = async (json) => ({
  body: new Uint8Array(gzipSync(Buffer.from(json, 'utf8'))),
  contentEncoding: 'gzip',
});

test('a gzipped upload carries Content-Encoding and a body that inflates back to the same batch', async () => {
  const { client, requests } = createMockClient();
  const sent = batch();

  const response = await client.uploadPenCaptures(sent, gzipEncoder);

  assert.equal(requests.length, 1);
  const [request] = requests;

  assert.equal(request.method, 'POST');
  assert.equal(request.url.pathname, '/api/whiteboard/pen-captures');
  assert.equal(request.headers.get('Content-Encoding'), 'gzip');
  // The payload IS json — Content-Encoding says how it was packed, not what it is.
  assert.equal(request.headers.get('Content-Type'), 'application/json');
  assert.equal(request.headers.get('X-Whiteboard-Api-Key'), API_KEY);

  assert.ok(request.body instanceof Uint8Array, 'the bytes go out verbatim, not JSON.stringify(bytes)');

  const inflated = JSON.parse(gunzipSync(Buffer.from(request.body as Uint8Array)).toString('utf8'));

  assert.deepEqual(inflated, sent, 'round-trips to exactly the batch the caller passed');
  assert.equal(response.received, 2);
});

test('gzip really is smaller — the point of the exercise, on a batch shaped like a real one', async () => {
  const { client, requests } = createMockClient();
  const frames = Array.from({ length: 400 }, (_, index) => ({
    t: index * 8,
    w: 6.5,
    h: 9.25,
    x: 100 + index,
    y: 200,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    coalesced: false,
  }));
  const sent = { ...batch(), contacts: [{ contactId: 'c1', frames }] };

  await client.uploadPenCaptures(sent, gzipEncoder);

  const packed = (requests[0].body as Uint8Array).byteLength;

  assert.ok(packed < Buffer.byteLength(JSON.stringify(sent)) / 4, `packed to ${packed} bytes`);
});

test('a retry re-sends the same contacts: the batch is what is replayed, not the bytes', async () => {
  const { client, requests } = createMockClient();
  const sent = batch();

  await client.uploadPenCaptures(sent, gzipEncoder);
  // Second attempt after a lost response — idempotency is on (sessionId, contactId), so the server
  // must see the same pairs it saw the first time.
  await client.uploadPenCaptures(sent, gzipEncoder);

  const [first, second] = requests.map((request) =>
    JSON.parse(gunzipSync(Buffer.from(request.body as Uint8Array)).toString('utf8')),
  );

  assert.deepEqual(first, second);
  assert.equal(second.session.sessionId, 'sess-7');
  assert.deepEqual(
    second.contacts.map((contact: { contactId: string }) => contact.contactId),
    ['c1', 'c2'],
  );
});

test('an encoder that cannot compress falls back to plain JSON with no Content-Encoding', async () => {
  const { client, requests } = createMockClient();
  const sent = batch();
  // What the app's encoder answers where `CompressionStream` is missing (web/dev, an old browser).
  const noCompressor: WhiteboardApiBodyEncoder = async () => null;

  await client.uploadPenCaptures(sent, noCompressor);

  const [request] = requests;

  assert.equal(request.headers.get('Content-Encoding'), null);
  assert.equal(request.headers.get('Content-Type'), 'application/json');
  assert.equal(typeof request.body, 'string');
  assert.deepEqual(JSON.parse(request.body as string), sent);
});

test('with no encoder at all the request is byte-for-byte the pre-compression one', async () => {
  const { client, requests } = createMockClient();
  const sent = batch();

  await client.uploadPenCaptures(sent);

  const [request] = requests;

  assert.equal(request.headers.get('Content-Encoding'), null);
  assert.equal(request.body, JSON.stringify(sent));
});

test('every OTHER endpoint still sends plain JSON — the raw-body path is pen-captures only', async () => {
  const { client, requests } = createMockClient();

  await client.createDocument({ title: 'Document' });

  const [request] = requests;

  assert.equal(request.headers.get('Content-Encoding'), null);
  assert.equal(request.headers.get('Content-Type'), 'application/json');
  assert.equal(request.body, JSON.stringify({ title: 'Document' }));
});
