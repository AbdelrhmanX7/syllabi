import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
import React from 'react';

import type { UsePdfPageImageNativeCapability } from './usePdfPageImage';

/**
 * The PDF background pre-warm chain, pinned to what the studio incident taught us.
 *
 * The teacher reported the board «very very slow on writing, laggy and jittering» while annotating
 * a PDF-backed board. The warm chain was rendering, at FULL live resolution, the entire remaining
 * document for any PDF of <= 80 pages, one page at a time, through the single PDFium worker — and
 * once a warm's `fetch` was issued nothing stopped it, so renders ran straight through strokes.
 * Its dedupe also sat AFTER the idle wait, so an already-warmed page still cost a full idle window
 * and the chain never advanced on a board being written to.
 */

const REAL_SET_TIMEOUT = globalThis.setTimeout;

/**
 * Long enough for the chain's 300 ms kickoff plus a full WARM_INPUT_IDLE_MS (1500 ms) idle window —
 * an earlier test's simulated stroke leaves `lastInputAt` recent, so the first warm of the next
 * test really does wait it out.
 */
const WARM_CHAIN_SETTLE_MS = 2200;
/** Per-page hop in the chain (the requestIdleCallback-less setTimeout fallback), plus slack. */
const WARM_STEP_MS = 260;

/** Warm URLs the stubbed native capability was asked for, in order. */
let warmUrlRequests: Array<{ edge: number; pageIndex: number }> = [];
/** Every `fetch` the hook issued, with the signal it passed. */
let fetchCalls: Array<{ signal?: AbortSignal; url: string }> = [];
/** When set, `fetch` never settles — lets a test inspect an in-flight warm. */
let holdFetch = false;

before(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const globals = globalThis as unknown as {
    document?: unknown;
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    Image?: unknown;
    window?: unknown;
  };

  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });

  // The LIVE page load goes through the shared image loader; give it something that resolves.
  class StubImage {
    crossOrigin: string | null = null;
    decoding = '';
    naturalHeight = 0;
    naturalWidth = 0;
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    private srcValue = '';

    get src(): string {
      return this.srcValue;
    }

    set src(value: string) {
      this.srcValue = value;
      queueMicrotask(() => {
        this.naturalWidth = 2546;
        this.naturalHeight = 3600;
        this.onload?.();
      });
    }

    async decode(): Promise<void> {}
  }

  globals.Image = StubImage;
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { signal?: AbortSignal }) => {
    fetchCalls.push({ signal: init?.signal, url: String(url) });

    if (holdFetch) {
      return await new Promise(() => {});
    }

    return { ok: true, status: 204 };
  };
});

beforeEach(() => {
  warmUrlRequests = [];
  fetchCalls = [];
  holdFetch = false;
});

/** Real-timer sleep (the hook schedules its chain on 300 ms + 200 ms window.setTimeout hops). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    REAL_SET_TIMEOUT(resolve, ms);
  });
}

/** One tap: down then up, the way a real contact ends. A contact that never lifts is still "interacting". */
function dispatchInput(): void {
  window.dispatchEvent(new window.Event('pointerdown'));
  window.dispatchEvent(new window.Event('pointerup'));
}

/**
 * ONE stable capability object for the whole file. The hook's effects depend on `nativePdf` by
 * identity, so a fresh object per render re-runs them forever (the host app memoizes it for the
 * same reason).
 */
const nativePdf: UsePdfPageImageNativeCapability = (() => {
  return {
    ensureCached: async () => true,
    isAvailable: () => true,
    isCached: () => true,
    pageUrl: (assetId, pageIndex, targetEdge, opts) => {
      if (opts?.warmOnly || opts?.warm) {
        warmUrlRequests.push({ edge: targetEdge, pageIndex });
      }

      return `http://pdfpage.localhost/render?asset=${assetId}&page=${pageIndex}&edge=${targetEdge}${
        opts?.warmOnly ? '&warm=1&warmonly=1' : ''
      }`;
    },
  };
})();

interface MountOptions {
  assetId: string;
  pageCount: number;
  pageIndex: number;
  /** Override the handwriting idle gate; omitted = the hook's default (the production value). */
  warmInputIdleMs?: number;
}

async function mountHook({ assetId, pageCount, pageIndex, warmInputIdleMs }: MountOptions) {
  const { usePdfPageImage } = await import('./usePdfPageImage');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  const loadPdfAsset = async () =>
    ({ blob: new Blob(['%PDF-1.4']), id: assetId, name: 'lesson.pdf', pageCount, size: 1024 }) as never;

  function Host({ page }: { page: number }): null {
    usePdfPageImage({
      containerHeight: 1080,
      containerWidth: 1920,
      loadPdfAsset,
      nativePdf,
      page: { id: `p${page}`, pdfAssetId: assetId, pdfPageIndex: page },
      warmInputIdleMs,
      zoom: 1,
    });

    return null;
  }

  const container = document.createElement('div');

  document.body.appendChild(container);

  const root = createRoot(container);

  await act(async () => {
    root.render(<Host page={pageIndex} />);
  });

  return {
    render: async (page: number) => {
      await act(async () => {
        root.render(<Host page={page} />);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

test('warming covers the near window only — never the rest of the document', async () => {
  // A 40-page PDF used to get all 40 pages rendered at full live resolution during the lesson
  // (<= PDF_PREFETCH_FULL_DOC_MAX_PAGES = 80), one after another on the single PDFium worker.
  const host = await mountHook({ warmInputIdleMs: 1500, assetId: 'near-window', pageCount: 40, pageIndex: 10 });

  try {
    await wait(WARM_CHAIN_SETTLE_MS + 8 * WARM_STEP_MS);

    const warmed = fetchCalls.map((call) => Number(new URL(call.url).searchParams.get('page'))).sort((a, b) => a - b);

    assert.deepEqual(warmed, [9, 11, 12], '2 ahead + 1 behind, and nothing else');
  } finally {
    await host.unmount();
  }
});

test('a warm already in flight is aborted the moment the teacher touches the board', async () => {
  holdFetch = true;

  const host = await mountHook({ warmInputIdleMs: 1500, assetId: 'abortable', pageCount: 12, pageIndex: 0 });

  try {
    await wait(WARM_CHAIN_SETTLE_MS);

    assert.equal(fetchCalls.length, 1, 'exactly one warm is in flight (they run one at a time)');
    assert.ok(fetchCalls[0]?.signal, 'the warm fetch must carry an AbortSignal');
    assert.equal(fetchCalls[0]?.signal?.aborted, false);

    dispatchInput();

    assert.equal(fetchCalls[0]?.signal?.aborted, true, 'a stroke must drop the in-flight warm response');
  } finally {
    await host.unmount();
  }
});

test('unmounting aborts an in-flight warm instead of letting it land', async () => {
  holdFetch = true;

  const host = await mountHook({ warmInputIdleMs: 1500, assetId: 'cleanup-aborts', pageCount: 12, pageIndex: 0 });
  let inFlight: AbortSignal | undefined;

  try {
    await wait(WARM_CHAIN_SETTLE_MS);

    inFlight = fetchCalls[0]?.signal;

    assert.ok(inFlight, 'a warm must be in flight to test the cleanup');
  } finally {
    await host.unmount();
  }

  assert.equal(inFlight?.aborted, true, 'the effect cleanup must abort what it started');
});

test('an already-warmed page short-circuits BEFORE paying an idle window', async () => {
  // Warm page 0's window with the teacher hands-off, so pages 1..2 are recorded as warmed.
  const host = await mountHook({ warmInputIdleMs: 1500, assetId: 'dedupe-first', pageCount: 30, pageIndex: 0 });

  try {
    await wait(WARM_CHAIN_SETTLE_MS + 6 * WARM_STEP_MS);

    const firstPassPages = fetchCalls.map((call) => Number(new URL(call.url).searchParams.get('page')));

    assert.deepEqual(
      firstPassPages.sort((a, b) => a - b),
      [1, 2],
    );

    fetchCalls = [];
    warmUrlRequests = [];

    // Now write on the board continuously and move to page 1. Its window is 2..3 + 0; page 2 is
    // already warmed. With the dedupe AFTER the idle wait (the bug) the chain would sit on page 2
    // forever and `pageUrl` would never be called at all. With it BEFORE, the warmed page is
    // recognised instantly and only the genuinely-new page (3) parks on the idle gate.
    const keepWriting = setInterval(dispatchInput, 50);

    dispatchInput();
    await host.render(1);
    await wait(WARM_CHAIN_SETTLE_MS + 6 * WARM_STEP_MS);
    clearInterval(keepWriting);

    const consideredPages = warmUrlRequests.map((request) => request.pageIndex);

    for (const page of [2, 3]) {
      assert.ok(consideredPages.includes(page), `page ${page} must be dedupe-checked without waiting for idle`);
    }

    assert.equal(fetchCalls.length, 0, 'and none of them may be re-fetched');
  } finally {
    await host.unmount();
  }
});

test('warm URLs are requested at the LIVE render edge, so the warmed raster is the one a page switch asks for', async () => {
  const host = await mountHook({ warmInputIdleMs: 1500, assetId: 'edge-match', pageCount: 12, pageIndex: 0 });

  try {
    await wait(WARM_CHAIN_SETTLE_MS + 2 * WARM_STEP_MS);

    assert.ok(warmUrlRequests.length > 0);

    const edges = new Set(warmUrlRequests.map((request) => request.edge));

    assert.equal(edges.size, 1, 'one edge for the whole window — a mismatched edge is a guaranteed cache miss');
  } finally {
    await host.unmount();
  }
});

test('with the DEFAULT gate, one tap silences warming for far longer than the old 1.5 s window', async () => {
  // The ViewSonic (Intel HD 530, recording the lesson at the same time) showed the pen stuttering on
  // PDF boards: every >=1.5 s pause in handwriting started a full-resolution PDFium render, up to
  // eight per visited page. A natural writing rhythm is FULL of 1.5 s pauses. The gate is now the
  // same order as the rest of the app's "device is idle" definition (10 s).
  const host = await mountHook({ assetId: 'default-gate', pageCount: 12, pageIndex: 0 });

  try {
    dispatchInput();
    // ~2.7 s: kickoff + the OLD idle window + a hop — the old code has warmed page 1 by now.
    await wait(WARM_CHAIN_SETTLE_MS + 2 * WARM_STEP_MS);

    assert.equal(fetchCalls.length, 0, 'no warm render may start 2.7 s after the pen was on the glass');
  } finally {
    await host.unmount();
  }
});
