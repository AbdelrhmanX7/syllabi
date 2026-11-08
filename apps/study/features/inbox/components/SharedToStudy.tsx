import type { SharedFile, ShareBridge } from '../lib/share';
import type { InboxItem } from '../types';
import type { NotebookImport } from '@/lib/notebooks/import-notebook';

import { useCallback, useEffect, useState } from 'react';
import { BookOpen, FileText, Inbox, NotebookPen, NotebookText, X } from 'lucide-react';

import { uploadToInbox } from '../api';
import { inboxPdfFileName } from '../lib/links';
import { getShareBridge, isSharedImage, parsePending, readSharedFile, SHARE_EVENT } from '../lib/share';
import { dispatchInbox, markItemUsed } from '../store';

import { BankExtractSheet } from './BankExtractSheet';
import { NotebookPickerSheet } from './NotebookPickerSheet';
import { OpenAsNotebookSheet } from './OpenAsNotebookSheet';
import { Sheet } from './Sheet';

import { ActionButton, ErrorNote } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';
import { formatBytes } from '@/lib/format';
import { notebookTitleForImages, notebookTitleFromFileName } from '@/lib/notebooks/import-pages';
import { IfAi } from '@/components/ui/AiOff';

type Next =
  | { kind: 'notes'; item: InboxItem }
  | { kind: 'bank'; file: SharedFile }
  | { kind: 'notebook'; files: SharedFile[] }
  | null;

/**
 * Files shared into Study on Android (Gallery, Files, screenshots, Quick Share). Mounted once in the
 * shell: lists the bridge's pending files on mount (a share that cold-started the app) and on every
 * `study-share` event (a share while open), and offers Add to Inbox / Insert into notes / Make questions.
 * Renders nothing outside the Android build (no `window.StudyShare`).
 */
export function SharedToStudy() {
  const [bridge, setBridge] = useState<ShareBridge | null>(null);
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [next, setNext] = useState<Next>(null);

  const refresh = useCallback(() => {
    const current = getShareBridge();

    setBridge(current);
    if (!current) return;
    const pending = parsePending(current.pending());

    setFiles(pending);
    if (pending.length) setDismissed(false);
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(SHARE_EVENT, refresh);

    return () => window.removeEventListener(SHARE_EVENT, refresh);
  }, [refresh]);

  const done = useCallback(
    (file: SharedFile) => {
      bridge?.remove(file.id);
      setFiles((current) => current.filter((candidate) => candidate.id !== file.id));
    },
    [bridge],
  );

  if (!bridge) return null;

  if (next?.kind === 'notes') return <NotebookPickerSheet item={next.item} onClose={() => setNext(null)} />;
  if (next?.kind === 'bank') {
    const file = next.file;

    return (
      <BankExtractSheet
        source={{ preview: null, load: async () => readSharedFile(bridge, file) }}
        onClose={() => setNext(null)}
        onExtracted={() => done(file)}
      />
    );
  }

  if (next?.kind === 'notebook') {
    const picked = next.files;
    const pdf = picked.length === 1 && !isSharedImage(picked[0]) ? picked[0] : null;
    const sources = picked.map((file) => ({
      name: file.name,
      mime: file.mime,
      // Read over the bridge only when the import reaches this file (one base64 copy at a time).
      load: () => readSharedFile(bridge, file),
    }));

    return (
      <OpenAsNotebookSheet
        defaultTitle={pdf ? notebookTitleFromFileName(pdf.name) : notebookTitleForImages(picked.map((file) => file.name))}
        input={pdf ? { kind: 'pdf', source: sources[0] } : { kind: 'images', sources }}
        prepare={pdf ? (input) => keepPdfInInbox(bridge, pdf, input) : undefined}
        onClose={() => setNext(null)}
        onImported={() => picked.forEach(done)}
      />
    );
  }

  if (!files.length || dismissed) return null;

  return (
    <SharedSheet
      bridge={bridge}
      files={files}
      onBank={(file) => setNext({ kind: 'bank', file })}
      onClose={() => setDismissed(true)}
      onDiscard={done}
      onNotebook={(picked) => setNext({ kind: 'notebook', files: picked })}
      onNotes={(item, file) => {
        done(file);
        setNext({ kind: 'notes', item });
      }}
      onUploaded={done}
    />
  );
}

function SharedSheet({
  bridge,
  files,
  onClose,
  onDiscard,
  onUploaded,
  onNotes,
  onBank,
  onNotebook,
}: {
  bridge: ShareBridge;
  files: SharedFile[];
  onClose: () => void;
  onDiscard: (file: SharedFile) => void;
  onUploaded: (file: SharedFile) => void;
  onNotes: (item: InboxItem, file: SharedFile) => void;
  onBank: (file: SharedFile) => void;
  onNotebook: (files: SharedFile[]) => void;
}) {
  const images = files.filter(isSharedImage);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Upload one shared file to the inbox (POST /inbox; the mock until it is live).
  const toInbox = async (file: SharedFile): Promise<InboxItem> => {
    const item = await uploadToInbox(readSharedFile(bridge, file));

    dispatchInbox({ type: 'arrived', items: [item] });

    return item;
  };

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet
      wide
      footer={
        files.length > 1 ? (
          <div className='flex flex-wrap justify-end gap-3'>
            {images.length > 1 && (
              <ActionButton disabled={busy !== null} onClick={() => onNotebook(images)}>
                <NotebookText className='h-4 w-4' /> Open all {images.length} images as one notebook
              </ActionButton>
            )}
            <ActionButton
              loading={busy === 'all'}
              variant='primary'
              onClick={() =>
                void run('all', async () => {
                  for (const file of files) {
                    await toInbox(file);
                    onUploaded(file);
                  }
                })
              }
            >
              <Inbox className='h-4 w-4' /> Add all {files.length} to Inbox
            </ActionButton>
          </div>
        ) : undefined
      }
      subtitle={`${files.length} file${files.length === 1 ? '' : 's'} from another app`}
      title='Shared to Study'
      onClose={onClose}
    >
      {error && (
        <div className='mb-3'>
          <ErrorNote message={error} />
        </div>
      )}
      <ul className='divide-st-line flex flex-col divide-y'>
        {files.map((file) => {
          const image = isSharedImage(file);

          return (
            <li key={file.id} className='flex flex-wrap items-center gap-3 py-3'>
              <SharedPreview bridge={bridge} file={file} />
              <div className='min-w-[10rem] flex-1'>
                <p className='text-st-fg break-words text-sm font-medium'>{file.name}</p>
                <p className='text-st-muted text-xs'>
                  {image ? 'Image' : 'PDF'} · {formatBytes(file.bytes)}
                </p>
              </div>
              <div className='flex flex-wrap gap-2'>
                <ActionButton
                  className='min-h-9 px-3 text-xs'
                  disabled={busy !== null}
                  loading={busy === `inbox:${file.id}`}
                  onClick={() =>
                    void run(`inbox:${file.id}`, async () => {
                      await toInbox(file);
                      onUploaded(file);
                    })
                  }
                >
                  <Inbox className='h-3.5 w-3.5' /> Add to Inbox
                </ActionButton>
                <ActionButton
                  className='min-h-9 px-3 text-xs'
                  disabled={busy !== null}
                  onClick={() => onNotebook([file])}
                >
                  <NotebookText className='h-3.5 w-3.5' /> Open as notebook
                </ActionButton>
                <ActionButton
                  className='min-h-9 px-3 text-xs'
                  disabled={!image || busy !== null}
                  loading={busy === `notes:${file.id}`}
                  title={image ? undefined : 'Only images go onto a notebook page'}
                  onClick={() => void run(`notes:${file.id}`, async () => onNotes(await toInbox(file), file))}
                >
                  <NotebookPen className='h-3.5 w-3.5' /> Insert into notes
                </ActionButton>
                <IfAi>
                  <ActionButton
                    className='min-h-9 px-3 text-xs'
                    disabled={!image || busy !== null}
                    title={image ? undefined : 'Question extraction reads photos'}
                    onClick={() => onBank(file)}
                  >
                    <BookOpen className='h-3.5 w-3.5' /> Make questions
                  </ActionButton>
                </IfAi>
                <ActionButton
                  aria-label={`Discard ${file.name}`}
                  className='min-h-9 px-2 text-xs'
                  disabled={busy !== null}
                  onClick={() => onDiscard(file)}
                >
                  <X className='h-3.5 w-3.5' />
                </ActionButton>
              </div>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

/**
 * Board PDFs live on the importing tablet only. A shared PDF is also kept in the inbox and its asset
 * named `phone-<itemId>.pdf`, so another tablet opening this notebook re-downloads it from there
 * (restoreInboxPdfAsset). Best effort: offline / no inbox → a device-only notebook, still usable.
 */
async function keepPdfInInbox(
  bridge: ShareBridge,
  file: SharedFile,
  input: NotebookImport,
): Promise<NotebookImport> {
  if (input.kind !== 'pdf') return input;
  try {
    const item = await uploadToInbox(readSharedFile(bridge, file));

    dispatchInbox({ type: 'arrived', items: [item] });
    void markItemUsed(item.id);

    return { ...input, assetFileName: inboxPdfFileName(item.id) };
  } catch {
    return input;
  }
}

/** A small thumbnail read from the bridge (images only), revoked on unmount. */
function SharedPreview({ bridge, file }: { bridge: ShareBridge; file: SharedFile }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!isSharedImage(file)) return;
    let url: string | null = null;

    try {
      url = URL.createObjectURL(readSharedFile(bridge, file));
      setSrc(url);
    } catch {
      setSrc(null);
    }

    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [bridge, file]);

  if (!src) {
    return (
      <div className='rounded-st bg-st-raised text-st-muted flex h-16 w-20 shrink-0 items-center justify-center'>
        <FileText className='h-6 w-6' strokeWidth={1.5} />
      </div>
    );
  }

  // eslint-disable-next-line @next/next/no-img-element -- blob URL
  return <img alt={file.name} className='rounded-st bg-st-raised h-16 w-20 shrink-0 object-cover' src={src} />;
}
