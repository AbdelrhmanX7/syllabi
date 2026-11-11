import type { Question } from '@/lib/api/types';

import { useState } from 'react';
import { addToast, Button } from '@repo/ui';
import { Bookmark } from 'lucide-react';

import { useCardMarks } from '../hooks';

import { describeError } from '@/lib/api/errors';

/**
 * The bookmark toggle on a card: a flat icon button, filled amber when on. Saves at once; `onSaved`
 * lets a session (which holds its own copy of the cards) follow along.
 */
export function BookmarkButton({
  card,
  className,
  onSaved,
}: {
  card: Pick<Question, 'id' | 'bookmarked'>;
  className?: string;
  onSaved?: (bookmarked: boolean) => void;
}) {
  const { setBookmark } = useCardMarks();
  const [pending, setPending] = useState<boolean | null>(null);
  const on = pending ?? Boolean(card.bookmarked);

  const toggle = () => {
    const next = !on;

    setPending(next);
    onSaved?.(next);
    setBookmark(card, next)
      .catch((err: unknown) => {
        onSaved?.(!next);
        addToast({ title: 'Bookmark didn’t save', description: describeError(err, 'Try again in a moment'), color: 'danger' });
      })
      .finally(() => setPending(null));
  };

  return (
    <Button
      isIconOnly
      aria-label={on ? 'Remove bookmark' : 'Bookmark this card'}
      aria-pressed={on}
      className={className}
      color={on ? 'warning' : 'default'}
      size='sm'
      title={on ? 'Bookmarked' : 'Bookmark'}
      variant='light'
      onPress={toggle}
    >
      <Bookmark className='h-4 w-4' fill={on ? 'currentColor' : 'none'} />
    </Button>
  );
}
