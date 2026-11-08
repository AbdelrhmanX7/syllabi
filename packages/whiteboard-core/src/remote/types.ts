export type WhiteboardTeacherType = 'Teacher' | 'StudioTeacher';

export interface WhiteboardApiDocument {
  _id: string;
  title: string;
  teacherId: string;
  teacherType: WhiteboardTeacherType;
  /**
   * Client-minted UUID this server doc was claimed from (via {@link WhiteboardApiClaimDocumentInput});
   * `null`/absent for server-created docs. Returned by the claim endpoint. The FE re-key uses
   * `_id` only — this is forward-compat/diagnostic. Optional so pre-claim backends still type-check.
   */
  clientId?: string | null;
  lectureId: string | null;
  isPublished: boolean;
  autoPublish: boolean;
  currentVersion: number;
  pageCount: number;
  draftRawDataUrl: string | null;
  draftUpdatedAt: string | null;
  /**
   * Newest draft-snapshot `seq` the server holds for this document (0 when none). Returned on
   * `GET /documents/:id`; the FE seeds its local seq cursor from it on open so first-append
   * divergence detection is accurate. Optional so older backends (pre-P1) still type-check.
   */
  latestSnapshotSeq?: number;
  /**
   * Server-merge (mechanism #3) status for this document. The board uploads per-page transparent
   * overlay PNGs + a geometry manifest; the backend composites them onto the vector source PDF into
   * a `WhiteboardVersion`. Surfaced on the teacher/studio document lists so the teacher-side UI can
   * badge "Merged ready" and offer a download. Optional so pre-merge backends still type-check.
   */
  mergedPdf?: WhiteboardMergedPdfStatus;
  tags: string[];
  thumbnail: string | null;
  isActive: boolean;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WhiteboardApiVersion {
  _id: string;
  documentId: string;
  versionNumber: number;
  pdfUrl: string;
  pdfFileSize: number;
  rawDataUrl: string;
  thumbnailUrl: string | null;
  pageCount: number;
  createdAt: string;
  updatedAt?: string;
}

export interface WhiteboardApiKey {
  _id: string;
  teacherId: string;
  teacherType: WhiteboardTeacherType;
  keyPrefix: string;
  label: string;
  lastUsedAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WhiteboardApiPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface WhiteboardApiDocumentListResponse {
  documents: WhiteboardApiDocument[];
  pagination: WhiteboardApiPagination;
}

export interface WhiteboardApiDocumentDetails extends WhiteboardApiDocument {
  latestVersion?: WhiteboardApiVersion | null;
}

export interface WhiteboardApiMessageResponse {
  message: string;
}

export interface WhiteboardApiUploadUrl {
  uploadUrl: string;
  publicUrl: string;
  key?: string;
}

export interface WhiteboardApiSourcePdfAsset {
  _id: string;
  documentId?: string;
  storageKey: string;
  fileName: string;
  mimeType?: string;
  fileSize: number;
  pageCount: number;
  status?: 'confirmed' | 'failed' | 'pending_upload' | 'uploaded';
  selectedPages?: number[];
  checksum?: string;
  referenceCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface WhiteboardApiSourcePdfUploadUrlInput {
  fileName: string;
  checksum?: string;
  fileSize?: number;
}

export interface WhiteboardApiSourcePdfUploadUrlFreshResponse {
  deduped?: false;
  assetId: string;
  storageKey: string;
  uploadUrl: string;
}

export interface WhiteboardApiSourcePdfUploadUrlDedupedResponse {
  deduped: true;
  assetId: string;
  storageKey?: undefined;
  uploadUrl?: undefined;
}

export type WhiteboardApiSourcePdfUploadUrlResponse =
  | WhiteboardApiSourcePdfUploadUrlFreshResponse
  | WhiteboardApiSourcePdfUploadUrlDedupedResponse;

export interface WhiteboardApiStartSourcePdfMultipartInput {
  fileName: string;
  mimeType: string;
  fileSize: number;
  checksum: string;
  pageCount: number;
}

export interface WhiteboardApiStartSourcePdfMultipartFreshResponse {
  deduped?: false;
  assetId: string;
  uploadId: string;
  partSize: number;
}

export interface WhiteboardApiStartSourcePdfMultipartDedupedResponse {
  deduped: true;
  assetId: string;
  uploadId?: undefined;
  partSize?: undefined;
}

export type WhiteboardApiStartSourcePdfMultipartResponse =
  | WhiteboardApiStartSourcePdfMultipartFreshResponse
  | WhiteboardApiStartSourcePdfMultipartDedupedResponse;

export interface WhiteboardApiSourcePdfMultipartPartUrlParams {
  uploadId: string;
  partNumber: number;
}

export interface WhiteboardApiSourcePdfMultipartPartUrlResponse {
  url: string;
}

export interface WhiteboardApiSourcePdfMultipartPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface WhiteboardApiSourcePdfMultipartPartsResponse {
  parts: WhiteboardApiSourcePdfMultipartPart[];
}

export interface WhiteboardApiCompleteSourcePdfMultipartInput {
  uploadId: string;
  parts: Array<{
    partNumber: number;
    etag: string;
  }>;
}

export interface WhiteboardApiConfirmSourcePdfInput {
  assetId: string;
  checksum?: string;
  fileSize: number;
  pageCount: number;
  selectedPages?: number[];
}

export interface WhiteboardApiConfirmSourcePdfResponse extends WhiteboardApiMessageResponse {
  asset: WhiteboardApiSourcePdfAsset;
}

export interface WhiteboardApiUpdateSourcePdfReferencesInput {
  referenceCount: number;
}

export interface WhiteboardApiSourcePdfReadAccess {
  headers: Record<string, string>;
  url: string;
}

/**
 * What a caller needs to fetch a file the API only handed it a URL for.
 *
 * `apiOrigin` is the question "is this URL ours?" — a merged PDF or a version PDF lives on
 * public object storage in production and on the API's own static mount in development, and
 * which one it is decides whether `headers` may be sent at all.
 */
export interface WhiteboardApiRequestAccess {
  apiOrigin: string;
  headers: Record<string, string>;
}

export interface WhiteboardApiVersionUploadUrlsResponse {
  versionNumber: number;
  urls: {
    pdf: WhiteboardApiUploadUrl;
    rawData: WhiteboardApiUploadUrl;
    thumbnail: WhiteboardApiUploadUrl;
  };
}

export interface WhiteboardApiCreateDocumentInput {
  title?: string;
  tags?: string[];
}

/**
 * Tier-2 claim/link: reconcile a local-minted board (UUID) to a server document. Idempotent +
 * race-safe on `(teacherId, clientId)` server-side — the same `clientId` always resolves to the
 * same `_id`. `POST <surface>/documents/claim`.
 */
export interface WhiteboardApiClaimDocumentInput {
  /** The board's local UUID (from `createWhiteboardId()`). Required; non-empty, <=128 chars. */
  clientId: string;
  title?: string;
  pageCount?: number;
  tags?: string[];
}

export interface WhiteboardApiClaimDocumentResponse {
  /** The linked server document (carries `_id` and `clientId`). */
  document: WhiteboardApiDocument;
  /** `true` = newly linked (201); `false` = idempotent hit, same `_id` returned (200). */
  created: boolean;
}

export interface WhiteboardApiListDocumentsParams {
  page?: number;
  limit?: number;
  tag?: string;
}

export interface WhiteboardApiUpdateDocumentInput {
  title?: string;
  tags?: string[];
}

export interface WhiteboardApiGetUploadUrlParams {
  type?: 'draft' | 'pdf' | 'thumbnail';
  fileName?: string;
}

export interface WhiteboardApiConfirmVersionInput {
  versionNumber: number;
  pdfUrl: string;
  rawDataUrl: string;
  thumbnailUrl?: string;
  pageCount?: number;
  pdfFileSize?: number;
  title?: string;
}

export interface WhiteboardApiConfirmVersionResponse extends WhiteboardApiMessageResponse {
  version: WhiteboardApiVersion;
}

export interface WhiteboardApiSyncDraftInput {
  draftRawDataUrl?: string;
  pageCount?: number;
  title?: string;
  thumbnail?: string;
}

export interface WhiteboardApiSyncDraftResponse {
  synced: boolean;
  draftUpdatedAt: string;
}

export interface WhiteboardApiLatestResponse {
  document: Pick<WhiteboardApiDocument, '_id' | 'title' | 'currentVersion'>;
  version: Pick<WhiteboardApiVersion, 'versionNumber' | 'rawDataUrl' | 'pdfUrl' | 'pageCount' | 'createdAt'>;
}

export interface WhiteboardApiVersionHistoryResponse {
  document: WhiteboardApiDocument;
  versions: WhiteboardApiVersion[];
}

export interface WhiteboardApiResumeSource {
  kind: 'draft' | 'version';
  url: string;
  versionNumber: number | null;
}

export interface WhiteboardApiDraftSnapshotUploadUrlResponse {
  uploadUrl: string;
  storageKey: string;
  /**
   * Public B2 URL of the snapshot object. When present, the FE passes it back as the append
   * body's `rawDataUrl` (mirrors `GET /documents/:id/upload-url`). When absent, the FE omits
   * `rawDataUrl` and the server derives it from `storageKey`. The syncer handles both.
   */
  publicUrl?: string;
}

export interface WhiteboardApiAppendDraftSnapshotInput {
  storageKey: string;
  /**
   * Public URL of the uploaded snapshot. Optional: sent when the upload-url response carried a
   * `publicUrl`; omitted otherwise so the server derives it from `storageKey`.
   */
  rawDataUrl?: string;
  pageCount: number;
  thumbnail: string | null;
  title: string;
  deviceId: string;
  baseSeq: number | null;
  fileSize: number;
}

export interface WhiteboardApiDraftSnapshotBranch {
  seq: number;
  deviceId: string;
  createdAt: string;
}

export interface WhiteboardApiAppendDraftSnapshotResponse {
  seq: number;
  latestSeq: number;
  diverged: boolean;
  otherBranch?: WhiteboardApiDraftSnapshotBranch;
}

export interface WhiteboardApiDraftSnapshot {
  seq: number;
  deviceId: string;
  baseSeq: number | null;
  pageCount: number;
  thumbnail: string | null;
  title: string;
  rawDataUrl: string;
  fileSize: number;
  createdAt: string;
}

export interface WhiteboardApiListDraftSnapshotsParams {
  limit?: number;
}

export interface WhiteboardApiListDraftSnapshotsResponse {
  snapshots: WhiteboardApiDraftSnapshot[];
}

/* -------------------------------------------------------------------------------------------------
 * Server-side merge (mechanism #3): board uploads per-page transparent overlay PNGs + a geometry
 * manifest; the backend composites them onto the vector source PDF into a WhiteboardVersion.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Presigned destination for ONE per-page overlay PNG. Returned by
 * `POST /documents/:id/merge-overlays/upload-url`. The board PUTs the PNG bytes to `uploadUrl`
 * (via {@link uploadToWhiteboardPresignedUrl}) and keeps `storageKey` as the manifest `overlayKey`.
 */
export interface MergeOverlayUploadUrl {
  uploadUrl: string;
  storageKey: string;
  publicUrl: string;
}

/**
 * One page of the merge geometry manifest. All measurements are in **PDF points** with a pdf-lib
 * **bottom-left** origin. `widthPt`/`heightPt` = contentBboxCss * 72/96. `pdf` (the source-PDF
 * placement rect) is present only for pages that embed a source PDF page and requires `pdfAssetId`.
 * `overlayKey` must be a `.../merge-overlays/<file>.png` produced for this teacher + document.
 */
export interface MergePageManifestEntry {
  index: number;
  pdfAssetId?: string;
  pdfPageIndex?: number;
  widthPt: number;
  heightPt: number;
  pdf?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /**
   * Source-page rotation in degrees CLOCKWISE (screen sense), any angle; absent = 0. When set, the
   * `pdf` rect is the BOUNDING BOX of the rotated source page: the backend must draw the source page
   * scaled by s = pdf.width / (w·|cos θ| + h·|sin θ|) (w,h = source page pt size) and rotated about
   * the rect's CENTER. In pdf-lib terms (y-up, CCW-positive) the draw rotation is −pdfRotation.
   */
  pdfRotation?: number;
  overlayKey: string;
}

/**
 * Body for `POST /documents/:id/versions/generate`. The board sends `pages[]` (the full geometry
 * manifest); a teacher/studio re-trigger omits `pages` so the backend reuses the board's stored
 * manifest (409 if none yet). `snapshotSeq` pins the version to a synced snapshot (idempotent —
 * one version per snapshotSeq).
 */
export interface GenerateVersionRequest {
  snapshotSeq?: number;
  pages?: MergePageManifestEntry[];
}

/**
 * Where a `done` answer with no job came from. Additive (BE #412/#413): a download request with no
 * `pages` that finds nothing staged and nothing to render is answered from a stored file instead
 * of a 409, LABELLED so the client can say so — drawings made after that file are not in it.
 */
export type GenerateVersionSource = 'published-version' | 'source-pdf';

/**
 * `202` response from `POST /documents/:id/versions/generate` — or `200` when the answer is a file
 * that already exists: a finished manifest (`jobId` set), or a fallback (`jobId: null`, `source` set).
 */
export interface GenerateVersionResponse {
  /** `null` when no job exists — the server answered from a stored file; see `source`. */
  jobId: string | null;
  status: 'queued' | 'rendering' | 'done' | 'failed';
  versionNumber?: number;
  pdfUrl?: string;
  source?: GenerateVersionSource;
  /** `source === 'published-version'`: when that version was published. */
  publishedAt?: string | null;
  /** `source === 'source-pdf'`: which of the board's PDFs was served (a board may hold several). */
  fileName?: string | null;
  pageCount?: number | null;
}

/**
 * The `409` body of `POST /documents/:id/versions/generate` with no `pages`, when there is truly
 * nothing to serve: no staged overlays, no renderable snapshot, no published version, no source PDF.
 * The `reason` is the machine-readable half (BE #412) so the client can name the state instead of
 * guessing between "the board never sent anything" and "a merge is already running".
 */
export interface GenerateVersionConflictBody {
  message?: string;
  reason?: 'no_staged_edits';
}

/**
 * Body for `POST /documents/:id/versions/stage`: the board's CURRENT overlays, for the on-demand
 * download path. Same `pages[]` the durable publish sends (validated identically — every
 * `overlayKey` must sit under this teacher + document's `merge-overlays/` prefix). `snapshotSeq` is
 * echoed back only; the transient slot stores `null`.
 */
export interface StageVersionRequest {
  pages: MergePageManifestEntry[];
  snapshotSeq?: number;
}

/** `200` response from `POST /documents/:id/versions/stage`. */
export interface StageVersionResponse {
  staged: true;
  manifestId: string;
  snapshotSeq: number | null;
}

/** Poll result from `GET /documents/:id/versions/jobs/:jobId`. */
export interface VersionJobStatus {
  status: 'queued' | 'rendering' | 'done' | 'failed';
  versionNumber?: number;
  pdfUrl?: string;
  error?: string;
}

/**
 * Per-document server-merge status carried on the teacher/studio document lists alongside the
 * existing `latestVersion`. `none` = no merge produced yet; `done` exposes the downloadable
 * `pdfUrl` + `versionNumber`.
 */
export interface WhiteboardMergedPdfStatus {
  status: 'none' | 'queued' | 'rendering' | 'done' | 'failed';
  versionNumber?: number;
  pdfUrl?: string;
  generatedAt?: string;
  jobId?: string;
}
