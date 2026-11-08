import test from 'node:test';
import assert from 'node:assert/strict';

import { collectWhiteboardPdfAssetReferenceCounts } from '../src/pdf-assets';

test('collectWhiteboardPdfAssetReferenceCounts counts repeated PDF asset usage per page', () => {
  const referenceCounts = collectWhiteboardPdfAssetReferenceCounts({
    pages: [
      { id: 'page-1', backgroundType: 'blank', canvasJSON: '', pdfAssetId: 'asset-a', thumbnail: '' },
      { id: 'page-2', backgroundType: 'blank', canvasJSON: '', pdfAssetId: 'asset-a', thumbnail: '' },
      { id: 'page-3', backgroundType: 'blank', canvasJSON: '', pdfAssetId: 'asset-b', thumbnail: '' },
      { id: 'page-4', backgroundType: 'blank', canvasJSON: '', thumbnail: '' },
    ],
  });

  assert.equal(referenceCounts.get('asset-a'), 2);
  assert.equal(referenceCounts.get('asset-b'), 1);
  assert.equal(referenceCounts.has(''), false);
});
