import React from 'react';

import { cn } from '../../cn';
import { HEROUI_COLOR_TEXT, PRIMARY_SOFT } from '../tokens';

/**
 * Tag — the design system's topic / keyword label (Figma «Tag Input» → tag).
 *
 * A flat soft-blue pill: primary-soft fill, primary text at 13px semi-bold, 22px tall, 10/3 padding,
 * 4px gap. NO rim, NO lip, NO shadow — unlike `Chip`, a tag is not a clay object; it is a tinted word,
 * so it can sit inside a field or a card without competing with the controls around it.
 *
 * The pill radius is the owner's Figma spec for tags (it is a true pill, not a chip).
 *
 * Contrast (13px semi-bold is body text, so 4.5:1): light #2f5bea on #e3e9fd = 4.56:1;
 * Study dark points `--primary-soft` at its accent-soft (#24316e) so #7b9bff on it = 4.6:1.
 *
 * `onRemove` adds the small × (14px glyph). Its hit area grows to 36×22 + a little sideways, kept inside
 * the 8px row gap of a wrapping row so it can never cover the tag on the next line.
 */
export interface TagProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  children: React.ReactNode;
  /** Shows the × and calls this when it is pressed. */
  onRemove?: () => void;
  /** Accessible name of the × (default: `Remove <text>` when children is a string). */
  removeLabel?: string;
  isDisabled?: boolean;
  classNames?: { base?: string; content?: string; remove?: string };
}

export const Tag = React.forwardRef<HTMLSpanElement, TagProps>(function Tag(
  { children, onRemove, removeLabel, isDisabled, className, classNames, style, ...rest },
  ref,
) {
  const name = removeLabel ?? (typeof children === 'string' ? `Remove ${children}` : 'Remove');

  return (
    <span
      ref={ref}
      aria-disabled={isDisabled || undefined}
      className={cn(
        'inline-flex h-[22px] min-w-0 max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-[10px] py-[3px]',
        'text-[13px] font-semibold leading-4',
        isDisabled && 'opacity-50',
        className,
        classNames?.base,
      )}
      style={{ background: PRIMARY_SOFT, color: HEROUI_COLOR_TEXT.primary, ...style }}
      {...rest}
    >
      <span className={cn('min-w-0 truncate', classNames?.content)}>{children}</span>
      {onRemove ? (
        <button
          aria-label={name}
          className={cn(
            // -mr-1: the × sits in the right padding, so a removable tag is not wider than it looks.
            'relative -mr-1 inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full',
            "before:absolute before:-inset-x-[5px] before:-inset-y-[4px] before:content-['']",
            'transition-opacity duration-150 hover:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1',
            'focus-visible:outline-[color:var(--p-text)] disabled:cursor-not-allowed',
            classNames?.remove,
          )}
          disabled={isDisabled}
          type='button'
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <svg aria-hidden fill='none' height='14' stroke='currentColor' strokeLinecap='round' strokeWidth={2.4} viewBox='0 0 24 24' width='14'>
            <path d='M17 7 7 17M7 7l10 10' />
          </svg>
        </button>
      ) : null}
    </span>
  );
});

Tag.displayName = 'Tag';
