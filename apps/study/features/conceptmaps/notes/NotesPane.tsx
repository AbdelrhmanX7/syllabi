import type { NoteLink } from './links';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Eye, FileText, Link2, NotebookPen, PenLine, X } from 'lucide-react';
import dynamic from 'next/dynamic';

import { linkKey } from './links';
import { restoreFor, seedFor } from './sources';

import { NotebookBoard } from '@/components/notebook/NotebookBoard';
import { ActionButton, EmptyState, ErrorNote, LoadingRows } from '@/components/ui/primitives';
import { useLibraryDoc } from '@/features/library/hooks';
import { useStudyBoardAi } from '@/features/tutor';
import { describeError } from '@/lib/api/errors';

const Markdown = dynamic(() => import('@/features/bank').then((mod) => mod.Markdown), { ssr: false });

/**
 * Left side of the workspace: his linked notes, one tab each, on the notebook board (PDFs scroll as
 * one column, zoom locked to the page width). View-only by default so a stray palm never marks the
 * notes while he draws the map; «Annotate» hands the pen to the notes. A slide photo (camera or
 * paste) lands on the current page and switches to annotate so he can move it into place.
 */
export interface NotesPaneProps {
  classId: string;
  links: NoteLink[];
  activeKey: string | null;
  onActiveKey: (key: string) => void;
  onLinkNotes: () => void;
  onUnlink: (key: string) => void;
  /** A photo from the workspace's paste handler, for the active page. */
  pastedImage: File | null;
  onPastedImageTaken: () => void;
  /** True on narrow screens: the pane is the whole width. */
  compact?: boolean;
  /** In class he is writing the notes: open with the pen on them. */
  annotateByDefault?: boolean;
}

export function NotesPane({
  classId,
  links,
  activeKey,
  onActiveKey,
  onLinkNotes,
  onUnlink,
  pastedImage,
  onPastedImageTaken,
  compact = false,
  annotateByDefault = false,
}: NotesPaneProps) {
  const active = links.find((link) => linkKey(link) === activeKey) ?? links[0] ?? null;
  const [annotate, setAnnotate] = useState(annotateByDefault);
  const [photo, setPhoto] = useState<File | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const isPage = active?.kind === 'page';

  // A pasted slide goes to the page on screen, and the pen with it.
  useEffect(() => {
    if (!pastedImage) return;
    if (isPage) {
      setPhoto(pastedImage);
      setAnnotate(true);
    }
    onPastedImageTaken();
  }, [pastedImage]);

  return (
    <div className='bg-st-bg flex h-full min-h-0 w-full flex-col'>
      <div className='border-st-line bg-st-surface flex min-h-12 items-center gap-1.5 border-b px-2'>
        <div className='flex min-w-0 flex-1 gap-1 overflow-x-auto py-1.5 [scrollbar-width:none]'>
          {links.map((link) => {
            const key = linkKey(link);
            const on = active !== null && linkKey(active) === key;

            return (
              <span
                key={key}
                className={`group inline-flex min-h-9 max-w-[16rem] shrink-0 items-center rounded-full border text-sm ${
                  on ? 'border-st-accent-lip bg-st-accent text-st-accent-fg' : 'border-st-line text-st-fg hover:bg-st-raised'
                }`}
              >
                <button
                  className='flex min-h-9 min-w-0 items-center gap-1.5 pl-3 pr-1'
                  type='button'
                  onClick={() => onActiveKey(key)}
                >
                  {link.kind === 'page' && !link.libraryId && !link.fileName ? (
                    <NotebookPen className='h-3.5 w-3.5 shrink-0' />
                  ) : (
                    <FileText className='h-3.5 w-3.5 shrink-0' />
                  )}
                  <span className='truncate'>{link.title}</span>
                </button>
                <button
                  aria-label={`Unlink ${link.title}`}
                  className={`mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                    on ? 'hover:bg-st-bg/20' : 'text-st-muted hover:bg-st-line'
                  }`}
                  type='button'
                  onClick={() => onUnlink(key)}
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </span>
            );
          })}
        </div>
        <ActionButton
          className='min-h-9 shrink-0 px-2.5'
          title='Link lecture notes'
          variant='ghost'
          onClick={onLinkNotes}
        >
          <Link2 className='h-4 w-4' /> {compact || links.length > 0 ? '' : 'Link notes'}
        </ActionButton>
        {isPage && (
          <>
            <input
              ref={cameraRef}
              accept='image/*'
              capture='environment'
              className='hidden'
              type='file'
              onChange={(event) => {
                const file = event.target.files?.[0];

                event.target.value = '';
                if (file) {
                  setPhoto(file);
                  setAnnotate(true);
                }
              }}
            />
            <ActionButton
              className='min-h-9 shrink-0 px-2.5'
              title='Add a slide photo to this page (or paste one)'
              variant='ghost'
              onClick={() => cameraRef.current?.click()}
            >
              <Camera className='h-4 w-4' />
            </ActionButton>
            <button
              aria-pressed={annotate}
              className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium ${
                annotate
                  ? 'border-st-accent bg-st-accent text-st-accent-fg'
                  : 'border-st-line text-st-fg hover:bg-st-raised'
              }`}
              title={annotate ? 'Back to view-only' : 'Write on the notes'}
              type='button'
              onClick={() => setAnnotate((value) => !value)}
            >
              {annotate ? <PenLine className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
              {annotate ? 'Annotating' : 'View only'}
            </button>
          </>
        )}
      </div>

      <div className='relative min-h-0 flex-1'>
        {!active ? (
          <div className='flex h-full items-center justify-center p-6'>
            <EmptyState
              action={
                <ActionButton variant='primary' onClick={onLinkNotes}>
                  <Link2 className='h-4 w-4' /> Link lecture notes
                </ActionButton>
              }
              hint='Your notebook page for this lecture, the PDF you exported, or a library file. It opens here, beside the map.'
              icon={NotebookPen}
              title='No notes linked yet'
            />
          </div>
        ) : active.kind === 'page' ? (
          <PageBoard
            key={active.pageId}
            annotate={annotate}
            classId={classId}
            link={active}
            photo={photo}
            onPhotoInserted={() => setPhoto(null)}
          />
        ) : (
          <LibraryNote key={active.libraryId} libraryId={active.libraryId} />
        )}
      </div>
    </div>
  );
}

function PageBoard({
  classId,
  link,
  annotate,
  photo,
  onPhotoInserted,
}: {
  classId: string;
  link: Extract<NoteLink, { kind: 'page' }>;
  annotate: boolean;
  photo: File | null;
  onPhotoInserted: () => void;
}) {
  const [progress, setProgress] = useState<string | null>(null);
  const boardAi = useStudyBoardAi(link.pageId, classId);
  // Stable per link: the board opens once, the seed closure must not change under it.
  const seed = useMemo(() => seedFor(link, setProgress), [link.pageId]);
  const restore = useMemo(() => restoreFor(link, setProgress), [link.pageId]);

  return (
    <div className='absolute inset-0'>
      <NotebookBoard
        embedded
        hideChrome
        boardAi={boardAi}
        pageId={link.pageId}
        pendingImage={photo}
        readOnly={!annotate}
        restorePdfAsset={restore}
        seed={seed}
        seedProgress={progress}
        title={link.title}
        onBack={() => undefined}
        onImageInserted={onPhotoInserted}
      />
    </div>
  );
}

function LibraryNote({ libraryId }: { libraryId: string }) {
  const doc = useLibraryDoc(libraryId);

  if (doc.isLoading) return <LoadingRows rows={6} />;
  if (doc.error) return <ErrorNote message={describeError(doc.error)} onRetry={() => void doc.refetch()} />;

  return (
    <div className='absolute inset-0 overflow-y-auto px-4 py-5'>
      <article className='bg-st-surface border-st-clay-edge rounded-st-lg shadow-clay mx-auto max-w-3xl border-2 px-6 py-5'>
        <h2 className='text-st-fg mb-3 text-lg font-semibold'>{doc.data?.title}</h2>
        <Markdown text={doc.data?.markdown ?? ''} />
      </article>
    </div>
  );
}
