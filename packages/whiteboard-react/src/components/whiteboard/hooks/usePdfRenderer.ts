import { useCallback, useEffect, useRef, useState } from 'react';

import { importPdfFile, inspectPdfFile } from '../utils/pdfAssetRenderer';
import { useWbLocale } from '../../../i18n/context';
import { wbT } from '../../../i18n/strings';

import type { PdfImportNativeRescue, PdfImportResult, PdfImportSummary } from '../utils/pdfAssetRenderer';

const DEFAULT_PDF_MODULE_SRC = '/pdf.min.mjs';

export interface UsePdfRendererReturn {
  analyzePdfFile: (file: File, pageRange?: string) => Promise<PdfImportSummary | null>;
  importPdfFile: (file: File, pageRange?: string) => Promise<PdfImportResult | null>;
  error: string | null;
  /**
   * Warnings from the LAST import — including the «Couldn't process …» line naming pages that came back
   * as placeholders. Separate from `error`: the import succeeded, so it must not be shown as a
   * failure, but the teacher still has to be told which pages need re-uploading.
   */
  importWarnings: string[];
  isAnalyzing: boolean;
  isRendering: boolean;
  progress: number;
}

/**
 * @param nativeRescue - Optional host-provided native (PDFium) renderer used as the TIER-2 fallback
 *   for a page pdf.js cannot rasterize, before the placeholder. Web hosts pass nothing and
 *   keep the pdf.js → placeholder behaviour unchanged.
 */
export function usePdfRenderer(
  workerSrc = '/pdf.worker.min.mjs',
  moduleSrc = DEFAULT_PDF_MODULE_SRC,
  nativeRescue?: PdfImportNativeRescue,
): UsePdfRendererReturn {
  const locale = useWbLocale();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const abortRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      abortRef.current = true;
    };
  }, []);

  const analyzePdfFile = useCallback(
    async (file: File, pageRange?: string): Promise<PdfImportSummary | null> => {
      setIsAnalyzing(true);
      setError(null);

      try {
        return await inspectPdfFile(file, {
          locale,
          moduleSrc,
          pageRange,
          workerSrc,
        });
      } catch (err) {
        // The engine string is turned into friendly copy by the modal, so keep the real error here.
        console.error('[usePdfRenderer] inspecting the PDF failed', err);

        const message = err instanceof Error ? err.message : wbT(locale, 'renderer.readFailed');

        if (mountedRef.current) {
          setError(message);
        }

        return null;
      } finally {
        if (mountedRef.current) {
          setIsAnalyzing(false);
        }
      }
    },
    [locale, moduleSrc, workerSrc],
  );

  const importPdf = useCallback(
    async (file: File, pageRange?: string): Promise<PdfImportResult | null> => {
      setIsRendering(true);
      setProgress(0);
      setError(null);
      setImportWarnings([]);
      abortRef.current = false;

      try {
        const result = await importPdfFile(file, {
          locale,
          moduleSrc,
          nativeRescue,
          onProgress: (nextProgress) => {
            if (mountedRef.current && !abortRef.current) {
              setProgress(nextProgress);
            }
          },
          pageRange,
          // The board draws pages lazily from the stored PDF; the import previews were never shown.
          previews: false,
          workerSrc,
        });

        if (abortRef.current) {
          return null;
        }

        if (mountedRef.current) {
          // A single page can fail without failing the import; the summary carries the notice
          // naming it. Progress is pinned to 100 here so the bar always completes, even if the last
          // page was the bad one.
          setImportWarnings(result.summary.warnings);
          setProgress(100);
        }

        return result;
      } catch (err) {
        console.error('[usePdfRenderer] importing the PDF failed', err);

        const message = err instanceof Error ? err.message : wbT(locale, 'renderer.processFailed');

        if (mountedRef.current) {
          setError(message);
        }

        return null;
      } finally {
        if (mountedRef.current) {
          setIsRendering(false);
        }
      }
    },
    [locale, moduleSrc, nativeRescue, workerSrc],
  );

  return {
    analyzePdfFile,
    error,
    importPdfFile: importPdf,
    importWarnings,
    isAnalyzing,
    isRendering,
    progress,
  };
}
