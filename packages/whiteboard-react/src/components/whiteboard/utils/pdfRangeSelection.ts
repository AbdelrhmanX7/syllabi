import { DEFAULT_PDF_PAGE_RANGE } from '@repo/whiteboard-core';

import { wbT, type WbLocale } from '../../../i18n/strings';

export type PdfPageSelectionMode = 'all' | 'range';

export interface PdfRangeSelectionState {
  endPage: string;
  mode: PdfPageSelectionMode;
  startPage: string;
}

const PAGE_NUMBER_PATTERN = /^\d+$/;
const PAGE_RANGE_PATTERN = /^(\d+)\s*-\s*(\d+)$/;

function normalizePageValue(value: string): string {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return '';
  }

  if (!PAGE_NUMBER_PATTERN.test(trimmedValue)) {
    return trimmedValue;
  }

  const parsedValue = Number.parseInt(trimmedValue, 10);

  return parsedValue > 0 ? `${parsedValue}` : trimmedValue;
}

export function parsePdfRangeSelection(rangeInput: string | null | undefined): PdfRangeSelectionState {
  const normalizedInput = rangeInput?.trim().toLowerCase() || DEFAULT_PDF_PAGE_RANGE;

  if (normalizedInput === DEFAULT_PDF_PAGE_RANGE) {
    return {
      endPage: '',
      mode: 'all',
      startPage: '',
    };
  }

  if (PAGE_NUMBER_PATTERN.test(normalizedInput)) {
    return {
      endPage: normalizedInput,
      mode: 'range',
      startPage: normalizedInput,
    };
  }

  const rangeMatch = normalizedInput.match(PAGE_RANGE_PATTERN);

  if (rangeMatch) {
    return {
      endPage: `${Number.parseInt(rangeMatch[2] ?? '', 10)}`,
      mode: 'range',
      startPage: `${Number.parseInt(rangeMatch[1] ?? '', 10)}`,
    };
  }

  return {
    endPage: '',
    mode: 'range',
    startPage: '',
  };
}

export function buildPdfRangeSelection({ endPage, mode, startPage }: PdfRangeSelectionState): string | null {
  if (mode === 'all') {
    return DEFAULT_PDF_PAGE_RANGE;
  }

  const normalizedStartPage = normalizePageValue(startPage);
  const normalizedEndPage = normalizePageValue(endPage);

  if (!normalizedStartPage || !normalizedEndPage) {
    return null;
  }

  if (!PAGE_NUMBER_PATTERN.test(normalizedStartPage) || !PAGE_NUMBER_PATTERN.test(normalizedEndPage)) {
    return null;
  }

  const startPageNumber = Number.parseInt(normalizedStartPage, 10);
  const endPageNumber = Number.parseInt(normalizedEndPage, 10);

  if (startPageNumber < 1 || endPageNumber < 1) {
    return null;
  }

  return startPageNumber === endPageNumber ? `${startPageNumber}` : `${startPageNumber}-${endPageNumber}`;
}

export function getPdfRangeSelectionInputError(
  { endPage, mode, startPage }: PdfRangeSelectionState,
  locale: WbLocale = 'en',
): string {
  if (mode !== 'range') {
    return '';
  }

  const normalizedStartPage = normalizePageValue(startPage);
  const normalizedEndPage = normalizePageValue(endPage);

  if (!normalizedStartPage && !normalizedEndPage) {
    return '';
  }

  if (!normalizedStartPage || !normalizedEndPage) {
    return wbT(locale, 'range.needBoth');
  }

  if (!PAGE_NUMBER_PATTERN.test(normalizedStartPage) || !PAGE_NUMBER_PATTERN.test(normalizedEndPage)) {
    return wbT(locale, 'range.wholeNumbers');
  }

  const startPageNumber = Number.parseInt(normalizedStartPage, 10);
  const endPageNumber = Number.parseInt(normalizedEndPage, 10);

  if (startPageNumber < 1 || endPageNumber < 1) {
    return wbT(locale, 'range.startsAtOne');
  }

  return '';
}
