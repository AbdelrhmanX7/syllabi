import test from 'node:test';
import assert from 'node:assert/strict';

import { WhiteboardApiClient, WhiteboardApiError } from '../src/remote/client';

import type { MergePageManifestEntry } from '../src/remote/types';

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

test('createMergeOverlayUploadUrl POSTs to merge-overlays/upload-url with the API key and normalizes a relative uploadUrl', async () => {
  const { client, requests } = createMockClient({
    body: {
      publicUrl: 'https://cdn.example.com/merge-overlays/doc-1/p0.png',
      storageKey: 'merge-overlays/doc-1/p0.png',
      uploadUrl: '/whiteboard/proxy-upload/p0',
    },
  });

  const response = await client.createMergeOverlayUploadUrl('doc-1');
  const request = requests[0];

  assert.equal(request.method, 'POST');
  assert.equal(request.url.pathname, '/api/whiteboard/documents/doc-1/merge-overlays/upload-url');
  assert.equal(request.headers.get('X-Whiteboard-Api-Key'), API_KEY);
  assert.equal(response.storageKey, 'merge-overlays/doc-1/p0.png');
  assert.equal(response.publicUrl, 'https://cdn.example.com/merge-overlays/doc-1/p0.png');
  assert.equal(response.uploadUrl, 'https://api.example.com/whiteboard/proxy-upload/p0');
});

test('generateVersion POSTs snapshotSeq + pages[] to versions/generate and parses the 202 queued job', async () => {
  const { client, requests } = createMockClient({
    body: { jobId: 'job-1', status: 'queued' },
    status: 202,
  });

  const pages: MergePageManifestEntry[] = [
    {
      heightPt: 960,
      index: 0,
      overlayKey: 'merge-overlays/doc-1/p0.png',
      pdf: { height: 960, width: 720, x: 0, y: 0 },
      pdfAssetId: 'asset-1',
      pdfPageIndex: 0,
      widthPt: 720,
    },
    {
      heightPt: 960,
      index: 1,
      overlayKey: 'merge-overlays/doc-1/p1.png',
      widthPt: 720,
    },
  ];
  const body = { pages, snapshotSeq: 5 };

  const response = await client.generateVersion('doc-1', body);
  const request = requests[0];

  assert.equal(request.method, 'POST');
  assert.equal(request.url.pathname, '/api/whiteboard/documents/doc-1/versions/generate');
  assert.equal(request.headers.get('X-Whiteboard-Api-Key'), API_KEY);
  assert.deepEqual(request.body, body);
  assert.equal(response.jobId, 'job-1');
  assert.equal(response.status, 'queued');
});

test('generateVersion with no pages sends only snapshotSeq so the backend reuses the stored manifest', async () => {
  const { client, requests } = createMockClient({
    body: { jobId: 'job-2', status: 'queued' },
    status: 202,
  });

  const response = await client.generateVersion('doc-1', { snapshotSeq: 9 });
  const request = requests[0];

  assert.equal(request.method, 'POST');
  assert.deepEqual(request.body, { snapshotSeq: 9 });
  assert.equal(response.jobId, 'job-2');
});

test('generateVersion defaults to an empty body when called with no arguments', async () => {
  const { client, requests } = createMockClient({
    body: { jobId: 'job-3', status: 'queued' },
    status: 202,
  });

  await client.generateVersion('doc-1');
  const request = requests[0];

  assert.deepEqual(request.body, {});
});

test('generateVersion throws WhiteboardApiError with status 409 when the board has not pushed overlays yet', async () => {
  const { client } = createMockClient({
    body: { message: 'No stored manifest for this document yet.' },
    status: 409,
  });

  await assert.rejects(
    () => client.generateVersion('doc-1', { snapshotSeq: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof WhiteboardApiError);
      assert.equal(error.status, 409);

      return true;
    },
  );
});

test('getVersionJob GETs the versions/jobs path and parses a done status + pdfUrl', async () => {
  const { client, requests } = createMockClient({
    body: { pdfUrl: 'https://cdn.example.com/versions/doc-1/v3.pdf', status: 'done', versionNumber: 3 },
  });

  const response = await client.getVersionJob('doc-1', 'job-1');
  const request = requests[0];

  assert.equal(request.method, 'GET');
  assert.equal(request.url.pathname, '/api/whiteboard/documents/doc-1/versions/jobs/job-1');
  assert.equal(request.headers.get('X-Whiteboard-Api-Key'), API_KEY);
  assert.equal(response.status, 'done');
  assert.equal(response.versionNumber, 3);
  assert.equal(response.pdfUrl, 'https://cdn.example.com/versions/doc-1/v3.pdf');
});

test('getVersionJob parses a failed status + error message for the retry UI', async () => {
  const { client } = createMockClient({
    body: { error: 'render OOM', status: 'failed' },
  });

  const response = await client.getVersionJob('doc-1', 'job-1');

  assert.equal(response.status, 'failed');
  assert.equal(response.error, 'render OOM');
});
