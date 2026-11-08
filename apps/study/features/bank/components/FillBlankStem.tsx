import type { BlankSegment } from '../lib/questionTypes';

import React, { useMemo, useRef } from 'react';
import { Check, X } from 'lucide-react';

import { useKatex } from '../lib/katex';
import { parseBlankStem, sizeBlanks } from '../lib/questionTypes';

import { CodeBlock, InlineMd, MathBlock } from './Markdown';

/**
 * A `fill_blank` stem with an inline input at every `___` (markdown + KaTeX kept around them).
 * Enter jumps to the next blank. After grading, `marks` paints each blank ✓/✗.
 */

export interface FillBlankStemProps {
  stem: string;
  values: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  /** Per-blank verdict; null = unknown. */
  marks?: (boolean | null)[];
  size?: 'md' | 'lg';
  className?: string;
}

export function FillBlankStem({
  stem,
  values,
  onChange,
  disabled = false,
  marks,
  size = 'lg',
  className = '',
}: FillBlankStemProps) {
  const katex = useKatex();
  const { blocks, count } = useMemo(() => parseBlankStem(stem), [stem]);
  const sized = sizeBlanks(values, count);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const base = size === 'lg' ? 'text-lg leading-[2.6rem]' : 'text-base leading-9';

  const setAt = (index: number, value: string) => {
    const next = [...sized];

    next[index] = value;
    onChange(next);
  };

  const renderSegments = (segments: BlankSegment[]) =>
    segments.map((segment, i) =>
      segment.kind === 'text' ? (
        <InlineMd key={i} katex={katex} text={segment.text} />
      ) : (
        <BlankInput
          key={i}
          disabled={disabled}
          index={segment.index}
          inputRef={(el) => {
            inputs.current[segment.index] = el;
          }}
          mark={marks?.[segment.index] ?? null}
          value={sized[segment.index] ?? ''}
          onChange={(value) => setAt(segment.index, value)}
          onEnter={() => inputs.current[segment.index + 1]?.focus()}
        />
      ),
    );

  return (
    <div className={`${base} text-st-fg ${className}`}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'h':
            return (
              <p key={index} className='mb-1 mt-3 text-[1.05em] font-semibold first:mt-0'>
                {renderSegments(block.segments)}
              </p>
            );
          case 'p':
            return (
              <p key={index} className='my-1 whitespace-pre-wrap first:mt-0'>
                {renderSegments(block.segments)}
              </p>
            );
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';

            return (
              <Tag key={index} className={`my-1 space-y-0.5 ps-6 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
                {block.items.map((item, i) => (
                  <li key={i}>{renderSegments(item)}</li>
                ))}
              </Tag>
            );
          }
          case 'code':
            return <CodeBlock key={index} code={block.code} lang={block.lang} />;
          case 'math':
            return <MathBlock key={index} katex={katex} tex={block.tex} />;
          case 'img':
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={index}
                alt={block.alt}
                className='my-2 max-h-[420px] w-auto max-w-full rounded-xl'
                src={block.src}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

function BlankInput({
  index,
  value,
  onChange,
  onEnter,
  disabled,
  mark,
  inputRef,
}: {
  index: number;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  disabled: boolean;
  mark: boolean | null;
  inputRef: (el: HTMLInputElement | null) => void;
}) {
  const tone =
    mark === true
      ? 'border-st-ok bg-st-ok/10'
      : mark === false
        ? 'border-st-danger bg-st-danger/10'
        : 'border-st-clay-edge bg-st-bg focus:border-st-accent';

  return (
    <span className='mx-1 inline-flex items-center gap-0.5 align-baseline'>
      <input
        ref={inputRef}
        aria-label={`Blank ${index + 1}`}
        autoCapitalize='off'
        autoComplete='off'
        autoCorrect='off'
        className={`h-10 rounded-lg border-b-2 border-dashed px-2 text-center text-[0.95em] text-st-fg outline-none disabled:opacity-90 ${tone}`}
        disabled={disabled}
        enterKeyHint='next'
        placeholder={String(index + 1)}
        spellCheck={false}
        style={{ width: `${Math.min(28, Math.max(6, value.length + 2))}ch` }}
        type='text'
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onEnter();
          }
        }}
      />
      {mark === true ? <Check aria-label='Correct' className='h-4 w-4 text-st-ok' /> : null}
      {mark === false ? <X aria-label='Wrong' className='h-4 w-4 text-st-danger' /> : null}
    </span>
  );
}
