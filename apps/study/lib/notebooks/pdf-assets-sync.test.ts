import type { WhiteboardPdfAsset, WhiteboardStorage } from '@repo/whiteboard-core';

import assert from 'node:assert/strict';
import test from 'node:test';

import { pdfAssetIdsOf, queuePdfAssetUpload, restorePdfAssetFromServer, setPdfAssetSyncEnv } from './pdf-assets-sync';

import { StudyApiError } from '@/lib/api/errors';

function memoryStore() {
  const map = new Map<string, string>();

  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

function fakeStorage(ids: string[]): WhiteboardStorage {
  const assets = new Map(ids.map((id) => [id, { id, blob: new Blob([`%PDF-${id}`]) } as unknown as WhiteboardPdfAsset]));

  return { loadPdfAsset: async (id: string) => assets.get(id) ?? null } as unknown as WhiteboardStorage;
}

test('pdfAssetIdsOf: distinct, non-empty ids in page order', () => {
  const pages = [{ pdfAssetId: 'a' }, { pdfAssetId: 'a' }, {}, { pdfAssetId: ' ' }, { pdfAssetId: 'b' }];

  assert.deepEqual(pdfAssetIdsOf({ pages } as never), ['a', 'b']);
  assert.deepEqual(pdfAssetIdsOf(null), []);
});

test('uploads only what the server lacks, one at a time, and remembers it per server + account', async () => {
  const store = memoryStore();
  const puts: string[] = [];
  let inFlight = 0;
  let lists = 0;

  setPdfAssetSyncEnv({
    store,
    scope: () => 'https://srv|u1',
    isDemo: () => false,
    listPresent: async (_page, ids) => {
      lists++;

      return ids.filter((id) => id === 'a');
    },
    put: async (_page, id) => {
      inFlight++;
      assert.equal(inFlight, 1);
      await new Promise((r) => setTimeout(r, 5));
      puts.push(id);
      inFlight--;
    },
  });
  const storage = fakeStorage(['a', 'b', 'c']);

  // 'gone' is not on this device: nothing to send.
  void queuePdfAssetUpload('p1', ['a', 'b'], storage);
  await queuePdfAssetUpload('p2', ['c', 'gone'], storage);
  assert.deepEqual(puts, ['b', 'c']);
  assert.ok(store.map.has('study_pdf_up|https://srv|u1|a'));
  assert.ok(store.map.has('study_pdf_up|https://srv|u1|b'));

  // Next save: everything known, no server call at all.
  lists = 0;
  await queuePdfAssetUpload('p1', ['a', 'b'], storage);
  assert.equal(lists, 0);
  setPdfAssetSyncEnv(null);
});

test('a failed upload is retried on the next save; demo mode and a server without the routes send nothing', async () => {
  const store = memoryStore();
  let fail = true;
  const puts: string[] = [];
  let demo = false;
  let lists = 0;

  setPdfAssetSyncEnv({
    store,
    scope: () => 's|u',
    isDemo: () => demo,
    listPresent: async () => {
      lists++;

      return [];
    },
    put: async (_page, id) => {
      if (fail) throw new TypeError('Failed to fetch');
      puts.push(id);
    },
  });
  const storage = fakeStorage(['x']);

  await queuePdfAssetUpload('p', ['x'], storage);
  assert.deepEqual(puts, []);
  fail = false;
  await queuePdfAssetUpload('p', ['x'], storage);
  assert.deepEqual(puts, ['x']);

  demo = true;
  lists = 0;
  await queuePdfAssetUpload('p', ['y'], fakeStorage(['y']));
  assert.equal(lists, 0);

  // Express's own 404 (no code): this server has no PDF routes → stop asking.
  demo = false;
  setPdfAssetSyncEnv({
    store,
    scope: () => 's|u',
    isDemo: () => false,
    listPresent: async () => {
      lists++;
      throw new StudyApiError(404, 'Cannot GET');
    },
  });
  lists = 0;
  await queuePdfAssetUpload('p', ['z'], fakeStorage(['z']));
  await queuePdfAssetUpload('p', ['z2'], fakeStorage(['z2']));
  assert.equal(lists, 1);
  setPdfAssetSyncEnv(null);
});

test('a file the server refuses for good (too big, not a PDF) is never resent', async () => {
  const store = memoryStore();
  const tries: string[] = [];

  setPdfAssetSyncEnv({
    store,
    scope: () => 's|u',
    isDemo: () => false,
    listPresent: async () => [],
    put: async (_page, id) => {
      tries.push(id);
      if (id === 'huge') throw new StudyApiError(413, 'request entity too large');
    },
  });
  const storage = fakeStorage(['huge', 'ok']);

  await queuePdfAssetUpload('p', ['huge', 'ok'], storage);
  await queuePdfAssetUpload('p', ['huge', 'ok'], storage);
  assert.deepEqual(tries, ['huge', 'ok']);
  assert.equal(store.map.get('study_pdf_up|s|u|huge'), 'skip');
  setPdfAssetSyncEnv(null);
});

test('restore from the server: stores from the signed url; false when missing, failing or demo', async () => {
  const restored: string[] = [];
  const restore = async (url: string) => void restored.push(url);

  assert.equal(await restorePdfAssetFromServer(async () => ({ url: 'https://signed/x' }), restore, false), true);
  assert.deepEqual(restored, ['https://signed/x']);
  assert.equal(
    await restorePdfAssetFromServer(async () => Promise.reject(new StudyApiError(404, 'gone', 'NOT_FOUND')), restore, false),
    false,
  );
  assert.equal(await restorePdfAssetFromServer(async () => ({ url: 'u' }), restore, true), false);
  assert.equal(restored.length, 1);
});
