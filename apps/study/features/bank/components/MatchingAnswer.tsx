import type { Matches } from '../lib/questionTypes';
import type { Question } from '@/lib/api/types';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, RotateCcw, X } from 'lucide-react';

import { useKatex } from '../lib/katex';
import {
  assignMatch,
  clearMatch,
  leftsHolding,
  matchingChoices,
  matchingIsUnique,
  matchingLefts,
  nextUnmatched,
} from '../lib/questionTypes';

import { InlineMd } from './Markdown';

/**
 * `matching` answer: tap a left item, then an option (or drag an option onto a left — pointer
 * events, so pen, touch and mouse all work). Tapping an option with no left selected fills the
 * next empty left. After grading, `marks` (one per left, from the verdict steps) paints ✓/✗;
 * `showCorrect` adds the right answer next to a wrong one (reveal / results only).
 */

export interface MatchingAnswerProps {
  question: Pick<Question, 'id' | 'pairs' | 'choices'>;
  value: Matches;
  onChange: (value: Matches) => void;
  disabled?: boolean;
  /** Per-left verdict in pair order; null = unknown. */
  marks?: (boolean | null)[];
  /** Show the correct right beside a wrong match (needs the pairs' rights). */
  showCorrect?: boolean;
}

interface Drag {
  right: string;
  pointerId: number;
  x0: number;
  y0: number;
  x: number;
  y: number;
  moved: boolean;
}

const DRAG_SLOP = 8;

export function MatchingAnswer({
  question,
  value,
  onChange,
  disabled = false,
  marks,
  showCorrect = false,
}: MatchingAnswerProps) {
  const katex = useKatex();
  const lefts = useMemo(() => matchingLefts(question), [question]);
  const choices = useMemo(() => matchingChoices(question), [question]);
  const unique = matchingIsUnique(lefts.length, choices.length);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hoverLeft, setHoverLeft] = useState<string | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => setSelected(null), [question.id]);

  const assign = (left: string, right: string) => {
    const next = assignMatch(value, left, right, unique);

    onChange(next);
    setSelected(nextUnmatched(lefts, next, left));
  };

  const pickChoice = (right: string) => {
    if (disabled) return;
    const target = selected ?? nextUnmatched(lefts, value, null);

    if (target) assign(target, right);
  };

  const leftAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-match-left]');

    return el?.dataset.matchLeft ?? null;
  };

  const onPointerDown = (right: string) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      right,
      pointerId: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moved = drag.moved || Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) > DRAG_SLOP;

    setDrag({ ...drag, x: event.clientX, y: event.clientY, moved });
    if (moved) setHoverLeft(leftAt(event.clientX, event.clientY));
  };

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>, commit: boolean) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      suppressClick.current = true;
      const left = commit ? leftAt(event.clientX, event.clientY) : null;

      if (left) assign(left, drag.right);
    }
    setDrag(null);
    setHoverLeft(null);
  };

  return (
    <div className='flex flex-col gap-4'>
      <ol className='flex flex-col gap-2'>
        {lefts.map((left, i) => {
          const right = value[left];
          const mark = marks?.[i] ?? null;
          const isSelected = selected === left;
          const isHover = hoverLeft === left;
          const correct = showCorrect ? question.pairs?.find((p) => p.left === left)?.right : null;

          return (
            <li key={left}>
              <div
                className={`flex min-h-14 flex-wrap items-center gap-2 rounded-2xl border p-2 ps-3 transition ${
                  isSelected || isHover
                    ? 'border-st-clay-edge ring-2 ring-st-ink/20'
                    : mark === true
                      ? 'border-st-ok bg-st-ok/10'
                      : mark === false
                        ? 'border-st-danger bg-st-danger/10'
                        : 'border-st-line bg-st-surface'
                }`}
                data-match-left={left}
              >
                <button
                  aria-pressed={isSelected}
                  className='flex min-h-10 min-w-0 flex-1 items-center gap-3 text-left text-base text-st-fg disabled:cursor-default'
                  disabled={disabled}
                  type='button'
                  onClick={() => setSelected(isSelected ? null : left)}
                >
                  <span className='flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-st-raised text-sm font-semibold'>
                    {i + 1}
                  </span>
                  <span className='min-w-0 flex-1'>
                    <InlineMd katex={katex} text={left} />
                  </span>
                </button>
                <ArrowRight className='h-4 w-4 shrink-0 text-st-muted' />
                {right ? (
                  <span className='inline-flex min-h-10 max-w-full items-center gap-1 rounded-xl bg-st-accent px-3 text-sm font-medium text-st-accent-fg'>
                    <span className='min-w-0'>
                      <InlineMd katex={katex} text={right} />
                    </span>
                    {!disabled ? (
                      <button
                        aria-label={`Clear match for item ${i + 1}`}
                        className='-me-1 flex h-8 w-8 items-center justify-center rounded-md hover:bg-st-accent-fg/15'
                        type='button'
                        onClick={() => onChange(clearMatch(value, left))}
                      >
                        <X className='h-4 w-4' />
                      </button>
                    ) : null}
                  </span>
                ) : (
                  <span className='inline-flex min-h-10 items-center rounded-xl border border-dashed border-st-line px-3 text-sm text-st-muted'>
                    {isSelected ? 'Pick an option' : 'Empty'}
                  </span>
                )}
                {mark === true ? <Check aria-label='Correct' className='h-5 w-5 text-st-ok' /> : null}
                {mark === false ? (
                  <span className='inline-flex items-center gap-1 text-sm text-st-danger'>
                    <X aria-label='Wrong' className='h-5 w-5' />
                    {correct ? <InlineMd katex={katex} text={correct} /> : null}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {!disabled ? (
        <div>
          <div className='mb-2 flex items-center gap-2'>
            <p className='text-xs font-semibold uppercase tracking-wide text-st-muted'>
              {selected ? `Match item ${lefts.indexOf(selected) + 1} with…` : 'Options · tap or drag onto an item'}
            </p>
            <span className='flex-1' />
            {Object.keys(value).length ? (
              <button
                className='flex h-9 items-center gap-1 rounded-xl px-3 text-sm text-st-muted hover:bg-st-raised'
                type='button'
                onClick={() => {
                  onChange({});
                  setSelected(null);
                }}
              >
                <RotateCcw className='h-4 w-4' /> Clear all
              </button>
            ) : null}
          </div>
          <div className='flex flex-wrap gap-2'>
            {choices.map((right) => {
              const holders = leftsHolding(value, right);
              const used = holders.length > 0;
              const dragging = drag?.right === right && drag.moved;

              return (
                <button
                  key={right}
                  className={`flex min-h-12 touch-none select-none items-center gap-2 rounded-2xl border px-4 text-base transition ${
                    used && unique
                      ? 'border-st-line bg-st-raised text-st-muted'
                      : 'border-st-line bg-st-surface text-st-fg hover:border-st-ink/50'
                  } ${dragging ? 'opacity-40' : ''}`}
                  type='button'
                  onClick={() => {
                    if (suppressClick.current) {
                      suppressClick.current = false;

                      return;
                    }
                    pickChoice(right);
                  }}
                  onPointerCancel={(event) => endDrag(event, false)}
                  onPointerDown={onPointerDown(right)}
                  onPointerMove={onPointerMove}
                  onPointerUp={(event) => endDrag(event, true)}
                >
                  <InlineMd katex={katex} text={right} />
                  {used ? (
                    <span className='text-xs tabular-nums text-st-muted'>
                      {holders.map((l) => lefts.indexOf(l) + 1).join(', ')}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {!choices.length ? (
            <p className='text-sm text-st-muted'>This question came without options — try reloading it.</p>
          ) : null}
        </div>
      ) : null}

      {drag?.moved ? (
        <div
          aria-hidden
          className='pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-st-lg border-2 border-st-accent-lip bg-st-accent px-4 py-2 text-base text-st-accent-fg shadow-clay-accent'
          style={{ left: drag.x, top: drag.y }}
        >
          <InlineMd katex={katex} text={drag.right} />
        </div>
      ) : null}
    </div>
  );
}
