import { useEffect, useRef, useState } from 'react';

import { createInputActivityAbortSignal, waitForInputIdle } from '../utils/inputActivity';
import { getRenderDeviceMemoryGb, loadCachedPdfAsset, resolveStoredPdfPageImageUrl } from '../utils/pdfAssetRenderer';
import { loadPdfPageImage } from '../utils/pdfPageImageLoader';
import { resolvePdfLiveRenderEdge } from '../utils/pdfRenderSizing';
import { recordPerf } from '../utils/perfHud';
import { perfMark } from '../utils/perfSpan';

import type { WhiteboardPdfAsset } from '@repo/whiteboard-core';
import type { InputActivityAbort } from '../utils/inputActivity';
import type { ResolveRemotePdfAsset } from '../utils/pdfAssetRenderer';

// Background PRE-WARM window: after the current page renders, quietly render this many pages AHEAD (the
// common teaching direction) and BEHIND into the native PERSISTENT disk render cache, so switching to
// them is instant instead of waiting on a fresh full-res PDFium render. Rendered ONE AT A TIME at idle so
// it never competes with the live page. Ahead-biased; tune here if a device struggles.
//
// SIZE THE WINDOW BY WHAT A PAGE TURN NEEDS, NOT BY WHAT THE CACHE COULD HOLD. A warm is a FULL-
// RESOLUTION PDFium render (it has to be — a warm at any other edge produces a different disk-cache key
// than the live view will ask for, i.e. a guaranteed miss and pure waste), and the measured cost of one
// is ~94 ms of JPEG encode for a 3125 px page on a DEV machine, on top of the render itself, on the ONE
// PDFium worker thread (pdf_render.rs). This window is what makes the next tap instant; pages far away
// are not "the next page" by any reading, and the teacher will have walked past them (warming each as
// they go) long before they get there.
// 2 ahead + 1 behind. It was 6 + 2: eight full-resolution renders per visited page, each one started
// by nothing more than a 1.5 s pause in handwriting — and a natural writing rhythm is FULL of 1.5 s
// pauses. On the studio's Intel HD 530 (recording the lesson on the same silicon) that read as the
// pen stuttering on every PDF board. A page turn needs its neighbour; the second page ahead covers a
// quick double flip; anything further is warmed when the teacher gets there.
const PDF_PREFETCH_AHEAD = 2;
const PDF_PREFETCH_BEHIND = 1;

/**
 * No warm render is issued until the teacher has been hands-off for this long (see warmPage).
 *
 * 10 s, not 1.5 s: the same order as the app's other "the device is idle" gate (background staging
 * waits 10 s too). A warm is speculation about a page turn that may never come; the pen is the
 * lesson. A pause shorter than this is the teacher thinking, not leaving.
 */
const WARM_INPUT_IDLE_MS = 10_000;

/**
 * Optional host-provided native (Rust/PDFium) PDF rendering capability. When
 * present and available, the hook renders pages natively and only falls back to
 * the pdf.js path on any failure. The package never imports the implementation;
 * the host app (e.g. the Tauri desktop shell) supplies it.
 */
export interface UsePdfPageImageNativeCapability {
  /** Whether native rendering is available in the current runtime. */
  isAvailable: () => boolean;
  /** Ensure the PDF's bytes are cached natively (streamed from the blob in chunks). `true` on success. */
  ensureCached: (assetId: string, blob: Blob) => Promise<boolean>;
  /** Sync check: are this asset's bytes already cached natively (so we can skip re-reading the blob)? */
  isCached: (assetId: string) => boolean;
  /** Whether the native push already failed for this asset this session (skip native entirely if so). */
  hasFailed?: (assetId: string) => boolean;
  /** The last native error message, for diagnostics in the perf HUD. */
  lastError?: () => string;
  /**
   * The custom-protocol URL for a rendered page image. Live page loads call it WITHOUT `opts` (HIGH
   * priority on the native render queue); background pre-warms pass `{ warm: true }`, which the host
   * encodes into the URL so the native side treats them as LOW priority (never delaying a live load)
   * while still writing the result to the same disk-cache entry the live URL will hit. `warmOnly`
   * additionally makes the native side answer an EMPTY 204 after caching — no image bytes ever
   * reach the WebView, so a warm can never cost a main-thread image decode (fetch it, don't <img>
   * it).
   */
  pageUrl: (
    assetId: string,
    pageIndex: number,
    targetEdge: number,
    opts?: { warm?: boolean; warmOnly?: boolean },
  ) => string;
}

/** Longest edge of the pdf.js STOPGAP render inside the desktop shell (see renderPdfAssetPageImageUrl.maxEdge). */
const NATIVE_FALLBACK_PDFJS_MAX_EDGE = 2048;

interface UsePdfPageImageOptions {
  /**
   * Bumped by the host when an asset's bytes land in local storage after the page was first shown
   * (a cloud board's PDF downloaded in the background). Re-runs the resolve so the page flips from
   * the pdf.js stopgap to the native renderer without a page turn.
   */
  assetRevision?: number;
  containerHeight: number;
  containerWidth: number;
  loadPdfAsset: (id: string) => Promise<WhiteboardPdfAsset | null>;
  moduleSrc?: string;
  nativePdf?: UsePdfPageImageNativeCapability;
  /**
   * The native renderer is present but this asset has NO local bytes (a board pulled from the cloud
   * whose PDF was never cached here). The host should fetch and store the PDF so the next resolve is
   * native; until then the page renders through pdf.js on the main thread — the studio pen lag on
   * cloud boards (2026-09-13).
   */
  onLocalBlobMissing?: (assetId: string) => void;
  page: {
    id: string;
    pdfAssetId?: string;
    pdfImageUrl?: string;
    pdfPageIndex?: number;
  } | null;
  resolveRemotePdfAsset?: ResolveRemotePdfAsset;
  /** Hands-off time before a background warm may start. Default {@link WARM_INPUT_IDLE_MS}; tests shorten it. */
  warmInputIdleMs?: number;
  workerSrc?: string;
  zoom: number;
}

interface UsePdfPageImageResult {
  imageUrl?: string;
  isLoading: boolean;
}

export function usePdfPageImage({
  assetRevision,
  containerHeight,
  containerWidth,
  loadPdfAsset,
  moduleSrc,
  nativePdf,
  onLocalBlobMissing,
  page,
  resolveRemotePdfAsset,
  warmInputIdleMs,
  workerSrc,
  zoom,
}: UsePdfPageImageOptions): UsePdfPageImageResult {
  const [imageUrl, setImageUrl] = useState<string | undefined>(page?.pdfImageUrl);
  const [isLoading, setIsLoading] = useState(false);
  // Remembers the last rendered page's real aspect ratio (width/height) so the NEXT render (on zoom /
  // resize) sizes the raster to exactly cover the fit-to-width display instead of assuming A4 portrait.
  // Keyed by asset+page so switching pages never reuses a stale aspect.
  const pageAspectRef = useRef<{ key: string; aspect: number } | null>(null);
  const onLocalBlobMissingRef = useRef(onLocalBlobMissing);

  onLocalBlobMissingRef.current = onLocalBlobMissing;
  // pdfpage:// URLs already pre-warmed this session, so navigating around doesn't re-issue them.
  const prefetchedUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setImageUrl(page?.pdfImageUrl);
  }, [page?.id, page?.pdfImageUrl]);

  useEffect(() => {
    if (!page) {
      setImageUrl(undefined);
      setIsLoading(false);
      return;
    }

    if (!page.pdfAssetId || page.pdfPageIndex === undefined || containerWidth <= 0 || containerHeight <= 0) {
      setImageUrl(page.pdfImageUrl);
      setIsLoading(false);
      return;
    }

    let isActive = true;

    setIsLoading(true);

    // Publish the ACTUAL width the raster is being sized from, for the on-board PDF debug overlay. This
    // is the smoking gun for the soft-PDF bug: if the display is full-width (e.g. 1916) but this shows
    // cw≈480, the raster is sized off a stale pre-layout width (width-wiring), not the render formula.
    if (typeof window !== 'undefined') {
      (window as unknown as { __pdfDebugSizer?: { cw: number; edge?: number; path: string } }).__pdfDebugSizer = {
        cw: Math.round(containerWidth),
        path: 'pending',
      };
    }

    void (async () => {
      // Native-first: inside the desktop shell, render the page with Rust/PDFium
      // and load it from the custom protocol. Any failure falls through to the
      // unchanged pdf.js path below — native is purely additive.
      const pdfAssetId = page.pdfAssetId;
      const pdfPageIndex = page.pdfPageIndex;

      if (nativePdf?.isAvailable() && pdfAssetId && pdfPageIndex !== undefined && !nativePdf.hasFailed?.(pdfAssetId)) {
        const __t = performance.now();
        let reason = '';

        try {
          // Only read the (large) blob the first time per asset; afterwards the bytes are already cached.
          let ready = nativePdf.isCached(pdfAssetId);
          let asset = null;

          if (!ready) {
            asset = await loadCachedPdfAsset(pdfAssetId, loadPdfAsset);

            if (asset?.blob) {
              // Pass the Blob (not a materialized ArrayBuffer) so the native side can stream it in
              // chunks — materializing a 250MB PDF here OOM-crashes the WebView.
              ready = await nativePdf.ensureCached(pdfAssetId, asset.blob);
              if (!ready) reason = 'ensure-failed';
            } else {
              reason = 'no-blob';
              onLocalBlobMissingRef.current?.(pdfAssetId);
            }
          }

          if (ready) {
            // edge: reuse asset size/pageCount when we loaded it, else fall back to the page's own values via a cheap asset load only if needed.
            const sizedAsset = asset ?? (await loadCachedPdfAsset(pdfAssetId, loadPdfAsset));
            const aspectKey = `${pdfAssetId}:${pdfPageIndex}`;
            const targetEdge = resolvePdfLiveRenderEdge({
              containerHeight,
              containerWidth,
              deviceMemoryGb: getRenderDeviceMemoryGb(),
              fileSize: sizedAsset?.size ?? 0,
              // Size the raster to cover the fit-to-width display at THIS page's real aspect once known
              // (from a prior render); until then resolvePdfLiveRenderEdge assumes A4 portrait so a tall
              // page's width is never under-rendered.
              pageAspectRatio: pageAspectRef.current?.key === aspectKey ? pageAspectRef.current.aspect : undefined,
              totalPages: sizedAsset?.pageCount ?? 1,
              zoom,
            });

            if (typeof window !== 'undefined') {
              (window as unknown as { __pdfDebugSizer?: { cw: number; edge?: number; path: string } }).__pdfDebugSizer =
                { cw: Math.round(containerWidth), edge: targetEdge, path: 'native' };
            }

            const url = nativePdf.pageUrl(pdfAssetId, pdfPageIndex, targetEdge);
            // Verify the native image actually renders before committing — otherwise fall back to pdf.js
            // (so a broken protocol can never leave a blank page). Also capture its real aspect so the
            // next render for this page is sized exactly (no over-render on wide pages).
            //
            // ONE LOAD, NOT TWO: this used to be a bare `new Image()` with no crossOrigin, while
            // WhiteboardCanvas immediately loaded the SAME url with crossOrigin='anonymous' — a
            // different Chromium cache key, so nothing was reused, and WebView2 does not HTTP-cache
            // the custom protocol either (WebView2Feedback#4687). Both loads therefore reached Rust
            // and shipped ~37 MB of decoded RGBA (2546x3600 at the default `high` quality) through a
            // main-thread decode. `loadPdfPageImage` is the shared, crossOrigin-consistent loader:
            // the canvas's load is now a cache hit on this exact HTMLImageElement.
            const image = await loadPdfPageImage(url);

            if (image) {
              pageAspectRef.current = { key: aspectKey, aspect: image.naturalWidth / image.naturalHeight };

              if (isActive) {
                setImageUrl(url);
                setIsLoading(false);
              }
              recordPerf(`pdf img p${pdfPageIndex}`, performance.now() - __t, 'native');

              return;
            }
            reason = 'url-failed';
          }
        } catch {
          reason = 'exception';
        }

        // record WHY native didn't win, so the on-device report pinpoints it
        const nativeError = reason === 'ensure-failed' ? nativePdf.lastError?.() : undefined;

        recordPerf(
          `pdf img p${pdfPageIndex}`,
          performance.now() - __t,
          `pdf.js (native:${reason || 'unavailable'}${nativeError ? ` "${nativeError}"` : ''})`,
        );
      }

      if (typeof window !== 'undefined') {
        (window as unknown as { __pdfDebugSizer?: { cw: number; edge?: number; path: string } }).__pdfDebugSizer = {
          cw: Math.round(containerWidth),
          path: 'pdf.js',
        };
      }

      const __tPdfjs = performance.now();
      const resolvedImageUrl = await resolveStoredPdfPageImageUrl({
        containerHeight,
        containerWidth,
        deviceMemoryGb: getRenderDeviceMemoryGb(),
        loadPdfAsset,
        // Inside the shell pdf.js is a stopgap until the bytes are local: keep its main-thread
        // raster small. On the web it is THE renderer and keeps full quality.
        maxEdge: nativePdf?.isAvailable() ? NATIVE_FALLBACK_PDFJS_MAX_EDGE : undefined,
        moduleSrc,
        page,
        resolveRemotePdfAsset,
        workerSrc,
        zoom,
      });
      recordPerf(`pdf img p${page.pdfPageIndex}`, performance.now() - __tPdfjs, 'pdf.js');

      if (isActive) {
        setImageUrl(resolvedImageUrl);
        setIsLoading(false);
      }
    })().catch(() => {
      if (isActive) {
        setImageUrl(page.pdfImageUrl);
        setIsLoading(false);
      }
    });

    return () => {
      isActive = false;
    };
    // Depend on the page's STABLE identity fields, not the whole `page` object — the editor passes a
    // fresh object literal on every render (incl. every stroke), which would otherwise re-resolve the
    // PDF image on each stroke (wasted work + HUD noise). The body only reads these fields of `page`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    assetRevision,
    containerHeight,
    containerWidth,
    loadPdfAsset,
    moduleSrc,
    nativePdf,
    page?.id,
    page?.pdfAssetId,
    page?.pdfImageUrl,
    page?.pdfPageIndex,
    resolveRemotePdfAsset,
    workerSrc,
    zoom,
  ]);

  // Background pre-warm pages into the native render cache so page-switching is instant. Native (desktop)
  // path only — the on-demand full-res PDFium render is what makes an un-cached page slow; rendering it
  // ahead of time hides that latency. Warm requests carry `{ warmOnly: true }` → the Rust worker gives
  // live loads ABSOLUTE priority over warm renders, coalesces duplicate requests, and answers an empty
  // 204 so no image bytes ever enter the WebView; warmed pages land in a PERSISTENT disk cache (they
  // survive a restart). Runs ONE page at a time, ahead-biased, only while the teacher is hands-off, and
  // is fully cancelled the moment the page/asset/size changes. Uses the DEFAULT aspect for the warmed
  // pages so the warmed URL matches the one a page switch actually requests (a mismatched edge = a cache
  // miss = no speed-up).
  //
  // THREE THINGS THIS LOOP GETS WRONG IF YOU "SIMPLIFY" IT — each one was a measured cause of the pen
  // stuttering on the studio touchscreen:
  //
  // 1. It warms a WINDOW, never the document. The old code appended "every remaining page" for any PDF
  //    of <= 80 pages, at full live resolution — up to 80 PDFium renders + ~94 ms JPEG encodes each,
  //    queued through the single render worker, during the lesson. Deleted: see PDF_PREFETCH_AHEAD.
  // 2. The dedupe happens BEFORE the idle wait. It used to sit after it, so an already-warmed page still
  //    cost a full WARM_INPUT_IDLE_MS window — on a board being written to, the chain never advanced
  //    past its first few entries and stayed pending forever.
  // 3. Every warm fetch carries an AbortSignal that fires on the next pointer event. `waitForInputIdle`
  //    alone only gates the START of a warm; once `fetch` was issued nothing stopped it, so the response
  //    arrived mid-stroke. (The already-running native render still completes — it cannot be cancelled
  //    from here — but its bytes go to the disk cache and at most ONE render can overlap a stroke.)
  useEffect(() => {
    const assetId = page?.pdfAssetId;
    const centerIndex = page?.pdfPageIndex;

    if (
      !nativePdf?.isAvailable() ||
      !assetId ||
      centerIndex === undefined ||
      containerWidth <= 0 ||
      containerHeight <= 0 ||
      nativePdf.hasFailed?.(assetId)
    ) {
      return;
    }

    let cancelled = false;
    const warmIdleMs = warmInputIdleMs ?? WARM_INPUT_IDLE_MS;
    const timeoutIds: number[] = [];
    const idleIds: number[] = [];
    // Warm fetches currently in flight, so the effect's cleanup (page/asset/size change, unmount)
    // tears their listeners down and aborts them instead of leaving them to complete into nothing.
    const activeWarmAborts = new Set<InputActivityAbort>();
    const idle = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    const warmPage = (pageIndex: number, edge: number): Promise<void> =>
      new Promise((resolve) => {
        const start = async () => {
          if (cancelled) {
            resolve();
            return;
          }

          // `warmOnly` → LOW priority on the Rust queue AND an empty 204 response: the render
          // lands in the native disk cache (which the later live URL hits — `warm*` params are
          // excluded from the cache key) but NO image bytes enter the WebView. The old <img>
          // warming decoded ~13-megapixel images on the main thread — the other half of the
          // pen stutter.
          const url = nativePdf.pageUrl(assetId, pageIndex, edge, { warmOnly: true });

          // DEDUPE FIRST, THEN PAY FOR IDLE. This check used to sit AFTER waitForInputIdle, so
          // re-entering a document charged one full WARM_INPUT_IDLE_MS window per already-warmed
          // page: while the teacher writes, input never goes idle, so the chain sat pending and
          // never reached the pages that actually still needed rendering.
          if (prefetchedUrlsRef.current.has(url)) {
            resolve();
            return;
          }

          // NEVER warm while the teacher is interacting: a background PDFium render pegs a CPU
          // core, and on the weak board CPUs that contention showed up as the PEN stuttering
          // mid-stroke. Warming is pure speculation — it always yields to live input.
          await waitForInputIdle(warmIdleMs, () => cancelled);

          if (cancelled) {
            resolve();
            return;
          }

          // ...and it keeps yielding AFTER it started: the signal aborts on the next pointer
          // event, so a stroke that begins mid-warm drops the response instead of landing a
          // multi-MB protocol reply on the main thread the teacher is writing on.
          const input = createInputActivityAbortSignal();

          activeWarmAborts.add(input);

          const warmStartedAt = performance.now();

          try {
            const response = await fetch(url, { signal: input.signal });

            if (response.ok || response.status === 204) {
              prefetchedUrlsRef.current.add(url);
            }

            // Wall time of the native warm render (the request returns when PDFium is done); lets a
            // pointer-sample gap in the trace be lined up against a warm that overlapped it.
            perfMark('pdf-warm', performance.now() - warmStartedAt, `page=${pageIndex + 1} status=${response.status}`);
          } catch {
            // Aborted by input, or a network/protocol hiccup. Deliberately NOT marked warmed —
            // the next warm pass (or the live view) retries it.
          } finally {
            activeWarmAborts.delete(input);
            input.dispose();
          }

          resolve();
        };

        if (typeof idle.requestIdleCallback === 'function') {
          idleIds.push(idle.requestIdleCallback(() => void start(), { timeout: 1500 }));
        } else {
          timeoutIds.push(window.setTimeout(() => void start(), 200));
        }
      });

    const run = async () => {
      const asset = await loadCachedPdfAsset(assetId, loadPdfAsset);

      if (cancelled || !asset) {
        return;
      }

      const pageCount = asset.pageCount ?? 1;
      // Use the DEFAULT aspect (undefined ⇒ A4 portrait), NOT the current page's measured aspect: the live
      // view renders a freshly-navigated page at the default first (it only learns the real aspect AFTER
      // that render), so warming at the default is what makes the warmed pdfpage:// URL match the one the
      // switch actually requests — the whole point (a mismatched edge = a cache miss = no speed-up).
      const edge = resolvePdfLiveRenderEdge({
        containerHeight,
        containerWidth,
        deviceMemoryGb: getRenderDeviceMemoryGb(),
        fileSize: asset.size ?? 0,
        pageAspectRatio: undefined,
        totalPages: pageCount,
        zoom,
      });

      // The near window, and ONLY the near window — ahead first (the teaching direction), then behind.
      //
      // There used to be a second phase here that appended EVERY remaining page of any document of
      // <= 80 pages. It was removed on purpose: those are full-resolution PDFium renders (~94 ms of
      // JPEG encode alone for a 3125 px page on a dev machine, more on the studio board) funnelled
      // through the single render worker thread WHILE THE LESSON IS RUNNING, and the teacher reported
      // the pen stuttering and jittering exactly there. Warming page 60 while the teacher writes on
      // page 3 buys nothing a warm issued when they reach page 55 would not: the disk cache is
      // persistent, the near window travels with them, and a page turn only ever needs its neighbour.
      const targets: number[] = [];

      for (let d = 1; d <= PDF_PREFETCH_AHEAD; d += 1) {
        if (centerIndex + d < pageCount) targets.push(centerIndex + d);
      }
      for (let d = 1; d <= PDF_PREFETCH_BEHIND; d += 1) {
        if (centerIndex - d >= 0) targets.push(centerIndex - d);
      }

      for (const pageIndex of targets) {
        if (cancelled) {
          return;
        }

        await warmPage(pageIndex, edge);
      }
    };

    // Let the CURRENT page win the PDFium worker first, then warm neighbours.
    const kickoff = window.setTimeout(() => {
      void run();
    }, 300);

    timeoutIds.push(kickoff);

    return () => {
      cancelled = true;
      timeoutIds.forEach((id) => window.clearTimeout(id));
      idleIds.forEach((id) => idle.cancelIdleCallback?.(id));
      // A warm already in flight is speculation for a page/size that no longer applies — abort it
      // (and drop its input listener) rather than letting its response land.
      activeWarmAborts.forEach((input) => {
        input.abort();
        input.dispose();
      });
      activeWarmAborts.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativePdf, page?.pdfAssetId, page?.pdfPageIndex, containerWidth, containerHeight, zoom, loadPdfAsset, warmInputIdleMs]);

  return {
    imageUrl,
    isLoading,
  };
}
