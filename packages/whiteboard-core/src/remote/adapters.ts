import { createBlankWhiteboardDocument } from '../defaults';
import { migrateWhiteboardDocument } from '../migrations';

import type { WhiteboardDocument } from '../types';
import type { WhiteboardApiDocument, WhiteboardApiDocumentDetails, WhiteboardApiResumeSource } from './types';

function parseTimestamp(value: string | null | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? fallback : parsed;
}

export function getWhiteboardRemoteUpdatedAt(document: WhiteboardApiDocumentDetails): number {
  return Math.max(
    parseTimestamp(document.updatedAt, 0),
    parseTimestamp(document.draftUpdatedAt, 0),
    parseTimestamp(document.latestVersion?.createdAt, 0),
  );
}

export function createCachedWhiteboardDocumentFromApiDocument(
  document: WhiteboardApiDocument,
  overrides: Partial<WhiteboardDocument> = {},
): WhiteboardDocument {
  const fallbackCreatedAt = Date.now();

  // Route the cached-doc build through migrate (§2.5: every decode path migrates) — IN-MEMORY
  // ONLY; this constructs the local cache shell from API metadata and never writes to the cloud.
  const { document: migrated } = migrateWhiteboardDocument({
    ...createBlankWhiteboardDocument({
      id: document._id,
      title: document.title,
    }),
    ...overrides,
    id: document._id,
    title: overrides.title ?? document.title,
    createdAt: parseTimestamp(document.createdAt, fallbackCreatedAt),
    thumbnail: overrides.thumbnail ?? document.thumbnail ?? '',
    updatedAt: parseTimestamp(document.updatedAt, fallbackCreatedAt),
    // Stamp the server's owner (id + type) onto the cached local doc so the home library can scope
    // boards by teacher without re-hitting the API. `teacherName` is display-only and NOT on the API
    // document, so it stays whatever `overrides` supplied (the create/claim callers pass the label).
    // An explicit override still wins (spread above) for forward flexibility.
    teacherId: overrides.teacherId ?? document.teacherId,
    teacherType: overrides.teacherType ?? document.teacherType,
  });

  return migrated;
}

export function resolveWhiteboardResumeSource(
  document: WhiteboardApiDocumentDetails,
): WhiteboardApiResumeSource | null {
  const draftTimestamp = parseTimestamp(document.draftUpdatedAt, 0);
  const latestVersionTimestamp = parseTimestamp(document.latestVersion?.createdAt, 0);

  if (document.draftRawDataUrl && draftTimestamp >= latestVersionTimestamp) {
    return {
      kind: 'draft',
      url: document.draftRawDataUrl,
      versionNumber: document.latestVersion?.versionNumber ?? null,
    };
  }

  if (document.latestVersion?.rawDataUrl) {
    return {
      kind: 'version',
      url: document.latestVersion.rawDataUrl,
      versionNumber: document.latestVersion.versionNumber,
    };
  }

  return null;
}

export function detectWhiteboardRemoteConflict(
  document: WhiteboardApiDocumentDetails,
  localUpdatedAt: number,
  toleranceMs = 1000,
): {
  hasConflict: boolean;
  remoteUpdatedAt: number;
  resumeSource: WhiteboardApiResumeSource | null;
} {
  const remoteUpdatedAt = getWhiteboardRemoteUpdatedAt(document);
  const resumeSource = resolveWhiteboardResumeSource(document);

  return {
    // Only a conflict if the server actually has loadable content to resume. A newer remote
    // `updatedAt` with NO resume source (e.g. a freshly server-claimed empty doc, or a metadata-only
    // change) must NOT be surfaced as a conflict — "load server version" would build a blank shell
    // and blank the local content. This is critical for the Tier-2 claim path: a just-claimed doc
    // has updatedAt≈now while the resumed local board keeps its older offline timestamp, so without
    // this gate every offline-create-then-claim would spuriously block sync and risk data loss.
    hasConflict: resumeSource !== null && remoteUpdatedAt > localUpdatedAt + toleranceMs,
    remoteUpdatedAt,
    resumeSource,
  };
}
