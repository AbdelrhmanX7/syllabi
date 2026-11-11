import type { WhiteboardStorage } from '@repo/whiteboard-core';
import type { Page } from '@/lib/api/types';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import { useRouter } from 'next/router';

import { NotebookBoard } from '@/components/notebook/NotebookBoard';
import { NoteCover } from '@/components/notes/NoteCover';
import { NotebookDetailsSheet } from '@/components/notes/NotebookDetailsSheet';
import { ActionButton, BOARD_CHIP_OVERRIDE, EmptyState, LinkButton } from '@/components/ui/primitives';
import { PlacePhoneImageChip } from '@/features/inbox';
import { recordPhoneImage } from '@/features/conceptmaps/lib/pageImages';
import { useNotebookConceptMaps } from '@/features/conceptmaps/notes/NotebookConceptMaps';
import { AttachToLectureButton, lectureNoteSeed, usePageLecture } from '@/features/lecturenotes';
import { track } from '@/lib/analytics';
import { getLibraryDoc, getPage, listPages, patchPage } from '@/lib/api/endpoints';
import { PAGE_DESCRIBED_EVENT, rememberPdfName } from '@/lib/notebooks/auto-describe';
import { notebookBackTarget } from '@/lib/notebooks/back';
import { retitleForPdf } from '@/lib/notebooks/note-title';
import { readCachedPage, rememberPages } from '@/lib/notebooks/pages-cache';
import { isLocalPageId, pageRedirect } from '@/lib/offline/local-pages';
import { useStudyBoardAi } from '@/features/tutor';
import { ForkedFromNote, ShareButton } from '@/features/share/components/ShareButton';
import { PageVersionsButton, SharedEditChip } from '@/features/share/components/PageVersions';

// «Make questions» from this page's ink — the bank feature owns the extract flow (client-only: canvas).
const ExtractButton = dynamic(() => import('@/features/bank').then((mod) => mod.ExtractButton), { ssr: false });

/**
 * `/notebook/?id=<pageId>[&page=<board page id>]` — a handwritten notebook page on the board, edge to edge.
 *
 * The Page record comes from the local index first (every list/create fills it) and from a pages
 * listing otherwise; the board itself only needs the id and a title.
 */
export default function NotebookPage() {
  const router = useRouter();
  const pageId = typeof router.query.id === 'string' ? router.query.id : '';
  const classId = typeof router.query.classId === 'string' ? router.query.classId : '';
  // `&page=<board page id>`: open on that page (a bookmark picked on the Notes page).
  const startPageId = typeof router.query.page === 'string' ? router.query.page : undefined;
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
  // Notebook details sheet (`&details=1` opens it, e.g. from a link).
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (router.query.details === '1') setDetailsOpen(true);
  }, [router.query.details]);

  // AI described this notebook after a sync: new name / tags.
  useEffect(() => {
    const onDescribed = (event: Event) => {
      const fresh = (event as CustomEvent<Page>).detail;

      if (fresh?.id === pageId) setPage((current) => (current ? { ...current, ...fresh } : current));
    };

    window.addEventListener(PAGE_DESCRIBED_EVENT, onDescribed);

    return () => window.removeEventListener(PAGE_DESCRIBED_EVENT, onDescribed);
  }, [pageId]);
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

  // A note made offline that the server has since created: its board lives under the server id now.
  const redirectTo = isLocalPageId(pageId) ? pageRedirect(pageId) : null;

  useEffect(() => {
    if (pageId && !redirectTo) track('notebook_opened', { offline_page: isLocalPageId(pageId), from_inbox: Boolean(inboxItemId) });
    // Once per page opened, not on every query change.
  }, [pageId, redirectTo]);

  useEffect(() => {
    if (!redirectTo) return;
    const query = { ...router.query, id: redirectTo };

    void router.replace({ pathname: router.pathname, query });
  }, [redirectTo, router]);

  useEffect(() => {
    if (!pageId || redirectTo) return;
    const cached = readCachedPage(pageId);
    let cancelled = false;

    // Made offline, not on the server yet: the device's record is the page.
    if (isLocalPageId(pageId)) {
      setPage(
        cached ?? {
          id: pageId,
          classId: classId || null,
          itemId: null,
          lectureId: null,
          title: 'Notebook',
          kind: 'note',
          updatedAt: new Date().toISOString(),
          version: 0,
          thumbUrl: null,
        },
      );

      return;
    }

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
  }, [classId, pageId, redirectTo]);

  const handleBack = useCallback(() => {
    // Only from the notebook still on screen: a late call from one already left must not close the next.
    if (!page || new URLSearchParams(window.location.search).get('id') !== page.id) return;
    // Where it was opened from first (the Notes page adds `&from=notes`), then shared / class / history.
    const target = notebookBackTarget(page, new URLSearchParams(window.location.search).get('from'), window.history.length > 1);

    if (target === 'history') router.back();
    else void router.push(target);
  }, [page, router]);

  // A PDF imported into a note that still has its generated name renames it after the file (a name
  // someone typed is never touched). Local first so the pill updates at once; the backend follows.
  const adoptPdfTitle = useCallback(
    (fileName: string) => {
      if (page) rememberPdfName(page.id, fileName);
      // A name the owner set in Notebook details is never replaced, even when it looks generated.
      const next = page && page.metaEdited?.title !== true ? retitleForPdf(page.title, fileName) : null;

      if (!page || !next) return;
      setPage({ ...page, title: next });
      rememberPages([{ ...page, title: next }]);
      // The app renamed it, not the owner: AI may still improve the name later.
      patchPage(page.id, { title: next, titleByApp: true })
        .then((saved) => rememberPages([saved]))
        .catch(() => undefined);
    },
    [page],
  );

  // A notebook on a Library PDF opened here (a bookmark on another tablet): when the server has no copy
  // of the PDF under the pages, fetch it from the Library document.
  const libraryId = sharedWithMe ? null : (page?.libraryId ?? null);
  const restoreFromLibrary = useCallback(
    async (storage: WhiteboardStorage, assetId: string) => {
      if (!libraryId) return;
      const doc = await getLibraryDoc(libraryId);

      if (!doc.url) return;
      const { restorePdfAsset } = await import('@/lib/notebooks/pdf-import');

      await restorePdfAsset({ assetId, fileUrl: doc.url, fileName: doc.path.split('/').pop() || `${doc.title}.pdf`, storage });
    },
    [libraryId],
  );

  // Moving to the server id: never mount the board on the old one (it would start a blank board there).
  if (redirectTo) return null;

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
          initialPageId={startPageId}
          onImagePlaced={conceptMaps.onImagePlaced}
          overlay={conceptMaps.overlay}
          live={Boolean(page.live)}
          // The name opens Notebook details (name, description, tags, cover live there, not up here).
          // Someone else's shared page has no details: the board shows its plain name.
          titleSlot={
            sharedWithMe ? undefined : (
              <ActionButton
                aria-label={`Notebook details: ${page.title || 'Notebook'}`}
                // Narrower than a laptop the top-end chips need the room: the name gives way first.
                className={`${BOARD_CHIP_OVERRIDE} min-w-0 max-w-[12rem] !pl-1.5 text-sm lg:max-w-[18rem]`}
                title={page.title || 'Notebook'}
                onClick={() => setDetailsOpen(true)}
              >
                <NoteCover page={page} size='xs' />
                <span className='min-w-0 truncate'>{page.title || 'Notebook'}</span>
              </ActionButton>
            )
          }
          pageId={page.id}
          pendingImage={inboxImage}
          pendingPdf={inboxPdf}
          restorePdfAsset={libraryId ? restoreFromLibrary : undefined}
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
      {page && detailsOpen && !sharedWithMe && (
        <NotebookDetailsSheet page={page} onChange={setPage} onClose={() => setDetailsOpen(false)} />
      )}
    </>
  );
}
