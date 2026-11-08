import test from 'node:test';
import assert from 'node:assert/strict';

import { WhiteboardMigrationError, migrateWhiteboardDocument, migrateWhiteboardPage } from '../src/migrations';

import type { WhiteboardDocument } from '../src/types';
import { WHITEBOARD_SCHEMA_VERSION } from '../src/types';

function createCurrentDocument(overrides: Partial<WhiteboardDocument> = {}): WhiteboardDocument {
  return {
    id: 'doc-1',
    title: 'My Board',
    pages: [
      {
        id: 'page-1',
        canvasJSON: '{"objects":[]}',
        thumbnail: '',
        backgroundType: 'grid',
        viewportOffsetX: 0,
        viewportOffsetY: 0,
      },
    ],
    currentPageIndex: 0,
    createdAt: 1000,
    updatedAt: 2000,
    thumbnail: '',
    viewportZoom: 1,
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
    ...overrides,
  };
}

test('a current-version document passes through unchanged', () => {
  const input = createCurrentDocument();
  const result = migrateWhiteboardDocument(input);

  assert.equal(result.fromVersion, WHITEBOARD_SCHEMA_VERSION);
  assert.equal(result.changed, false);
  assert.deepEqual(result.document, input);
});

test('an undefined schemaVersion document upgrades to the current version', () => {
  const legacy = {
    id: 'doc-legacy',
    title: 'Legacy Board',
    pages: [{ id: 'p1', canvasJSON: '', thumbnail: '', backgroundType: 'blank' }],
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: 2,
    thumbnail: '',
    // no schemaVersion
  };

  const result = migrateWhiteboardDocument(legacy);

  assert.equal(result.fromVersion, null);
  assert.equal(result.changed, true);
  assert.equal(result.document.schemaVersion, WHITEBOARD_SCHEMA_VERSION);
  assert.equal(result.document.id, 'doc-legacy');
  assert.equal(result.document.pages.length, 1);
});

test('an explicit legacy schemaVersion (v1) upgrades to current and reports fromVersion', () => {
  const v1 = {
    id: 'doc-v1',
    title: 'V1 Board',
    pages: [{ id: 'p1', canvasJSON: '', thumbnail: '', backgroundType: 'lined' }],
    currentPageIndex: 0,
    createdAt: 5,
    updatedAt: 6,
    thumbnail: '',
    schemaVersion: 1,
  };

  const result = migrateWhiteboardDocument(v1);

  assert.equal(result.fromVersion, 1);
  assert.equal(result.changed, true);
  assert.equal(result.document.schemaVersion, WHITEBOARD_SCHEMA_VERSION);
  assert.equal(result.document.pages[0].backgroundType, 'lined');
});

test('missing and partial fields are repaired', () => {
  const partial = {
    // no id, no title, no createdAt/updatedAt, no thumbnail, no schemaVersion
    pages: [{ canvasJSON: '{"a":1}' }],
    currentPageIndex: 99,
  };

  const result = migrateWhiteboardDocument(partial);
  const { document } = result;

  assert.equal(typeof document.id, 'string');
  assert.ok(document.id.length > 0);
  assert.equal(document.title, 'New board');
  assert.equal(document.thumbnail, '');
  assert.equal(document.schemaVersion, WHITEBOARD_SCHEMA_VERSION);
  assert.equal(document.viewportZoom, 1);
  // currentPageIndex clamped into [0, pages-1]
  assert.equal(document.currentPageIndex, 0);
  // page got a generated id + defaults
  assert.equal(typeof document.pages[0].id, 'string');
  assert.ok(document.pages[0].id.length > 0);
  assert.equal(document.pages[0].canvasJSON, '{"a":1}');
  assert.equal(document.pages[0].backgroundType, 'blank');
  assert.equal(document.pages[0].thumbnail, '');
  assert.equal(result.changed, true);
});

test('missing pages array is repaired to a single blank page', () => {
  const noPages = {
    id: 'doc-empty',
    title: 'Empty',
    pages: undefined,
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: 2,
    thumbnail: '',
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
  };

  const result = migrateWhiteboardDocument(noPages);

  assert.equal(result.document.pages.length, 1);
  assert.equal(result.document.pages[0].backgroundType, 'blank');
  assert.equal(result.document.pages[0].canvasJSON, '');
  assert.equal(result.changed, true);
});

test('an empty pages array is repaired to a single blank page', () => {
  const result = migrateWhiteboardDocument({
    id: 'doc-2',
    title: 'Empty Pages',
    pages: [],
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: 2,
    thumbnail: '',
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
  });

  assert.equal(result.document.pages.length, 1);
});

test('corrupt nested page values are tolerated and coerced', () => {
  const result = migrateWhiteboardDocument({
    id: 'doc-corrupt',
    title: 'Corrupt',
    pages: [
      // wrong types everywhere — must not throw
      { id: 42, canvasJSON: { not: 'a string' }, thumbnail: null, backgroundType: 'nonsense', viewportZoom: 'big' },
      // not even an object
      'totally not a page',
      null,
    ],
    currentPageIndex: -5,
    createdAt: 'nope',
    updatedAt: null,
    thumbnail: 7,
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
  });

  const { document } = result;

  assert.equal(document.pages.length, 3);
  // first page: id coerced to a generated string, canvasJSON cleared, bg fell back
  assert.equal(typeof document.pages[0].id, 'string');
  assert.equal(document.pages[0].canvasJSON, '');
  assert.equal(document.pages[0].backgroundType, 'blank');
  assert.equal(document.pages[0].viewportZoom, undefined);
  // string / null pages became blank pages
  assert.equal(document.pages[1].canvasJSON, '');
  assert.equal(document.pages[2].canvasJSON, '');
  // currentPageIndex clamped up to 0
  assert.equal(document.currentPageIndex, 0);
  // bad timestamps replaced with finite numbers
  assert.equal(typeof document.createdAt, 'number');
  assert.equal(typeof document.updatedAt, 'number');
  assert.equal(document.thumbnail, '');
});

test('a FUTURE schemaVersion is preserved, not downgraded', () => {
  const future = {
    id: 'doc-future',
    title: 'From The Future',
    pages: [{ id: 'fp', canvasJSON: '{"future":true}', thumbnail: '', backgroundType: 'dotted' }],
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: 2,
    thumbnail: '',
    schemaVersion: WHITEBOARD_SCHEMA_VERSION + 5,
    // a field this build does not know about must survive
    unknownFutureField: { deeply: { nested: 'value' } },
  };

  const result = migrateWhiteboardDocument(future);

  assert.equal(result.fromVersion, WHITEBOARD_SCHEMA_VERSION + 5);
  assert.equal(result.changed, false);
  // version NOT downgraded
  assert.equal(result.document.schemaVersion, WHITEBOARD_SCHEMA_VERSION + 5);
  // board still openable
  assert.equal(result.document.id, 'doc-future');
  assert.equal(result.document.pages[0].canvasJSON, '{"future":true}');
  assert.equal(result.document.pages[0].backgroundType, 'dotted');
});

test('a FUTURE schemaVersion preserves unknown top-level AND page fields (forward-safety)', () => {
  const future = {
    id: 'doc-future-2',
    title: 'Future With Extras',
    pages: [
      {
        id: 'fp',
        canvasJSON: '{"future":true}',
        thumbnail: '',
        backgroundType: 'dotted',
        // a NEW per-page field a newer build introduced — must survive a round-trip
        futurePageProp: { layers: [1, 2, 3] },
      },
    ],
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: 2,
    thumbnail: '',
    schemaVersion: WHITEBOARD_SCHEMA_VERSION + 5,
    unknownFutureField: { deeply: { nested: 'value' } },
  };

  const result = migrateWhiteboardDocument(future);

  // The whole point of forward-safety: opening a newer board on an older build must
  // NOT silently strip the newer fields (they'd be lost on the next resave).
  assert.deepEqual((result.document as unknown as Record<string, unknown>).unknownFutureField, {
    deeply: { nested: 'value' },
  });
  assert.deepEqual((result.document.pages[0] as unknown as Record<string, unknown>).futurePageProp, {
    layers: [1, 2, 3],
  });
  assert.equal(result.changed, false);
});

test('a CURRENT-version doc preserves an unknown extra field (matches existing load path)', () => {
  const input = {
    ...createCurrentDocument(),
    // the existing normalizeWhiteboardDocument keeps this via `{ ...doc }`; migration must too
    extraTeacherField: 'KEEP-ME',
  } as unknown as WhiteboardDocument;

  const result = migrateWhiteboardDocument(input);

  assert.equal((result.document as unknown as Record<string, unknown>).extraTeacherField, 'KEEP-ME');
  // and a doc that differs only by a preserved field is still a no-op (no needless resave)
  assert.equal(result.changed, false);
});

test('re-running migrate on an already-migrated document is a no-op (changed=false)', () => {
  const legacy = {
    id: 'doc-idem',
    title: 'Legacy',
    pages: [{ id: 'p', canvasJSON: '{"a":1}', thumbnail: '', backgroundType: 'grid' }],
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: 2,
    thumbnail: '',
    // no schemaVersion -> first pass migrates
  };

  const first = migrateWhiteboardDocument(legacy);

  assert.equal(first.changed, true);

  const second = migrateWhiteboardDocument(first.document);

  assert.equal(second.changed, false);
  assert.deepEqual(second.document, first.document);
});

test('clamps an out-of-range viewportZoom and shared background opacity', () => {
  const result = migrateWhiteboardDocument({
    id: 'doc-zoom',
    title: 'Zoom',
    pages: [{ id: 'p', canvasJSON: '', thumbnail: '', backgroundType: 'blank', viewportZoom: 99 }],
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: 2,
    thumbnail: '',
    viewportZoom: 99,
    sharedBackgroundImageUrl: 'https://example.com/bg.png',
    sharedBackgroundImageOpacity: 50,
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
  });

  assert.equal(result.document.viewportZoom, 4);
  assert.equal(result.document.pages[0].viewportZoom, 4);
  assert.equal(result.document.sharedBackgroundImageUrl, 'https://example.com/bg.png');
  assert.equal(result.document.sharedBackgroundImageOpacity, 1);
});

test('throws a typed WhiteboardMigrationError on irrecoverable non-object input', () => {
  for (const garbage of [null, undefined, 42, 'a string', true, [1, 2, 3]]) {
    assert.throws(
      () => migrateWhiteboardDocument(garbage),
      (error: unknown) => {
        assert.ok(error instanceof WhiteboardMigrationError);
        assert.equal((error as WhiteboardMigrationError).name, 'WhiteboardMigrationError');

        return true;
      },
    );
  }
});

test('an empty object is repaired into a valid blank document', () => {
  const result = migrateWhiteboardDocument({});

  assert.equal(result.fromVersion, null);
  assert.equal(result.changed, true);
  assert.equal(result.document.schemaVersion, WHITEBOARD_SCHEMA_VERSION);
  assert.equal(result.document.pages.length, 1);
  assert.equal(result.document.title, 'New board');
  assert.equal(result.document.currentPageIndex, 0);
});

test('migrateWhiteboardPage repairs a single page and never throws', () => {
  const repaired = migrateWhiteboardPage({ canvasJSON: '{"x":1}', backgroundType: 'grid' });

  assert.equal(typeof repaired.id, 'string');
  assert.ok(repaired.id.length > 0);
  assert.equal(repaired.canvasJSON, '{"x":1}');
  assert.equal(repaired.backgroundType, 'grid');
  assert.equal(repaired.thumbnail, '');
  assert.equal(repaired.viewportOffsetX, 0);
  assert.equal(repaired.viewportOffsetY, 0);

  // junk input yields a blank-but-valid page
  const fromJunk = migrateWhiteboardPage('not a page');

  assert.equal(typeof fromJunk.id, 'string');
  assert.equal(fromJunk.canvasJSON, '');
  assert.equal(fromJunk.backgroundType, 'blank');
});

test('a numeric document id is coerced with String(), not regenerated', () => {
  // A non-string but stringifiable id (e.g. a number written by an older format) is
  // IDENTITY: it must be coerced with String(), never replaced with a fresh UUID —
  // regenerating it would fork the board from its cloud draft/version history.
  const result = migrateWhiteboardDocument({
    id: 12345,
    title: 'Numeric Id Board',
    pages: [{ id: 'p1', canvasJSON: '', thumbnail: '', backgroundType: 'blank' }],
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: 2,
    thumbnail: '',
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
  });

  assert.equal(result.document.id, '12345');
});

test('a numeric page id is coerced with String(), not regenerated', () => {
  const result = migrateWhiteboardDocument({
    id: 'doc-numeric-page',
    title: 'Numeric Page Id',
    pages: [{ id: 777, canvasJSON: '{"a":1}', thumbnail: '', backgroundType: 'grid' }],
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: 2,
    thumbnail: '',
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
  });

  assert.equal(result.document.pages[0].id, '777');
});

test('migrateWhiteboardPage coerces a numeric page id instead of regenerating it', () => {
  const page = migrateWhiteboardPage({ id: 42, canvasJSON: '', thumbnail: '', backgroundType: 'blank' });

  assert.equal(page.id, '42');
});

test('a genuinely missing/empty/non-stringifiable id is still generated', () => {
  // Empty string -> generated
  const empty = migrateWhiteboardDocument({
    id: '',
    title: 'Empty Id',
    pages: [{ id: '', canvasJSON: '', thumbnail: '', backgroundType: 'blank' }],
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: 2,
    thumbnail: '',
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
  });

  assert.ok(empty.document.id.length > 0);
  assert.ok(empty.document.pages[0].id.length > 0);

  // Non-stringifiable id (object) -> generated, never String([object Object])
  const objectId = migrateWhiteboardPage({
    id: { nope: true },
    canvasJSON: '',
    thumbnail: '',
    backgroundType: 'blank',
  });

  assert.ok(objectId.id.length > 0);
  assert.notEqual(objectId.id, '[object Object]');
});

test('preserves pdf page metadata through migration', () => {
  const result = migrateWhiteboardDocument({
    id: 'doc-pdf',
    title: 'PDF Board',
    pages: [
      {
        id: 'pdfp',
        canvasJSON: '',
        thumbnail: '',
        backgroundType: 'blank',
        pdfAssetId: 'asset-1',
        pdfFingerprint: 'sha256:abc',
        pdfPageIndex: 3,
        pdfImageUrl: 'https://example.com/p3.png',
        pdfSourceName: 'lecture.pdf',
      },
    ],
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: 2,
    thumbnail: '',
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
  });

  const page = result.document.pages[0];

  assert.equal(page.pdfAssetId, 'asset-1');
  assert.equal(page.pdfFingerprint, 'sha256:abc');
  assert.equal(page.pdfPageIndex, 3);
  assert.equal(page.pdfImageUrl, 'https://example.com/p3.png');
  assert.equal(page.pdfSourceName, 'lecture.pdf');
});
