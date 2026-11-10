// Open exported pages (a Samsung Notes / GoodNotes / OneNote PDF, or a set of page screenshots) as a
// NEW notebook page the student keeps writing on. The document is built and stored on this device
// BEFORE the page is created and opened, so a file the board cannot read surfaces as an error here
// instead of a silently blank notebook (the board's own seed path swallows failures).
import type { ImageBackground } from './import-pages';
import type { Page } from '@/lib/api/types';

import {
  createIndexedDbWhiteboardStorage,
  createWhiteboardId,
  decodeImagePageBackground,
  WHITEBOARD_SCHEMA_VERSION,
} from '@repo/whiteboard-core';

import { buildImageNotebookDocument, importProgressLabel } from './import-pages';
import { rememberPages, writeSyncedVersion } from './pages-cache';
import { readPaperSpacingDefaults, withPaperSpacingDefaults } from './paper-settings';
import { buildPdfNotebookDocument } from './pdf-import';

import { createNotePage } from '@/lib/offline/jobs';

/** A file read only when its turn comes (a shared file is base64 over the bridge — one at a time). */
export interface ImportSource {
  name: string;
  mime: string;
  load: () => Promise<Blob> | Blob;
}

export type NotebookImport =
  | {
      kind: 'pdf';
      source: ImportSource;
      /** The name the PDF asset is stored under (`phone-<itemId>.pdf` lets another tablet re-download it). */
      assetFileName?: string;
    }
  | { kind: 'images'; sources: ImportSource[] };

export interface ImportNotebookInput {
  classId: string | null;
  title: string;
  input: NotebookImport;
  onProgress?: (label: string) => void;
}

const UNREADABLE_IMAGES = "None of these images could be read. Try saving them as JPG or PNG.";

export async function importNotebook({ classId, title, input, onProgress }: ImportNotebookInput): Promise<Page> {
  const storage = createIndexedDbWhiteboardStorage();

  try {
    await storage.ready();
    const draftId = createWhiteboardId();
    let doc;

    if (input.kind === 'pdf') {
      onProgress?.(importProgressLabel('reading'));
      const file = await input.source.load();

      // pdf.js renders the pages one after another (and keeps its own previews bounded per device).
      doc = await buildPdfNotebookDocument({
        pageId: draftId,
        title,
        file,
        fileName: input.assetFileName ?? (input.source.name || 'document.pdf'),
        storage,
        onProgress: (value) => onProgress?.(importProgressLabel('rendering', value)),
      });
      if (doc.pages.length === 0) throw new Error('This PDF has no pages to open.');
    } else {
      const images: ImageBackground[] = [];
      let skipped = 0;
      const total = input.sources.length;

      // Sequential on purpose: one source in memory at a time, each decode downscaled to the page cap.
      for (let index = 0; index < total; index++) {
        const source = input.sources[index];

        onProgress?.(importProgressLabel('images', index, total));
        try {
          const blob = await source.load();
          const background = await decodeImagePageBackground(blob, source.mime || blob.type);

          images.push({ dataUrl: background.dataUrl, width: background.width, height: background.height, name: source.name });
        } catch {
          // One unreadable image must not cost the rest of the selection.
          skipped++;
        }
      }
      if (images.length === 0 || skipped === total) throw new Error(UNREADABLE_IMAGES);
      doc = buildImageNotebookDocument({
        pageId: draftId,
        title,
        images,
        canvas: { width: window.innerWidth, height: window.innerHeight },
        newId: createWhiteboardId,
        schemaVersion: WHITEBOARD_SCHEMA_VERSION,
      });
    }

    onProgress?.(importProgressLabel('saving'));
    // Signed out or offline: the notebook starts on this device and moves to the server later.
    const page = await createNotePage({ classId: classId ?? null, title, kind: 'note' });
    const ready = withPaperSpacingDefaults({ ...doc, id: page.id, title: page.title }, readPaperSpacingDefaults());

    await storage.saveWhiteboard(ready);
    // Never uploaded: dirty on version 0, so the board pushes it as soon as it opens.
    writeSyncedVersion(page.id, 0, true);
    rememberPages([page]);

    return page;
  } finally {
    storage.close();
  }
}
