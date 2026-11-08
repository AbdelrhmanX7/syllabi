import type { TutorContext, TutorMode } from '../types';
import type { ButtonVariant } from '@/components/ui/primitives';

import { useCallback, useState } from 'react';
import { Sparkles } from 'lucide-react';

import { AskSheet } from './AskSheet';

import { ActionButton } from '@/components/ui/primitives';
import { useAiEnabled } from '@/hooks/useAiEnabled';

export interface AskTutorButtonProps {
  classId?: string | null;
  /** What to ask about. A function is read at click time (a video's current second). */
  context?: TutorContext | (() => TutorContext);
  /** Shown under the sheet title; a function is read at click time too. */
  contextLabel?: string | (() => string);
  label?: string;
  mode?: TutorMode;
  variant?: ButtonVariant;
  className?: string;
  /** Icon-only (the video header is tight). */
  iconOnly?: boolean;
}

/**
 * Drop-in entry point: a button that opens the Ask sheet with the given context. The class page,
 * item page, video study and notebook mount this; the sheet is self-contained.
 */
function AskTutorButtonInner({
  classId,
  context,
  contextLabel,
  label = 'Ask tutor',
  mode,
  variant = 'secondary',
  className,
  iconOnly = false,
}: AskTutorButtonProps) {
  const [open, setOpen] = useState<{ context?: TutorContext; label?: string } | null>(null);

  const openSheet = useCallback(() => {
    setOpen({
      context: typeof context === 'function' ? context() : context,
      label: typeof contextLabel === 'function' ? contextLabel() : contextLabel,
    });
  }, [context, contextLabel]);
  const close = useCallback(() => setOpen(null), []);

  return (
    <>
      <ActionButton aria-label={label} className={className} title={label} variant={variant} onClick={openSheet}>
        <Sparkles className='h-4 w-4' /> {!iconOnly && label}
      </ActionButton>
      <AskSheet
        classId={classId}
        context={open?.context}
        contextLabel={open?.label}
        mode={mode}
        open={open !== null}
        onClose={close}
      />
    </>
  );
}

/** Hidden for accounts without AI (`useAiEnabled`). */
export function AskTutorButton(props: Parameters<typeof AskTutorButtonInner>[0]) {
  return useAiEnabled() ? <AskTutorButtonInner {...props} /> : null;
}
