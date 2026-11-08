import type { Page } from '@/lib/api/types';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import { useRouter } from 'next/router';

import { NotebookBoard } from '@/components/notebook/NotebookBoard';
import { EmptyState, LinkButton } from '@/components/ui/primitives';
import { PlacePhoneImageChip } from '@/features/inbox';
import { recordPhoneImage } from '@/features/conceptmaps/lib/pageImages';
import { useNotebookConceptMaps } from '@/features/conceptmaps/notes/NotebookConceptMaps';
import { AttachToLectureButton, lectureNoteSeed, usePageLecture } from '@/features/lecturenotes';
import { getPage, listPages, patchPage } from '@/lib/api/endpoints';
import { retitleForPdf } from '@/lib/notebooks/note-title';
import { readCachedPage, rememberPages } from '@/lib/notebooks/pages-cache';
import { useStudyBoardAi } from '@/features/tutor';
import { ForkedFromNote, ShareButton } from '@/features/share/components/ShareButton';
import { PageVersionsButton, SharedEditChip } from '@/features/share/components/PageVersions';

// «Make questions» from this page's ink — the bank feature owns the extract flow (client-only: canvas).
const ExtractButton = dynamic(() => import('@/features/bank').then((mod) => mod.ExtractButton), { ssr: false });

/**
 * `/notebook/?id=<pageId>` — a handwritten notebook page on the board, edge to edge.
 *
 * The Page record comes from the local index first (every list/create fills it) and from a pages
 * listing otherwise; the board itself only needs the id and a title.
 */
export default function NotebookPage() {
  const router = useRouter();
  const pageId = typeof router.query.id === 'string' ? router.query.id : '';
  const classId = typeof router.query.classId === 'string' ? router.query.classId : '';
  const [page, setPage] = useState<Page | null>(null);
  // Someone else's page shared with me to edit: content only, nothing that reaches into their classes.
  const sharedWithMe = page?.shared ?? null;
  const ownClassId = sharedWithMe ? null : (page?.classId ?? (classId || null));
  const boardAi = useStudyBoardAi(pageId, ownClassId);
  // The lecture this page is a note for (its server fields, else this device's record).
  const lecture = usePageLecture(page);
  // «Concept map» on the selection bar + the linked map's concept strip.
  const conceptMaps = useNotebookConceptMaps({
    classId: ownClassId,
    pageId,
    pageTitle: page?.title ?? '',
    lecture,
  });
  const [missing, setMissing] = useState(false);
  // `&inbox=<itemId>` (Inbox → «Add to notes»): offer that photo / PDF on the board; a tap places it
  // (a PDF's pages are appended through the editor's import sheet).
  const inboxItemId = typeof router.query.inbox === 'string' ? router.query.inbox : '';
  const [inboxImage, setInboxImage] = useState<File | null>(null);
  const [inboxPdf, setInboxPdf] = useState<File | null>(null);
  const dropInboxParam = useCallback(() => {
    const query = { ...router.query };

    delete query.inbox;
    delete query.map;
    void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
  }, [router]);

  useEffect(() => {
    if (!pageId) return;
    const cached = readCachedPage(pageId);
    let cancelled = false;

    // The cached record paints first; the backend's copy follows (it carries the typed body of a page
    // Claude wrote, which lists do not). An older backend without GET /pages/:id falls back to the list.
    if (cached) setPage(cached);

    getPage(pageId)
      .then((fresh) => {
        rememberPages([fresh]);
        if (!cancelled) setPage(fresh);
      })
      .catch(async () => {
        if (cached) return;
        const pages = await listPages(classId ? { classId } : {});

        rememberPages(pages);
        const found = pages.find((candidate) => candidate.id === pageId) ?? null;

        if (cancelled) return;
        if (found) setPage(found);
        else setMissing(true);
      })
      .catch(() => {
        // Offline with nothing cached: still open the board under a generic title.
        if (!cancelled)
          setPage({
            id: pageId,
            classId: classId || null,
            itemId: null,
            lectureId: null,
            title: 'Notebook',
            kind: 'note',
            updatedAt: new Date().toISOString(),
            version: 0,
            thumbUrl: null,
          });
      });

    return () => {
      cancelled = true;
    };
  }, [classId, pageId]);

  const handleBack = useCallback(() => {
    if (page?.shared) void router.push('/shared/');
    else if (page?.classId) void router.push(`/class/?id=${encodeURIComponent(page.classId)}`);
    else if (window.history.length > 1) router.back();
    else void router.push('/');
  }, [page?.classId, page?.shared, router]);

  // A PDF imported into a note that still has its generated name renames it after the file (a name
  // someone typed is never touched). Local first so the pill updates at once; the backend follows.
  const adoptPdfTitle = useCallback(
    (fileName: string) => {
      const next = page ? retitleForPdf(page.title, fileName) : null;

      if (!page || !next) return;
      setPage({ ...page, title: next });
      rememberPages([{ ...page, title: next }]);
      patchPage(page.id, { title: next })
        .then((saved) => rememberPages([saved]))
        .catch(() => undefined);
    },
    [page],
  );

  if (!pageId || missing) {
    return (
      <div className='flex h-full items-center justify-center p-10'>
        <EmptyState
          action={<LinkButton href='/classes/'>Go to classes</LinkButton>}
          title={missing ? 'This notebook no longer exists' : 'No notebook selected'}
        />
      </div>
    );
  }

  return (
    <>
      <Head>
        <title>{page ? `${page.title} · Syllabi` : 'Notebook · Syllabi'}</title>
      </Head>
      {page && (
        <NotebookBoard
          boardAi={boardAi}
          extraSelectionActions={conceptMaps.selectionActions}
          onImagePlaced={conceptMaps.onImagePlaced}
          overlay={conceptMaps.overlay}
          live={Boolean(page.live)}
          pageId={page.id}
          pendingImage={inboxImage}
          pendingPdf={inboxPdf}
          // A lecture note starts on lined paper (only a brand-new page is seeded).
          seed={lecture ? lectureNoteSeed(page.id, page.title) : undefined}
          title={page.title}
          topRight={
            <div className='flex items-center gap-2'>
              {inboxItemId && (
                <PlacePhoneImageChip
                  itemId={inboxItemId}
                  onDismiss={dropInboxParam}
                  onPlace={(file, item) => {
                    if (item.kind === 'pdf') {
                      setInboxPdf(file);
                    } else {
                      recordPhoneImage(page.id, file, inboxItemId);
                      setInboxImage(file);
                      if (router.query.map === '1') conceptMaps.makeFromFile(file);
                    }
                    dropInboxParam();
                  }}
                />
              )}
              {page.classId && page.kind === 'note' && (
                // A rename shows on the next open: changing the board's title prop re-opens the document.
                <AttachToLectureButton classId={page.classId} page={page} />
              )}
              {sharedWithMe ? (
                <SharedEditChip ownerName={sharedWithMe.ownerName} />
              ) : (
                <>
                  {conceptMaps.topRight}
                  <ForkedFromNote board resourceId={page.id} resourceType='notebook' />
                  <PageVersionsButton pageId={page.id} />
                  <ShareButton board target={{ resourceType: 'notebook', resourceId: page.id, title: page.title || 'Notebook' }} />
                  <ExtractButton chip classId={page.classId ?? undefined} label='Make questions' pageId={page.id} />
                </>
              )}
            </div>
          }
          typedMarkdown={page.markdown ?? page.text ?? null}
          onBack={handleBack}
          onImageInserted={() => setInboxImage(null)}
          onPdfInserted={() => setInboxPdf(null)}
          onPdfFileImported={adoptPdfTitle}
        />
      )}
    </>
  );
}
