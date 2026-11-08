import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectWhiteboardRemoteConflict,
  getWhiteboardRemoteUpdatedAt,
  resolveWhiteboardResumeSource,
} from '../src/remote/adapters';

import type { WhiteboardApiDocumentDetails } from '../src/remote/types';

function createDocument(overrides: Partial<WhiteboardApiDocumentDetails> = {}): WhiteboardApiDocumentDetails {
  return {
    _id: 'doc-1',
    title: 'Test Whiteboard',
    teacherId: 'teacher-1',
    teacherType: 'Teacher',
    lectureId: null,
    isPublished: false,
    autoPublish: false,
    currentVersion: 1,
    pageCount: 3,
    draftRawDataUrl: null,
    draftUpdatedAt: null,
    tags: [],
    thumbnail: null,
    isActive: true,
    isDeleted: false,
    createdAt: '2026-03-09T10:00:00.000Z',
    updatedAt: '2026-03-09T10:00:00.000Z',
    latestVersion: {
      _id: 'version-1',
      documentId: 'doc-1',
      versionNumber: 1,
      pdfUrl: 'https://example.com/v1.pdf',
      pdfFileSize: 120000,
      rawDataUrl: 'https://example.com/v1.json',
      thumbnailUrl: 'https://example.com/v1.png',
      pageCount: 3,
      createdAt: '2026-03-09T09:00:00.000Z',
      updatedAt: '2026-03-09T09:00:00.000Z',
    },
    ...overrides,
  };
}

test('resolveWhiteboardResumeSource prefers the newer draft over the saved version', () => {
  const document = createDocument({
    draftRawDataUrl: 'https://example.com/draft.json',
    draftUpdatedAt: '2026-03-09T11:00:00.000Z',
  });

  assert.deepEqual(resolveWhiteboardResumeSource(document), {
    kind: 'draft',
    url: 'https://example.com/draft.json',
    versionNumber: 1,
  });
});

test('resolveWhiteboardResumeSource falls back to the latest saved version when the draft is older', () => {
  const document = createDocument({
    draftRawDataUrl: 'https://example.com/draft.json',
    draftUpdatedAt: '2026-03-09T08:00:00.000Z',
  });

  assert.deepEqual(resolveWhiteboardResumeSource(document), {
    kind: 'version',
    url: 'https://example.com/v1.json',
    versionNumber: 1,
  });
});

test('getWhiteboardRemoteUpdatedAt returns the freshest timestamp across document, draft, and version', () => {
  const document = createDocument({
    draftUpdatedAt: '2026-03-09T12:00:00.000Z',
    updatedAt: '2026-03-09T11:00:00.000Z',
    latestVersion: {
      ...createDocument().latestVersion!,
      createdAt: '2026-03-09T13:00:00.000Z',
    },
  });

  assert.equal(getWhiteboardRemoteUpdatedAt(document), Date.parse('2026-03-09T13:00:00.000Z'));
});

test('detectWhiteboardRemoteConflict flags a newer remote draft and returns the matching resume source', () => {
  const document = createDocument({
    draftRawDataUrl: 'https://example.com/draft.json',
    draftUpdatedAt: '2026-03-09T12:30:00.000Z',
  });

  const result = detectWhiteboardRemoteConflict(document, Date.parse('2026-03-09T12:00:00.000Z'));

  assert.equal(result.hasConflict, true);
  assert.equal(result.remoteUpdatedAt, Date.parse('2026-03-09T12:30:00.000Z'));
  assert.deepEqual(result.resumeSource, {
    kind: 'draft',
    url: 'https://example.com/draft.json',
    versionNumber: 1,
  });
});

test('detectWhiteboardRemoteConflict respects the tolerance window for near-equal timestamps', () => {
  const document = createDocument({
    updatedAt: '2026-03-09T10:00:00.900Z',
  });

  const result = detectWhiteboardRemoteConflict(document, Date.parse('2026-03-09T10:00:00.000Z'), 1000);

  assert.equal(result.hasConflict, false);
});

test('detectWhiteboardRemoteConflict does NOT flag a newer-but-EMPTY remote as a conflict (Tier-2 claim data-loss guard)', () => {
  // Mirrors the post-claim re-bootstrap: a just-server-claimed doc has updatedAt≈now (newer than the
  // resumed local board's old offline timestamp) but NO draft and NO version -> resumeSource is null.
  // Surfacing this as a conflict would let "load server version" blank the local content, so it must
  // be hasConflict=false (and the caller then syncs the local content up instead).
  const document = createDocument({
    draftRawDataUrl: null,
    draftUpdatedAt: null,
    latestVersion: undefined,
    updatedAt: '2026-03-09T18:00:00.000Z',
  });

  const result = detectWhiteboardRemoteConflict(document, Date.parse('2026-03-09T10:00:00.000Z'));

  assert.equal(result.resumeSource, null);
  assert.equal(result.hasConflict, false);
});
