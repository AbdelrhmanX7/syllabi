import test from 'node:test';
import assert from 'node:assert/strict';

import { WhiteboardApiClient, WhiteboardApiError } from '../src/remote/client';

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

test('requestDraftSnapshotUploadUrl POSTs to the upload-url path with the API key and normalizes a relative uploadUrl', async () => {
  const { client, requests } = createMockClient({
    body: { storageKey: 'snapshots/doc-1/abc.json.gz', uploadUrl: '/b2/upload/abc' },
  });

  const response = await client.requestDraftSnapshotUploadUrl('doc-1');
  const request = requests[0];

  assert.equal(request.method, 'POST');
  assert.equal(request.url.pathname, '/api/whiteboard/documents/doc-1/draft-snapshots/upload-url');
  assert.equal(request.headers.get('X-Whiteboard-Api-Key'), API_KEY);
  assert.equal(response.storageKey, 'snapshots/doc-1/abc.json.gz');
  assert.equal(response.uploadUrl, 'https://api.example.com/b2/upload/abc');
});

test('appendDraftSnapshot POSTs the snapshot body and parses diverged + otherBranch', async () => {
  const { client, requests } = createMockClient({
    body: {
      diverged: true,
      latestSeq: 8,
      otherBranch: { createdAt: '2026-06-14T10:00:00.000Z', deviceId: 'device-b', seq: 7 },
      seq: 8,
    },
  });

  const input = {
    baseSeq: 6,
    deviceId: 'device-a',
    fileSize: 4096,
    pageCount: 3,
    rawDataUrl: 'https://cdn.example.com/snapshots/doc-1/abc.json.gz',
    storageKey: 'snapshots/doc-1/abc.json.gz',
    thumbnail: null,
    title: 'My Board',
  };

  const response = await client.appendDraftSnapshot('doc-1', input);
  const request = requests[0];

  assert.equal(request.method, 'POST');
  assert.equal(request.url.pathname, '/api/whiteboard/documents/doc-1/draft-snapshots');
  assert.equal(request.headers.get('X-Whiteboard-Api-Key'), API_KEY);
  assert.deepEqual(request.body, input);
  assert.equal(response.seq, 8);
  assert.equal(response.latestSeq, 8);
  assert.equal(response.diverged, true);
  assert.deepEqual(response.otherBranch, {
    createdAt: '2026-06-14T10:00:00.000Z',
    deviceId: 'device-b',
    seq: 7,
  });
});

test('appendDraftSnapshot throws WhiteboardApiError with status 404 so the syncer can fall back to legacy sync-draft', async () => {
  const { client } = createMockClient({ body: { message: 'Not Found' }, status: 404 });

  await assert.rejects(
    () =>
      client.appendDraftSnapshot('doc-1', {
        baseSeq: null,
        deviceId: 'device-a',
        fileSize: 10,
        pageCount: 1,
        rawDataUrl: 'https://cdn.example.com/x.json.gz',
        storageKey: 'k',
        thumbnail: null,
        title: 'x',
      }),
    (error: unknown) => {
      assert.ok(error instanceof WhiteboardApiError);
      assert.equal(error.status, 404);

      return true;
    },
  );
});

test('listDraftSnapshots GETs the draft-snapshots path with the limit query and parses the ring', async () => {
  const { client, requests } = createMockClient({
    body: {
      snapshots: [
        {
          baseSeq: 7,
          createdAt: '2026-06-14T10:00:00.000Z',
          deviceId: 'device-a',
          fileSize: 4096,
          pageCount: 3,
          rawDataUrl: 'https://cdn.example.com/8.json.gz',
          seq: 8,
          thumbnail: null,
          title: 'My Board',
        },
      ],
    },
  });

  const response = await client.listDraftSnapshots('doc-1', { limit: 20 });
  const request = requests[0];

  assert.equal(request.method, 'GET');
  assert.equal(request.url.pathname, '/api/whiteboard/documents/doc-1/draft-snapshots');
  assert.equal(request.url.searchParams.get('limit'), '20');
  assert.equal(request.headers.get('X-Whiteboard-Api-Key'), API_KEY);
  assert.equal(response.snapshots.length, 1);
  assert.equal(response.snapshots[0]?.seq, 8);
});

test('requestSourcePdfUploadUrl forwards checksum + fileSize and normalizes a relative uploadUrl', async () => {
  const { client, requests } = createMockClient({
    body: { assetId: 'asset-1', storageKey: 'pdfs/doc-1/asset-1.pdf', uploadUrl: '/b2/upload/asset-1' },
  });

  const response = await client.requestSourcePdfUploadUrl('doc-1', {
    checksum: 'sha256-abc',
    fileName: 'lecture.pdf',
    fileSize: 1024,
  });
  const request = requests[0];

  assert.equal(request.method, 'POST');
  assert.equal(request.url.pathname, '/api/whiteboard/documents/doc-1/source-pdf/upload-url');
  assert.deepEqual(request.body, { checksum: 'sha256-abc', fileName: 'lecture.pdf', fileSize: 1024 });
  assert.equal(response.deduped ?? false, false);

  if (!response.deduped) {
    assert.equal(response.assetId, 'asset-1');
    assert.equal(response.uploadUrl, 'https://api.example.com/b2/upload/asset-1');
  }
});

test('requestSourcePdfUploadUrl returns the deduped variant with no uploadUrl/storageKey', async () => {
  const { client } = createMockClient({ body: { assetId: 'asset-existing', deduped: true } });

  const response = await client.requestSourcePdfUploadUrl('doc-1', {
    checksum: 'sha256-dupe',
    fileName: 'lecture.pdf',
    fileSize: 1024,
  });

  assert.equal(response.deduped, true);
  assert.equal(response.assetId, 'asset-existing');

  if (response.deduped) {
    assert.equal(response.uploadUrl, undefined);
    assert.equal(response.storageKey, undefined);
  }
});

test('startSourcePdfMultipart POSTs the start body and parses assetId/uploadId/partSize', async () => {
  const { client, requests } = createMockClient({
    body: { assetId: 'asset-1', partSize: 16 * 1024 * 1024, uploadId: 'upload-1' },
  });

  const input = {
    checksum: 'sha256-big',
    fileName: 'big.pdf',
    fileSize: 150 * 1024 * 1024,
    mimeType: 'application/pdf',
    pageCount: 200,
  };

  const response = await client.startSourcePdfMultipart('doc-1', input);
  const request = requests[0];

  assert.equal(request.method, 'POST');
  assert.equal(request.url.pathname, '/api/whiteboard/documents/doc-1/source-pdf/multipart/start');
  assert.deepEqual(request.body, input);
  assert.equal(response.assetId, 'asset-1');
  assert.equal(response.deduped ?? false, false);

  if (!response.deduped) {
    assert.equal(response.uploadId, 'upload-1');
    assert.equal(response.partSize, 16 * 1024 * 1024);
  }
});

test('getSourcePdfMultipartPartUrl GETs the part-url path with uploadId + partNumber and normalizes the url', async () => {
  const { client, requests } = createMockClient({ body: { url: '/b2/upload/asset-1/part/3' } });

  const response = await client.getSourcePdfMultipartPartUrl('doc-1', 'asset-1', {
    partNumber: 3,
    uploadId: 'upload-1',
  });
  const request = requests[0];

  assert.equal(request.method, 'GET');
  assert.equal(request.url.pathname, '/api/whiteboard/documents/doc-1/source-pdf/asset-1/multipart/part-url');
  assert.equal(request.url.searchParams.get('uploadId'), 'upload-1');
  assert.equal(request.url.searchParams.get('partNumber'), '3');
  assert.equal(response.url, 'https://api.example.com/b2/upload/asset-1/part/3');
});

test('listSourcePdfMultipartParts GETs the parts path with uploadId and parses received parts for resume', async () => {
  const { client, requests } = createMockClient({
    body: {
      parts: [
        { etag: 'etag-1', partNumber: 1, size: 16 },
        { etag: 'etag-2', partNumber: 2, size: 16 },
      ],
    },
  });

  const response = await client.listSourcePdfMultipartParts('doc-1', 'asset-1', { uploadId: 'upload-1' });
  const request = requests[0];

  assert.equal(request.method, 'GET');
  assert.equal(request.url.pathname, '/api/whiteboard/documents/doc-1/source-pdf/asset-1/multipart/parts');
  assert.equal(request.url.searchParams.get('uploadId'), 'upload-1');
  assert.equal(response.parts.length, 2);
  assert.equal(response.parts[1]?.etag, 'etag-2');
});

test('completeSourcePdfMultipart POSTs the uploadId + parts and parses the confirmed asset', async () => {
  const { client, requests } = createMockClient({
    body: {
      asset: {
        _id: 'asset-1',
        fileName: 'big.pdf',
        fileSize: 100,
        pageCount: 200,
        status: 'confirmed',
        storageKey: 'k',
      },
      message: 'ok',
    },
  });

  const input = {
    parts: [
      { etag: 'etag-1', partNumber: 1 },
      { etag: 'etag-2', partNumber: 2 },
    ],
    uploadId: 'upload-1',
  };

  const response = await client.completeSourcePdfMultipart('doc-1', 'asset-1', input);
  const request = requests[0];

  assert.equal(request.method, 'POST');
  assert.equal(request.url.pathname, '/api/whiteboard/documents/doc-1/source-pdf/asset-1/multipart/complete');
  assert.deepEqual(request.body, input);
  assert.equal(response.message, 'ok');
  assert.equal(response.asset._id, 'asset-1');
  assert.equal(response.asset.status, 'confirmed');
});
