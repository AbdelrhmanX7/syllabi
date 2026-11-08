import assert from 'node:assert/strict';
import { test } from 'node:test';

import { wbT } from '../../../i18n/strings';

import { describeGenerateConflict, describeReadyDownload } from './mergeDownloadMessages';

/**
 * The two sentences the PDF library shows around an on-demand download, now that the backend
 * (BE #412/#413) tells it WHICH file it served and WHY it could not serve one.
 */

test('a download answered from the last published version is labelled as that version', () => {
  assert.equal(
    describeReadyDownload({ source: 'published-version', versionNumber: 3 }),
    wbT('en', 'merge.publishedN', { n: 3 }),
  );
});

test('a published fallback with no version number still says what it is', () => {
  assert.equal(describeReadyDownload({ source: 'published-version' }), wbT('en', 'merge.published'));
});

test('the clean source PDF is named so nobody mistakes it for annotated work', () => {
  assert.equal(
    describeReadyDownload({ fileName: 'chapter-3.pdf', source: 'source-pdf' }),
    wbT('en', 'merge.sourceNamed', { name: 'chapter-3.pdf' }),
  );
  assert.equal(describeReadyDownload({ source: 'source-pdf' }), wbT('en', 'merge.source'));
});

test('a real merge carries no label — the row already says «Merged copy»', () => {
  assert.equal(describeReadyDownload({ versionNumber: 4 }), undefined);
  assert.equal(describeReadyDownload({}), undefined);
});

test('a 409 that names its reason gets the one sentence that fits it', () => {
  assert.equal(
    describeGenerateConflict({ body: { message: 'x', reason: 'no_staged_edits' }, status: 409 }),
    wbT('en', 'merge.noStagedEdits'),
  );
});

test('a 409 without a reason keeps the two-cause guidance, because it still has two causes', () => {
  const both = describeGenerateConflict({ body: { message: 'x' }, status: 409 });

  assert.equal(both, wbT('en', 'merge.conflictUnknown'));
  assert.equal(describeGenerateConflict({ body: null, status: 409 }), both);
  assert.equal(describeGenerateConflict(new Error('409')), both);
});
