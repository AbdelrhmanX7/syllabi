import type { InkCanvasHandle, InkTool } from '@/features/bank/components/InkCanvas';
import type { Question, QuestionNote } from '@/lib/api/types';

import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@repo/ui';
import { Eraser, PenLine, Trash2, Undo2 } from 'lucide-react';

import { useCardMarks } from '../hooks';
import { decodeNote, encodeNote, noteTooBig, sameNote } from '../lib/note';

import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { ActionButton, ErrorNote } from '@/components/ui/primitives';
import { InkCanvas } from '@/features/bank/components/InkCanvas';
import { Sheet } from '@/features/inbox/components/Sheet';
import { describeError } from '@/lib/api/errors';

const PAD_HEIGHT = 280;

/**
 * A small pen pad for a note on a card: pen, eraser (or the S Pen button), undo, clear (asks first).
 * Fingers and a resting palm never draw. It saves when you close it; if the save fails it stays open
 * with the ink, so nothing is lost.
 */
export function NotePad({
  card,
  onClose,
  onSaved,
}: {
  card: Pick<Question, 'id' | 'stem' | 'note'>;
  onClose: () => void;
  onSaved?: (note: QuestionNote | null) => void;
}) {
  const { saveNote } = useCardMarks();
  const inkRef = useRef<InkCanvasHandle>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<InkTool>('pen');
  const [empty, setEmpty] = useState(!card.note);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'clear' | 'discard' | null>(null);
  /** Loading the saved strokes fires the pad's change event too; that isn't an edit. */
  const loaded = useRef(false);

  // Load the saved note sized to this pad (a note written on a wider screen shrinks to fit).
  useLayoutEffect(() => {
    const width = boxRef.current?.clientWidth;

    if (card.note && width) inkRef.current?.setStrokes(decodeNote(card.note, width));
    loaded.current = true;
    // Only on open: later edits belong to the pad.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = async () => {
    if (saving) return;
    const width = boxRef.current?.clientWidth ?? card.note?.w ?? 1;
    const note = encodeNote(inkRef.current?.getStrokes() ?? [], width, PAD_HEIGHT);

    if (!dirty || sameNote(note, card.note)) return onClose();
    if (noteTooBig(note)) return setError('This note is too long to save. Erase some of it and close again.');
    setSaving(true);
    setError(null);
    try {
      await saveNote(card, note);
      onSaved?.(note);
      onClose();
    } catch (err) {
      setSaving(false);
      setError(describeError(err, 'The note didn’t save. It’s still here: try closing again.'));
    }
  };

  const toolButton = (key: InkTool, label: string, Icon: typeof PenLine) => (
    <Button
      isIconOnly
      aria-label={label}
      aria-pressed={tool === key}
      color={tool === key ? 'primary' : 'default'}
      size='sm'
      title={label}
      variant={tool === key ? 'flat' : 'light'}
      onPress={() => setTool(key)}
    >
      <Icon className='h-4 w-4' />
    </Button>
  );

  return (
    <>
      <Sheet
        footer={
          error ? (
            <div className='flex justify-end'>
              <ActionButton disabled={saving} variant='ghost' onClick={() => setConfirm('discard')}>
                Close without saving
              </ActionButton>
            </div>
          ) : undefined
        }
        subtitle={saving ? 'Saving…' : 'Saves when you close it'}
        title='Note on this card'
        onClose={() => void close()}
      >
        <div className='flex flex-col gap-3'>
          <div className='flex items-center gap-1'>
            {toolButton('pen', 'Pen', PenLine)}
            {toolButton('eraser', 'Eraser', Eraser)}
            <span className='flex-1' />
            <Button isIconOnly aria-label='Undo' size='sm' title='Undo' variant='light' onPress={() => inkRef.current?.undo()}>
              <Undo2 className='h-4 w-4' />
            </Button>
            <Button
              isIconOnly
              aria-label='Clear the note'
              color='danger'
              isDisabled={empty}
              size='sm'
              title='Clear'
              variant='light'
              onPress={() => setConfirm('clear')}
            >
              <Trash2 className='h-4 w-4' />
            </Button>
          </div>
          <div ref={boxRef}>
            <InkCanvas
              ref={inkRef}
              hideToolbar
              growable={false}
              minHeight={PAD_HEIGHT}
              placeholder='Write a note with the pen…'
              tool={tool}
              onChange={(isEmpty) => {
                setEmpty(isEmpty);
                if (loaded.current) setDirty(true);
              }}
            />
          </div>
          {error && <ErrorNote message={error} />}
        </div>
      </Sheet>
      {confirm === 'clear' && (
        <ConfirmSheet
          danger
          confirmLabel='Clear note'
          title='Clear this note?'
          onClose={() => setConfirm(null)}
          onConfirm={() => inkRef.current?.clear()}
        >
          Everything written here goes. Undo brings it back until you close the pad.
        </ConfirmSheet>
      )}
      {confirm === 'discard' && (
        <ConfirmSheet
          danger
          confirmLabel='Close without saving'
          title='Close without saving?'
          onClose={() => setConfirm(null)}
          onConfirm={onClose}
        >
          What you wrote since opening the pad is lost.
        </ConfirmSheet>
      )}
    </>
  );
}
