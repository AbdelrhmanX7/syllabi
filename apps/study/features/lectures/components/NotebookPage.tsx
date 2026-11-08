import type { BoardAiService } from '@repo/whiteboard-react';
import type { MutableRefObject } from 'react';

import { lazy, memo, Suspense, useCallback, useEffect, useState } from 'react';
import { useChromeInset } from '@repo/whiteboard-react';

import { recordPhoneImage } from '@/features/conceptmaps/lib/pageImages';
import { useNotebookConceptMaps } from '@/features/conceptmaps/notes/NotebookConceptMaps';
import { InsertFromPhoneButton } from '@/features/inbox';
import { useLectureNoteMetas } from '@/features/lecturenotes/store';
import { useNotebookFillScreen } from '@/lib/notebooks/fill-screen';
import { useBoardTheme } from '@/lib/notebooks/board-theme';
import { usePaperSpacingDefaults } from '@/lib/notebooks/paper-settings';
import { useHidePenShortcuts } from '@/lib/notebooks/pen-shortcuts-button';

// Client-only: the editor pulls Fabric and touches `window` at import time.
const WhiteboardEditor = lazy(() =>
  import('@repo/whiteboard-react').then((module) => ({ default: module.WhiteboardEditor })),
);

interface NotebookPageProps {
  /** The notebook page id — also the whiteboard document id in this device's IndexedDB. */
  pageId: string;
  flushRef?: MutableRefObject<(() => Promise<void>) | null>;
  /** Lasso ask / generate / page check / concept map — the Study tutor (`useStudyBoardAi`). */
  boardAi?: BoardAiService;
  /** The class the notes belong to: turns on «Concept map» on the selection bar and the concept strip. */
  classId?: string | null;
  /** For picking the concept map (week / lecture in the title). */
  pageTitle?: string;
  /** The page's lecture-note record (`pageLecture` in features/lecturenotes), when it has one. */
  lecture?: { week?: number | null; lecture?: number | null; mapId?: string | null } | null;
}

// Memo: the screen around a notebook (a playing video, a dragged divider) must not re-render the board.
export const NotebookPage = memo(function NotebookPage({
  pageId,
  flushRef,
  boardAi,
  classId = null,
  pageTitle = '',
  lecture = null,
}: NotebookPageProps) {
  const [mounted, setMounted] = useState(false);
  const paperSpacingDefaults = usePaperSpacingDefaults();
  const boardTheme = useBoardTheme();
  const hidePenShortcuts = useHidePenShortcuts();
  const fillScreen = useNotebookFillScreen();
  // «Insert from phone» feeds the editor's image insert (viewport centre, one undo step); its chip
  // reserves room at the toolbar's end like NotebookBoard's top-right cluster.
  const [phoneImage, setPhoneImage] = useState<File | null>(null);
  const clearPhoneImage = useCallback(() => setPhoneImage(null), []);
  const phoneChipRef = useChromeInset('end');

  // The page's lecture-note record (written when the recorder / «New lecture note» made it), unless given.
  const noteMeta = useLectureNoteMetas()[pageId] ?? null;
  const conceptMaps = useNotebookConceptMaps({ classId, pageId, pageTitle, lecture: lecture ?? noteMeta });

  useEffect(() => setMounted(true), []);

  const fallback = (
    <div className='flex h-full items-center justify-center text-sm text-st-muted'>Opening notebook…</div>
  );

  return (
    <div className='relative h-full w-full overflow-hidden bg-st-surface'>
      {mounted ? (
        <Suspense fallback={fallback}>
          <WhiteboardEditor
            key={pageId}
            allowInsertBlankPages
            allowPaperSpacing
            allowPdfLayoutToggle
            compactSelectTool
            compactUndoRedo
            boardTheme={boardTheme}
            paperOverPdf
            straightenInk
            termsMap
            verticalNotebook
            boardAi={boardAi}
            defaultEraserMode='object'
            defaultPaperSpacingMm={paperSpacingDefaults}
            defaultToolbarDock='bottom'
            extraSelectionActions={conceptMaps.selectionActions}
            onImagePlaced={conceptMaps.onImagePlaced}
            flushBeforeCloseRef={flushRef}
            hideQuickPenTrigger={hidePenShortcuts}
            initialPenTool='brush'
            locale='en'
            notebookFillScreen={fillScreen}
            pdfLayout='scroll'
            pendingImageImport={phoneImage}
            selectionChrome='modern'
            selectionShape='box'
            toolbarLayout='full-scroll'
            whiteboardId={pageId}
            onPendingImageImportHandled={clearPhoneImage}
          />
        </Suspense>
      ) : (
        fallback
      )}
      {mounted && conceptMaps.overlay}
      {mounted && (
        <div ref={phoneChipRef} className='absolute right-3 top-3 z-30'>
          <InsertFromPhoneButton
            onInsert={(file, item) => {
              recordPhoneImage(pageId, file, item.id);
              setPhoneImage(file);
            }}
          />
        </div>
      )}
    </div>
  );
});
