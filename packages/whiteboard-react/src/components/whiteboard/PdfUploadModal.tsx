import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  buildImportAccept,
  DEFAULT_PDF_PAGE_RANGE,
  excludeImportedPdfPages,
  formatPdfPageRange,
  MAX_PDF_IMPORT_FILE_SIZE,
  MAX_PDF_IMPORT_PAGE_COUNT,
  routeImportSelection,
  suggestNextPdfPageRange,
} from '@repo/whiteboard-core';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Progress } from '@repo/ui';
import { AlertCircle, CheckCircle2, FileText, FileUp, Info, LoaderCircle, RotateCcw, Upload, X } from 'lucide-react';
import { motion } from 'motion/react';

import { usePdfRenderer } from './hooks/usePdfRenderer';
import { formatRescuedPdfPagesNotice } from './utils/pdfAssetRenderer';
import { describePdfImportError } from './utils/pdfImportErrorMessages';
import {
  PDF_IMPORT_ADVISORY_TITLE,
  PDF_PARTIAL_IMPORT_REASSURANCE,
  PDF_PARTIAL_IMPORT_TITLE,
  PDF_RESCUED_PAGES_TITLE,
  selectNewPdfImportWarnings,
} from './utils/pdfImportNotices';
import {
  buildPdfRangeSelection,
  getPdfRangeSelectionInputError,
  parsePdfRangeSelection,
} from './utils/pdfRangeSelection';

import { createStagedSourceTracker } from './utils/stagedSource';

import type { PdfImportNativeRescue, PdfImportResult, PdfImportSummary } from './utils/pdfAssetRenderer';
import { useWbStrings, type WbStrings } from '../../i18n/context';

interface PdfUploadModalProps {
  /**
   * Convert a picked PowerPoint file (.pptx/.ppt) into a PDF `File` (native desktop shell
   * only — the Rust side drives PowerPoint COM or LibreOffice). When absent, PowerPoint
   * files are rejected with the PDF-only message. Should throw an Error whose `message`
   * is user-presentable on failure.
   */
  convertOfficeFile?: (file: File) => Promise<File | null>;
  existingImports?: Array<{
    fileName: string;
    fingerprint: string;
    pageNumbers: number[];
  }>;
  isOpen: boolean;
  /**
   * Preload the modal with a file the host already has, instead of making the user pick one.
   *
   * Used when a file arrives over the LAN, or is dropped on the canvas, and the teacher chooses to
   * put it on the board they are already working on. It goes through the SAME flow as a hand-picked
   * selection — routing, page-range picker, duplicate-import hints, conversion — because "add pages
   * to this board" and "import a file" are the same operation, and giving those paths their own
   * shortcut would mean several import paths to keep correct.
   */
  initialFiles?: File[] | null;
  /**
   * Take a selection of IMAGES instead of a PDF — one page per photo, appended to the open board.
   *
   * Supplied by the editor. When absent the modal stays PDF-only (its `accept`, its copy and its
   * rejection message all follow this prop), so a host that cannot append image pages never offers
   * the teacher a picker that would only refuse what they chose.
   */
  onImagesSelected?: (files: File[]) => void;
  lastImportedPdf?: {
    fileName: string;
    fingerprint: string;
    importedRange: string;
    suggestedRange: string;
  } | null;
  /**
   * Host-provided native (PDFium) page renderer, used as the tier-2 fallback when pdf.js cannot
   * rasterize a page — so a malformed page still imports as a REAL page instead of a placeholder.
   * Only the desktop shell supplies it; web hosts omit it and nothing changes for them.
   */
  nativePdfRescue?: PdfImportNativeRescue;
  onClose: () => void;
  /**
   * Hand the imported pages to the board. `sourceFile` is the file the TEACHER picked, which is not
   * always the PDF that was imported: a PowerPoint pick is converted first, and only the original
   * `.pptx` still holds the deck's animations (slide intros). Null when the selection is unknown.
   */
  onPdfProcessed: (result: PdfImportResult, sourceFile: File | null) => void | Promise<void>;
  /**
   * A CONVERTED source file is leaving without being imported — the teacher cancelled, picked
   * another file, or the modal went away. Converting a PowerPoint writes a whole PDF to disk, so
   * the host has something to delete; a plain PDF pick is the teacher's own file and is never
   * reported. Fired exactly once per staged file.
   */
  onSourceDiscarded?: (sourceFile: File) => void;
  portalContainer?: Element;
  workerSrc?: string;
}

const formatFileSize = (bytes: number, t: WbStrings['t']): string => {
  if (bytes < 1024) return t('upload.size.bytes', { n: bytes });
  if (bytes < 1024 * 1024) return t('upload.size.kb', { n: (bytes / 1024).toFixed(1) });

  return t('upload.size.mb', { n: (bytes / (1024 * 1024)).toFixed(1) });
};

const PdfUploadModal: React.FC<PdfUploadModalProps> = ({
  convertOfficeFile,
  existingImports = [],
  lastImportedPdf,
  initialFiles,
  isOpen,
  nativePdfRescue,
  onClose,
  onImagesSelected,
  onPdfProcessed,
  onSourceDiscarded,
  portalContainer,
  workerSrc,
}) => {
  const { t, locale } = useWbStrings();
  const [file, setFile] = useState<File | null>(null);
  // The ORIGINAL pick behind `file` — identical to it for a PDF, the `.pptx` when one was converted.
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isConvertingOffice, setIsConvertingOffice] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [pageSelectionMode, setPageSelectionMode] = useState<'all' | 'range'>('all');
  const [rangeStartPage, setRangeStartPage] = useState('');
  const [rangeEndPage, setRangeEndPage] = useState('');
  const [summary, setSummary] = useState<PdfImportSummary | null>(null);
  /**
   * A finished import that came back with NEW warnings (pages the importer had to skip). The pages
   * are ready but not handed over yet: `onPdfProcessed` closes the modal, so the notice would flash
   * past. The teacher reads what was skipped, then the acknowledge button commits the pages.
   */
  const [pendingImport, setPendingImport] = useState<{ result: PdfImportResult; warnings: string[] } | null>(null);
  const [isCommittingImport, setIsCommittingImport] = useState(false);
  /**
   * Pages the second (native) engine rendered after pdf.js gave up. Shown as a CALM line, never as a
   * gate: those pages came out complete, so making the teacher acknowledge them would be telling
   * them something went wrong when nothing did.
   */
  const [rescuedPageNumbers, setRescuedPageNumbers] = useState<number[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * The converted PDF staged for import, and nothing else: only a PowerPoint conversion leaves a
   * file behind that the host must delete. Tracked in a ref (not state) because the close effect,
   * the unmount cleanup and a second file pick all release it, and they must agree on what is
   * staged at the instant they run rather than on a render-old copy.
   */
  const onSourceDiscardedRef = useRef(onSourceDiscarded);
  const stagedSourceRef = useRef(
    createStagedSourceTracker<File>((discardedFile) => onSourceDiscardedRef.current?.(discardedFile)),
  );

  onSourceDiscardedRef.current = onSourceDiscarded;

  // The modal going away entirely (the editor unmounting mid-import, a crash boundary swapping it
  // out) is the third way a converted deck can leave unused.
  useEffect(() => {
    const tracker = stagedSourceRef.current;

    return () => tracker.release();
  }, []);

  const {
    analyzePdfFile,
    importPdfFile,
    isAnalyzing,
    isRendering,
    progress,
    error: renderError,
  } = usePdfRenderer(workerSrc, undefined, nativePdfRescue);

  useEffect(() => {
    if (!isOpen) {
      // Closing without importing: the converted deck on disk is nobody's now.
      stagedSourceRef.current.release();
      setFile(null);
      setSourceFile(null);
      setIsDragging(false);
      setIsConvertingOffice(false);
      setValidationError('');
      setPageSelectionMode('all');
      setRangeStartPage('');
      setRangeEndPage('');
      setSummary(null);
      setPendingImport(null);
      setIsCommittingImport(false);
      setRescuedPageNumbers([]);

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [isOpen]);

  // Drop-zone copy follows what this host can actually take, so the prompt never offers a format the
  // modal would then refuse.
  const dropZonePrompt = onImagesSelected
    ? convertOfficeFile
      ? t('upload.drop.pdfOfficeImages')
      : t('upload.drop.pdfImages')
    : convertOfficeFile
      ? t('upload.drop.pdfOffice')
      : t('upload.drop.pdf');
  const dropZoneFormats = onImagesSelected
    ? convertOfficeFile
      ? t('upload.formats.pdfOfficeImages')
      : t('upload.formats.pdfImages')
    : convertOfficeFile
      ? t('upload.formats.pdfOffice')
      : t('upload.formats.pdf');

  const matchingImport = summary
    ? (existingImports.find((pdfImport) => pdfImport.fingerprint === summary.fingerprint) ?? null)
    : null;
  const alreadyImportedPageNumbers = matchingImport?.pageNumbers ?? [];
  const newPageNumbers = summary
    ? excludeImportedPdfPages(summary.selectedPageNumbers, alreadyImportedPageNumbers)
    : [];
  const duplicatePageNumbers = summary
    ? summary.selectedPageNumbers.filter((pageNumber) => alreadyImportedPageNumbers.includes(pageNumber))
    : [];
  const effectivePageRange = newPageNumbers.length > 0 ? formatPdfPageRange(newPageNumbers) : '';
  const suggestedNextRange = summary
    ? suggestNextPdfPageRange(alreadyImportedPageNumbers, summary.totalPages)
    : (lastImportedPdf?.suggestedRange ?? '');
  const requestedPageRange = buildPdfRangeSelection({
    endPage: rangeEndPage,
    mode: pageSelectionMode,
    startPage: rangeStartPage,
  });
  const rangeSelectionError = getPdfRangeSelectionInputError(
    { endPage: rangeEndPage, mode: pageSelectionMode, startPage: rangeStartPage },
    locale,
  );

  const applyPageRangeSelection = useCallback((nextRange: string) => {
    const parsedSelection = parsePdfRangeSelection(nextRange);

    setPageSelectionMode(parsedSelection.mode);
    setRangeStartPage(parsedSelection.startPage);
    setRangeEndPage(parsedSelection.endPage);
  }, []);

  useEffect(() => {
    if (!file) {
      setSummary(null);
      return;
    }

    if (pageSelectionMode === 'range' && (!requestedPageRange || rangeSelectionError)) {
      setSummary(null);
      return;
    }

    let isActive = true;
    const timer = window.setTimeout(() => {
      void analyzePdfFile(file, requestedPageRange ?? DEFAULT_PDF_PAGE_RANGE).then((nextSummary) => {
        if (!isActive) {
          return;
        }

        setSummary(nextSummary);
      });
    }, 250);

    return () => {
      isActive = false;
      window.clearTimeout(timer);
    };
  }, [analyzePdfFile, file, pageSelectionMode, rangeSelectionError, requestedPageRange]);

  const handleFileSelect = useCallback(
    (selectedFile: File) => {
      // A new pick replaces whatever was staged — the previous conversion is dead weight on disk.
      stagedSourceRef.current.release();

      const acceptFile = (pdfFile: File) => {
        if (pdfFile.size > MAX_PDF_IMPORT_FILE_SIZE) {
          setValidationError(
            t('pdfimport.fileTooLarge', { mb: Math.round(MAX_PDF_IMPORT_FILE_SIZE / (1024 * 1024)) }),
          );
          setSummary(null);
          return;
        }

        setFile(pdfFile);
        setSourceFile(selectedFile);
        setValidationError('');
      };

      // PowerPoint pick → convert to PDF once, then continue through the unchanged PDF path.
      if (/\.pptx?$/i.test(selectedFile.name) && convertOfficeFile) {
        setFile(null);
        setSourceFile(null);
        setSummary(null);
        setValidationError('');
        setIsConvertingOffice(true);
        void (async () => {
          try {
            const pdfFile = await convertOfficeFile(selectedFile);

            if (!pdfFile) {
              setValidationError(t('upload.officeDesktopOnly'));
              return;
            }

            // Staged the moment the conversion SUCCEEDS, before the size gate below: a deck that
            // converted and was then refused for being too large has still written its PDF to disk,
            // and that copy needs discarding just as much as a cancelled one.
            stagedSourceRef.current.stage(selectedFile);
            acceptFile(pdfFile);
          } catch (error) {
            setValidationError(error instanceof Error ? error.message : t('upload.officeConvertFailed'));
          } finally {
            setIsConvertingOffice(false);
          }
        })();
        return;
      }

      if (selectedFile.type !== 'application/pdf' && !/\.pdf$/i.test(selectedFile.name)) {
        setValidationError(
          onImagesSelected
            ? convertOfficeFile
              ? t('upload.pick.pdfOfficeImage')
              : t('upload.pick.pdfImage')
            : convertOfficeFile
              ? t('upload.pick.pdfOffice')
              : t('upload.pick.pdf'),
        );
        setSummary(null);
        return;
      }

      acceptFile(selectedFile);
    },
    [convertOfficeFile, onImagesSelected],
  );

  /**
   * The ONE entry point for a selection, whatever produced it: the picker, a drop on this modal's
   * zone, a drop on the canvas, or a file handed over by the host.
   *
   * `routeImportSelection` decides what the selection IS (a document, a run of images, or a refused
   * mix) so the modal and the canvas cannot reach different verdicts on the same files. Images leave
   * through `onImagesSelected` — this modal's page-range picker has nothing to ask about a photo.
   */
  const handleFilesSelected = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      if (!onImagesSelected) {
        const [first] = files;

        if (first) {
          handleFileSelect(first);
        }

        return;
      }

      const route = routeImportSelection(files, (candidate) => candidate.name, { office: Boolean(convertOfficeFile) });

      if (route.kind === 'images') {
        setValidationError('');
        onImagesSelected(route.files);

        return;
      }

      if (route.kind === 'rejected') {
        setFile(null);
        setSourceFile(null);
        setSummary(null);
        setValidationError(route.message);

        return;
      }

      handleFileSelect(route.file);
    },
    [convertOfficeFile, handleFileSelect, onImagesSelected],
  );

  // Route a host-supplied selection through the SAME handler a hand-picked one uses, so routing,
  // conversion and the page-range picker all behave identically. Guarded on `file` being empty:
  // re-running after the user has swapped to a different file would silently yank their choice back.
  useEffect(() => {
    if (isOpen && initialFiles && initialFiles.length > 0 && !file) {
      handleFilesSelected(initialFiles);
    }
  }, [file, handleFilesSelected, initialFiles, isOpen]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      handleFilesSelected(Array.from(e.target.files ?? []));
    },
    [handleFilesSelected],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      handleFilesSelected(Array.from(e.dataTransfer.files));
    },
    [handleFilesSelected],
  );

  const handleProcess = useCallback(async () => {
    if (!file) {
      return;
    }

    setValidationError('');
    setRescuedPageNumbers([]);

    try {
      const result = await importPdfFile(file, effectivePageRange || requestedPageRange || DEFAULT_PDF_PAGE_RANGE);

      if (!result) {
        return;
      }

      // Set before the warnings branch below, so the calm line is on screen for BOTH outcomes: on its
      // own, and beside the partial-import card when the same file also had a page nothing could read.
      // `?? []` is load-bearing: a summary built by an older caller (or a hand-rolled test double)
      // has no `rescuedPageNumbers` at all, and reading `.length` off undefined would take the whole
      // modal down at the exact moment the import succeeded.
      setRescuedPageNumbers(result.summary.rescuedPageNumbers ?? []);

      // Warnings the IMPORT added on top of the inspection notes already on screen — i.e. pages the
      // importer could not process. Hold the modal on the notice instead of closing over it.
      const importWarnings = selectNewPdfImportWarnings(summary?.warnings, result.summary.warnings);

      if (importWarnings.length > 0) {
        setPendingImport({ result, warnings: importWarnings });
        return;
      }

      await onPdfProcessed(result, sourceFile ?? file);
      // The import owns the converted file's contents now; discarding it is no longer this modal's
      // business, so the staged copy is dropped WITHOUT a discard.
      stagedSourceRef.current.consume();
      onClose();
    } catch (error) {
      console.error('[PdfUploadModal] PDF import failed', error);
      setValidationError(error instanceof Error ? error.message : t('upload.importFailed'));
    }
  }, [
    effectivePageRange,
    file,
    importPdfFile,
    onClose,
    onPdfProcessed,
    requestedPageRange,
    sourceFile,
    summary?.warnings,
  ]);

  const handleCommitPendingImport = useCallback(async () => {
    if (!pendingImport) {
      return;
    }

    setIsCommittingImport(true);

    try {
      await onPdfProcessed(pendingImport.result, sourceFile ?? file);
      stagedSourceRef.current.consume();
      onClose();
    } catch (error) {
      console.error('[PdfUploadModal] handing the imported pages to the board failed', error);
      setPendingImport(null);
      setValidationError(error instanceof Error ? error.message : t('upload.importFailed'));
    } finally {
      setIsCommittingImport(false);
    }
  }, [file, onClose, onPdfProcessed, pendingImport, sourceFile]);

  const handleClickDropZone = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const displayError = validationError || renderError;
  const errorCopy = displayError ? describePdfImportError(displayError, locale) : null;
  const advisoryWarnings = pendingImport ? [] : (summary?.warnings ?? []);

  // The raw string stays in the console for diagnosis even though the teacher sees friendly copy.
  useEffect(() => {
    if (renderError) {
      console.error('[PdfUploadModal] PDF engine error:', renderError);
    }
  }, [renderError]);

  return (
    <Modal isOpen={isOpen} portalContainer={portalContainer} size='lg' onClose={onClose}>
      <ModalContent>
        <ModalHeader className='flex-row items-center gap-2 text-start'>
          <FileUp className='text-primary h-5 w-5' />
          <span className='min-w-0 flex-1'>{onImagesSelected ? t('upload.title.pdfImage') : t('upload.title.pdf')}</span>
          <Button
            isIconOnly
            aria-label={t('ai.close')}
            isDisabled={isRendering || isAnalyzing || isCommittingImport}
            size='sm'
            variant='light'
            onPress={onClose}
          >
            <X className='h-5 w-5' />
          </Button>
        </ModalHeader>

        <ModalBody>
          <div className='flex flex-col gap-4'>
            {!isRendering && !pendingImport && (
              <motion.div
                animate={{ scale: isDragging ? 1.02 : 1 }}
                className={`flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed p-8 transition-all duration-200 ${
                  isDragging
                    ? 'border-primary bg-primary/10 shadow-[inset_0_0_0_1px_hsl(var(--heroui-primary)/0.3)]'
                    : 'border-default-300 hover:border-primary/50 hover:bg-default-50'
                }`}
                transition={{ duration: 0.15 }}
                onClick={handleClickDropZone}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              >
                <div className='bg-primary/10 flex h-14 w-14 items-center justify-center rounded-full'>
                  <Upload className='text-primary h-7 w-7' />
                </div>
                <p className='text-foreground text-sm font-medium'>{dropZonePrompt}</p>
                <p className='text-default-400 text-center text-xs'>
                  {t('upload.limits', {
                    formats: dropZoneFormats,
                    mb: Math.round(MAX_PDF_IMPORT_FILE_SIZE / (1024 * 1024)),
                    pages: MAX_PDF_IMPORT_PAGE_COUNT,
                  })}
                </p>
                {onImagesSelected ? (
                  <p className='text-default-400 text-center text-xs'>
                    {t('upload.imagesHint')}
                  </p>
                ) : null}
                {isConvertingOffice ? (
                  <p className='text-primary flex items-center gap-2 text-xs'>
                    <LoaderCircle className='h-3.5 w-3.5 animate-spin' />
                    {t('upload.converting')}
                  </p>
                ) : null}
                <input
                  ref={fileInputRef}
                  accept={buildImportAccept({ images: Boolean(onImagesSelected), office: Boolean(convertOfficeFile) })}
                  className='hidden'
                  multiple={Boolean(onImagesSelected)}
                  type='file'
                  onChange={handleInputChange}
                />
              </motion.div>
            )}

            {!file && lastImportedPdf ? (
              <div className='border-default-200 bg-default-50/80 flex flex-col gap-2 rounded-xl border p-4'>
                <p className='text-foreground text-sm font-semibold'>{t('upload.lastImported')}</p>
                <p className='text-default-500 text-xs'>{lastImportedPdf.fileName}</p>
                <p className='text-default-500 text-xs'>
                  {t('upload.lastRange', { range: lastImportedPdf.importedRange || t('pdflib.notAvailable') })}
                </p>
                {lastImportedPdf.suggestedRange ? (
                  <div className='flex flex-wrap items-center gap-2'>
                    <span className='text-default-500 text-xs'>{t('upload.nextSuggestion')}</span>
                    <button
                      className='border-primary/20 text-primary hover:bg-primary/5 rounded-sm border bg-content1 px-3 py-1 text-xs transition-colors'
                      type='button'
                      onClick={() => applyPageRangeSelection(lastImportedPdf.suggestedRange)}
                    >
                      {lastImportedPdf.suggestedRange}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {file && (
              <div className='border-default-200 bg-content1 flex items-center gap-3 rounded-md border p-3'>
                <div className='bg-danger/10 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md'>
                  <FileText className='text-danger h-5 w-5' />
                </div>
                <div className='min-w-0 flex-1'>
                  <p className='text-foreground truncate text-sm font-medium'>{file.name}</p>
                  <p className='text-default-400 text-xs'>{formatFileSize(file.size, t)}</p>
                </div>
                {isAnalyzing ? <LoaderCircle className='text-default-400 h-4 w-4 animate-spin' /> : null}
              </div>
            )}

            {file && !isRendering && !pendingImport ? (
              <div className='border-default-200 bg-default-50/80 flex flex-col gap-3 rounded-xl border p-4'>
                <div className='flex items-center justify-between gap-3'>
                  <div>
                    <p className='text-foreground text-sm font-semibold'>{t('upload.pageRange')}</p>
                    <p className='text-default-400 text-xs'>
                      {t('upload.pageRangeHint')}
                    </p>
                  </div>
                  {summary ? (
                    <div className='rounded-sm border border-default-200 bg-content1 px-3 py-1 text-[11px] text-default-600'>
                      {t('upload.selectedOfTotal', { n: summary.selectedPageCount, total: summary.totalPages })}
                    </div>
                  ) : null}
                </div>
                <div className='grid grid-cols-2 gap-2'>
                  <button
                    className={`rounded-xl border px-4 py-3 text-sm font-medium transition-colors ${
                      pageSelectionMode === 'all'
                        ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                        : 'border-default-300 hover:border-primary/40 bg-content1 text-default-600'
                    }`}
                    type='button'
                    onClick={() => applyPageRangeSelection(DEFAULT_PDF_PAGE_RANGE)}
                  >
                    {t('upload.allPages')}
                  </button>
                  <button
                    className={`rounded-xl border px-4 py-3 text-sm font-medium transition-colors ${
                      pageSelectionMode === 'range'
                        ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                        : 'border-default-300 hover:border-primary/40 bg-content1 text-default-600'
                    }`}
                    type='button'
                    onClick={() => setPageSelectionMode('range')}
                  >
                    {t('upload.customRange')}
                  </button>
                </div>
                {pageSelectionMode === 'range' ? (
                  <div className='grid grid-cols-1 gap-3 md:grid-cols-2'>
                    <label className='flex flex-col gap-1'>
                      <span className='text-default-500 text-xs font-medium'>Start</span>
                      <input
                        className='border-2 border-[rgb(var(--st-control-edge,205_209_224))] focus:border-[rgb(var(--st-accent,47_91_234))] focus:ring-primary/20 w-full rounded-xl bg-content1 text-foreground px-3 py-2 text-sm outline-none focus:ring-4'
                        inputMode='numeric'
                        min='1'
                        placeholder='35'
                        type='number'
                        value={rangeStartPage}
                        onChange={(event) => setRangeStartPage(event.target.value)}
                      />
                    </label>
                    <label className='flex flex-col gap-1'>
                      <span className='text-default-500 text-xs font-medium'>To</span>
                      <input
                        className='border-2 border-[rgb(var(--st-control-edge,205_209_224))] focus:border-[rgb(var(--st-accent,47_91_234))] focus:ring-primary/20 w-full rounded-xl bg-content1 text-foreground px-3 py-2 text-sm outline-none focus:ring-4'
                        inputMode='numeric'
                        min='1'
                        placeholder='45'
                        type='number'
                        value={rangeEndPage}
                        onChange={(event) => setRangeEndPage(event.target.value)}
                      />
                    </label>
                  </div>
                ) : null}
                {rangeSelectionError ? <p className='text-danger text-xs'>{rangeSelectionError}</p> : null}
                <div className='flex flex-wrap gap-2'>
                  <button
                    className='border-default-300 hover:border-primary/40 rounded-sm border bg-content1 px-3 py-1 text-xs text-default-600 transition-colors'
                    type='button'
                    onClick={() => applyPageRangeSelection(DEFAULT_PDF_PAGE_RANGE)}
                  >
                    {t('upload.allPages')}
                  </button>
                  <button
                    className='border-default-300 hover:border-primary/40 rounded-sm border bg-content1 px-3 py-1 text-xs text-default-600 transition-colors'
                    type='button'
                    onClick={() => applyPageRangeSelection('1-50')}
                  >
                    {t('upload.first50')}
                  </button>
                  <button
                    className='border-default-300 hover:border-primary/40 rounded-sm border bg-content1 px-3 py-1 text-xs text-default-600 transition-colors'
                    type='button'
                    onClick={() => applyPageRangeSelection('1-100')}
                  >
                    {t('upload.first100')}
                  </button>
                  {suggestedNextRange ? (
                    <button
                      className='border-primary/20 text-primary hover:bg-primary/5 rounded-sm border bg-content1 px-3 py-1 text-xs transition-colors'
                      type='button'
                      onClick={() => applyPageRangeSelection(suggestedNextRange)}
                    >
                      {t('upload.nextSuggestionN', { range: suggestedNextRange })}
                    </button>
                  ) : null}
                </div>
                {summary ? (
                  <div className='rounded-md border border-default-200 bg-content1 p-3 text-xs text-default-600'>
                    <p>{t('upload.storageNote')}</p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {summary && matchingImport && !pendingImport ? (
              <div className='border-default-200 flex flex-col gap-2 rounded-xl border bg-content1 p-4'>
                <p className='text-foreground text-sm font-semibold'>{t('upload.alreadyImported')}</p>
                <p className='text-default-500 text-xs'>
                  {matchingImport.fileName || summary.fileName} • {formatPdfPageRange(alreadyImportedPageNumbers)}
                </p>
                {effectivePageRange ? (
                  <p className='text-success text-xs'>{t('upload.newPages', { range: effectivePageRange })}</p>
                ) : null}
                {duplicatePageNumbers.length > 0 ? (
                  <p className='text-warning text-xs'>
                    {t('upload.duplicatesSkipped', { range: formatPdfPageRange(duplicatePageNumbers) })}
                  </p>
                ) : null}
                {!effectivePageRange && duplicatePageNumbers.length > 0 ? (
                  <p className='text-danger text-xs'>{t('upload.allDuplicates')}</p>
                ) : null}
              </div>
            ) : null}

            {advisoryWarnings.length > 0 ? (
              <div className='flex flex-col gap-2 rounded-xl border border-warning-200 bg-warning-50 p-4 text-start'>
                <div className='flex items-center gap-2'>
                  <Info className='h-4 w-4 flex-shrink-0 text-warning-600' />
                  <p className='text-sm font-semibold text-warning-800'>{t(PDF_IMPORT_ADVISORY_TITLE)}</p>
                </div>
                <ul className='flex list-none flex-col gap-1.5 ps-6'>
                  {advisoryWarnings.map((warning) => (
                    <li key={warning} className='text-xs leading-relaxed text-warning-700'>
                      {warning}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {pendingImport ? (
              <div className='flex flex-col gap-2 rounded-xl border border-warning-200 bg-warning-50 p-4 text-start'>
                <div className='flex items-center gap-2'>
                  <Info className='h-5 w-5 flex-shrink-0 text-warning-600' />
                  <p className='text-sm font-semibold text-warning-800'>{t(PDF_PARTIAL_IMPORT_TITLE)}</p>
                </div>
                <ul className='flex list-none flex-col gap-1.5 ps-7'>
                  {pendingImport.warnings.map((warning) => (
                    <li key={warning} className='text-xs leading-relaxed text-warning-700'>
                      {warning}
                    </li>
                  ))}
                </ul>
                <p className='ps-7 text-xs leading-relaxed text-warning-700'>
                  {t(PDF_PARTIAL_IMPORT_REASSURANCE)} {t('upload.readyCount', { n: pendingImport.result.pages.length })}
                </p>
              </div>
            ) : null}

            {rescuedPageNumbers.length > 0 ? (
              <div className='flex items-start gap-2 rounded-xl border border-primary-200 bg-primary-50 p-4 text-start'>
                <CheckCircle2 className='mt-0.5 h-4 w-4 flex-shrink-0 text-primary-600' />
                <div className='flex flex-col gap-1'>
                  <p className='text-sm font-semibold text-primary-800'>{t(PDF_RESCUED_PAGES_TITLE)}</p>
                  <p className='text-xs leading-relaxed text-primary-700'>
                    {formatRescuedPdfPagesNotice(rescuedPageNumbers, locale)}
                  </p>
                </div>
              </div>
            ) : null}

            {isRendering && (
              <div className='flex flex-col gap-2'>
                <Progress
                  aria-label={t('upload.processing')}
                  className='w-full'
                  color='primary'
                  size='md'
                  value={progress}
                />
                <p className='text-default-500 text-center text-sm'>
                  {t('upload.generatingPreviews', { pct: Math.round(progress) })}
                </p>
              </div>
            )}

            {errorCopy && (
              <div className='border-danger-200 bg-danger-50 flex flex-col gap-3 rounded-xl border p-4 text-start'>
                <div className='flex items-start gap-3'>
                  <div className='bg-danger/10 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md'>
                    <AlertCircle className='text-danger h-5 w-5' />
                  </div>
                  <div className='flex min-w-0 flex-col gap-1'>
                    <p className='text-danger text-sm font-semibold'>{errorCopy.title}</p>
                    <p className='text-danger-700 text-sm leading-relaxed'>{errorCopy.message}</p>
                    {errorCopy.hint ? (
                      <p className='text-default-600 text-xs leading-relaxed'>{errorCopy.hint}</p>
                    ) : null}
                  </div>
                </div>
                {errorCopy.detail ? (
                  <details className='border-danger-200/70 border-t pt-2'>
                    <summary className='text-default-500 cursor-pointer select-none text-xs'>{t('upload.technicalDetails')}</summary>
                    <p className='text-default-500 mt-1.5 break-words font-mono text-[11px]' dir='ltr'>
                      {errorCopy.detail}
                    </p>
                  </details>
                ) : null}
              </div>
            )}
          </div>
        </ModalBody>

        <ModalFooter>
          {pendingImport ? (
            <Button
              color='primary'
              isLoading={isCommittingImport}
              startContent={!isCommittingImport ? <FileUp className='h-4 w-4' /> : undefined}
              onPress={handleCommitPendingImport}
            >
              {t('upload.addPages')}
            </Button>
          ) : null}

          {!pendingImport && displayError && file ? (
            <Button
              color='warning'
              isDisabled={isAnalyzing}
              startContent={<RotateCcw className='h-4 w-4' />}
              variant='flat'
              onPress={handleProcess}
            >
              {t('pdflib.retry')}
            </Button>
          ) : null}

          {!pendingImport && !displayError ? (
            <Button
              color='primary'
              isDisabled={
                !file ||
                isAnalyzing ||
                !summary ||
                Boolean(rangeSelectionError) ||
                (pageSelectionMode === 'range' && !requestedPageRange) ||
                (matchingImport !== null && newPageNumbers.length === 0)
              }
              isLoading={isRendering}
              startContent={!isRendering ? <FileUp className='h-4 w-4' /> : undefined}
              onPress={handleProcess}
            >
              {t('upload.importPages')}
            </Button>
          ) : null}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};

const MemoizedPdfUploadModal = React.memo(PdfUploadModal);

export { MemoizedPdfUploadModal as PdfUploadModal };
export default MemoizedPdfUploadModal;
