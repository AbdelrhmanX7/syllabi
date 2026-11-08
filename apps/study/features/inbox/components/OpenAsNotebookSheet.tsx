import type { ImportSource, NotebookImport } from '@/lib/notebooks/import-notebook';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NotebookPen } from 'lucide-react';
import { useRouter } from 'next/router';

import { Sheet } from './Sheet';

import { ActionButton, ErrorNote, Field, FilterChip, INPUT_CLASS } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';
import { useClasses } from '@/lib/api/hooks';
import { importNotebook } from '@/lib/notebooks/import-notebook';

const TITLE_MAX = 200;
const LAST_CLASS_KEY = 'study_import_class';

function readLastClass(): string {
  try {
    return window.localStorage.getItem(LAST_CLASS_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberLastClass(classId: string): void {
  try {
    window.localStorage.setItem(LAST_CLASS_KEY, classId);
  } catch {
    // storage refusal: the next import just asks again
  }
}

export const notebookPageHref = (pageId: string) => `/notebook/?id=${encodeURIComponent(pageId)}`;

/** Picked files (web / desktop file picker) → import sources read straight from memory. */
export const fileSources = (files: readonly File[]): ImportSource[] =>
  files.map((file) => ({ name: file.name, mime: file.type, load: () => file }));

/**
 * «Open as notebook»: a PDF (one board page per PDF page) or a set of images (one page each, the
 * image as the locked background) becomes a NEW notebook page in a class, then opens on the board.
 * `classId` fixes the class (the class page; `null` = no class, the Notes page); without it the student
 * picks one or «No class» (the share sheet).
 */
export function OpenAsNotebookSheet({
  input,
  defaultTitle,
  classId: fixedClassId,
  prepare,
  onImported,
  onClose,
}: {
  input: NotebookImport;
  defaultTitle: string;
  classId?: string | null;
  /** Last step before building, e.g. keep a shared PDF in the inbox so another tablet can fetch it. */
  prepare?: (input: NotebookImport) => Promise<NotebookImport>;
  /** The notebook exists: drop the source files (the share bridge's copies). */
  onImported?: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: classes } = useClasses();
  const [title, setTitle] = useState(defaultTitle.slice(0, TITLE_MAX));
  const fixed = fixedClassId !== undefined;
  const [classId, setClassId] = useState(fixedClassId ?? '');
  const [noClass, setNoClass] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null;
  const count = input.kind === 'images' ? input.sources.length : 1;

  // Preselect the class used last time (or the only one).
  useEffect(() => {
    if (fixed || noClass || classId || !classes?.length) return;
    const last = readLastClass();

    setClassId(classes.some((cls) => cls.id === last) ? last : classes[0].id);
  }, [classId, classes, fixed, noClass]);

  const open = async () => {
    setError(null);
    setProgress('Starting…');
    try {
      const ready = prepare ? await prepare(input) : input;
      const page = await importNotebook({
        classId: classId || null,
        title: title.trim() || defaultTitle,
        input: ready,
        onProgress: setProgress,
      });

      if (classId) rememberLastClass(classId);
      onImported?.();
      void queryClient.invalidateQueries({ queryKey: ['study', 'pages'] });
      onClose();
      void router.push(notebookPageHref(page.id));
    } catch (err) {
      setError(describeError(err));
      setProgress(null);
    }
  };

  return (
    <Sheet
      footer={
        <div className='flex flex-wrap items-center justify-end gap-3'>
          {progress && (
            <p aria-live='polite' className='text-st-muted min-w-0 flex-1 text-sm'>
              {progress}
            </p>
          )}
          <ActionButton loading={busy} variant='primary' onClick={() => void open()}>
            <NotebookPen className='h-4 w-4' /> Open notebook
          </ActionButton>
        </div>
      }
      subtitle={
        input.kind === 'pdf'
          ? 'Each PDF page becomes a page you can write on.'
          : `${count} image${count === 1 ? '' : 's'}, one page each, to write on.`
      }
      title='Open as notebook'
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className='flex flex-col gap-3'>
        {error && <ErrorNote message={error} />}
        <Field label='Title'>
          <input
            aria-label='Notebook title'
            className={INPUT_CLASS}
            disabled={busy}
            maxLength={TITLE_MAX}
            placeholder={defaultTitle}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        {!fixed && (
          <div className='flex flex-col gap-1.5'>
            <span className='text-st-fg text-sm font-medium'>Class</span>
            {classes?.length ? (
              <div className='flex flex-wrap gap-2'>
                <FilterChip
                  active={!classId}
                  onClick={() => {
                    if (busy) return;
                    setNoClass(true);
                    setClassId('');
                  }}
                >
                  No class
                </FilterChip>
                {classes.map((cls) => (
                  <FilterChip key={cls.id} active={classId === cls.id} onClick={() => !busy && setClassId(cls.id)}>
                    <span className='h-2 w-2 rounded-sm' style={{ backgroundColor: cls.color }} />
                    {cls.code || cls.name}
                  </FilterChip>
                ))}
              </div>
            ) : (
              <span className='text-st-muted text-sm'>Not set</span>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
