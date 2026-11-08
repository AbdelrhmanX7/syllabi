export const MAX_PDF_IMPORT_FILE_SIZE = 500 * 1024 * 1024;
export const MAX_PDF_IMPORT_PAGE_COUNT = 500;
export const DEFAULT_PDF_PAGE_RANGE = 'all';
export const DEFAULT_PDF_NEXT_RANGE_SIZE = 10;

const PAGE_RANGE_SEPARATOR = ',';

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

export function parsePdfPageRange(rangeInput: string | null | undefined, totalPages: number): number[] {
  assertPositiveInteger(totalPages, 'totalPages');

  const normalizedInput = rangeInput?.trim().toLowerCase() || DEFAULT_PDF_PAGE_RANGE;

  if (normalizedInput === DEFAULT_PDF_PAGE_RANGE) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const selectedPages = new Set<number>();
  const segments = normalizedInput
    .split(PAGE_RANGE_SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    throw new Error('Enter a valid page range or choose all pages.');
  }

  for (const segment of segments) {
    const rangeMatch = segment.match(/^(\d+)\s*-\s*(\d+)$/);

    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1] ?? '', 10);
      const end = Number.parseInt(rangeMatch[2] ?? '', 10);

      if (Number.isNaN(start) || Number.isNaN(end)) {
        throw new Error(`The range "${segment}" is not valid.`);
      }

      const lower = Math.min(start, end);
      const upper = Math.max(start, end);

      if (lower < 1 || upper > totalPages) {
        throw new Error(`The range "${segment}" is outside the file (${totalPages} pages).`);
      }

      for (let pageNumber = lower; pageNumber <= upper; pageNumber += 1) {
        selectedPages.add(pageNumber);
      }

      continue;
    }

    const pageNumber = Number.parseInt(segment, 10);

    if (Number.isNaN(pageNumber) || String(pageNumber) !== segment) {
      throw new Error(`"${segment}" is not a valid page number.`);
    }

    if (pageNumber < 1 || pageNumber > totalPages) {
      throw new Error(`Page "${pageNumber}" is outside the file (${totalPages} pages).`);
    }

    selectedPages.add(pageNumber);
  }

  const resolvedPages = Array.from(selectedPages).sort((left, right) => left - right);

  if (resolvedPages.length === 0) {
    throw new Error('No pages were selected to import.');
  }

  if (resolvedPages.length > MAX_PDF_IMPORT_PAGE_COUNT) {
    throw new Error(
      `${resolvedPages.length} pages selected — the limit is ${MAX_PDF_IMPORT_PAGE_COUNT} pages.`,
    );
  }

  return resolvedPages;
}

export function formatPdfPageRange(pageNumbers: number[]): string {
  if (pageNumbers.length === 0) {
    return '';
  }

  const normalizedPages = Array.from(new Set(pageNumbers)).sort((left, right) => left - right);
  const ranges: string[] = [];
  let start = normalizedPages[0] ?? 0;
  let previous = start;

  for (let index = 1; index < normalizedPages.length; index += 1) {
    const current = normalizedPages[index];

    if (current === undefined) {
      continue;
    }

    if (current === previous + 1) {
      previous = current;
      continue;
    }

    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = current;
    previous = current;
  }

  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);

  return ranges.join(', ');
}

export function excludeImportedPdfPages(selectedPageNumbers: number[], importedPageNumbers: number[]): number[] {
  const importedPageSet = new Set(importedPageNumbers);

  return selectedPageNumbers.filter((pageNumber) => !importedPageSet.has(pageNumber));
}

export function suggestNextPdfPageRange(
  importedPageNumbers: number[],
  totalPages: number,
  chunkSize = DEFAULT_PDF_NEXT_RANGE_SIZE,
): string {
  assertPositiveInteger(totalPages, 'totalPages');
  assertPositiveInteger(chunkSize, 'chunkSize');

  if (importedPageNumbers.length === 0) {
    const endPage = Math.min(totalPages, chunkSize);

    return endPage <= 1 ? '1' : `1-${endPage}`;
  }

  const normalizedPages = Array.from(new Set(importedPageNumbers)).sort((left, right) => left - right);
  const highestImportedPage = normalizedPages[normalizedPages.length - 1] ?? 0;
  const startPage = highestImportedPage + 1;

  if (startPage > totalPages) {
    return '';
  }

  const endPage = Math.min(totalPages, startPage + chunkSize - 1);

  return startPage === endPage ? `${startPage}` : `${startPage}-${endPage}`;
}
