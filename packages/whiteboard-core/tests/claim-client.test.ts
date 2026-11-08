import test from 'node:test';
import assert from 'node:assert/strict';

import { WhiteboardApiClient } from '../src/remote/client';

const API_KEY = `wb_${'a'.repeat(64)}`;
const BASE_URL = 'https://api.example.com/api';

interface RecordedRequest {
  body: unknown;
  headers: Headers;
  method: string;
  url: URL;
}

interface MockFetchResult {
  body?: unknown;
  status?: number;
}

function createMockClient(result: MockFetchResult | ((request: RecordedRequest) => MockFetchResult)): {
  client: WhiteboardApiClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    const parsedBody = typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined;
    const request: RecordedRequest = {
      body: parsedBody,
      headers,
      method: init?.method ?? 'GET',
      url: new URL(rawUrl),
    };

    requests.push(request);

    const resolved = typeof result === 'function' ? result(request) : result;
    const status = resolved.status ?? 200;
    const payload = resolved.body === undefined ? '' : JSON.stringify(resolved.body);

    return new Response(payload, {
      headers: { 'Content-Type': 'application/json' },
      status,
    });
  };

  return {
    client: new WhiteboardApiClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetcher }),
    requests,
  };
}

const CLAIMED_DOCUMENT = {
  _id: 'a1b2c3d4e5f60718293a4b5c',
  clientId: '550e8400-e29b-41d4-a716-446655440000',
  title: 'New document',
  teacherId: 'b1b2c3d4e5f60718293a4b5c',
  teacherType: 'Teacher' as const,
  lectureId: null,
  isPublished: false,
  autoPublish: false,
  currentVersion: 0,
  pageCount: 2,
  draftRawDataUrl: null,
  draftUpdatedAt: null,
  tags: [],
  thumbnail: null,
  isActive: true,
  isDeleted: false,
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
};

test('claimDocument POSTs clientId/title/pageCount to /documents/claim with the API key and returns the wrapper', async () => {
  const { client, requests } = createMockClient({ body: { created: true, document: CLAIMED_DOCUMENT }, status: 201 });

  const response = await client.claimDocument({
    clientId: '550e8400-e29b-41d4-a716-446655440000',
    pageCount: 2,
    title: 'New document',
  });

  assert.equal(requests.length, 1);
  const [request] = requests;

  assert.equal(request.method, 'POST');
  // base normalizes to .../whiteboard, then the claim path is appended.
  assert.equal(request.url.pathname, '/api/whiteboard/documents/claim');
  assert.equal(request.headers.get('X-Whiteboard-Api-Key'), API_KEY);
  assert.deepEqual(request.body, {
    clientId: '550e8400-e29b-41d4-a716-446655440000',
    pageCount: 2,
    title: 'New document',
  });

  assert.equal(response.created, true);
  assert.equal(response.document._id, 'a1b2c3d4e5f60718293a4b5c');
  assert.equal(response.document.clientId, '550e8400-e29b-41d4-a716-446655440000');
});

test('claimDocument surfaces created:false on the idempotent (200) hit with the same _id', async () => {
  const { client } = createMockClient({ body: { created: false, document: CLAIMED_DOCUMENT }, status: 200 });

  const response = await client.claimDocument({ clientId: '550e8400-e29b-41d4-a716-446655440000' });

  assert.equal(response.created, false);
  assert.equal(response.document._id, 'a1b2c3d4e5f60718293a4b5c');
});

test('claimDocument works through the token-auth (authHeaders) surface too', async () => {
  const requests: RecordedRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    requests.push({
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: new Headers(init?.headers),
      method: init?.method ?? 'GET',
      url: new URL(rawUrl),
    });

    return new Response(JSON.stringify({ created: true, document: CLAIMED_DOCUMENT }), {
      headers: { 'Content-Type': 'application/json' },
      status: 201,
    });
  };
  const client = new WhiteboardApiClient({
    authHeaders: () => ({ Authorization: 'Bearer teacher-token-xyz' }),
    baseUrl: 'https://api.example.com/teacher',
    fetcher,
  });

  await client.claimDocument({ clientId: '550e8400-e29b-41d4-a716-446655440000' });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, '/teacher/whiteboard/documents/claim');
  assert.equal(requests[0].headers.get('Authorization'), 'Bearer teacher-token-xyz');
  assert.equal(requests[0].headers.get('X-Whiteboard-Api-Key'), null);
});
