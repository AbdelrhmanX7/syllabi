import type { NotebookImport } from '@/lib/notebooks/import-notebook';

import { useRef, useState } from 'react';
import { FileUp } from 'lucide-react';

import { fileSources, OpenAsNotebookSheet } from './OpenAsNotebookSheet';
import { Sheet } from './Sheet';

import { ActionButton, ErrorNote } from '@/components/ui/primitives';
import { notebookTitleForImages, notebookTitleFromFileName, planImport } from '@/lib/notebooks/import-pages';

const ACCEPT = 'application/pdf,.pdf,image/*';

/**
 * «Import pages» next to «New notebook»: pick a PDF exported from Samsung Notes / GoodNotes / OneNote
 * (or a set of page images) and open it as a new notebook in this class — the web / desktop way in,
 * the same import the Android share sheet runs.
 */
export function ImportNotebookButton({ classId }: { classId: string | null }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ input: NotebookImport; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = (files: File[]) => {
    const plan = planImport(files);

    if (plan.kind === 'error') {
      setError(plan.message);

      return;
    }
    setError(null);
    if (plan.kind === 'pdf') {
      setPending({ input: { kind: 'pdf', source: fileSources([plan.file])[0] }, title: notebookTitleFromFileName(plan.file.name) });
    } else {
      setPending({
        input: { kind: 'images', sources: fileSources(plan.files) },
        title: notebookTitleForImages(plan.files.map((file) => file.name)),
      });
    }
  };

  return (
    <>
      <ActionButton onClick={() => fileRef.current?.click()}>
        <FileUp className='h-4 w-4' /> Import pages
      </ActionButton>
      <input
        ref={fileRef}
        aria-hidden
        multiple
        accept={ACCEPT}
        className='hidden'
        tabIndex={-1}
        type='file'
        onChange={(event) => {
          // Copy first: the FileList is live and clearing the input empties it.
          const files = Array.from(event.target.files ?? []);

          event.target.value = '';
          if (files.length) pick(files);
        }}
      />
      {error && (
        <Sheet title="Can't open these files" onClose={() => setError(null)}>
          <ErrorNote message={error} />
        </Sheet>
      )}
      {pending && (
        <OpenAsNotebookSheet
          classId={classId}
          defaultTitle={pending.title}
          input={pending.input}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}
