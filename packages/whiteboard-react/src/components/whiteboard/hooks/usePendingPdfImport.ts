import { useCallback, useEffect, useState } from 'react';

import type { Dispatch, SetStateAction } from 'react';

export interface UsePendingPdfImportResult {
  pdfModalOpen: boolean;
  setPdfModalOpen: Dispatch<SetStateAction<boolean>>;
  /**
   * The captured host selection the import modal must preload. Cleared whenever the modal closes.
   *
   * A LIST, not one file: a picker and a drop can both carry several files, and the modal owns the
   * decision of what that selection means (one PDF, a run of images, or a refused mix) — splitting
   * that decision across the two callers is how they came to disagree.
   */
  pendingImportFiles: File[] | null;
  /**
   * Open the import modal preloaded with files the board itself captured — a drag-and-drop onto the
   * canvas. Same one-shot contract as the host path: they live here until the modal closes.
   */
  startImportWithFiles: (files: File[]) => void;
  /** Single-file convenience over {@link startImportWithFiles}. */
  startImportWithFile: (file: File) => void;
}

/**
 * A host-supplied import opens the same modal the toolbar button opens. Notifying immediately
 * (rather than when the modal closes) keeps this a one-shot: the host clears its reference, and a
 * teacher who then cancels the modal is not re-prompted with the same file forever.
 *
 * The file must be captured locally BEFORE notifying: React batches the host's clear into the same
 * commit that opens the modal, so on the modal's first open render the host prop is already null —
 * reading it directly means the preload never sees a file.
 */
export function usePendingPdfImport(
  pendingPdfImport: File | null | undefined,
  onPendingPdfImportHandled: (() => void) | undefined,
): UsePendingPdfImportResult {
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [pendingImportFiles, setPendingImportFiles] = useState<File[] | null>(null);

  useEffect(() => {
    if (pendingPdfImport) {
      setPendingImportFiles([pendingPdfImport]);
      setPdfModalOpen(true);
      onPendingPdfImportHandled?.();
    }
  }, [onPendingPdfImportHandled, pendingPdfImport]);

  useEffect(() => {
    if (!pdfModalOpen) {
      setPendingImportFiles(null);
    }
  }, [pdfModalOpen]);

  const startImportWithFiles = useCallback((files: File[]) => {
    if (files.length === 0) {
      return;
    }

    setPendingImportFiles(files);
    setPdfModalOpen(true);
  }, []);

  const startImportWithFile = useCallback(
    (file: File) => {
      startImportWithFiles([file]);
    },
    [startImportWithFiles],
  );

  return { pdfModalOpen, pendingImportFiles, setPdfModalOpen, startImportWithFile, startImportWithFiles };
}
