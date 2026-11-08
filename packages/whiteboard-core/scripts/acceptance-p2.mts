/**
 * FE↔BE acceptance pass for whiteboard lossless-sync P2 (large-PDF: multipart + dedup).
 * Drives the REAL uploadSourcePdfAsset against a live backend.
 *
 * Run:
 *   WB_API_KEY=wb_<64hex> WB_API_BASE=http://localhost:5000 \
 *     node --import tsx packages/whiteboard-core/scripts/acceptance-p2.mts
 */
import { WhiteboardApiClient } from '../src/remote/client';
import { uploadSourcePdfAsset } from '../src/remote/source-pdf-upload';

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

/** A blob of `size` bytes whose first bytes carry a unique marker (so checksum differs per run). */
function markedBlob(size: number, marker: string): Blob {
  const buf = new Uint8Array(size);
  const enc = new TextEncoder().encode(marker);
  buf.set(enc.subarray(0, Math.min(enc.length, size)), 0);

  return new Blob([buf], { type: 'application/pdf' });
}

async function main() {
  const client = new WhiteboardApiClient({ apiKey: API_KEY, baseUrl: API_BASE });
  const runWithClient = <T,>(fn: (c: WhiteboardApiClient) => Promise<T>) => fn(client);
  const created = await client.createDocument({ title: 'acceptance-p2' });
  const documentId = created._id;
  const marker = `p2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const assetsToClean = new Set<string>();
  console.log(`\nTest document: ${documentId}\n`);

  try {
    // M1 — multipart (>16MB): 20MB → 2 parts (16 + 4).
    const big = markedBlob(20 * 1024 * 1024, `${marker}-big`);
    let maxParts = 0;
    const up1 = await uploadSourcePdfAsset({
      runWithClient,
      documentId,
      file: big,
      fileName: 'big.pdf',
      pageCount: 50,
      onProgress: (p) => {
        if (p.totalParts) maxParts = Math.max(maxParts, p.totalParts);
      },
    });
    assetsToClean.add(up1.assetId);
    check(
      'M1 multipart fresh upload',
      up1.deduped === false && !!up1.assetId,
      `assetId=${up1.assetId} deduped=${up1.deduped}`,
    );
    check('M1 used multipart (>=2 parts)', maxParts >= 2, `totalParts=${maxParts}`);

    // M2 — re-upload identical 20MB blob → deduped, same asset, zero bytes.
    const up2 = await uploadSourcePdfAsset({
      runWithClient,
      documentId,
      file: big,
      fileName: 'big.pdf',
      pageCount: 50,
    });
    check(
      'M2 dedup on re-upload',
      up2.deduped === true && up2.assetId === up1.assetId,
      `deduped=${up2.deduped} assetId=${up2.assetId}`,
    );

    // S1 — single-PUT (<=16MB): 2MB fresh.
    const small = markedBlob(2 * 1024 * 1024, `${marker}-small`);
    const up3 = await uploadSourcePdfAsset({
      runWithClient,
      documentId,
      file: small,
      fileName: 'small.pdf',
      pageCount: 3,
    });
    assetsToClean.add(up3.assetId);
    check('S1 single-PUT fresh upload', up3.deduped === false && !!up3.assetId, `assetId=${up3.assetId}`);

    // S2 — re-upload identical small blob → deduped.
    const up4 = await uploadSourcePdfAsset({
      runWithClient,
      documentId,
      file: small,
      fileName: 'small.pdf',
      pageCount: 3,
    });
    check('S2 single-PUT dedup', up4.deduped === true && up4.assetId === up3.assetId, `deduped=${up4.deduped}`);

    // L1 — both confirmed assets are listed.
    const list = await client.listSourcePdfs(documentId);
    const confirmed = list.filter((a) => a.status === 'confirmed' || a.status === undefined);
    check('L1 both assets confirmed + listed', confirmed.length >= 2, `count=${list.length}`);
  } finally {
    for (const assetId of assetsToClean) {
      await client
        .deleteSourcePdf(documentId, assetId, { force: true })
        .catch((e) => console.warn('asset cleanup:', e?.message));
    }
    await client.deleteDocument(documentId).catch((e) => console.warn('doc cleanup:', e?.message));
    console.log(`\nCleaned up ${documentId}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.error('FAILED:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
  console.log('P2 ACCEPTANCE PASS ✅');
}

main().catch((e) => {
  console.error('Acceptance run threw:', e);
  process.exit(1);
});
