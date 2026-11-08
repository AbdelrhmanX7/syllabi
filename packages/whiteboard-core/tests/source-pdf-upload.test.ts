import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  WhiteboardApiClient,
  WhiteboardApiCompleteSourcePdfMultipartInput,
  WhiteboardApiConfirmSourcePdfInput,
  WhiteboardApiConfirmSourcePdfResponse,
  WhiteboardApiSourcePdfMultipartPart,
  WhiteboardApiSourcePdfMultipartPartUrlParams,
  WhiteboardApiSourcePdfMultipartPartUrlResponse,
  WhiteboardApiSourcePdfMultipartPartsResponse,
  WhiteboardApiSourcePdfUploadUrlInput,
  WhiteboardApiSourcePdfUploadUrlResponse,
  WhiteboardApiStartSourcePdfMultipartInput,
  WhiteboardApiStartSourcePdfMultipartResponse,
} from '../src';

import { sha256Hex, uploadSourcePdfAsset, WhiteboardApiError } from '../src';

const MB = 1024 * 1024;
const THRESHOLD = 16 * MB;

type ClientCall =
  | { method: 'requestSourcePdfUploadUrl'; documentId: string; input: WhiteboardApiSourcePdfUploadUrlInput }
  | { method: 'confirmSourcePdfUpload'; documentId: string; input: WhiteboardApiConfirmSourcePdfInput }
  | { method: 'startSourcePdfMultipart'; documentId: string; input: WhiteboardApiStartSourcePdfMultipartInput }
  | {
      method: 'getSourcePdfMultipartPartUrl';
      documentId: string;
      assetId: string;
      params: WhiteboardApiSourcePdfMultipartPartUrlParams;
    }
  | { method: 'listSourcePdfMultipartParts'; documentId: string; assetId: string; params: { uploadId: string } }
  | {
      method: 'completeSourcePdfMultipart';
      documentId: string;
      assetId: string;
      input: WhiteboardApiCompleteSourcePdfMultipartInput;
    };

interface FakeClientScript {
  uploadUrl?: WhiteboardApiSourcePdfUploadUrlResponse;
  start?: WhiteboardApiStartSourcePdfMultipartResponse;
  existingParts?: WhiteboardApiSourcePdfMultipartPart[];
  /** Make listSourcePdfMultipartParts throw for a specific uploadId (simulates a stale/expired id). */
  failListPartsForUploadId?: { uploadId: string; error: unknown };
}

interface FakeClientHandle {
  client: WhiteboardApiClient;
  calls: ClientCall[];
  runWithClient: <T>(fn: (client: WhiteboardApiClient) => Promise<T>) => Promise<T>;
}

function confirmResponse(assetId: string): WhiteboardApiConfirmSourcePdfResponse {
  return {
    asset: {
      _id: assetId,
      fileName: 'doc.pdf',
      fileSize: 1,
      pageCount: 1,
      status: 'confirmed',
      storageKey: `keys/${assetId}`,
    },
    message: 'ok',
  };
}

function createFakeClient(script: FakeClientScript): FakeClientHandle {
  const calls: ClientCall[] = [];
  const client = {
    async requestSourcePdfUploadUrl(
      documentId: string,
      input: WhiteboardApiSourcePdfUploadUrlInput,
    ): Promise<WhiteboardApiSourcePdfUploadUrlResponse> {
      calls.push({ documentId, input, method: 'requestSourcePdfUploadUrl' });

      if (!script.uploadUrl) {
        throw new Error('uploadUrl response not scripted');
      }

      return script.uploadUrl;
    },
    async confirmSourcePdfUpload(
      documentId: string,
      input: WhiteboardApiConfirmSourcePdfInput,
    ): Promise<WhiteboardApiConfirmSourcePdfResponse> {
      calls.push({ documentId, input, method: 'confirmSourcePdfUpload' });

      return confirmResponse(input.assetId);
    },
    async startSourcePdfMultipart(
      documentId: string,
      input: WhiteboardApiStartSourcePdfMultipartInput,
    ): Promise<WhiteboardApiStartSourcePdfMultipartResponse> {
      calls.push({ documentId, input, method: 'startSourcePdfMultipart' });

      if (!script.start) {
        throw new Error('start response not scripted');
      }

      return script.start;
    },
    async getSourcePdfMultipartPartUrl(
      documentId: string,
      assetId: string,
      params: WhiteboardApiSourcePdfMultipartPartUrlParams,
    ): Promise<WhiteboardApiSourcePdfMultipartPartUrlResponse> {
      calls.push({ assetId, documentId, method: 'getSourcePdfMultipartPartUrl', params });

      return { url: `https://parts.example.com/${assetId}/${params.partNumber}` };
    },
    async listSourcePdfMultipartParts(
      documentId: string,
      assetId: string,
      params: { uploadId: string },
    ): Promise<WhiteboardApiSourcePdfMultipartPartsResponse> {
      calls.push({ assetId, documentId, method: 'listSourcePdfMultipartParts', params });

      if (script.failListPartsForUploadId && params.uploadId === script.failListPartsForUploadId.uploadId) {
        throw script.failListPartsForUploadId.error;
      }

      return { parts: script.existingParts ?? [] };
    },
    async completeSourcePdfMultipart(
      documentId: string,
      assetId: string,
      input: WhiteboardApiCompleteSourcePdfMultipartInput,
    ): Promise<WhiteboardApiConfirmSourcePdfResponse> {
      calls.push({ assetId, documentId, input, method: 'completeSourcePdfMultipart' });

      return confirmResponse(assetId);
    },
  } as unknown as WhiteboardApiClient;

  return {
    calls,
    client,
    runWithClient: (fn) => fn(client),
  };
}

interface PartPutRecord {
  url: string;
  byteLength: number;
  contentType: string | null;
}

interface FakeFetcherOptions {
  /** Part numbers (parsed from the URL) that should throw once before succeeding. */
  failOnce?: Set<number>;
}

function createPartFetcher(options: FakeFetcherOptions = {}): {
  fetcher: typeof fetch;
  puts: PartPutRecord[];
} {
  const puts: PartPutRecord[] = [];
  const failedOnce = new Set<number>();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const partNumber = Number(url.split('/').pop());
    const body = init?.body;
    let byteLength = 0;

    if (body instanceof Blob) {
      byteLength = body.size;
    } else if (body instanceof ArrayBuffer) {
      byteLength = body.byteLength;
    } else if (body instanceof Uint8Array) {
      byteLength = body.byteLength;
    }

    const contentType = new Headers(init?.headers).get('Content-Type');

    if (options.failOnce?.has(partNumber) && !failedOnce.has(partNumber)) {
      failedOnce.add(partNumber);

      throw new TypeError('network blip');
    }

    puts.push({ byteLength, contentType, url });

    return new Response(JSON.stringify({ etag: `etag-${partNumber}`, size: byteLength }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  }) as typeof fetch;

  return { fetcher, puts };
}

function makeBlob(size: number): Blob {
  return new Blob([new Uint8Array(size)], { type: 'application/pdf' });
}

test('sha256Hex returns lowercase hex matching crypto.subtle', async () => {
  const hex = await sha256Hex(new Uint8Array([1, 2, 3]));

  assert.match(hex, /^[a-f0-9]{64}$/);
  assert.equal(hex, await sha256Hex(new Blob([new Uint8Array([1, 2, 3])])));
});

test('≤16MB deduped → no upload, returns deduped:true', async () => {
  const { calls, runWithClient } = createFakeClient({
    uploadUrl: { assetId: 'asset-dedup', deduped: true },
  });
  const { fetcher, puts } = createPartFetcher();

  const result = await uploadSourcePdfAsset({
    checksum: 'sum-1',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(MB),
    fileName: 'doc.pdf',
    pageCount: 3,
    runWithClient,
  });

  assert.deepEqual(result, { assetId: 'asset-dedup', deduped: true });
  assert.equal(puts.length, 0);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['requestSourcePdfUploadUrl'],
  );
});

test('≤16MB fresh → single-PUT once + confirm, returns deduped:false', async () => {
  const { calls, runWithClient } = createFakeClient({
    uploadUrl: {
      assetId: 'asset-fresh',
      deduped: false,
      storageKey: 'keys/asset-fresh',
      uploadUrl: 'https://upload.example.com/single',
    },
  });
  const singlePuts: PartPutRecord[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body;
    const byteLength = body instanceof Blob ? body.size : 0;

    singlePuts.push({ byteLength, contentType: new Headers(init?.headers).get('Content-Type'), url });

    return new Response('', { status: 200 });
  }) as typeof fetch;

  const progress: number[] = [];
  const result = await uploadSourcePdfAsset({
    checksum: 'sum-2',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(2 * MB),
    fileName: 'doc.pdf',
    onProgress: (p) => progress.push(p.uploadedBytes),
    pageCount: 5,
    runWithClient,
  });

  assert.deepEqual(result, { assetId: 'asset-fresh', deduped: false });
  assert.equal(singlePuts.length, 1);
  assert.equal(singlePuts[0].url, 'https://upload.example.com/single');
  assert.equal(singlePuts[0].contentType, 'application/octet-stream');
  assert.equal(singlePuts[0].byteLength, 2 * MB);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['requestSourcePdfUploadUrl', 'confirmSourcePdfUpload'],
  );

  const confirmCall = calls.find((call) => call.method === 'confirmSourcePdfUpload');

  assert.ok(confirmCall && confirmCall.method === 'confirmSourcePdfUpload');
  assert.deepEqual(confirmCall.input, {
    assetId: 'asset-fresh',
    checksum: 'sum-2',
    fileSize: 2 * MB,
    pageCount: 5,
  });
  assert.deepEqual(progress, [2 * MB]);
});

test('>16MB deduped (start) → no part loop, returns deduped:true', async () => {
  const { calls, runWithClient } = createFakeClient({
    start: { assetId: 'asset-mp-dedup', deduped: true },
  });
  const { fetcher, puts } = createPartFetcher();

  const result = await uploadSourcePdfAsset({
    checksum: 'sum-3',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(40 * MB),
    fileName: 'big.pdf',
    pageCount: 100,
    runWithClient,
  });

  assert.deepEqual(result, { assetId: 'asset-mp-dedup', deduped: true });
  assert.equal(puts.length, 0);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['startSourcePdfMultipart'],
  );
});

test('>16MB fresh → 3 parts (16+16+8), each part-url + PUT, complete sorted with right etags', async () => {
  const { calls, runWithClient } = createFakeClient({
    start: { assetId: 'asset-mp', deduped: false, partSize: THRESHOLD, uploadId: 'up-1' },
    existingParts: [],
  });
  const { fetcher, puts } = createPartFetcher();

  const result = await uploadSourcePdfAsset({
    checksum: 'sum-4',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(40 * MB),
    fileName: 'big.pdf',
    pageCount: 100,
    runWithClient,
  });

  assert.deepEqual(result, { assetId: 'asset-mp', deduped: false });
  assert.equal(puts.length, 3);
  assert.deepEqual(
    puts.map((put) => put.byteLength),
    [THRESHOLD, THRESHOLD, 8 * MB],
  );
  assert.deepEqual(
    puts.map((put) => put.contentType),
    ['application/octet-stream', 'application/octet-stream', 'application/octet-stream'],
  );

  const partUrlCalls = calls.filter((call) => call.method === 'getSourcePdfMultipartPartUrl');

  assert.equal(partUrlCalls.length, 3);

  const completeCall = calls.find((call) => call.method === 'completeSourcePdfMultipart');

  assert.ok(completeCall && completeCall.method === 'completeSourcePdfMultipart');
  assert.deepEqual(completeCall.input, {
    parts: [
      { etag: 'etag-1', partNumber: 1 },
      { etag: 'etag-2', partNumber: 2 },
      { etag: 'etag-3', partNumber: 3 },
    ],
    uploadId: 'up-1',
  });
});

test('RESUME: part 1 already present → not re-PUT, parts 2..3 uploaded, complete has all 3', async () => {
  const { calls, runWithClient } = createFakeClient({
    existingParts: [{ etag: 'etag-existing-1', partNumber: 1, size: THRESHOLD }],
    start: { assetId: 'asset-resume', deduped: false, partSize: THRESHOLD, uploadId: 'up-2' },
  });
  const { fetcher, puts } = createPartFetcher();

  const result = await uploadSourcePdfAsset({
    checksum: 'sum-5',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(40 * MB),
    fileName: 'big.pdf',
    pageCount: 100,
    runWithClient,
  });

  assert.deepEqual(result, { assetId: 'asset-resume', deduped: false });
  // Only parts 2 and 3 were PUT.
  assert.equal(puts.length, 2);
  assert.deepEqual(
    puts.map((put) => Number(put.url.split('/').pop())),
    [2, 3],
  );

  // No part-url was requested for part 1.
  const partUrlNumbers = calls
    .filter((call) => call.method === 'getSourcePdfMultipartPartUrl')
    .map((call) => (call.method === 'getSourcePdfMultipartPartUrl' ? call.params.partNumber : 0));

  assert.deepEqual(partUrlNumbers, [2, 3]);

  const completeCall = calls.find((call) => call.method === 'completeSourcePdfMultipart');

  assert.ok(completeCall && completeCall.method === 'completeSourcePdfMultipart');
  assert.deepEqual(completeCall.input.parts, [
    { etag: 'etag-existing-1', partNumber: 1 },
    { etag: 'etag-2', partNumber: 2 },
    { etag: 'etag-3', partNumber: 3 },
  ]);
});

test('per-part retry: transient part-PUT failure is retried and succeeds, no duplicate parts', async () => {
  const { calls, runWithClient } = createFakeClient({
    existingParts: [],
    start: { assetId: 'asset-retry', deduped: false, partSize: THRESHOLD, uploadId: 'up-3' },
  });
  const { fetcher, puts } = createPartFetcher({ failOnce: new Set([2]) });

  const result = await uploadSourcePdfAsset({
    checksum: 'sum-6',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(40 * MB),
    fileName: 'big.pdf',
    pageCount: 100,
    runWithClient,
  });

  assert.deepEqual(result, { assetId: 'asset-retry', deduped: false });
  // 3 successful PUTs recorded (the failed attempt for part 2 threw before recording).
  assert.equal(puts.length, 3);

  const completeCall = calls.find((call) => call.method === 'completeSourcePdfMultipart');

  assert.ok(completeCall && completeCall.method === 'completeSourcePdfMultipart');
  assert.equal(completeCall.input.parts.length, 3);
  assert.deepEqual(completeCall.input.parts, [
    { etag: 'etag-1', partNumber: 1 },
    { etag: 'etag-2', partNumber: 2 },
    { etag: 'etag-3', partNumber: 3 },
  ]);
});

test('threshold boundary: exactly 16MB uses single-PUT, 16MB+1 uses multipart', async () => {
  // Exactly at threshold → single-PUT.
  const single = createFakeClient({
    uploadUrl: {
      assetId: 'asset-boundary-single',
      deduped: false,
      storageKey: 'keys/boundary',
      uploadUrl: 'https://upload.example.com/boundary',
    },
  });
  let singlePutCount = 0;
  const singleFetcher = (async (): Promise<Response> => {
    singlePutCount += 1;

    return new Response('', { status: 200 });
  }) as typeof fetch;

  await uploadSourcePdfAsset({
    checksum: 'sum-7a',
    documentId: 'doc-1',
    fetcher: singleFetcher,
    file: makeBlob(THRESHOLD),
    fileName: 'edge.pdf',
    pageCount: 1,
    runWithClient: single.runWithClient,
  });

  assert.equal(singlePutCount, 1);
  assert.ok(single.calls.some((call) => call.method === 'requestSourcePdfUploadUrl'));
  assert.ok(!single.calls.some((call) => call.method === 'startSourcePdfMultipart'));

  // One byte over threshold → multipart.
  const multi = createFakeClient({
    existingParts: [],
    start: { assetId: 'asset-boundary-mp', deduped: false, partSize: THRESHOLD, uploadId: 'up-edge' },
  });
  const { fetcher: multiFetcher } = createPartFetcher();

  await uploadSourcePdfAsset({
    checksum: 'sum-7b',
    documentId: 'doc-1',
    fetcher: multiFetcher,
    file: makeBlob(THRESHOLD + 1),
    fileName: 'edge.pdf',
    pageCount: 1,
    runWithClient: multi.runWithClient,
  });

  assert.ok(multi.calls.some((call) => call.method === 'startSourcePdfMultipart'));
  assert.ok(!multi.calls.some((call) => call.method === 'requestSourcePdfUploadUrl'));
});

test('checksum is passed to the upload-url request (single) and the start request (multipart)', async () => {
  const single = createFakeClient({
    uploadUrl: { assetId: 'a', deduped: true },
  });

  await uploadSourcePdfAsset({
    checksum: 'precomputed-single',
    documentId: 'doc-1',
    file: makeBlob(MB),
    fileName: 'doc.pdf',
    pageCount: 1,
    runWithClient: single.runWithClient,
  });

  const uploadUrlCall = single.calls.find((call) => call.method === 'requestSourcePdfUploadUrl');

  assert.ok(uploadUrlCall && uploadUrlCall.method === 'requestSourcePdfUploadUrl');
  assert.equal(uploadUrlCall.input.checksum, 'precomputed-single');

  const multi = createFakeClient({
    start: { assetId: 'b', deduped: true },
  });

  await uploadSourcePdfAsset({
    checksum: 'precomputed-multi',
    documentId: 'doc-1',
    file: makeBlob(40 * MB),
    fileName: 'big.pdf',
    pageCount: 1,
    runWithClient: multi.runWithClient,
  });

  const startCall = multi.calls.find((call) => call.method === 'startSourcePdfMultipart');

  assert.ok(startCall && startCall.method === 'startSourcePdfMultipart');
  assert.equal(startCall.input.checksum, 'precomputed-multi');
});

test('RESUME option: skips start, reuses the saved uploadId, skips already-sent parts', async () => {
  const { calls, runWithClient } = createFakeClient({
    // No `start` scripted — proves start is NEVER called on the resume path.
    existingParts: [{ etag: 'etag-existing-1', partNumber: 1, size: THRESHOLD }],
  });
  const { fetcher, puts } = createPartFetcher();
  const starts: unknown[] = [];

  const result = await uploadSourcePdfAsset({
    checksum: 'sum-resume-opt',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(40 * MB),
    fileName: 'big.pdf',
    onMultipartStart: (info) => starts.push(info),
    pageCount: 100,
    resume: { assetId: 'asset-resumed', partSize: THRESHOLD, uploadId: 'up-resume' },
    runWithClient,
  });

  assert.deepEqual(result, { assetId: 'asset-resumed', deduped: false });
  // start was NOT called and onMultipartStart did NOT fire (no fresh start happened).
  assert.ok(!calls.some((call) => call.method === 'startSourcePdfMultipart'));
  assert.equal(starts.length, 0);

  // The parts listing was made against the RESUMED uploadId.
  const listCall = calls.find((call) => call.method === 'listSourcePdfMultipartParts');

  assert.ok(listCall && listCall.method === 'listSourcePdfMultipartParts');
  assert.equal(listCall.params.uploadId, 'up-resume');

  // Only the missing parts (2, 3) were PUT — part 1 was skipped.
  assert.deepEqual(
    puts.map((put) => Number(put.url.split('/').pop())),
    [2, 3],
  );

  const completeCall = calls.find((call) => call.method === 'completeSourcePdfMultipart');

  assert.ok(completeCall && completeCall.method === 'completeSourcePdfMultipart');
  assert.equal(completeCall.input.uploadId, 'up-resume');
  assert.deepEqual(completeCall.input.parts, [
    { etag: 'etag-existing-1', partNumber: 1 },
    { etag: 'etag-2', partNumber: 2 },
    { etag: 'etag-3', partNumber: 3 },
  ]);
});

test('onMultipartStart fires on a fresh multipart start with the server ids', async () => {
  const { runWithClient } = createFakeClient({
    existingParts: [],
    start: { assetId: 'asset-cb', deduped: false, partSize: THRESHOLD, uploadId: 'up-cb' },
  });
  const { fetcher } = createPartFetcher();
  const starts: Array<{ assetId: string; partSize: number; uploadId: string }> = [];

  await uploadSourcePdfAsset({
    checksum: 'sum-cb',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(40 * MB),
    fileName: 'big.pdf',
    onMultipartStart: (info) => starts.push(info),
    pageCount: 100,
    runWithClient,
  });

  assert.deepEqual(starts, [{ assetId: 'asset-cb', partSize: THRESHOLD, uploadId: 'up-cb' }]);
});

test('RESUME fallback: a stale uploadId (4xx on list) restarts with a fresh start', async () => {
  const { calls, runWithClient } = createFakeClient({
    existingParts: [],
    failListPartsForUploadId: { error: new WhiteboardApiError('gone', 404, null), uploadId: 'up-stale' },
    start: { assetId: 'asset-fresh-mp', deduped: false, partSize: THRESHOLD, uploadId: 'up-fresh' },
  });
  const { fetcher, puts } = createPartFetcher();
  const starts: Array<{ assetId: string; partSize: number; uploadId: string }> = [];

  const result = await uploadSourcePdfAsset({
    checksum: 'sum-stale',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(40 * MB),
    fileName: 'big.pdf',
    onMultipartStart: (info) => starts.push(info),
    pageCount: 100,
    resume: { assetId: 'asset-stale', partSize: THRESHOLD, uploadId: 'up-stale' },
    runWithClient,
  });

  assert.deepEqual(result, { assetId: 'asset-fresh-mp', deduped: false });
  // Fell back to a fresh start and fired onMultipartStart with the NEW ids.
  assert.ok(calls.some((call) => call.method === 'startSourcePdfMultipart'));
  assert.deepEqual(starts, [{ assetId: 'asset-fresh-mp', partSize: THRESHOLD, uploadId: 'up-fresh' }]);

  // All 3 parts uploaded under the fresh upload; complete uses the fresh uploadId.
  assert.equal(puts.length, 3);

  const completeCall = calls.find((call) => call.method === 'completeSourcePdfMultipart');

  assert.ok(completeCall && completeCall.method === 'completeSourcePdfMultipart');
  assert.equal(completeCall.input.uploadId, 'up-fresh');
});

test('RESUME: a persistent 5xx on the parts listing falls back to a fresh start (no infinite loop)', async () => {
  const { calls, runWithClient } = createFakeClient({
    existingParts: [],
    // A dead-but-matching uploadId surfaces as 500 in prod — must NOT loop "continue" forever.
    failListPartsForUploadId: { error: new WhiteboardApiError('boom', 503, null), uploadId: 'up-dead' },
    start: { assetId: 'asset-after-5xx', deduped: false, partSize: THRESHOLD, uploadId: 'up-new' },
  });
  const { fetcher, puts } = createPartFetcher();
  const starts: Array<{ assetId: string; partSize: number; uploadId: string }> = [];

  const result = await uploadSourcePdfAsset({
    checksum: 'sum-5xx',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(40 * MB),
    fileName: 'big.pdf',
    onMultipartStart: (info) => starts.push(info),
    pageCount: 100,
    resume: { assetId: 'asset-dead', partSize: THRESHOLD, uploadId: 'up-dead' },
    runWithClient,
  });

  // After the bounded retry on the 5xx it fell back to a fresh start (instead of looping forever).
  assert.deepEqual(result, { assetId: 'asset-after-5xx', deduped: false });
  assert.deepEqual(starts, [{ assetId: 'asset-after-5xx', partSize: THRESHOLD, uploadId: 'up-new' }]);

  // The dead uploadId's listing was retried a bounded number of times (not once, not forever).
  const deadListCalls = calls.filter(
    (call) => call.method === 'listSourcePdfMultipartParts' && call.params.uploadId === 'up-dead',
  );

  assert.equal(deadListCalls.length, 2);

  // Then all parts uploaded under the fresh upload.
  assert.equal(puts.length, 3);

  const completeCall = calls.find((call) => call.method === 'completeSourcePdfMultipart');

  assert.ok(completeCall && completeCall.method === 'completeSourcePdfMultipart');
  assert.equal(completeCall.input.uploadId, 'up-new');
});

test('RESUME: a 409 alreadyCompleted on the parts listing adopts the assetId and does NOT re-upload', async () => {
  const { calls, runWithClient } = createFakeClient({
    // No `start` scripted — proves we never fall back to a fresh start when the asset is already done.
    failListPartsForUploadId: {
      error: new WhiteboardApiError('already completed', 409, {
        alreadyCompleted: true,
        assetId: 'asset-already-done',
      }),
      uploadId: 'up-done',
    },
  });
  const { fetcher, puts } = createPartFetcher();
  const starts: unknown[] = [];

  let lastProgress: { totalBytes: number; uploadedBytes: number } | undefined;

  const result = await uploadSourcePdfAsset({
    checksum: 'sum-already-done',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(40 * MB),
    fileName: 'big.pdf',
    onMultipartStart: (info) => starts.push(info),
    onProgress: (progress) => {
      lastProgress = { totalBytes: progress.totalBytes, uploadedBytes: progress.uploadedBytes };
    },
    pageCount: 100,
    resume: { assetId: 'asset-resumed-done', partSize: THRESHOLD, uploadId: 'up-done' },
    runWithClient,
  });

  // Adopted the server's assetId; no re-upload, no fresh start, no part PUTs, no complete.
  assert.deepEqual(result, { assetId: 'asset-already-done', deduped: false });
  assert.equal(starts.length, 0);
  assert.equal(puts.length, 0);
  assert.ok(!calls.some((call) => call.method === 'startSourcePdfMultipart'));
  assert.ok(!calls.some((call) => call.method === 'completeSourcePdfMultipart'));

  // Progress was reported as fully complete.
  assert.deepEqual(lastProgress, { totalBytes: 40 * MB, uploadedBytes: 40 * MB });

  // The listing was hit exactly once (409 is terminal-adopt, not retried).
  const listCalls = calls.filter((call) => call.method === 'listSourcePdfMultipartParts');

  assert.equal(listCalls.length, 1);
});

test('RESUME with a STALE partSize: refuses to reuse the parts and starts fresh', async () => {
  // The server owns partSize and never echoes it back in the parts listing, so a persisted value
  // saved days earlier can silently disagree with the server's current one. Reusing the parts then
  // assembles a file from correctly-NUMBERED parts holding the WRONG bytes — the boundaries moved.
  // The saved partSize here is 16MB; the server's listing reports 8MB parts, so it must restart.
  const { calls, runWithClient } = createFakeClient({
    existingParts: [
      { etag: 'etag-old-1', partNumber: 1, size: 8 * MB },
      { etag: 'etag-old-2', partNumber: 2, size: 8 * MB },
    ],
    start: { assetId: 'asset-restarted', deduped: false, partSize: THRESHOLD, uploadId: 'up-fresh' },
  });
  const { fetcher, puts } = createPartFetcher();
  const starts: unknown[] = [];

  const result = await uploadSourcePdfAsset({
    checksum: 'sum-stale-partsize',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(40 * MB),
    fileName: 'big.pdf',
    onMultipartStart: (info) => starts.push(info),
    pageCount: 100,
    resume: { assetId: 'asset-stale-size', partSize: THRESHOLD, uploadId: 'up-stale-size' },
    runWithClient,
  });

  // Fell back to a fresh upload rather than adopting the mismatched parts.
  assert.deepEqual(result, { assetId: 'asset-restarted', deduped: false });
  assert.ok(calls.some((call) => call.method === 'startSourcePdfMultipart'));
  assert.equal(starts.length, 1, 'a fresh start must re-publish resume info');

  // Every part was re-PUT — none of the 8MB parts was salvaged.
  assert.deepEqual(
    puts.map((put) => Number(put.url.split('/').pop())),
    [1, 2, 3],
  );

  const completeCall = calls.find((call) => call.method === 'completeSourcePdfMultipart');

  assert.ok(completeCall && completeCall.method === 'completeSourcePdfMultipart');
  assert.equal(completeCall.input.uploadId, 'up-fresh', 'must complete against the FRESH uploadId');
  assert.ok(
    completeCall.input.parts.every((part) => !part.etag.startsWith('etag-old-')),
    'no part from the stale upload may survive into complete',
  );
});

test('RESUME with an EMPTY parts listing: starts fresh rather than trusting an unverifiable partSize', async () => {
  // An empty listing after a long gap is expected (the provider expired the parts). There is
  // nothing to salvage and nothing to verify partSize against, so a fresh start costs no re-upload
  // and avoids reusing a number we cannot check.
  const { calls, runWithClient } = createFakeClient({
    existingParts: [],
    start: { assetId: 'asset-empty-restart', deduped: false, partSize: THRESHOLD, uploadId: 'up-fresh-2' },
  });
  const { fetcher, puts } = createPartFetcher();

  const result = await uploadSourcePdfAsset({
    checksum: 'sum-empty-parts',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(40 * MB),
    fileName: 'big.pdf',
    pageCount: 100,
    resume: { assetId: 'asset-empty', partSize: THRESHOLD, uploadId: 'up-empty' },
    runWithClient,
  });

  assert.deepEqual(result, { assetId: 'asset-empty-restart', deduped: false });
  assert.ok(calls.some((call) => call.method === 'startSourcePdfMultipart'));
  assert.deepEqual(
    puts.map((put) => Number(put.url.split('/').pop())),
    [1, 2, 3],
  );
});

test('RESUME with a MATCHING partSize still reuses parts — the guard must not break the happy path', async () => {
  const { calls, runWithClient } = createFakeClient({
    existingParts: [
      { etag: 'etag-keep-1', partNumber: 1, size: THRESHOLD },
      { etag: 'etag-keep-2', partNumber: 2, size: THRESHOLD },
    ],
  });
  const { fetcher, puts } = createPartFetcher();

  const result = await uploadSourcePdfAsset({
    checksum: 'sum-matching',
    documentId: 'doc-1',
    fetcher,
    file: makeBlob(40 * MB),
    fileName: 'big.pdf',
    pageCount: 100,
    resume: { assetId: 'asset-match', partSize: THRESHOLD, uploadId: 'up-match' },
    runWithClient,
  });

  assert.deepEqual(result, { assetId: 'asset-match', deduped: false });
  assert.ok(!calls.some((call) => call.method === 'startSourcePdfMultipart'), 'must NOT restart');
  // Only part 3 was missing.
  assert.deepEqual(
    puts.map((put) => Number(put.url.split('/').pop())),
    [3],
  );
});
