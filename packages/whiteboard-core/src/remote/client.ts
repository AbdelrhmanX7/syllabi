import type {
  WhiteboardApiAppendDraftSnapshotInput,
  WhiteboardApiAppendDraftSnapshotResponse,
  WhiteboardApiClaimDocumentInput,
  WhiteboardApiClaimDocumentResponse,
  WhiteboardApiCompleteSourcePdfMultipartInput,
  WhiteboardApiConfirmSourcePdfInput,
  WhiteboardApiConfirmSourcePdfResponse,
  WhiteboardApiConfirmVersionInput,
  WhiteboardApiConfirmVersionResponse,
  WhiteboardApiCreateDocumentInput,
  WhiteboardApiDocument,
  WhiteboardApiDocumentDetails,
  WhiteboardApiDocumentListResponse,
  WhiteboardApiDraftSnapshotUploadUrlResponse,
  GenerateVersionRequest,
  GenerateVersionResponse,
  MergeOverlayUploadUrl,
  StageVersionRequest,
  StageVersionResponse,
  VersionJobStatus,
  WhiteboardApiGetUploadUrlParams,
  WhiteboardApiLatestResponse,
  WhiteboardApiListDocumentsParams,
  WhiteboardApiListDraftSnapshotsParams,
  WhiteboardApiListDraftSnapshotsResponse,
  WhiteboardApiMessageResponse,
  WhiteboardApiSourcePdfAsset,
  WhiteboardApiSourcePdfMultipartPartUrlParams,
  WhiteboardApiSourcePdfMultipartPartUrlResponse,
  WhiteboardApiSourcePdfMultipartPartsResponse,
  WhiteboardApiRequestAccess,
  WhiteboardApiSourcePdfReadAccess,
  WhiteboardApiSourcePdfUploadUrlInput,
  WhiteboardApiSourcePdfUploadUrlResponse,
  WhiteboardApiStartSourcePdfMultipartInput,
  WhiteboardApiStartSourcePdfMultipartResponse,
  WhiteboardApiSyncDraftInput,
  WhiteboardApiSyncDraftResponse,
  WhiteboardApiUpdateSourcePdfReferencesInput,
  WhiteboardApiUpdateDocumentInput,
  WhiteboardApiUploadUrl,
  WhiteboardApiVersionHistoryResponse,
  WhiteboardApiVersionUploadUrlsResponse,
} from './types';

type QueryValue = boolean | number | string | null | undefined;

export class WhiteboardApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'WhiteboardApiError';
    this.status = status;
    this.body = body;
  }
}

/** One upload of captured contacts. Shape mirrors `wb-contact-capture/v1` (see contact-capture.ts). */
export interface WhiteboardApiPenCaptureBatch {
  schema: 'wb-contact-capture/v1';
  session: {
    sessionId: string;
    deviceLabel: string;
    createdAt: string;
    nativeVersion: string;
    jsBuild: string;
    devicePixelRatio: number;
    screenW: number;
    screenH: number;
    maxTouchPoints: number;
    /** WHICH rulebook was live — a row cannot be interpreted without it. */
    rulebook: string;
    bands: { smallHeadMaxWidth: number; bigHeadMaxWidth: number; fingerMinWidth: number };
    touchInputMode: string;
    dualTipEnabled: boolean;
  };
  contacts: unknown[];
}

export interface WhiteboardApiPenCaptureResult {
  received: number;
}

/** Bytes to put on the wire verbatim, plus the `Content-Encoding` that describes them. */
export interface WhiteboardApiEncodedBody {
  body: Uint8Array;
  /** Today always `'gzip'`. */
  contentEncoding: string;
}

/**
 * Compress an already-serialized request body.
 *
 * Handed the exact JSON string the uncompressed path would have sent, so the encoded bytes can never
 * describe a different batch than the caller passed — the encoder has nothing else to work from.
 * Returning `null` means "send it plain": the caller's runtime has no compressor (no
 * `CompressionStream`), which must degrade to an ordinary JSON POST rather than fail the upload.
 *
 * Lives here as a callback rather than as compression inside the client because the only compressor
 * worth using is the platform's own, and this package runs in a WebView, in Node tests, and in a
 * Next.js build — the app that knows which one it is supplies it.
 */
export type WhiteboardApiBodyEncoder = (json: string) => Promise<WhiteboardApiEncodedBody | null>;

export interface WhiteboardApiClientOptions {
  baseUrl: string;
  fetcher?: typeof fetch;
  /**
   * API-key auth (the board device). Validated as `wb_<64hex>`. Mutually exclusive with
   * {@link WhiteboardApiClientOptions.authHeaders}; one of the two is required.
   */
  apiKey?: string;
  /**
   * Custom auth-header provider for token-auth surfaces (platform teacher `/teacher/whiteboard`,
   * studio teacher `/studio-teacher/whiteboard`, admin acts-on-behalf = board API key +
   * `X-Whiteboard-Teacher-Id`/`-Type`). Invoked per request; the returned headers are merged onto
   * every request and onto {@link WhiteboardApiClient.getSourcePdfReadAccess}. Reading the token
   * inside the callback keeps it fresh across re-auth. Mutually exclusive with `apiKey`.
   */
  authHeaders?: () => Record<string, string>;
}

/**
 * Ceiling on a JSON metadata request (list, get, confirm — never a file transfer; uploads go
 * straight to presigned storage URLs and are not routed through `requestJson`).
 *
 * `fetch` has no default timeout, so a connection that opens and then stalls — the classic
 * flaky-uplink failure, distinct from a clean refusal — hangs forever. On the home screen that
 * meant a refresh that never finished and never failed, so nothing retried and no error was ever
 * shown. Failing at a bounded point turns that into an ordinary error the caller can report or
 * retry, and the caller keeps whatever it had cached.
 */
const REQUEST_TIMEOUT_MS = 20_000;

function bindFetcher(fetcher: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    Reflect.apply(
      fetcher as unknown as (...args: [RequestInfo | URL, RequestInit | undefined]) => Promise<Response>,
      globalThis,
      [input, init],
    )) as typeof fetch;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function isWhiteboardApiKey(value: string | null | undefined): boolean {
  return /^wb_[a-f0-9]{64}$/i.test(value?.trim() ?? '');
}

export function normalizeWhiteboardApiBaseUrl(value: string): string {
  const trimmed = trimTrailingSlash(value.trim());

  if (!trimmed) {
    return '';
  }

  return trimmed.endsWith('/whiteboard') ? trimmed : `${trimmed}/whiteboard`;
}

export class WhiteboardApiClient {
  private readonly authHeaders: () => Record<string, string>;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor({ apiKey, authHeaders, baseUrl, fetcher = fetch }: WhiteboardApiClientOptions) {
    const normalizedBaseUrl = normalizeWhiteboardApiBaseUrl(baseUrl);

    if (!normalizedBaseUrl) {
      throw new Error('Whiteboard API base URL is required.');
    }

    if (authHeaders) {
      // Token-auth surface (teacher/studio/admin): caller owns the auth header(s).
      this.authHeaders = authHeaders;
    } else {
      // Board device: validate + pin the API key (unchanged behaviour).
      if (!isWhiteboardApiKey(apiKey)) {
        throw new Error('Invalid whiteboard API key format.');
      }

      // isWhiteboardApiKey rejects null/undefined, so apiKey is a string here.
      const key = apiKey!.trim();

      this.authHeaders = () => ({ 'X-Whiteboard-Api-Key': key });
    }

    this.baseUrl = normalizedBaseUrl;
    this.fetcher = bindFetcher(fetcher);
  }

  /**
   * Upload a batch of captured touch contacts (training data for the touch classifier).
   *
   * Idempotent server-side on `(sessionId, contactId)`: the board uploads from a durable queue that
   * retries, so the same batch WILL arrive twice after a flaky network and must not become two rows.
   * A 404 here means the server has not shipped the endpoint yet — the caller parks the queue rather
   * than discarding it, so nothing captured before the backend landed is lost.
   *
   * The ONE endpoint on this client that may send a compressed body. A batch is a few hundred
   * near-identical frame records — the most compressible payload the board produces, and the one it
   * sends from a studio uplink shared with the cameras. `encodeBody` gzips the serialized batch (the
   * server accepts `Content-Encoding: gzip`); an encoder that returns `null` sends the same JSON
   * uncompressed, which is exactly what the wire looked like before compression existed.
   *
   * Compressing here changes nothing about idempotency: the retried batch is the same object, so it
   * re-serializes to the same JSON and re-sends the same `(sessionId, contactId)` pairs whether or
   * not the compressor was available on either attempt.
   */
  async uploadPenCaptures(
    batch: WhiteboardApiPenCaptureBatch,
    encodeBody?: WhiteboardApiBodyEncoder,
  ): Promise<WhiteboardApiPenCaptureResult> {
    const json = JSON.stringify(batch);
    const encoded = encodeBody ? await encodeBody(json) : null;

    return this.requestJson<WhiteboardApiPenCaptureResult>('/pen-captures', {
      headers: encoded ? { 'Content-Encoding': encoded.contentEncoding } : undefined,
      method: 'POST',
      rawBody: encoded ? encoded.body : json,
    });
  }

  async createDocument(input: WhiteboardApiCreateDocumentInput = {}): Promise<WhiteboardApiDocument> {
    return this.requestJson<WhiteboardApiDocument>('/documents', {
      body: input,
      method: 'POST',
    });
  }

  /**
   * Tier-2 claim/link: reconcile a local-minted board (UUID) to a server document. Idempotent +
   * race-safe on `(teacherId, clientId)` — the same `clientId` always resolves to the same `_id`
   * (`created:false` on the idempotent hit). Works on every surface (board `wb_` key, teacher/studio
   * token, admin acts-on-behalf) via the shared auth header; resolves to `<surface>/whiteboard/documents/claim`.
   */
  async claimDocument(input: WhiteboardApiClaimDocumentInput): Promise<WhiteboardApiClaimDocumentResponse> {
    return this.requestJson<WhiteboardApiClaimDocumentResponse>('/documents/claim', {
      body: input,
      method: 'POST',
    });
  }

  async listDocuments(params: WhiteboardApiListDocumentsParams = {}): Promise<WhiteboardApiDocumentListResponse> {
    return this.requestJson<WhiteboardApiDocumentListResponse>('/documents', {
      query: params,
    });
  }

  async getDocument(documentId: string): Promise<WhiteboardApiDocumentDetails> {
    return this.requestJson<WhiteboardApiDocumentDetails>(`/documents/${encodeURIComponent(documentId)}`);
  }

  async updateDocument(documentId: string, input: WhiteboardApiUpdateDocumentInput): Promise<WhiteboardApiDocument> {
    return this.requestJson<WhiteboardApiDocument>(`/documents/${encodeURIComponent(documentId)}`, {
      body: input,
      method: 'PUT',
    });
  }

  async deleteDocument(documentId: string): Promise<WhiteboardApiMessageResponse> {
    return this.requestJson<WhiteboardApiMessageResponse>(`/documents/${encodeURIComponent(documentId)}`, {
      method: 'DELETE',
    });
  }

  async getUploadUrl(
    documentId: string,
    params: WhiteboardApiGetUploadUrlParams = {},
  ): Promise<WhiteboardApiUploadUrl> {
    const response = await this.requestJson<WhiteboardApiUploadUrl>(
      `/documents/${encodeURIComponent(documentId)}/upload-url`,
      {
        query: params,
      },
    );

    return this.normalizeUploadUrl(response);
  }

  async getVersionUploadUrls(documentId: string): Promise<WhiteboardApiVersionUploadUrlsResponse> {
    const response = await this.requestJson<WhiteboardApiVersionUploadUrlsResponse>(
      `/documents/${encodeURIComponent(documentId)}/version-upload-urls`,
    );

    return {
      ...response,
      urls: {
        pdf: this.normalizeUploadUrl(response.urls.pdf),
        rawData: this.normalizeUploadUrl(response.urls.rawData),
        thumbnail: this.normalizeUploadUrl(response.urls.thumbnail),
      },
    };
  }

  async confirmVersion(
    documentId: string,
    input: WhiteboardApiConfirmVersionInput,
  ): Promise<WhiteboardApiConfirmVersionResponse> {
    return this.requestJson<WhiteboardApiConfirmVersionResponse>(
      `/documents/${encodeURIComponent(documentId)}/confirm-version`,
      {
        body: input,
        method: 'POST',
      },
    );
  }

  async syncDraft(documentId: string, input: WhiteboardApiSyncDraftInput): Promise<WhiteboardApiSyncDraftResponse> {
    return this.requestJson<WhiteboardApiSyncDraftResponse>(`/documents/${encodeURIComponent(documentId)}/sync-draft`, {
      body: input,
      method: 'POST',
    });
  }

  async requestSourcePdfUploadUrl(
    documentId: string,
    input: WhiteboardApiSourcePdfUploadUrlInput,
  ): Promise<WhiteboardApiSourcePdfUploadUrlResponse> {
    const response = await this.requestJson<WhiteboardApiSourcePdfUploadUrlResponse>(
      `/documents/${encodeURIComponent(documentId)}/source-pdf/upload-url`,
      {
        body: input,
        method: 'POST',
      },
    );

    if (response.deduped === true) {
      return response;
    }

    return {
      ...response,
      uploadUrl: this.resolveExternalUrl(response.uploadUrl),
    };
  }

  async requestDraftSnapshotUploadUrl(documentId: string): Promise<WhiteboardApiDraftSnapshotUploadUrlResponse> {
    const response = await this.requestJson<WhiteboardApiDraftSnapshotUploadUrlResponse>(
      `/documents/${encodeURIComponent(documentId)}/draft-snapshots/upload-url`,
      {
        method: 'POST',
      },
    );

    return {
      ...response,
      uploadUrl: this.resolveExternalUrl(response.uploadUrl),
    };
  }

  async appendDraftSnapshot(
    documentId: string,
    input: WhiteboardApiAppendDraftSnapshotInput,
  ): Promise<WhiteboardApiAppendDraftSnapshotResponse> {
    return this.requestJson<WhiteboardApiAppendDraftSnapshotResponse>(
      `/documents/${encodeURIComponent(documentId)}/draft-snapshots`,
      {
        body: input,
        method: 'POST',
      },
    );
  }

  async listDraftSnapshots(
    documentId: string,
    params: WhiteboardApiListDraftSnapshotsParams = {},
  ): Promise<WhiteboardApiListDraftSnapshotsResponse> {
    return this.requestJson<WhiteboardApiListDraftSnapshotsResponse>(
      `/documents/${encodeURIComponent(documentId)}/draft-snapshots`,
      {
        query: params,
      },
    );
  }

  async startSourcePdfMultipart(
    documentId: string,
    input: WhiteboardApiStartSourcePdfMultipartInput,
  ): Promise<WhiteboardApiStartSourcePdfMultipartResponse> {
    return this.requestJson<WhiteboardApiStartSourcePdfMultipartResponse>(
      `/documents/${encodeURIComponent(documentId)}/source-pdf/multipart/start`,
      {
        body: input,
        method: 'POST',
      },
    );
  }

  async getSourcePdfMultipartPartUrl(
    documentId: string,
    assetId: string,
    params: WhiteboardApiSourcePdfMultipartPartUrlParams,
  ): Promise<WhiteboardApiSourcePdfMultipartPartUrlResponse> {
    const response = await this.requestJson<WhiteboardApiSourcePdfMultipartPartUrlResponse>(
      `/documents/${encodeURIComponent(documentId)}/source-pdf/${encodeURIComponent(assetId)}/multipart/part-url`,
      {
        query: params,
      },
    );

    return {
      ...response,
      url: this.resolveExternalUrl(response.url),
    };
  }

  async listSourcePdfMultipartParts(
    documentId: string,
    assetId: string,
    params: {
      uploadId: string;
    },
  ): Promise<WhiteboardApiSourcePdfMultipartPartsResponse> {
    return this.requestJson<WhiteboardApiSourcePdfMultipartPartsResponse>(
      `/documents/${encodeURIComponent(documentId)}/source-pdf/${encodeURIComponent(assetId)}/multipart/parts`,
      {
        query: params,
      },
    );
  }

  async completeSourcePdfMultipart(
    documentId: string,
    assetId: string,
    input: WhiteboardApiCompleteSourcePdfMultipartInput,
  ): Promise<WhiteboardApiConfirmSourcePdfResponse> {
    return this.requestJson<WhiteboardApiConfirmSourcePdfResponse>(
      `/documents/${encodeURIComponent(documentId)}/source-pdf/${encodeURIComponent(assetId)}/multipart/complete`,
      {
        body: input,
        method: 'POST',
      },
    );
  }

  async confirmSourcePdfUpload(
    documentId: string,
    input: WhiteboardApiConfirmSourcePdfInput,
  ): Promise<WhiteboardApiConfirmSourcePdfResponse> {
    return this.requestJson<WhiteboardApiConfirmSourcePdfResponse>(
      `/documents/${encodeURIComponent(documentId)}/source-pdf/confirm`,
      {
        body: input,
        method: 'POST',
      },
    );
  }

  async listSourcePdfs(documentId: string): Promise<WhiteboardApiSourcePdfAsset[]> {
    return this.requestJson<WhiteboardApiSourcePdfAsset[]>(`/documents/${encodeURIComponent(documentId)}/source-pdfs`);
  }

  async updateSourcePdfReferences(
    documentId: string,
    assetId: string,
    input: WhiteboardApiUpdateSourcePdfReferencesInput,
  ): Promise<Pick<WhiteboardApiSourcePdfAsset, '_id' | 'referenceCount'>> {
    return this.requestJson<Pick<WhiteboardApiSourcePdfAsset, '_id' | 'referenceCount'>>(
      `/documents/${encodeURIComponent(documentId)}/source-pdf/${encodeURIComponent(assetId)}/references`,
      {
        body: input,
        method: 'PATCH',
      },
    );
  }

  async deleteSourcePdf(
    documentId: string,
    assetId: string,
    options: {
      force?: boolean;
    } = {},
  ): Promise<WhiteboardApiMessageResponse> {
    return this.requestJson<WhiteboardApiMessageResponse>(
      `/documents/${encodeURIComponent(documentId)}/source-pdf/${encodeURIComponent(assetId)}`,
      {
        method: 'DELETE',
        query: options,
      },
    );
  }

  getSourcePdfReadAccess(documentId: string, assetId: string): WhiteboardApiSourcePdfReadAccess {
    return {
      headers: this.authHeaders(),
      url: this.buildUrl(`/documents/${encodeURIComponent(documentId)}/source-pdf/${encodeURIComponent(assetId)}/read`),
    };
  }

  /**
   * The API's origin, plus the headers a request to it must carry.
   *
   * Exposed for the one case the JSON endpoints don't cover: downloading a file whose URL the
   * API hands back rather than serving itself. The caller has to decide, by origin, which
   * client fetches it — and getting that wrong is not a style question:
   *
   *  - our own API is auth-guarded, so a fetch there without `headers` gets a 401;
   *  - public object storage allows a plain `GET` and advertises no
   *    `Access-Control-Allow-Headers`, so a fetch there WITH `headers` forces a preflight the
   *    bucket refuses — and mails the caller's token to a third party on the way.
   *
   * Nothing here performs a request; it is the same pair {@link getSourcePdfReadAccess} hands
   * out, minus a path.
   */
  getRequestAccess(): WhiteboardApiRequestAccess {
    return { apiOrigin: new URL(this.baseUrl).origin, headers: this.authHeaders() };
  }

  async getLatest(documentId: string): Promise<WhiteboardApiLatestResponse> {
    return this.requestJson<WhiteboardApiLatestResponse>(`/documents/${encodeURIComponent(documentId)}/latest`);
  }

  async getVersionHistory(documentId: string): Promise<WhiteboardApiVersionHistoryResponse> {
    return this.requestJson<WhiteboardApiVersionHistoryResponse>(
      `/documents/${encodeURIComponent(documentId)}/versions`,
    );
  }

  /**
   * Server-merge (mechanism #3): request a presigned destination for ONE per-page overlay PNG. The
   * caller PUTs the PNG bytes to the returned `uploadUrl` via {@link uploadToWhiteboardPresignedUrl}
   * and keeps `storageKey` as the manifest `overlayKey`. The relative proxy `uploadUrl` is
   * normalized against the API origin, mirroring the source-pdf / draft-snapshot upload-url flows.
   */
  async createMergeOverlayUploadUrl(documentId: string): Promise<MergeOverlayUploadUrl> {
    const response = await this.requestJson<MergeOverlayUploadUrl>(
      `/documents/${encodeURIComponent(documentId)}/merge-overlays/upload-url`,
      {
        method: 'POST',
      },
    );

    return {
      ...response,
      uploadUrl: this.resolveExternalUrl(response.uploadUrl),
    };
  }

  /**
   * Server-merge (mechanism #3): enqueue a merged-version render. The board sends `pages[]` (the
   * geometry manifest); a teacher/studio re-trigger omits `pages` so the backend reuses the stored
   * manifest (throws {@link WhiteboardApiError} with status 409 if none exists yet). Returns the
   * queued job to poll via {@link getVersionJob}.
   */
  async generateVersion(documentId: string, body: GenerateVersionRequest = {}): Promise<GenerateVersionResponse> {
    return this.requestJson<GenerateVersionResponse>(`/documents/${encodeURIComponent(documentId)}/versions/generate`, {
      body,
      method: 'POST',
    });
  }

  /**
   * Server-merge (mechanism #3): STAGE the board's current overlays for the on-demand download path
   * WITHOUT rendering. Upserts the single transient manifest per {document, teacher} that a
   * teacher/studio "download" ({@link generateVersion} with no `pages`) merges from; never enqueues
   * a job and never mints a numbered version. Re-staging supersedes the previous transient artifact.
   * The board calls this on close and after a quiet spell — see the app's `stage-scheduler`.
   */
  async stageVersion(documentId: string, body: StageVersionRequest): Promise<StageVersionResponse> {
    return this.requestJson<StageVersionResponse>(`/documents/${encodeURIComponent(documentId)}/versions/stage`, {
      body,
      method: 'POST',
    });
  }

  /** Server-merge (mechanism #3): poll a generate job. On `done` the `pdfUrl` is the version download. */
  async getVersionJob(documentId: string, jobId: string): Promise<VersionJobStatus> {
    return this.requestJson<VersionJobStatus>(
      `/documents/${encodeURIComponent(documentId)}/versions/jobs/${encodeURIComponent(jobId)}`,
    );
  }

  private buildUrl(path: string, query?: object): string {
    const url = new URL(path.replace(/^\//, ''), `${this.baseUrl}/`);

    if (query) {
      for (const [key, value] of Object.entries(query as Record<string, QueryValue>)) {
        if (value === undefined || value === null || value === '') {
          continue;
        }

        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  private normalizeUploadUrl(upload: WhiteboardApiUploadUrl): WhiteboardApiUploadUrl {
    return {
      ...upload,
      uploadUrl: this.resolveExternalUrl(upload.uploadUrl),
    };
  }

  private resolveExternalUrl(value: string): string {
    if (!value) {
      return value;
    }

    try {
      return new URL(value).toString();
    } catch {
      const apiOrigin = new URL(this.baseUrl).origin;

      if (value.startsWith('/')) {
        return new URL(value, `${apiOrigin}/`).toString();
      }

      return new URL(value, `${this.baseUrl}/`).toString();
    }
  }

  private async requestJson<T>(
    path: string,
    options: {
      body?: unknown;
      headers?: HeadersInit;
      method?: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
      query?: object;
      /**
       * A body that is ALREADY serialized — sent verbatim, and the caller owns any
       * `Content-Encoding` that describes it. Exists for the one compressed endpoint
       * ({@link WhiteboardApiClient.uploadPenCaptures}); every other call passes `body` and is
       * `JSON.stringify`'d here exactly as before.
       */
      rawBody?: BodyInit;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const headers = new Headers(options.headers);
    // Either way the payload IS JSON — a gzipped body is still `Content-Type: application/json`,
    // with `Content-Encoding` describing how it was packed.
    const hasJsonBody = options.rawBody !== undefined || options.body !== undefined;

    headers.set('Accept', 'application/json');

    for (const [name, value] of Object.entries(this.authHeaders())) {
      headers.set(name, value);
    }

    if (hasJsonBody && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    // Abort on our own timer, while still honouring a caller's signal: whichever fires first wins.
    // Built by hand rather than with `AbortSignal.any` — this package runs in the Tauri WebView and
    // in Node test environments, and `any` is not available everywhere both of those land.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
    const abortFromCaller = () => timeoutController.abort();

    options.signal?.addEventListener('abort', abortFromCaller);

    let response: Response;

    try {
      response = await this.fetcher(this.buildUrl(path, options.query), {
        body: options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
        headers,
        method: options.method ?? 'GET',
        signal: timeoutController.signal,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }

    const responseText = await response.text();
    const responseBody = responseText ? this.safeParseJson(responseText) : null;

    if (!response.ok) {
      const message = this.extractErrorMessage(responseBody, response.statusText);

      throw new WhiteboardApiError(message, response.status, responseBody);
    }

    return responseBody as T;
  }

  private extractErrorMessage(body: unknown, fallback: string): string {
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
      return body.message;
    }

    return fallback || 'Whiteboard API request failed.';
  }

  private safeParseJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}

export function createWhiteboardApiClient(options: WhiteboardApiClientOptions): WhiteboardApiClient {
  return new WhiteboardApiClient(options);
}
