// One-time move of every notebook PDF on this device to a server account: reads the board storage's
// PDF store directly (no page needed) and PUTs each file to `/study/pdf-assets/<assetId>` (the
// account's store, the same one the page routes read). Exposed as
// `window.__syllabiUploadAllPdfAssets(apiBase?, token?)` for a devtools console; with no arguments it
// uses this app's server and session. An older install without this code runs the same steps as a
// pasted snippet (kept outside the repo); keep the two in step.
import { readSessionToken } from '@/lib/auth';
import { getBackendSettingsSnapshot } from '@/lib/backend-settings';

/** Board storage names (packages/whiteboard-core/src/storage/indexeddb.ts); unchanged since PDFs were added. */
export const BOARD_DB_NAME = 'whiteboard-store';
export const PDF_ASSETS_STORE = 'pdfAssets';

export interface PdfMigrationReport {
  total: number;
  uploaded: string[];
  alreadyThere: string[];
  failed: { id: string; error: string }[];
}

/** `https://host` or `https://host/study` → `https://host/study`. */
export const studyApiBase = (apiBase: string) => `${apiBase.trim().replace(/\/+$/, '').replace(/\/study$/, '')}/study`;

function openBoardDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // No version: never upgrades (and never fights the app's own connection).
    const request = indexedDB.open(BOARD_DB_NAME);

    // Only fires when the database does not exist: do not create an empty one.
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('No notebook storage on this device'));
  });
}

function read<T>(db: IDBDatabase, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(PDF_ASSETS_STORE, 'readonly').objectStore(PDF_ASSETS_STORE));

    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}

/** The file of one stored asset row (`blob`; raw bytes tolerated). */
function assetBlob(row: unknown): Blob | null {
  const r = row as { blob?: unknown; data?: unknown } | null;

  if (r?.blob instanceof Blob) return r.blob;
  if (r?.data instanceof ArrayBuffer || ArrayBuffer.isView(r?.data)) return new Blob([r.data as BlobPart], { type: 'application/pdf' });

  return null;
}

export async function uploadAllLocalPdfAssets(
  apiBase: string = getBackendSettingsSnapshot().backendUrl,
  token: string | null = readSessionToken(),
  log: (line: string) => void = (line) => console.info(`[pdf upload] ${line}`), // eslint-disable-line no-console
): Promise<PdfMigrationReport> {
  if (!apiBase) throw new Error('No server address');
  if (!token) throw new Error('No sign-in token');
  const base = studyApiBase(apiBase);
  const auth = { Authorization: `Bearer ${token}` };
  const db = await openBoardDb();
  const report: PdfMigrationReport = { total: 0, uploaded: [], alreadyThere: [], failed: [] };

  try {
    if (!db.objectStoreNames.contains(PDF_ASSETS_STORE)) return report;
    const ids = (await read<IDBValidKey[]>(db, (store) => store.getAllKeys())).map(String);

    report.total = ids.length;
    log(`${ids.length} PDF(s) on this device`);
    const present = new Set<string>();

    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100).filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id));

      if (!chunk.length) continue;
      const res = await fetch(`${base}/pdf-assets?ids=${chunk.map(encodeURIComponent).join(',')}`, { headers: auth });

      if (res.status === 401) throw new Error('The token was refused (sign in again on the new app and copy a fresh one)');
      if (!res.ok) throw new Error(`The server said ${res.status} — does it have PDF sync yet?`);
      for (const id of ((await res.json()) as { present?: string[] }).present ?? []) present.add(id);
    }

    for (const id of ids) {
      if (present.has(id)) {
        report.alreadyThere.push(id);
        continue;
      }
      try {
        // Own short transaction per row; the network call runs after it has finished.
        const row = await read<unknown>(db, (store) => store.get(id));
        const blob = assetBlob(row);

        if (!blob) throw new Error('no file in this row');
        const res = await fetch(`${base}/pdf-assets/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { ...auth, 'Content-Type': 'application/pdf' },
          body: blob,
        });

        if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
        report.uploaded.push(id);
        log(`sent ${(row as { fileName?: string }).fileName ?? id} (${Math.round(blob.size / 1024)} KB)`);
      } catch (error) {
        report.failed.push({ id, error: error instanceof Error ? error.message : String(error) });
        log(`FAILED ${id}: ${report.failed[report.failed.length - 1].error}`);
      }
    }
  } finally {
    db.close();
  }
  log(`done: ${report.uploaded.length} sent, ${report.alreadyThere.length} already there, ${report.failed.length} failed`);

  return report;
}

/** `window.__syllabiUploadAllPdfAssets(apiBase?, token?)` — installed once by the app shell. */
export function installPdfAssetMigrationHelper(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__syllabiUploadAllPdfAssets = (apiBase?: string, token?: string) =>
    uploadAllLocalPdfAssets(apiBase || undefined, token || undefined);
}
