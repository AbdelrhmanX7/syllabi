import type { WhiteboardDocument, WhiteboardStorage } from '@repo/whiteboard-core';
import type { Item, Page } from '@/lib/api/types';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, FileText, Layers, NotebookPen } from 'lucide-react';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { notebookHref } from './class';

import { ITEM_TYPE_ICON, ITEM_TYPE_LABEL } from '@/components/items/ItemRow';
import { PageHeader } from '@/components/layout/PageHeader';
import { NotebookBoard } from '@/components/notebook/NotebookBoard';
import { useNotebookConceptMaps } from '@/features/conceptmaps/notes/NotebookConceptMaps';
import { ActionButton, Badge, EmptyState, ErrorNote, LoadingRows, Surface } from '@/components/ui/primitives';
import { createPage, getItem } from '@/lib/api/endpoints';
import { effectiveDue } from '@/lib/due';
import { describeError } from '@/lib/api/errors';
import { studyKeys, useClasses, useItem, useMarkSeen, usePages } from '@/lib/api/hooks';
import { daysUntil, formatBytes, formatDateTime, formatDue } from '@/lib/format';
import { rememberPages } from '@/lib/notebooks/pages-cache';
import { buildPdfNotebookDocument, restorePdfAsset } from '@/lib/notebooks/pdf-import';
import { useStudyBoardAi } from '@/features/tutor';
import { useAiEnabled } from '@/hooks/useAiEnabled';
import { sanitizeCanvasHtml } from '@/lib/sanitize-html';

// The lectures feature owns video study (player + transcript + synced notebook).
// «Make questions» from a file or page — the bank feature owns the extract flow.
const ExtractButton = dynamic(() => import('@/features/bank').then((mod) => mod.ExtractButton), { ssr: false });

// «Ask about this» — the tutor with this item as context (features/tutor).
const AskTutorButton = dynamic(() => import('@/features/tutor').then((mod) => mod.AskTutorButton), { ssr: false });

const VideoStudy = dynamic(() => import('@/features/lectures/VideoStudy'), {
  ssr: false,
  loading: () => <LoadingRows rows={6} />,
});

const isPdf = (item: Item) =>
  item.type === 'file' && (item.file?.mime === 'application/pdf' || /\.pdf$/i.test(item.title));

/** Finds (or creates) the notebook page annotating this Canvas file. */
function useAnnotationPage(item: Item | undefined) {
  const queryClient = useQueryClient();
  const pages = usePages(item ? { itemId: item.id } : {});
  const existing = pages.data?.[0] ?? null;
  const create = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error('No item');
      const page = await createPage({
        classId: item.classId,
        itemId: item.id,
        title: item.title.replace(/\.pdf$/i, ''),
        kind: 'pdf',
      });

      rememberPages([page]);

      return page;
    },
    onSuccess: () => {
      if (item) void queryClient.invalidateQueries({ queryKey: studyKeys.pages(undefined, item.id) });
    },
  });

  useEffect(() => {
    if (pages.data) rememberPages(pages.data);
  }, [pages.data]);

  return { page: existing ?? create.data ?? null, loading: pages.isLoading, create };
}

/** The handwritten notes page tied to this assignment / page / quiz (found or made on tap). */
function useItemNotes(item: Item | undefined) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const pages = usePages(item ? { itemId: item.id } : {});
  const existing = item ? (pages.data?.find((page) => page.itemId === item.id && page.kind === 'note') ?? null) : null;
  const open = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error('No item');
      if (existing) return existing;
      const page = await createPage({ classId: item.classId, itemId: item.id, title: `Notes · ${item.title}`, kind: 'note' });

      rememberPages([page]);

      return page;
    },
    onSuccess: (page) => {
      if (item) void queryClient.invalidateQueries({ queryKey: studyKeys.pages(undefined, item.id) });
      void router.push(notebookHref(page));
    },
  });

  return { existing, open };
}

function PdfBoard({ item, page, onBack }: { item: Item; page: Page; onBack: () => void }) {
  const [progress, setProgress] = useState<string | null>(null);
  const boardAi = useStudyBoardAi(page.id, item.classId, () => ({ itemId: item.id }));
  // The slides he annotates are where he draws the map: «Concept map» on the selection bar.
  const conceptMaps = useNotebookConceptMaps({ classId: item.classId, pageId: page.id, pageTitle: page.title });
  // The file URL is a signed B2 link (~1 h). A stale one from the cache 404s, so ask for the item
  // again when it has expired (or is about to) before downloading.
  const freshFileUrl = useCallback(async (): Promise<string | null> => {
    if (!item.file?.url) return null;
    const expiresAt = new Date(item.file.expiresAt).getTime();
    const stale = Number.isNaN(expiresAt) || expiresAt < Date.now() + 60_000;
    const source = stale ? await getItem(item.id) : item;

    return source.file?.url ?? null;
  }, [item]);
  const seed = useCallback(
    async (storage: WhiteboardStorage): Promise<WhiteboardDocument | null> => {
      const fileUrl = await freshFileUrl();

      if (!fileUrl) return null;
      setProgress('Downloading PDF…');

      return buildPdfNotebookDocument({
        pageId: page.id,
        title: page.title,
        fileUrl,
        fileName: item.title,
        storage,
        onProgress: (value) => setProgress(`Rendering PDF ${Math.round(value * 100)}%`),
      });
    },
    [freshFileUrl, item.title, page.id, page.title],
  );
  const restore = useCallback(
    async (storage: WhiteboardStorage, assetId: string) => {
      const fileUrl = await freshFileUrl();

      if (!fileUrl) return;
      setProgress('Downloading PDF…');
      await restorePdfAsset({
        assetId,
        fileUrl,
        fileName: item.title,
        storage,
        onProgress: (value) => setProgress(`Rendering PDF ${Math.round(value * 100)}%`),
      });
    },
    [freshFileUrl, item.title],
  );

  return (
    <NotebookBoard
      boardAi={boardAi}
      extraSelectionActions={conceptMaps.selectionActions}
      onImagePlaced={conceptMaps.onImagePlaced}
      overlay={conceptMaps.overlay}
      pageId={page.id}
      restorePdfAsset={restore}
      seed={seed}
      seedProgress={progress}
      title={page.title}
      topRight={conceptMaps.topRight}
      onBack={onBack}
    />
  );
}

function HtmlBody({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const safeHtml = useMemo(() => sanitizeCanvasHtml(html), [html]);

  // Canvas HTML links open in the system browser, not inside the WebView.
  useEffect(() => {
    ref.current?.querySelectorAll('a').forEach((anchor) => {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noreferrer');
    });
  }, [safeHtml]);

  return <div dangerouslySetInnerHTML={{ __html: safeHtml }} ref={ref} className='st-prose' />;
}

export default function ItemPage() {
  const router = useRouter();
  const itemId = typeof router.query.id === 'string' ? router.query.id : '';
  const annotate = router.query.annotate === '1';
  const { data: item, isLoading, error, refetch } = useItem(itemId);
  const { data: classes } = useClasses('all');
  const cls = useMemo(() => classes?.find((candidate) => candidate.id === item?.classId), [classes, item?.classId]);
  const markSeen = useMarkSeen();
  const seenRef = useRef<string | null>(null);
  const annotation = useAnnotationPage(item && isPdf(item) ? item : undefined);
  const notes = useItemNotes(item && !isPdf(item) ? item : undefined);
  const aiOn = useAiEnabled();

  useEffect(() => {
    if (item && !item.seenAt && seenRef.current !== item.id) {
      seenRef.current = item.id;
      markSeen.mutate(item.id);
    }
  }, [item, markSeen]);

  const backToClass = useCallback(() => {
    if (item) void router.push(`/class/?id=${encodeURIComponent(item.classId)}`);
    else router.back();
  }, [item, router]);

  if (!itemId) return <EmptyState title='No item selected' />;
  if (error) return <ErrorNote message={describeError(error)} onRetry={() => void refetch()} />;
  if (isLoading || !item) return <LoadingRows rows={6} />;

  // Video → the lectures feature's study view (player + transcript + synced notebook).
  if (item.type === 'video') {
    return (
      <>
        <Head>
          <title>{item.title} · Syllabi</title>
        </Head>
        {/* Over the shell's padded, max-width column: the video + notes split needs the whole content
            area, and a fixed height so only its own panes scroll (never the page under the pen). */}
        <div className='bg-st-bg absolute inset-0 z-10'>
          <VideoStudy item={item} itemId={item.id} onBack={backToClass} />
        </div>
      </>
    );
  }

  // PDF opened for annotation: the board takes the whole content area.
  if (isPdf(item) && annotate && annotation.page) {
    return (
      <div className='bg-st-bg fixed inset-0 z-40'>
        <Head>
          <title>{item.title} · Syllabi</title>
        </Head>
        <PdfBoard
          item={item}
          page={annotation.page}
          onBack={() => void router.replace(`/item/?id=${encodeURIComponent(item.id)}`)}
        />
      </div>
    );
  }

  const Icon = ITEM_TYPE_ICON[item.type];
  const dueAt = effectiveDue(item);
  const due = daysUntil(dueAt);

  return (
    <>
      <Head>
        <title>{item.title} · Syllabi</title>
      </Head>
      <PageHeader
        actions={
          <>
            <AskTutorButton
              classId={item.classId}
              context={{ itemId: item.id }}
              contextLabel={item.title}
              label='Ask about this'
            />
            {!isPdf(item) && (
              <ActionButton disabled={notes.open.isPending} onClick={() => notes.open.mutate()}>
                <NotebookPen className='h-4 w-4' /> {notes.existing ? 'Open my notes' : 'Take notes'}
              </ActionButton>
            )}
            {notes.existing && aiOn && (
              <ActionButton
                onClick={() =>
                  void router.push(`/flashcards/?classId=${encodeURIComponent(item.classId)}&make=page`)
                }
              >
                <Layers className='h-4 w-4' /> Make flashcards
              </ActionButton>
            )}
            {(item.type === 'file' || item.type === 'page' || item.type === 'assignment') && (
              <ExtractButton classId={item.classId} itemId={item.id} label='Make questions' />
            )}
            {/* An item filed from the phone inbox (or generated) has no Canvas page to open. */}
            {item.canvasUrl && (
              <a
                className='rounded-st border-st-clay-edge bg-st-surface shadow-clay text-st-fg hover:bg-st-accent-soft inline-flex min-h-11 items-center gap-2 border-2 px-4 text-sm font-semibold transition-transform active:translate-y-[3px] active:shadow-none'
                href={item.canvasUrl}
                rel='noreferrer'
                target='_blank'
              >
                <ExternalLink className='h-4 w-4' /> Open in Canvas
              </a>
            )}
            {item.file?.url && (
              <a
                className='rounded-st border-st-clay-edge bg-st-surface shadow-clay text-st-fg hover:bg-st-accent-soft inline-flex min-h-11 items-center gap-2 border-2 px-4 text-sm font-semibold transition-transform active:translate-y-[3px] active:shadow-none'
                download={item.title}
                href={item.file.url}
                rel='noreferrer'
                target='_blank'
              >
                <Download className='h-4 w-4' /> Download {formatBytes(item.file.size)}
              </a>
            )}
          </>
        }
        back={`/class/?id=${encodeURIComponent(item.classId)}`}
        eyebrow={
          <span className='inline-flex items-center gap-2'>
            {cls && <span className='h-2.5 w-2.5 rounded-sm' style={{ backgroundColor: cls.color }} />}
            {cls?.code ?? ''} · {ITEM_TYPE_LABEL[item.type]}
            {item.external?.tool && <Badge tone='accent'>{item.external.tool}</Badge>}
          </span>
        }
        subtitle={
          <span className='inline-flex flex-wrap items-center gap-3'>
            {dueAt && (
              <span
                className={
                  due !== null &&
                  due < 0 &&
                  item.submission?.state !== 'graded' &&
                  item.submission?.state !== 'submitted'
                    ? 'text-st-danger font-medium'
                    : ''
                }
              >
                Due {formatDue(dueAt)} · {formatDateTime(dueAt)}
              </span>
            )}
            {item.dueChangedBy && (
              <Link
                className='text-st-warn inline-flex min-h-9 items-center gap-1 text-xs font-medium underline-offset-2 hover:underline'
                href={`/item/?id=${encodeURIComponent(item.dueChangedBy.announcementItemId)}`}
                title={item.dueChangedBy.text}
              >
                <Badge tone='warn'>Moved by announcement</Badge>
                {item.dueAt && item.dueAt !== dueAt && (
                  <span className='text-st-muted font-normal'>Canvas says {formatDateTime(item.dueAt)}</span>
                )}
              </Link>
            )}
            {typeof item.points === 'number' && (
              <span>
                {item.submission?.score !== null && item.submission?.score !== undefined
                  ? `${item.submission.score} / `
                  : ''}
                {item.points} pts
              </span>
            )}
            {item.submission && (
              <Badge
                tone={
                  item.submission.state === 'graded'
                    ? 'ok'
                    : item.submission.state === 'missing'
                      ? 'danger'
                      : item.submission.state === 'late'
                        ? 'warn'
                        : item.submission.state === 'submitted'
                          ? 'accent'
                          : 'neutral'
                }
              >
                {item.submission.state}
              </Badge>
            )}
          </span>
        }
        title={item.title}
      />

      {isPdf(item) && (
        <Surface className='mb-6 flex flex-wrap items-center gap-4 p-4'>
          <span className='rounded-st bg-st-raised text-st-muted flex h-12 w-12 items-center justify-center'>
            <FileText className='h-6 w-6' />
          </span>
          <div className='min-w-0 flex-1'>
            <p className='text-st-fg text-sm font-semibold'>Annotate with the S Pen</p>
            <p className='text-st-muted text-sm'>
              {annotation.page
                ? 'Your handwriting is saved on this tablet and synced to the cloud.'
                : 'Opens the PDF as notebook pages you can write on.'}
            </p>
          </div>
          {annotation.create.error && <ErrorNote message={describeError(annotation.create.error)} />}
          <ActionButton
            loading={annotation.loading || annotation.create.isPending}
            variant='primary'
            onClick={async () => {
              let page = annotation.page;

              if (!page) page = await annotation.create.mutateAsync();
              void router.replace(`/item/?id=${encodeURIComponent(item.id)}&annotate=1`);
            }}
          >
            <NotebookPen className='h-4 w-4' /> {annotation.page ? 'Continue annotating' : 'Open in notebook'}
          </ActionButton>
          {annotation.page && (
            <Link
              className='text-st-accent text-sm font-medium underline underline-offset-2'
              href={notebookHref(annotation.page)}
            >
              Open as notebook
            </Link>
          )}
        </Surface>
      )}

      {item.type === 'file' && !isPdf(item) && (
        <Surface className='mb-6 flex items-center gap-4 p-4'>
          <Icon className='text-st-muted h-6 w-6' />
          <div className='text-st-muted min-w-0 flex-1 text-sm'>
            {item.file?.mime ?? 'file'} · {formatBytes(item.file?.size)} · v{item.file?.version ?? 1}
          </div>
        </Surface>
      )}

      {item.html ? (
        <Surface className='p-6'>
          <HtmlBody html={item.html} />
        </Surface>
      ) : (
        !isPdf(item) &&
        item.type !== 'file' && (
          <EmptyState hint='Open it in Canvas for the full content.' icon={Icon} title='No body to show' />
        )
      )}
    </>
  );
}
