import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Baseline, Check, ClipboardPaste, Copy, CopyPlus, Crop, Network, Palette, Scissors, Sparkles, Trash2 } from 'lucide-react';

import { STROKE_WIDTHS } from './types';
import { MODERN_CHROME_REACH } from './utils/selectionChrome';
import { placeSelectionBar } from './utils/selectionClipboard';
import { useWbStrings } from '../../i18n/context';

import type { SelectionRaster } from './utils/selectionActions';
import type { ClipboardRect } from './utils/selectionClipboard';
import type { ReactNode } from 'react';

/** What a host action receives: the selection as a picture on white, taken the moment it was pressed. */
export interface WhiteboardSelectionSnapshot {
  objectCount: number;
  /** Null when there was nothing to render (or no DOM). Long side ≤ 2000 px. */
  raster: SelectionRaster | null;
}

/**
 * A host's own button on the selection bar (the Study app's «Concept map»). Opt-in through
 * `WhiteboardEditorProps.extraSelectionActions`; the board adds no history for it.
 */
export interface WhiteboardSelectionAction {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Where it shows: `picture` = only while ONE picture is selected, `other` = never for one (default: always). */
  scope?: 'picture' | 'other';
  onSelect: (selection: WhiteboardSelectionSnapshot) => void;
}

/**
 * The floating bar over a selection: colour (+ thickness), copy, cut, duplicate, delete and — when the
 * board has AI — «Ask AI». Every target is ≥ 44 px so a fingertip or the S Pen lands it first try.
 *
 * It sits in the editor's overlay layer; `selection` is the selection's box in that layer's CSS
 * pixels. Pointer events stop here so a tap on the bar never reaches the canvas under it (which would
 * otherwise clear the very selection the tap was acting on).
 */

interface SelectionActionBarProps {
  selection: ClipboardRect;
  /** The layer's size, to keep the bar on screen. */
  container: { width: number; height: number };
  /** Room the top chrome takes; the bar flips below the selection rather than hide under it. */
  topInset?: number;
  colors: readonly string[];
  onColor: (color: string) => void;
  onWidth: (width: number) => void;
  onCopy: () => void;
  onCut: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAsk?: () => void;
  /** «Map my terms» (opt-in, `WhiteboardEditorProps.termsMap` + a service with `mapTerms`). */
  onMapTerms?: () => void;
  /** «Straighten» (opt-in, `WhiteboardEditorProps.straightenInk`; the editor passes it only for ≥ 2 ink strokes). */
  onStraighten?: () => void;
  /** «Crop» — the editor passes it only for one unpinned picture. */
  onCrop?: () => void;
  /** Host buttons, after the built-in ones. */
  extraActions?: readonly WhiteboardSelectionAction[];
  onExtraAction?: (action: WhiteboardSelectionAction) => void;
  /**
   * `compact` — the icon row every app had. `labeled` (opt-in, with the `modern` selection chrome) —
   * icon-over-label buttons in groups on a flat sheet, placed BELOW the selection by default so it never
   * lands on the frame's rotate handle, and clear of the frame's round handles on either side.
   */
  variant?: 'compact' | 'labeled';
}

const BUTTON_CLASS =
  'flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold transition-colors hover:bg-ink/5 active:bg-ink/10';

/** Labeled: icon over a short label, 56px tall — a fingertip or the S Pen lands it without aiming. */
const LABELED_BUTTON_CLASS =
  'flex min-h-14 min-w-14 flex-col items-center justify-center gap-1 whitespace-nowrap rounded-xl px-2 text-[11px] font-semibold leading-none transition-colors hover:bg-ink/5 active:bg-ink/10 [&_svg]:h-5 [&_svg]:w-5 [&_svg]:shrink-0';
const LABELED_SWATCH_CLASS = 'hover:bg-ink/5 active:bg-ink/10 flex h-11 w-11 items-center justify-center rounded-xl';
const LABELED_DIVIDER_CLASS = 'bg-ink/10 mx-1 my-2 w-px self-stretch';

const stop = (event: React.SyntheticEvent) => event.stopPropagation();

export function SelectionActionBar({
  selection,
  container,
  topInset,
  colors,
  onColor,
  onWidth,
  onCopy,
  onCut,
  onDuplicate,
  onDelete,
  onAsk,
  onMapTerms,
  onStraighten,
  onCrop,
  extraActions,
  onExtraAction,
  variant = 'compact',
}: SelectionActionBarProps) {
  const { t, dir } = useWbStrings();
  const barRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 320, height: 52 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The copy button answers for ~1.5 s with a check and «Copied» — copying is otherwise invisible.
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const handleCopy = () => {
    onCopy();
    setCopied(true);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1_500);
  };

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const element = barRef.current;

    if (!element) return;

    const next = { width: element.offsetWidth, height: element.offsetHeight };

    setSize((current) => (current.width === next.width && current.height === next.height ? current : next));
  });

  const labeled = variant === 'labeled';
  const spot = placeSelectionBar(
    selection,
    size,
    container,
    labeled
      ? { topInset, prefer: 'below', gapAbove: MODERN_CHROME_REACH.top + 6, gapBelow: MODERN_CHROME_REACH.other + 6 }
      : { topInset },
  );

  if (labeled) {
    return (
      <div
        ref={barRef}
        aria-label={t('selection.bar')}
        className='bg-paper text-ink border-ink/10 absolute z-[30] flex max-w-[calc(100%-16px)] flex-col rounded-2xl border p-1.5 shadow-[0_12px_32px_-10px_rgba(15,23,42,0.35),0_2px_6px_rgba(15,23,42,0.08)]'
        data-testid='wb-selection-bar'
        data-variant='labeled'
        dir={dir}
        role='toolbar'
        style={{ left: spot.left, top: spot.top, touchAction: 'none' }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={stop}
        onPointerMove={stop}
        onPointerUp={stop}
      >
        {paletteOpen ? (
          <div className='border-ink/10 mb-1.5 flex flex-col gap-1 border-b px-0.5 pb-1.5'>
            <div className='flex flex-wrap gap-0.5'>
              {colors.map((color) => (
                <button
                  key={color}
                  aria-label={t('selection.colorN', { color })}
                  className={LABELED_SWATCH_CLASS}
                  data-color={color}
                  type='button'
                  onClick={() => onColor(color)}
                >
                  <span className='ring-ink/20 block h-7 w-7 rounded-full ring-1 ring-inset' style={{ background: color }} />
                </button>
              ))}
            </div>
            <div aria-label={t('selection.width')} className='flex flex-wrap gap-0.5' role='group'>
              {STROKE_WIDTHS.map((width) => (
                <button
                  key={width}
                  aria-label={t('selection.widthN', { n: width })}
                  className={LABELED_SWATCH_CLASS}
                  type='button'
                  onClick={() => onWidth(width)}
                >
                  <span className='bg-ink block rounded-full' style={{ height: Math.min(width, 22), width: Math.min(width, 22) }} />
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className='flex flex-wrap items-stretch gap-0.5'>
          <button
            aria-expanded={paletteOpen}
            className={`${LABELED_BUTTON_CLASS} ${paletteOpen ? 'bg-ink/10' : ''}`}
            data-action='color'
            type='button'
            onClick={() => setPaletteOpen((open) => !open)}
          >
            <Palette aria-hidden className='h-5 w-5' />
            <span>{t('selection.color')}</span>
          </button>
          <span aria-hidden className={LABELED_DIVIDER_CLASS} />
          <button aria-live='polite' className={LABELED_BUTTON_CLASS} data-action='copy' type='button' onClick={handleCopy}>
            {copied ? <Check aria-hidden className='h-5 w-5 text-emerald-600' /> : <Copy aria-hidden className='h-5 w-5' />}
            <span>{t(copied ? 'selection.copied' : 'selection.copy')}</span>
          </button>
          <button className={LABELED_BUTTON_CLASS} data-action='cut' type='button' onClick={onCut}>
            <Scissors aria-hidden className='h-5 w-5' />
            <span>{t('selection.cut')}</span>
          </button>
          <button className={LABELED_BUTTON_CLASS} data-action='duplicate' type='button' onClick={onDuplicate}>
            <CopyPlus aria-hidden className='h-5 w-5' />
            <span>{t('selection.duplicate')}</span>
          </button>
          {onCrop ? (
            <button className={LABELED_BUTTON_CLASS} data-action='crop' type='button' onClick={onCrop}>
              <Crop aria-hidden className='h-5 w-5' />
              <span>{t('selection.crop')}</span>
            </button>
          ) : null}
          <span aria-hidden className={LABELED_DIVIDER_CLASS} />
          <button
            className={`${LABELED_BUTTON_CLASS} text-sk-red`}
            data-action='delete'
            type='button'
            onClick={onDelete}
          >
            <Trash2 aria-hidden className='h-5 w-5' />
            <span>{t('selection.delete')}</span>
          </button>
          {onAsk || onMapTerms || onStraighten || extraActions?.length ? <span aria-hidden className={LABELED_DIVIDER_CLASS} /> : null}
          {onAsk ? (
            <button
              className={`${LABELED_BUTTON_CLASS} bg-citrine text-ink-const hover:bg-citrine active:bg-citrine`}
              data-action='ask'
              type='button'
              onClick={onAsk}
            >
              <Sparkles aria-hidden className='h-5 w-5' />
              <span>{t('toolbar.askAi')}</span>
            </button>
          ) : null}
          {onMapTerms ? (
            <button className={LABELED_BUTTON_CLASS} data-action='map-terms' type='button' onClick={onMapTerms}>
              <Network aria-hidden className='h-5 w-5' />
              <span>{t('ai.terms.action')}</span>
            </button>
          ) : null}
          {onStraighten ? (
            <button className={LABELED_BUTTON_CLASS} data-action='straighten' type='button' onClick={onStraighten}>
              <Baseline aria-hidden className='h-5 w-5' />
              <span>{t('selection.straighten')}</span>
            </button>
          ) : null}
          {extraActions?.map((action) => (
            <button
              key={action.id}
              className={LABELED_BUTTON_CLASS}
              data-action={`extra-${action.id}`}
              type='button'
              onClick={() => onExtraAction?.(action)}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={barRef}
      aria-label={t('selection.bar')}
      className='border-sk border-ink bg-paper text-ink shadow-sk absolute z-[30] flex max-w-[calc(100%-16px)] flex-col gap-1 rounded-2xl p-1'
      data-testid='wb-selection-bar'
      dir={dir}
      role='toolbar'
      style={{ left: spot.left, top: spot.top, touchAction: 'none' }}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
    >
      {paletteOpen ? (
        <div className='flex flex-col gap-1 px-1 pt-1'>
          <div className='flex flex-wrap gap-1'>
            {colors.map((color) => (
              <button
                key={color}
                aria-label={t('selection.colorN', { color })}
                className='hover:bg-ink/5 flex h-11 w-11 items-center justify-center rounded-xl'
                data-color={color}
                type='button'
                onClick={() => onColor(color)}
              >
                <span className='border-ink/25 block h-7 w-7 rounded-full border' style={{ background: color }} />
              </button>
            ))}
          </div>
          <div aria-label={t('selection.width')} className='border-ink/10 flex flex-wrap gap-1 border-t pt-1' role='group'>
            {STROKE_WIDTHS.map((width) => (
              <button
                key={width}
                aria-label={t('selection.widthN', { n: width })}
                className='hover:bg-ink/5 flex h-11 w-11 items-center justify-center rounded-xl'
                type='button'
                onClick={() => onWidth(width)}
              >
                <span className='bg-ink block rounded-full' style={{ height: Math.min(width, 22), width: Math.min(width, 22) }} />
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className='flex flex-wrap items-center gap-0.5'>
        <button
          aria-expanded={paletteOpen}
          aria-label={t('selection.color')}
          className={`${BUTTON_CLASS} ${paletteOpen ? 'bg-ink/10' : ''}`}
          data-action='color'
          type='button'
          onClick={() => setPaletteOpen((open) => !open)}
        >
          <span
            className='border-ink/30 block h-6 w-6 rounded-full border'
            style={{ background: `conic-gradient(${colors.slice(0, 6).join(', ')}, ${colors[0] ?? 'currentColor'})` }}
          />
        </button>
        <span className='bg-ink/15 mx-0.5 h-6 w-px' />
        <button
          aria-label={t(copied ? 'selection.copied' : 'selection.copy')}
          aria-live='polite'
          className={BUTTON_CLASS}
          data-action='copy'
          type='button'
          onClick={handleCopy}
        >
          {copied ? <Check aria-hidden className='h-5 w-5 text-emerald-600' /> : <Copy aria-hidden className='h-5 w-5' />}
        </button>
        <button aria-label={t('selection.cut')} className={BUTTON_CLASS} data-action='cut' type='button' onClick={onCut}>
          <Scissors aria-hidden className='h-5 w-5' />
        </button>
        <button aria-label={t('selection.duplicate')} className={BUTTON_CLASS} data-action='duplicate' type='button' onClick={onDuplicate}>
          <CopyPlus aria-hidden className='h-5 w-5' />
        </button>
        {onCrop ? (
          <button aria-label={t('selection.crop')} className={BUTTON_CLASS} data-action='crop' type='button' onClick={onCrop}>
            <Crop aria-hidden className='h-5 w-5' />
          </button>
        ) : null}
        <button
          aria-label={t('selection.delete')}
          className={`${BUTTON_CLASS} text-red-600`}
          data-action='delete'
          type='button'
          onClick={onDelete}
        >
          <Trash2 aria-hidden className='h-5 w-5' />
        </button>
        {onAsk ? (
          <>
            <span className='bg-ink/15 mx-0.5 h-6 w-px' />
            <button className={`${BUTTON_CLASS} bg-citrine`} data-action='ask' type='button' onClick={onAsk}>
              <Sparkles aria-hidden className='h-4 w-4' />
              {t('toolbar.askAi')}
            </button>
          </>
        ) : null}
        {onMapTerms ? (
          <button className={`${BUTTON_CLASS} border-ink/20 border`} data-action='map-terms' type='button' onClick={onMapTerms}>
            <Network aria-hidden className='h-4 w-4' />
            {t('ai.terms.action')}
          </button>
        ) : null}
        {onStraighten ? (
          <button className={`${BUTTON_CLASS} border-ink/20 border`} data-action='straighten' type='button' onClick={onStraighten}>
            <Baseline aria-hidden className='h-4 w-4' />
            {t('selection.straighten')}
          </button>
        ) : null}
        {extraActions?.map((action) => (
          <button
            key={action.id}
            className={`${BUTTON_CLASS} border-ink/20 border`}
            data-action={`extra-${action.id}`}
            type='button'
            onClick={() => onExtraAction?.(action)}
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

interface PasteChipProps {
  /** Where the press landed, in layer CSS pixels. */
  at: { left: number; top: number };
  onPaste: () => void;
}

/** The one-button «Paste» chip a long-press (or a tap with the select tool) on empty canvas raises. */
export function PasteChip({ at, onPaste }: PasteChipProps) {
  const { t } = useWbStrings();

  return (
    <div
      className='pointer-events-none absolute z-[30] -translate-x-1/2 -translate-y-[calc(100%+12px)]'
      style={{ left: at.left, top: at.top }}
      onPointerDown={stop}
      onPointerUp={stop}
    >
      <button
        className='border-sk border-ink bg-paper text-ink shadow-sk pointer-events-auto flex h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold'
        data-testid='wb-paste-chip'
        type='button'
        onClick={onPaste}
        onContextMenu={(event) => event.preventDefault()}
      >
        <ClipboardPaste aria-hidden className='h-5 w-5' />
        {t('selection.paste')}
      </button>
    </div>
  );
}
