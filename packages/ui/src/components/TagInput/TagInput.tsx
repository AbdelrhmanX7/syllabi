import React from 'react';

import { cn } from '../../cn';
import { clayVars, CLAY_FILL } from '../clay';
import { FIELD_RADIUS, FIELD_TEXT } from '../sizing';
import { Tag } from '../Tag';
import { HEROUI_COLOR_TEXT, INK, INK_MUTED } from '../tokens';

/**
 * TagInput — the design system's tag field (Figma «Tag Input»).
 *
 * The tags sit INSIDE the field, followed by the typed text inline; the field wraps onto more lines
 * when they don't fit. Field: card-white face, 2px rim (the normal control edge, primary when focused),
 * 12px radius (FIELD_RADIUS), 44px tall for one line, 8px gap. Helper line under it.
 *
 * Enter (or a comma) adds the draft; leaving the field adds it too, so a tag typed but not «entered»
 * is never silently lost. Removing is the × on each tag only — no Backspace-deletes-the-last-tag, a
 * key that can wipe a tag you never meant to touch.
 *
 * Like the DatePicker, the rim and face read `--field-edge` / `--field-bg` first, so an app that
 * points those at its own field look gets fields that match.
 */
const FIELD_FACE = CLAY_FILL.default;
const FIELD_EDGE = (clayVars(FIELD_FACE, { kind: 'control' }) as Record<string, string>)['--clay-edge'];

export interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Turns the raw draft into a tag, or '' / null to reject it. Default: trimmed text. */
  normalize?: (draft: string) => string | null | undefined;
  /** Most tags allowed; the text box hides once it is reached. */
  maxTags?: number;
  /** Longest draft, in characters. */
  maxLength?: number;
  placeholder?: string;
  /** The helper line under the field. Default «Press Enter to add.» */
  description?: React.ReactNode;
  id?: string;
  'aria-label'?: string;
  isDisabled?: boolean;
  /** The live draft, for a parent that wants to save a tag typed but not yet entered. */
  onDraftChange?: (draft: string) => void;
  className?: string;
  classNames?: { base?: string; field?: string; input?: string; description?: string };
}

export const TagInput = React.forwardRef<HTMLInputElement, TagInputProps>(function TagInput(
  {
    value,
    onChange,
    normalize = (draft) => draft.trim(),
    maxTags,
    maxLength,
    placeholder = 'Add a tag',
    description = 'Press Enter to add.',
    id,
    'aria-label': ariaLabel,
    isDisabled,
    onDraftChange,
    className,
    classNames,
  },
  ref,
) {
  const [draft, setDraftState] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const reactId = React.useId();
  const inputId = id ?? reactId;
  const descId = description ? `${inputId}-desc` : undefined;
  const full = typeof maxTags === 'number' && value.length >= maxTags;

  const setDraft = (next: string) => {
    setDraftState(next);
    onDraftChange?.(next);
  };

  const add = (text: string) => {
    const tag = normalize(text);

    if (tag && !value.includes(tag) && !full) onChange([...value, tag]);
    setDraft('');
  };
  const commit = () => {
    if (draft) add(draft);
  };

  const setRefs = (node: HTMLInputElement | null) => {
    inputRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  return (
    <div className={cn('flex flex-col gap-1.5', className, classNames?.base)}>
      <div
        className={cn(
          'flex min-h-11 w-full cursor-text flex-wrap items-center gap-2 border-2 px-3 py-[9px]',
          'border-[color:var(--ti-edge)] focus-within:border-[color:var(--ti-focus)]',
          FIELD_RADIUS,
          isDisabled && 'cursor-not-allowed opacity-50',
          classNames?.field,
        )}
        style={
          {
            background: `var(--field-bg, ${FIELD_FACE})`,
            '--ti-edge': `var(--field-edge, ${FIELD_EDGE})`,
            '--ti-focus': HEROUI_COLOR_TEXT.primary,
          } as React.CSSProperties
        }
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((tag) => (
          <Tag key={tag} isDisabled={isDisabled} onRemove={() => onChange(value.filter((other) => other !== tag))}>
            {tag}
          </Tag>
        ))}
        {!full && (
          <input
            ref={setRefs}
            aria-describedby={descId}
            aria-label={ariaLabel}
            className={cn(
              // 22px line, same as a tag, so the field stays 44px with tags in it. 16px text: iOS zooms under it.
              'h-[22px] min-w-[7rem] flex-1 bg-transparent p-0 leading-[22px] outline-none placeholder:font-normal',
              FIELD_TEXT,
              classNames?.input,
            )}
            disabled={isDisabled}
            enterKeyHint='enter'
            id={inputId}
            maxLength={maxLength}
            placeholder={placeholder}
            style={{ color: INK }}
            value={draft}
            onBlur={commit}
            onChange={(event) => {
              const next = event.target.value;

              if (next.endsWith(',')) {
                add(next.slice(0, -1));

                return;
              }
              setDraft(next);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            }}
          />
        )}
      </div>
      {description ? (
        <p className={cn('text-xs', classNames?.description)} id={descId} style={{ color: INK_MUTED }}>
          {full ? `That's the most tags (${maxTags}).` : description}
        </p>
      ) : null}
    </div>
  );
});

TagInput.displayName = 'TagInput';
