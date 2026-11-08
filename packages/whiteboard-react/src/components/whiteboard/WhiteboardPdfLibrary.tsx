import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Card, CardBody, Chip, Pagination, Progress, Spinner } from '@repo/ui';
import { createWhiteboardId, uploadSourcePdfAsset, WhiteboardApiError } from '@repo/whiteboard-core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, FileText, RefreshCw, Trash2, Upload, X } from 'lucide-react';

import { describeGenerateConflict, describeReadyDownload } from './utils/mergeDownloadMessages';
import { inspectPdfFile } from './utils/pdfAssetRenderer';
import { WbLocaleProvider, useWbStrings, type WbStrings } from '../../i18n/context';
import { wbIntlLocale, wbT, type WbLocale, type WbStringKey } from '../../i18n/strings';

import type { HeroUIColor } from '@repo/ui';
import type {
  SourcePdfUploadProgress,
  WhiteboardApiRequestAccess,
  VersionJobStatus,
  WhiteboardApiClient,
  WhiteboardApiDocument,
  WhiteboardApiDocumentDetails,
  WhiteboardMultipartResumeInfo,
} from '@repo/whiteboard-core';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WhiteboardPdfLibraryProps {
  /** Already-constructed API client (the host app owns auth: board key OR token authHeaders). */
  client: WhiteboardApiClient;
  /** Optional context line shown in the header — e.g. admin acting on behalf of a teacher. */
  teacherLabel?: string;
  /** Surfaces any background failure (upload / list / generate) to the host app. */
  onError?: (error: unknown) => void;
  /** Optional portal root for overlays (reserved — this version renders no modals). */
  portalContainer?: HTMLElement | null;
  /** Kept for host compatibility; the library UI is English-only. */
  locale?: WbLocale;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCUMENTS_PAGE_LIMIT = 12;
const DOCUMENTS_QUERY_KEY = 'whiteboard-pdf-library-documents';

// Server-merge job poll cadence — mirrors the board's pollMergeJob: ~1.5s easing toward 5s, ~2min cap.
const VERSION_JOB_POLL_INTERVAL_MS = 1500;
const VERSION_JOB_POLL_MAX_INTERVAL_MS = 5000;
const VERSION_JOB_POLL_TIMEOUT_MS = 120000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UploadPhase = 'canceled' | 'creating' | 'deduped' | 'done' | 'error' | 'inspecting' | 'queued' | 'uploading';

// One file in the bulk-upload queue. `documentId`/`pageCount` persist across retries so a "continue"
// resumes (skips re-create + re-inspect) and the resumable multipart upload picks up its parts.
interface UploadTask {
  documentId: string | null;
  errorMessage: string;
  file: File;
  fileName: string;
  id: string;
  // Multipart resume ids (>16MB uploads), captured on the first start so "continue" skips already-sent
  // parts instead of restarting. null for single-PUT uploads or before the first multipart start.
  multipart: WhiteboardMultipartResumeInfo | null;
  pageCount: number | null;
  phase: UploadPhase;
  totalBytes: number;
  uploadedBytes: number;
}

const ACTIVE_UPLOAD_PHASES: ReadonlySet<UploadPhase> = new Set<UploadPhase>([
  'queued',
  'inspecting',
  'creating',
  'uploading',
]);

const TERMINAL_UPLOAD_PHASES: ReadonlySet<UploadPhase> = new Set<UploadPhase>(['done', 'deduped']);

type DocAction =
  | { phase: 'downloading'; message: string }
  | { phase: 'error'; message: string }
  | { phase: 'generating'; message: string }
  /** `note`: what the file IS when it is not a fresh merge (the last publish, the clean source PDF). */
  | { phase: 'ready'; url: string; versionNumber?: number; note?: string };

type MergeStatus = 'done' | 'failed' | 'none' | 'processing' | 'queued' | 'rendering';

interface MergeBadge {
  color: HeroUIColor;
  label: WbStringKey;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type T = WbStrings['t'];

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
  year: 'numeric',
};

const MERGE_STATUS_BADGE: Record<MergeStatus, MergeBadge> = {
  done: { color: 'success', label: 'pdflib.badge.done' },
  failed: { color: 'danger', label: 'pdflib.badge.failed' },
  none: { color: 'default', label: 'pdflib.badge.none' },
  processing: { color: 'primary', label: 'pdflib.badge.merging' },
  queued: { color: 'warning', label: 'pdflib.badge.queued' },
  rendering: { color: 'primary', label: 'pdflib.badge.merging' },
};

function resolveMergeBadge(status: string | undefined): MergeBadge {
  return MERGE_STATUS_BADGE[(status ?? 'none') as MergeStatus] ?? MERGE_STATUS_BADGE.none;
}

function formatDateTime(value: string | undefined, locale: WbLocale): string {
  if (!value) {
    return '';
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return '';
  }

  return new Intl.DateTimeFormat(wbIntlLocale(locale), DATE_TIME_OPTIONS).format(new Date(timestamp));
}

function formatBytes(bytes: number, t: T): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return t('pdflib.bytes0');
  }

  if (bytes < 1024) {
    return t('pdflib.bytesB', { n: Math.round(bytes) });
  }

  if (bytes < 1024 * 1024) {
    return t('pdflib.bytesKB', { n: (bytes / 1024).toFixed(1) });
  }

  return t('pdflib.bytesMB', { n: (bytes / (1024 * 1024)).toFixed(1) });
}

function deriveTitleFromFileName(fileName: string, t: T): string {
  const base = fileName.replace(/\.pdf$/i, '').trim();

  return base || t('pdflib.defaultTitle');
}

function uploadTaskPercent(task: UploadTask): number {
  return task.totalBytes > 0 ? Math.min(100, Math.round((task.uploadedBytes / task.totalBytes) * 100)) : 0;
}

function uploadTaskStatusText(task: UploadTask, t: T): string {
  switch (task.phase) {
    case 'queued':
      return t('pdflib.task.queued');
    case 'inspecting':
      return t('pdflib.task.inspecting');
    case 'creating':
      return t('pdflib.task.creating');
    case 'uploading':
      return t('pdflib.task.progress', { done: formatBytes(task.uploadedBytes, t), total: formatBytes(task.totalBytes, t) });
    case 'done':
      return t('pdflib.task.done');
    case 'deduped':
      return t('pdflib.task.deduped');
    case 'canceled':
      return t('pdflib.task.canceled');
    case 'error':
      return task.errorMessage || t('pdflib.task.error');
    default:
      return '';
  }
}

function buildDownloadFileName(title: string, versionNumber?: number): string {
  const safe = (title || 'whiteboard').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'whiteboard';

  return versionNumber ? `${safe}-v${versionNumber}.pdf` : `${safe}.pdf`;
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'name' in error && (error as { name?: string }).name === 'AbortError',
  );
}

function toDisplayError(error: unknown, fallback = wbT('en', 'pdflib.unexpected')): string {
  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (error instanceof WhiteboardApiError) {
    return error.message || fallback;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

/**
 * True when `url` is served by our own API rather than by object storage.
 *
 * The merged PDF is one or the other depending on the environment — production uploads it to
 * a Backblaze bucket and hands back a bucket URL, development writes it to the API's own
 * static mount — and this component runs in four apps against both. So the origin is measured,
 * never assumed.
 */
function isApiUrl(url: string, apiOrigin: string): boolean {
  if (!/^https?:\/\//i.test(url)) {
    return true;
  }

  try {
    return new URL(url).origin === apiOrigin;
  } catch {
    return false;
  }
}

/**
 * Save a merged PDF to disk.
 *
 * Pointing an anchor at the merged `pdfUrl` never saved anything: the `download` attribute is
 * **silently ignored cross-origin**, so the click merely navigated to the PDF. (`window.open` is
 * no better; it is popup-blocked once the async generate+poll has spent the user gesture.) So we
 * fetch the bytes ourselves and hand the browser a blob URL, which IS same-origin, and there the
 * attribute is honoured.
 *
 * Which fetch does it is decided by where the URL points, and both directions matter:
 *  - **our API** — the route is auth-guarded, so the client's headers must ride along or it 401s;
 *  - **object storage** — a plain credential-less `GET`. Attaching the auth header there would
 *    mail the host app's token to Backblaze AND force a preflight the bucket answers without
 *    `Access-Control-Allow-Headers`, killing the download for a reason that looks nothing like
 *    its cause.
 *
 * The component stays auth-agnostic through all of this: it asks the client it was handed for the
 * origin and headers, and never learns what kind of credential they are.
 */
async function saveRemotePdf(url: string, fileName: string, access: WhiteboardApiRequestAccess, t: T): Promise<void> {
  if (typeof document === 'undefined') {
    return;
  }

  const response = isApiUrl(url, access.apiOrigin)
    ? await fetch(url, { headers: access.headers })
    : await fetch(url, { credentials: 'omit' });

  if (!response.ok) {
    throw new Error(t('pdflib.downloadStatus', { status: response.status }));
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  // Revoking synchronously can cancel the save (Safari most reliably) — one frame is enough for
  // the click to have been consumed.
  requestAnimationFrame(() => URL.revokeObjectURL(objectUrl));
}

/**
 * Poll a server-merge generate job to a terminal state. Backs off from ~1.5s toward 5s, tolerates
 * transient poll errors (the backend job keeps running), is abortable, and times out at ~2 minutes —
 * returning a synthetic `failed` status rather than throwing so the caller surfaces one message.
 */
async function pollVersionJob(
  client: WhiteboardApiClient,
  documentId: string,
  jobId: string,
  isAborted: () => boolean,
  t: T,
): Promise<VersionJobStatus> {
  const deadline = Date.now() + VERSION_JOB_POLL_TIMEOUT_MS;
  let intervalMs = VERSION_JOB_POLL_INTERVAL_MS;

  for (;;) {
    if (isAborted()) {
      return { status: 'failed', error: t('pdflib.canceled') };
    }

    try {
      const status = await client.getVersionJob(documentId, jobId);

      if (status.status === 'done' || status.status === 'failed') {
        return status;
      }
    } catch {
      // Transient poll error (network blip / 5xx) — keep polling until the deadline.
    }

    if (Date.now() >= deadline) {
      return { status: 'failed', error: t('pdflib.timeout') };
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
    intervalMs = Math.min(Math.round(intervalMs * 1.25), VERSION_JOB_POLL_MAX_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Document row (memoized — only the row whose doc/action changed re-renders)
// ---------------------------------------------------------------------------

interface DocumentRowProps {
  action: DocAction | undefined;
  document: WhiteboardApiDocument;
  onDownload: (document: WhiteboardApiDocument) => void;
}

const DocumentRow = React.memo(function DocumentRow({ action, document, onDownload }: DocumentRowProps) {
  const { t, locale } = useWbStrings();
  const merged = document.mergedPdf;
  const badge = resolveMergeBadge(action?.phase === 'ready' ? 'done' : merged?.status);
  const isGenerating = action?.phase === 'generating';
  const isDownloading = action?.phase === 'downloading';
  // Fetching a large merged PDF takes a while and shows no browser progress, so the button locks
  // for the whole round trip — a second click would start a second fetch of the same file.
  const isBusy = isGenerating || isDownloading;
  // The server already has a merge job running for this doc — clicking RESUMES it (awaits + downloads)
  // rather than re-triggering (which 409s). Keep the button enabled so the teacher can pick it up.
  const serverInProgress = !isBusy && (merged?.status === 'queued' || merged?.status === 'rendering');
  // A download is available either from a freshly-generated version (this session) or a stored merge.
  const readyUrl = action?.phase === 'ready' ? action.url : merged?.status === 'done' ? merged.pdfUrl : undefined;
  const readyVersionNumber = action?.phase === 'ready' ? action.versionNumber : merged?.versionNumber;
  const readyNote = action?.phase === 'ready' ? action.note : undefined;
  // `latestVersion` only ships on the details endpoint, but surface it defensively when a backend
  // includes it on the list rows; otherwise fall back to the document's currentVersion.
  const latestVersion = (document as Partial<WhiteboardApiDocumentDetails>).latestVersion;
  const generatedAt = formatDateTime(merged?.generatedAt, locale);

  const handlePress = useCallback(() => {
    onDownload(document);
  }, [document, onDownload]);

  return (
    <Card className='w-full' shadow='sm'>
      <CardBody className='flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between'>
        <div className='flex min-w-0 items-start gap-3'>
          <span className='bg-default-100 text-default-500 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg'>
            <FileText className='h-5 w-5' />
          </span>
          <div className='min-w-0'>
            <p className='text-foreground truncate text-sm font-bold'>{document.title || t('pdflib.untitled')}</p>
            <div className='text-default-500 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs'>
              {document.pageCount > 0 ? <span>{t('pdflib.pages', { n: document.pageCount })}</span> : null}
              {document.currentVersion > 0 ? <span>{t('pdflib.currentVersion', { n: document.currentVersion })}</span> : null}
              {latestVersion?.versionNumber ? <span>{t('pdflib.latestVersion', { n: latestVersion.versionNumber })}</span> : null}
              <span>{t('pdflib.lastUpdated', { date: formatDateTime(document.updatedAt, locale) || t('pdflib.notAvailable') })}</span>
            </div>
            {readyNote || readyVersionNumber || generatedAt ? (
              <p className='text-default-400 mt-1 text-xs'>
                {readyNote ?? (readyVersionNumber ? t('pdflib.mergedN', { n: readyVersionNumber }) : t('pdflib.merged'))}
                {generatedAt ? ` • ${generatedAt}` : ''}
              </p>
            ) : null}
          </div>
        </div>

        <div className='flex shrink-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center'>
          <Chip color={badge.color} size='sm' variant='flat'>
            {t(badge.label)}
          </Chip>
          <Button
            color={readyUrl ? 'success' : 'primary'}
            isDisabled={isBusy}
            isLoading={isBusy}
            size='sm'
            startContent={isBusy ? undefined : <Download className='h-4 w-4' />}
            variant='flat'
            onPress={handlePress}
          >
            {isDownloading
              ? t('pdflib.downloading')
              : isGenerating
                ? t('pdflib.preparing')
                : readyUrl
                  ? readyNote
                    ? t('pdflib.downloadPdf')
                    : t('pdflib.downloadUpdated')
                  : serverInProgress
                    ? t('pdflib.resumeMerge')
                    : t('pdflib.createDownload')}
          </Button>
        </div>
      </CardBody>

      {(action?.phase === 'generating' || action?.phase === 'downloading') && action.message ? (
        <div className='text-default-500 border-default-100 border-t px-4 py-2 text-xs'>{action.message}</div>
      ) : null}
      {action?.phase === 'error' ? (
        <div className='text-danger border-default-100 flex items-center gap-1.5 border-t px-4 py-2 text-xs'>
          <AlertTriangle className='h-3.5 w-3.5 shrink-0' />
          <span>{action.message}</span>
        </div>
      ) : null}
    </Card>
  );
});

// ---------------------------------------------------------------------------
// WhiteboardPdfLibrary
// ---------------------------------------------------------------------------

export function WhiteboardPdfLibrary({ locale = 'en', ...props }: WhiteboardPdfLibraryProps) {
  return (
    <WbLocaleProvider locale={locale}>
      <WhiteboardPdfLibraryInner {...props} />
    </WbLocaleProvider>
  );
}

function WhiteboardPdfLibraryInner({ client, onError, teacherLabel }: Omit<WhiteboardPdfLibraryProps, 'locale'>) {
  const { t, dir, locale } = useWbStrings();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Per-task upload state. tasksRef is the source of truth the sequential queue runner reads/mutates;
  // `uploads` is the render snapshot kept in sync via syncUploads(). One AbortController per task.
  const tasksRef = useRef<Map<string, UploadTask>>(new Map());
  const uploadControllersRef = useRef<Map<string, AbortController>>(new Map());
  const isProcessingQueueRef = useRef(false);
  // Flips true on unmount so an in-flight generate poll / queue stops writing state after teardown.
  const mergeAbortRef = useRef(false);
  // Per-document re-entrancy guard: a merge/download already running for an id here. Synchronous (set
  // before any await) so a fast double-click can't fire two generateVersion calls → the second 409s.
  const mergeInFlightRef = useRef<Set<string>>(new Set());

  const [page, setPage] = useState(1);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [docActions, setDocActions] = useState<Record<string, DocAction>>({});

  const documentsQuery = useQuery({
    placeholderData: (previousData) => previousData,
    queryFn: () => client.listDocuments({ limit: DOCUMENTS_PAGE_LIMIT, page }),
    queryKey: [DOCUMENTS_QUERY_KEY, page],
  });

  const invalidateDocuments = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: [DOCUMENTS_QUERY_KEY] });
  }, [queryClient]);

  // Surface list-load failures to the host (React Query v5 dropped useQuery onError).
  const queryError = documentsQuery.error;

  useEffect(() => {
    if (queryError) {
      onError?.(queryError);
    }
  }, [onError, queryError]);

  useEffect(() => {
    // Clear the teardown flag on (re)mount so React StrictMode's dev mount→cleanup→remount cycle
    // doesn't leave it latched true — which would freeze the upload queue and the merge poll.
    mergeAbortRef.current = false;

    return () => {
      mergeAbortRef.current = true;
      uploadControllersRef.current.forEach((controller) => controller.abort());
    };
  }, []);

  // ── Source-PDF upload queue (bulk + resumable) ─────────────────────────────

  // Rebuild the render snapshot from the source-of-truth task map (insertion order preserved).
  const syncUploads = useCallback(() => {
    setUploads(Array.from(tasksRef.current.values()));
  }, []);

  const patchTask = useCallback(
    (taskId: string, patch: Partial<UploadTask>) => {
      const task = tasksRef.current.get(taskId);

      if (!task) {
        return;
      }

      tasksRef.current.set(taskId, { ...task, ...patch });
      syncUploads();
    },
    [syncUploads],
  );

  // Run one task to completion. Resumable: a retry already has documentId/pageCount so it skips
  // create + inspect, and the multipart upload picks up its already-sent parts.
  const runUploadTask = useCallback(
    async (taskId: string) => {
      const task = tasksRef.current.get(taskId);

      if (!task) {
        return;
      }

      const controller = new AbortController();
      uploadControllersRef.current.set(taskId, controller);

      try {
        let { documentId, pageCount } = task;

        if (pageCount == null) {
          patchTask(taskId, { errorMessage: '', phase: 'inspecting' });
          // pdf.js page-count + size validation (throws a localized message for oversized files).
          const summary = await inspectPdfFile(task.file);

          pageCount = summary.totalPages;
          patchTask(taskId, { pageCount });
        }

        if (!documentId) {
          // createDocument can't be aborted mid-flight, so guard around it: skip entirely if already
          // canceled, and if a cancel/remove lands while it's in flight, delete the orphan doc.
          if (controller.signal.aborted) {
            throw Object.assign(new Error('Upload canceled'), { name: 'AbortError' });
          }

          patchTask(taskId, { errorMessage: '', phase: 'creating' });
          const created = await client.createDocument({ title: deriveTitleFromFileName(task.file.name, t) });

          if (controller.signal.aborted) {
            void client.deleteDocument(created._id).catch(() => {});
            throw Object.assign(new Error('Upload canceled'), { name: 'AbortError' });
          }

          documentId = created._id;
          patchTask(taskId, { documentId });
        }

        if (controller.signal.aborted) {
          throw Object.assign(new Error('Upload canceled'), { name: 'AbortError' });
        }

        patchTask(taskId, { errorMessage: '', phase: 'uploading' });

        const { deduped } = await uploadSourcePdfAsset({
          documentId,
          file: task.file,
          fileName: task.file.name,
          mimeType: task.file.type || 'application/pdf',
          // Persist the multipart ids on first start so a later "continue" resumes (skips sent parts).
          onMultipartStart: (info) => patchTask(taskId, { multipart: info }),
          onProgress: (progress: SourcePdfUploadProgress) => {
            patchTask(taskId, { totalBytes: progress.totalBytes, uploadedBytes: progress.uploadedBytes });
          },
          pageCount,
          // Resume an interrupted >16MB upload instead of restarting it.
          resume: task.multipart ?? undefined,
          // Single passed-in client; its authHeaders callback reads a fresh token per request.
          runWithClient: (fn) => fn(client),
          signal: controller.signal,
        });

        patchTask(taskId, { phase: deduped ? 'deduped' : 'done', uploadedBytes: task.file.size });
        await invalidateDocuments();
      } catch (error) {
        if (isAbortError(error)) {
          patchTask(taskId, { phase: 'canceled' });

          return;
        }

        patchTask(taskId, { errorMessage: toDisplayError(error, t('pdflib.task.error')), phase: 'error' });
        onError?.(error);
      } finally {
        uploadControllersRef.current.delete(taskId);
      }
    },
    [client, invalidateDocuments, onError, patchTask],
  );

  // Drain the queue one task at a time (gentle on slow uplinks; the feature targets low upload speed).
  const processQueue = useCallback(async () => {
    if (isProcessingQueueRef.current) {
      return;
    }

    isProcessingQueueRef.current = true;

    try {
      for (;;) {
        if (mergeAbortRef.current) {
          return;
        }

        const next = Array.from(tasksRef.current.values()).find((task) => task.phase === 'queued');

        if (!next) {
          return;
        }

        await runUploadTask(next.id);
      }
    } finally {
      isProcessingQueueRef.current = false;
    }
  }, [runUploadTask]);

  const enqueueFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      const rejected: string[] = [];

      for (const file of files) {
        const isPdf = !file.type || file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

        if (!isPdf) {
          rejected.push(file.name);
          continue;
        }

        const id = createWhiteboardId();

        tasksRef.current.set(id, {
          documentId: null,
          errorMessage: '',
          file,
          fileName: file.name,
          id,
          multipart: null,
          pageCount: null,
          phase: 'queued',
          totalBytes: file.size,
          uploadedBytes: 0,
        });
      }

      syncUploads();

      if (rejected.length > 0) {
        onError?.(new Error(t('pdflib.onlyPdf', { names: rejected.join(t('pdflib.listSeparator')) })));
      }

      void processQueue();
    },
    [onError, processQueue, syncUploads],
  );

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);

      // Reset the input so re-picking the same file(s) fires change again.
      event.target.value = '';
      enqueueFiles(files);
    },
    [enqueueFiles],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Continue a failed/canceled task — re-queue it; documentId/pageCount persist so it resumes.
  const continueTask = useCallback(
    (taskId: string) => {
      patchTask(taskId, { errorMessage: '', phase: 'queued' });
      void processQueue();
    },
    [patchTask, processQueue],
  );

  const cancelTask = useCallback(
    (taskId: string) => {
      const controller = uploadControllersRef.current.get(taskId);

      if (controller) {
        controller.abort();

        return;
      }

      // Not started yet (still queued) — mark canceled so the runner skips it.
      const task = tasksRef.current.get(taskId);

      if (task && task.phase === 'queued') {
        tasksRef.current.set(taskId, { ...task, phase: 'canceled' });
        syncUploads();
      }
    },
    [syncUploads],
  );

  const removeTask = useCallback(
    (taskId: string) => {
      uploadControllersRef.current.get(taskId)?.abort();
      uploadControllersRef.current.delete(taskId);
      tasksRef.current.delete(taskId);
      syncUploads();
    },
    [syncUploads],
  );

  const clearFinishedTasks = useCallback(() => {
    Array.from(tasksRef.current.entries()).forEach(([id, task]) => {
      if (TERMINAL_UPLOAD_PHASES.has(task.phase) || task.phase === 'canceled') {
        tasksRef.current.delete(id);
      }
    });

    syncUploads();
  }, [syncUploads]);

  // ── Generate + download merged PDF ─────────────────────────────────────────

  // Fetch the merged PDF and save it, reporting either outcome on the row. Returns whether it
  // saved, so the merge paths only claim "ready" for a file that actually reached the disk.
  const saveMergedPdf = useCallback(
    async (documentId: string, url: string, fileName: string): Promise<boolean> => {
      setDocActions((previous) => ({
        ...previous,
        [documentId]: { message: t('pdflib.downloadingFile'), phase: 'downloading' },
      }));

      try {
        await saveRemotePdf(url, fileName, client.getRequestAccess(), t);

        return true;
      } catch (error) {
        if (!mergeAbortRef.current) {
          setDocActions((previous) => ({
            ...previous,
            [documentId]: {
              message: toDisplayError(error, t('pdflib.downloadFailed')),
              phase: 'error',
            },
          }));
        }

        onError?.(error);

        return false;
      }
    },
    [client, onError],
  );

  const handleDownload = useCallback(
    async (document: WhiteboardApiDocument) => {
      const documentId = document._id;
      const merged = document.mergedPdf;

      // Re-entrancy guard: a double-click (or a click while a merge/download is already running
      // here) must not fire a second generateVersion — the backend returns 409 "a merge is already
      // in progress" — nor a second fetch of the same file.
      if (mergeInFlightRef.current.has(documentId)) {
        return;
      }

      // Already merged on the server → fetch the bytes and save, no generate needed.
      if (merged?.status === 'done' && merged.pdfUrl) {
        const { pdfUrl, versionNumber } = merged;

        mergeInFlightRef.current.add(documentId);

        try {
          if (await saveMergedPdf(documentId, pdfUrl, buildDownloadFileName(document.title, versionNumber))) {
            if (mergeAbortRef.current) {
              return;
            }

            setDocActions((previous) => ({
              ...previous,
              [documentId]: { phase: 'ready', url: pdfUrl, versionNumber },
            }));
          }
        } finally {
          mergeInFlightRef.current.delete(documentId);
        }

        return;
      }

      mergeInFlightRef.current.add(documentId);
      setDocActions((previous) => ({
        ...previous,
        [documentId]: { message: t('pdflib.preparingMerged'), phase: 'generating' },
      }));

      // Drives the job to a terminal state then downloads (shared by the fresh + resume paths).
      const finishWithJob = async (jobId: string): Promise<boolean> => {
        const result = await pollVersionJob(client, documentId, jobId, () => mergeAbortRef.current, t);

        if (mergeAbortRef.current) {
          return true;
        }

        if (result.status === 'done' && result.pdfUrl) {
          const { pdfUrl, versionNumber } = result;

          if (await saveMergedPdf(documentId, pdfUrl, buildDownloadFileName(document.title, versionNumber))) {
            setDocActions((previous) => ({
              ...previous,
              [documentId]: { phase: 'ready', url: pdfUrl, versionNumber },
            }));
          }

          await invalidateDocuments();

          return true;
        }

        setDocActions((previous) => ({
          ...previous,
          [documentId]: {
            message: toDisplayError(result.error, t('pdflib.mergeFailed')),
            phase: 'error',
          },
        }));

        return false;
      };

      // A merge is ALREADY running on the server for this doc (e.g. the board just enqueued one, or a
      // prior session) → await THAT job instead of re-triggering, which would 409.
      const runningJobId =
        merged && merged.status !== 'done' && merged.status !== 'failed' && merged.status !== 'none'
          ? merged.jobId
          : undefined;

      try {
        if (runningJobId) {
          setDocActions((previous) => ({
            ...previous,
            [documentId]: { message: t('pdflib.mergeInProgress'), phase: 'generating' },
          }));
          await finishWithJob(runningJobId);

          return;
        }

        // No `pages` → the backend reuses the board's stored manifest (409 if none yet).
        const job = await client.generateVersion(documentId, {});

        if (job.status === 'done' && job.pdfUrl) {
          if (mergeAbortRef.current) {
            return;
          }

          const jobPdfUrl = job.pdfUrl;
          const jobVersionNumber = job.versionNumber;

          if (await saveMergedPdf(documentId, jobPdfUrl, buildDownloadFileName(document.title, jobVersionNumber))) {
            setDocActions((previous) => ({
              ...previous,
              [documentId]: {
                note: describeReadyDownload(job, locale),
                phase: 'ready',
                url: jobPdfUrl,
                versionNumber: jobVersionNumber,
              },
            }));
          }

          await invalidateDocuments();

          return;
        }

        // A `null` jobId is the no-merge fallback shape (BE #412) — always `done` with a `pdfUrl`,
        // handled above. Anything else without a job is a contract break: say so, don't poll `null`.
        if (!job.jobId) {
          setDocActions((previous) => ({
            ...previous,
            [documentId]: { message: t('pdflib.noResult'), phase: 'error' },
          }));

          return;
        }

        setDocActions((previous) => ({
          ...previous,
          [documentId]: { message: t('pdflib.creatingMerged'), phase: 'generating' },
        }));
        await finishWithJob(job.jobId);
      } catch (error) {
        // 409 has two causes: (a) a merge is already running for this doc, (b) the board hasn't pushed
        // a manifest yet. For (a) — recover by awaiting the running job (no raw error toast); for (b) —
        // guide the teacher to push edits. We only know the job id for (a) from the row's mergedPdf.
        if (error instanceof WhiteboardApiError && error.status === 409) {
          if (merged?.jobId && !mergeAbortRef.current) {
            try {
              setDocActions((previous) => ({
                ...previous,
                [documentId]: { message: t('pdflib.mergeInProgress'), phase: 'generating' },
              }));
              await finishWithJob(merged.jobId);

              return;
            } catch {
              // fall through to the guidance message
            }
          }

          setDocActions((previous) => ({
            ...previous,
            [documentId]: { message: describeGenerateConflict(error, locale), phase: 'error' },
          }));

          return;
        }

        setDocActions((previous) => ({
          ...previous,
          [documentId]: { message: toDisplayError(error, t('pdflib.mergeFailed')), phase: 'error' },
        }));
        onError?.(error);
      } finally {
        mergeInFlightRef.current.delete(documentId);
      }
    },
    [client, invalidateDocuments, onError, saveMergedPdf],
  );

  // ── Derived view state ─────────────────────────────────────────────────────

  const documents = documentsQuery.data?.documents ?? [];
  const pagination = documentsQuery.data?.pagination;
  const totalPages = pagination?.totalPages ?? 1;
  const activeUploadCount = uploads.filter((task) => ACTIVE_UPLOAD_PHASES.has(task.phase)).length;
  // Counts only what "Clear completed" actually removes (done/deduped/canceled) — error rows are kept
  // so they stay continuable, so they must NOT make the clear button appear with nothing to do.
  const finishedUploadCount = uploads.filter(
    (task) => TERMINAL_UPLOAD_PHASES.has(task.phase) || task.phase === 'canceled',
  ).length;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className='mx-auto flex max-w-4xl flex-col gap-6 p-4 md:p-6' dir={dir}>
      <input
        ref={fileInputRef}
        accept='application/pdf'
        className='hidden'
        multiple
        type='file'
        onChange={handleFileInputChange}
      />

      {/* Header */}
      <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
        <div>
          <h1 className='text-foreground text-2xl font-bold'>{t('pdflib.title')}</h1>
          {teacherLabel ? <p className='text-default-500 mt-1 text-sm'>{t('pdflib.actingAs', { label: teacherLabel })}</p> : null}
        </div>
        <Button color='primary' startContent={<Upload className='h-4 w-4' />} onPress={openFilePicker}>
          {t('pdflib.upload')}
        </Button>
      </div>

      {/* Upload queue (bulk + resumable) */}
      {uploads.length > 0 ? (
        <Card shadow='sm'>
          <CardBody className='flex flex-col gap-3 p-4'>
            <div className='flex items-center justify-between gap-3'>
              <p className='text-foreground text-sm font-bold'>
                {activeUploadCount > 0 ? t('pdflib.uploadingN', { n: activeUploadCount }) : t('pdflib.uploadQueue')}
              </p>
              {finishedUploadCount > 0 ? (
                <Button size='sm' variant='light' onPress={clearFinishedTasks}>
                  {t('pdflib.clearDone')}
                </Button>
              ) : null}
            </div>

            <div className='flex flex-col gap-2'>
              {uploads.map((task) => {
                const percent = uploadTaskPercent(task);
                const isActive = ACTIVE_UPLOAD_PHASES.has(task.phase);
                const isErrored = task.phase === 'error' || task.phase === 'canceled';
                const isDone = TERMINAL_UPLOAD_PHASES.has(task.phase);

                return (
                  <div key={task.id} className='border-default-100 flex flex-col gap-2 rounded-lg border p-3'>
                    <div className='flex items-start justify-between gap-3'>
                      <div className='flex min-w-0 items-center gap-2'>
                        <FileText className='text-default-500 h-5 w-5 shrink-0' />
                        <p className='text-foreground truncate text-sm font-medium'>{task.fileName}</p>
                      </div>
                      <div className='flex shrink-0 items-center gap-1'>
                        {task.phase === 'uploading' || task.phase === 'queued' ? (
                          <Button
                            isIconOnly
                            aria-label={t('pdflib.cancel')}
                            size='sm'
                            variant='light'
                            onPress={() => cancelTask(task.id)}
                          >
                            <X className='h-4 w-4' />
                          </Button>
                        ) : (
                          <Button
                            isIconOnly
                            aria-label={t('pdflib.remove')}
                            size='sm'
                            variant='light'
                            onPress={() => removeTask(task.id)}
                          >
                            <Trash2 className='h-4 w-4' />
                          </Button>
                        )}
                      </div>
                    </div>

                    {task.phase === 'uploading' ? (
                      <Progress
                        aria-label={t('pdflib.uploadProgress')}
                        color='primary'
                        showValueLabel
                        value={percent}
                        valueLabel={`${percent}%`}
                      />
                    ) : null}

                    <div className='flex items-center gap-2 text-xs'>
                      {isActive ? <Spinner color='primary' size='sm' /> : null}
                      {isDone ? <CheckCircle2 className='text-success h-4 w-4 shrink-0' /> : null}
                      {isErrored ? <AlertTriangle className='text-danger h-4 w-4 shrink-0' /> : null}
                      <span
                        className={
                          isErrored
                            ? 'text-danger truncate'
                            : isDone
                              ? 'text-success truncate'
                              : 'text-default-500 truncate'
                        }
                      >
                        {uploadTaskStatusText(task, t)}
                      </span>
                    </div>

                    {isErrored ? (
                      <Button
                        className='self-start'
                        color='primary'
                        size='sm'
                        startContent={<RefreshCw className='h-4 w-4' />}
                        variant='flat'
                        onPress={() => continueTask(task.id)}
                      >
                        {t('pdflib.resumeUpload')}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* List */}
      <div className='flex flex-col gap-3'>
        <div className='flex items-center justify-between'>
          <h2 className='text-foreground text-lg font-bold'>{t('pdflib.myDocuments')}</h2>
          <Button
            isIconOnly
            aria-label={t('pdflib.refresh')}
            isLoading={documentsQuery.isFetching}
            size='sm'
            variant='light'
            onPress={() => {
              void invalidateDocuments();
            }}
          >
            <RefreshCw className='h-4 w-4' />
          </Button>
        </div>

        {documentsQuery.isLoading ? (
          <div className='flex h-48 items-center justify-center'>
            <Spinner color='primary' label={t('pdflib.loadingDocs')} size='lg' />
          </div>
        ) : queryError ? (
          <Card shadow='sm'>
            <CardBody className='flex flex-col items-center gap-3 py-10'>
              <AlertTriangle className='text-danger h-8 w-8' />
              <p className='text-default-500 text-sm'>{toDisplayError(queryError, t('pdflib.loadFailed'))}</p>
              <Button
                color='primary'
                size='sm'
                startContent={<RefreshCw className='h-4 w-4' />}
                variant='flat'
                onPress={() => {
                  void documentsQuery.refetch();
                }}
              >
                {t('pdflib.retry')}
              </Button>
            </CardBody>
          </Card>
        ) : documents.length === 0 ? (
          <Card shadow='sm'>
            <CardBody className='flex flex-col items-center gap-2 py-12'>
              <FileText className='text-default-300 h-10 w-10' />
              <p className='text-default-500 text-sm'>{t('pdflib.empty')}</p>
            </CardBody>
          </Card>
        ) : (
          <div className='flex flex-col gap-3'>
            {documents.map((document) => (
              <DocumentRow
                key={document._id}
                action={docActions[document._id]}
                document={document}
                onDownload={handleDownload}
              />
            ))}
          </div>
        )}

        {totalPages > 1 ? (
          <div className='mt-2 flex justify-center'>
            <Pagination page={page} total={totalPages} onChange={setPage} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default WhiteboardPdfLibrary;
