/**
 * FE↔BE acceptance pass for whiteboard lossless-sync P1 (draft snapshot ring).
 * Drives the REAL WhiteboardApiClient against a live backend.
 *
 * Run:
 *   WB_API_KEY=wb_<64hex> WB_API_BASE=http://localhost:5000 \
 *     node --import tsx packages/whiteboard-core/scripts/acceptance-p1.mts
 *
 * Exits non-zero if any scenario fails. Cleans up the test document at the end.
 */
import { WhiteboardApiClient } from '../src/remote/client';
import { createWhiteboardRawDataBlob } from '../src/remote/raw-data';
import { uploadToWhiteboardPresignedUrl } from '../src/remote/upload';

import type { WhiteboardDocument, WhiteboardPage } from '../src/types';

const API_KEY = process.env.WB_API_KEY ?? '';
const API_BASE = process.env.WB_API_BASE ?? '';

if (!API_KEY || !API_BASE) {
  console.error('Set WB_API_KEY and WB_API_BASE env vars.');
  process.exit(2);
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function makeDoc(id: string, n: number): WhiteboardDocument {
  const page: WhiteboardPage = {
    id: `p-${n}`,
    canvasJSON: JSON.stringify({ version: '6', objects: [{ note: `rev-${n}` }] }),
    thumbnail: '',
    backgroundType: 'blank',
  };

  return {
    id,
    title: `acceptance-${n}`,
    pages: [page],
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: n,
    thumbnail: '',
    schemaVersion: 2,
  };
}

/** Full upload→append cycle, mirroring the syncer engine's drain. */
async function appendSnapshot(
  client: WhiteboardApiClient,
  documentId: string,
  rev: number,
  deviceId: string,
  baseSeq: number | null,
) {
  const { uploadUrl, storageKey, publicUrl } = await client.requestDraftSnapshotUploadUrl(documentId);
  const { blob, contentType } = await createWhiteboardRawDataBlob(makeDoc(documentId, rev), { gzip: true });

  await uploadToWhiteboardPresignedUrl({ uploadUrl, body: blob, contentType });

  return client.appendDraftSnapshot(documentId, {
    storageKey,
    rawDataUrl: publicUrl,
    pageCount: 1,
    thumbnail: null,
    title: `acceptance-${rev}`,
    deviceId,
    baseSeq,
    fileSize: blob.size,
  });
}

async function main() {
  const client = new WhiteboardApiClient({ apiKey: API_KEY, baseUrl: API_BASE });
  const created = await client.createDocument({ title: 'acceptance-p1' });
  const documentId = created._id;
  console.log(`\nTest document: ${documentId}\n`);

  try {
    // S1 — sequential appends from device A: gap-free seq 1,2,3, never diverged.
    const seqs: number[] = [];
    let cursorA: number | null = null;
    for (let i = 1; i <= 3; i++) {
      const r = await appendSnapshot(client, documentId, i, 'device-A', cursorA);
      seqs.push(r.seq);
      cursorA = r.seq;
      if (r.diverged) check(`S1 append ${i} not diverged`, false, `unexpected diverged at seq ${r.seq}`);
    }
    check(
      'S1 gap-free sequential seq',
      JSON.stringify(seqs) === JSON.stringify([1, 2, 3]),
      `got ${JSON.stringify(seqs)}`,
    );

    // S2 — device B appends with a STALE baseSeq (1) → diverged:true + otherBranch = pre-append latest (device A, seq 3).
    const div = await appendSnapshot(client, documentId, 4, 'device-B', 1);
    check('S2 diverged flag true', div.diverged === true, `diverged=${div.diverged}`);
    check(
      'S2 otherBranch is the pre-append latest (device-A)',
      !!div.otherBranch && div.otherBranch.deviceId === 'device-A' && div.otherBranch.seq === 3,
      `otherBranch=${JSON.stringify(div.otherBranch)}`,
    );

    // S3 — list newest-first.
    const listed = await client.listDraftSnapshots(documentId, { limit: 20 });
    const listSeqs = listed.snapshots.map((s) => s.seq);
    const descending = listSeqs.every((s, i) => i === 0 || listSeqs[i - 1] > s);
    check('S3 list newest-first', descending && listSeqs[0] === div.seq, `seqs=${JSON.stringify(listSeqs)}`);

    // S4 — ring cap: drive total appends well past 20, then assert exactly newest 20 retained.
    let cursor = div.seq;
    for (let i = 5; i <= 25; i++) {
      const r = await appendSnapshot(client, documentId, i, 'device-A', cursor);
      cursor = r.seq;
    }
    const afterCap = await client.listDraftSnapshots(documentId, { limit: 50 });
    const capSeqs = afterCap.snapshots.map((s) => s.seq);
    const newestSeq = Math.max(...capSeqs);
    const oldestSeq = Math.min(...capSeqs);
    check('S4 ring capped at 20', capSeqs.length === 20, `retained ${capSeqs.length}`);
    check(
      'S4 newest retained, oldest pruned',
      newestSeq === cursor && oldestSeq === cursor - 19,
      `newest=${newestSeq} oldest=${oldestSeq} (expected ${cursor}..${cursor - 19})`,
    );
  } finally {
    await client.deleteDocument(documentId).catch((e) => console.warn('cleanup failed:', e?.message));
    console.log(`\nCleaned up ${documentId}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.error('FAILED:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
  console.log('ACCEPTANCE PASS ✅');
}

main().catch((e) => {
  console.error('Acceptance run threw:', e);
  process.exit(1);
});
