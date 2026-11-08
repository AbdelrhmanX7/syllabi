import type { WhiteboardDocument } from './types';

export function collectWhiteboardPdfAssetReferenceCounts(
  document: Pick<WhiteboardDocument, 'pages'> | null | undefined,
): Map<string, number> {
  const referenceCounts = new Map<string, number>();

  for (const page of document?.pages ?? []) {
    const assetId = page.pdfAssetId?.trim();

    if (!assetId) {
      continue;
    }

    referenceCounts.set(assetId, (referenceCounts.get(assetId) ?? 0) + 1);
  }

  return referenceCounts;
}
