import type { LibraryDoc } from '@/lib/api/types';

import { useRef, useState } from 'react';
import { addToast } from '@repo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { FileUp } from 'lucide-react';

import { libraryKeys } from '../hooks';
import { libraryUploadProblem } from '../lib/library';

import { ActionButton } from '@/components/ui/primitives';
import { LIBRARY_UPLOAD_MAX_BYTES, uploadLibraryPdf } from '@/lib/api/endpoints';
import { describeError } from '@/lib/api/errors';

/**
 * «Upload PDF» in a class Library: pick a PDF, it goes into this class's Library and shows in the list
 * at once, ready for «Write on it», Flashcards and questions.
 */
export function LibraryUploadButton({ classId, variant = 'secondary' }: { classId: string; variant?: 'primary' | 'secondary' }) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // Set at once: a second tap before the button re-renders as busy must not upload twice.
  const busyRef = useRef(false);

  const upload = async (file: File) => {
    const problem = libraryUploadProblem(file, LIBRARY_UPLOAD_MAX_BYTES);

    if (problem) {
      addToast({ title: problem, color: 'danger' });

      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const doc = await uploadLibraryPdf(classId, file, file.name);

      // In the list now, then the server's own list (never wait out the list's cache time).
      queryClient.setQueryData<LibraryDoc[]>(libraryKeys.list(classId), (list) =>
        list && !list.some((item) => item.id === doc.id) ? [...list, doc] : list,
      );
      void queryClient.invalidateQueries({ queryKey: libraryKeys.list(classId) });
      // Flashcards → Library lists sources under its own key.
      void queryClient.invalidateQueries({ queryKey: ['study', 'flashcard-sources'] });
      addToast({ title: `Added “${doc.title}” to the Library`, color: 'success' });
    } catch (err) {
      addToast({ title: describeError(err, 'Could not upload that PDF'), color: 'danger' });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <ActionButton className='shrink-0' loading={busy} variant={variant} onClick={() => fileRef.current?.click()}>
        {!busy && <FileUp className='h-4 w-4' />} {busy ? 'Uploading…' : 'Upload PDF'}
      </ActionButton>
      <input
        ref={fileRef}
        aria-hidden
        accept='application/pdf,.pdf'
        className='hidden'
        tabIndex={-1}
        type='file'
        onChange={(event) => {
          const file = event.target.files?.[0];

          // Clear it so picking the same file again still fires a change.
          event.target.value = '';
          if (file) void upload(file);
        }}
      />
    </>
  );
}
