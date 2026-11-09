import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Baseline, Check, ClipboardPaste, Copy, CopyPlus, Crop, Network, Palette, Pin, Scissors, Sparkles, Trash2 } from 'lucide-react';
import { ColorSwatch } from '@repo/ui';

import { ShapeStylePanel } from './ShapeStylePanel';
import { STROKE_WIDTHS } from './types';
import { MODERN_CHROME_REACH } from './utils/selectionChrome';
import { placePasteChip, placeSelectionBar } from './utils/selectionClipboard';
import { useWbStrings } from '../../i18n/context';

import type { SelectionRaster } from './utils/selectionActions';
import type { ShapeStylePatch } from './utils/shapeStylePaint';
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
  /** «Pin image» — the editor passes it only for one unpinned picture (lives here so the bar never covers it). */
  onPin?: () => void;
  /** Host buttons, after the built-in ones. */
  extraActions?: readonly WhiteboardSelectionAction[];
  onExtraAction?: (action: WhiteboardSelectionAction) => void;
  /**
   * `compact` — the icon row every app had. `labeled` (opt-in, with the `modern` selection chrome) —
   * icon-over-label buttons in groups on a flat sheet, placed BELOW the selection by default so it never
   * lands on the frame's rotate handle, and clear of the frame's round handles on either side.
   */
  variant?: 'compact' | 'labeled';
  /** The «Style» panel (background, fill pattern, outline, opacity): what the selection has now… */
  readStyle?: () => { style: ShapeStylePatch; hasShape: boolean; canFill: boolean } | null;
  /** …and applying a choice to it. Both absent = no «Style» button. */
  onStyle?: (patch: ShapeStylePatch) => void;
}

const BUTTON_CLASS =
  'flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold transition-colors hover:bg-ink/5 active:bg-ink/10';

/** Labeled: icon over a short label, 56px tall — a fingertip or the S Pen lands it without aiming. */
const LABELED_BUTTON_CLASS =
  'flex min-h-14 min-w-14 flex-col items-center justify-center gap-1 whitespace-nowrap rounded-xl px-2 text-[11px] font-semibold leading-none transition-colors hover:bg-ink/5 active:bg-ink/10 [&_svg]:h-5 [&_svg]:w-5 [&_svg]:shrink-0';
const LABELED_SWATCH_CLASS = 'hover:bg-ink/5 active:bg-ink/10 flex h-11 w-11 items-center justify-center rounded-xl';
const LABELED_DIVIDER_CLASS = 'bg-ink/10 mx-1 my-2 w-px self-stretch';

const stop = (event: React.SyntheticEvent) => event.stopPropagation();

/** Three lines getting thicker — the «Size» button's icon (drawn like the lucide icons around it). */
function SizeIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill='none' stroke='currentColor' strokeLinecap='round' viewBox='0 0 24 24'>
      <path d='M4 6h16' strokeWidth={1.25} />
      <path d='M4 12h16' strokeWidth={2.5} />
      <path d='M4 18.5h16' strokeWidth={4} />
    </svg>
  );
}

/** Two overlapping squares, one filled — the «Style» button's icon. */
function StyleIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill='none' stroke='currentColor' strokeLinejoin='round' strokeWidth={1.75} viewBox='0 0 24 24'>
      <rect height='11' rx='2' width='11' x='3.5' y='3.5' />
      <rect fill='currentColor' fillOpacity={0.25} height='11' rx='2' width='11' x='9.5' y='9.5' />
    </svg>
  );
}

type SelectionPanel = 'color' | 'size' | 'style' | null;

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
  onPin,
  extraActions,
  onExtraAction,
  variant = 'compact',
  readStyle,
  onStyle,
}: SelectionActionBarProps) {
  const { t, dir } = useWbStrings();
  const barRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 320, height: 52 });
  // The colour and size choices open one at a time, above the button row.
  const [panel, setPanel] = useState<SelectionPanel>(null);
  const togglePanel = (next: Exclude<SelectionPanel, null>) => setPanel((current) => (current === next ? null : next));
  // The style panel re-reads the selection when it opens, when the selection changes, and after each choice.
  const [styleInfo, setStyleInfo] = useState<ReturnType<NonNullable<typeof readStyle>>>(null);
  const styleOn = panel === 'style' && !!readStyle && !!onStyle;

  useEffect(() => {
    if (styleOn) setStyleInfo(readStyle!());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleOn, selection.left, selection.top, selection.width, selection.height]);

  const applyStyle = (patch: ShapeStylePatch) => {
    onStyle?.(patch);
    if (readStyle) setStyleInfo(readStyle());
  };
  const stylePanel =
    styleOn && styleInfo ? (
      <ShapeStylePanel
        maxHeightClassName='max-h-[min(42vh,340px)]'
        rows={{ fill: styleInfo.canFill, shape: styleInfo.hasShape, stroke: false }}
        value={styleInfo.style}
        onChange={applyStyle}
      />
    ) : null;
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
        {panel === 'color' ? (
          <div className='border-ink/10 mb-1.5 flex flex-wrap gap-1 border-b px-0.5 pb-1.5'>
            {colors.map((color) => (
              <ColorSwatch
                key={color}
                className='h-11 w-11'
                color={color}
                data-color={color}
                label={t('selection.colorN', { color })}
                onClick={() => onColor(color)}
              />
            ))}
          </div>
        ) : null}
        {stylePanel ? <div className='border-ink/10 mb-1.5 border-b pb-1.5'>{stylePanel}</div> : null}
        {panel === 'size' ? (
          <div aria-label={t('selection.width')} className='border-ink/10 mb-1.5 flex flex-wrap gap-1 border-b px-0.5 pb-1.5' role='group'>
            {STROKE_WIDTHS.map((width) => (
              <button
                key={width}
                aria-label={t('selection.widthN', { n: width })}
                className={LABELED_SWATCH_CLASS}
                data-width={width}
                type='button'
                onClick={() => onWidth(width)}
              >
                <span className='bg-ink block rounded-full' style={{ height: Math.min(width + 2, 22), width: Math.min(width + 2, 22) }} />
              </button>
            ))}
          </div>
        ) : null}
        <div className='flex flex-wrap items-stretch gap-1'>
          <button
            aria-expanded={panel === 'color'}
            className={`${LABELED_BUTTON_CLASS} ${panel === 'color' ? 'bg-ink/10' : ''}`}
            data-action='color'
            type='button'
            onClick={() => togglePanel('color')}
          >
            <Palette aria-hidden className='h-5 w-5' />
            <span>{t('selection.color')}</span>
          </button>
          <button
            aria-expanded={panel === 'size'}
            className={`${LABELED_BUTTON_CLASS} ${panel === 'size' ? 'bg-ink/10' : ''}`}
            data-action='size'
            type='button'
            onClick={() => togglePanel('size')}
          >
            <SizeIcon className='h-5 w-5' />
            <span>{t('selection.width')}</span>
          </button>
          {readStyle && onStyle ? (
            <button
              aria-expanded={panel === 'style'}
              className={`${LABELED_BUTTON_CLASS} ${panel === 'style' ? 'bg-ink/10' : ''}`}
              data-action='style'
              type='button'
              onClick={() => togglePanel('style')}
            >
              <StyleIcon className='h-5 w-5' />
              <span>{t('selection.style')}</span>
            </button>
          ) : null}
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
          {onPin ? (
            <button className={LABELED_BUTTON_CLASS} data-action='pin' type='button' onClick={onPin}>
              <Pin aria-hidden className='h-5 w-5' />
              <span>{t('editor.pinImage')}</span>
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
      {panel === 'color' ? (
        <div className='flex flex-wrap gap-1 px-1 pt-1'>
          {colors.map((color) => (
            <ColorSwatch
              key={color}
              className='h-11 w-11'
              color={color}
              data-color={color}
              label={t('selection.colorN', { color })}
              onClick={() => onColor(color)}
            />
          ))}
        </div>
      ) : null}
      {stylePanel}
      {panel === 'size' ? (
        <div aria-label={t('selection.width')} className='flex flex-wrap gap-1 px-1 pt-1' role='group'>
          {STROKE_WIDTHS.map((width) => (
            <button
              key={width}
              aria-label={t('selection.widthN', { n: width })}
              className='hover:bg-ink/5 flex h-11 w-11 items-center justify-center rounded-xl'
              data-width={width}
              type='button'
              onClick={() => onWidth(width)}
            >
              <span className='bg-ink block rounded-full' style={{ height: Math.min(width + 2, 22), width: Math.min(width + 2, 22) }} />
            </button>
          ))}
        </div>
      ) : null}
      <div className='flex flex-wrap items-center gap-0.5'>
        <button
          aria-expanded={panel === 'color'}
          aria-label={t('selection.color')}
          className={`${BUTTON_CLASS} ${panel === 'color' ? 'bg-ink/10' : ''}`}
          data-action='color'
          type='button'
          onClick={() => togglePanel('color')}
        >
          <span
            className='border-ink/30 block h-6 w-6 rounded-full border'
            style={{ background: `conic-gradient(${colors.slice(0, 6).join(', ')}, ${colors[0] ?? 'currentColor'})` }}
          />
        </button>
        <button
          aria-expanded={panel === 'size'}
          aria-label={t('selection.width')}
          className={`${BUTTON_CLASS} ${panel === 'size' ? 'bg-ink/10' : ''}`}
          data-action='size'
          type='button'
          onClick={() => togglePanel('size')}
        >
          <SizeIcon className='h-5 w-5' />
        </button>
        {readStyle && onStyle ? (
          <button
            aria-expanded={panel === 'style'}
            aria-label={t('selection.style')}
            className={`${BUTTON_CLASS} ${panel === 'style' ? 'bg-ink/10' : ''}`}
            data-action='style'
            type='button'
            onClick={() => togglePanel('style')}
          >
            <StyleIcon className='h-5 w-5' />
          </button>
        ) : null}
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
        {onPin ? (
          <button aria-label={t('editor.pinImage')} className={BUTTON_CLASS} data-action='pin' title={t('editor.pinImage')} type='button' onClick={onPin}>
            <Pin aria-hidden className='h-5 w-5' />
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
  /** The layer's size, to keep the chip on screen. */
  container?: { width: number; height: number };
  /** Room the top chrome takes, as for the selection bar. */
  topInset?: number;
  /** `labeled` matches the modern selection bar's flat sheet; `compact` the classic clay chip. */
  variant?: 'compact' | 'labeled';
  onPaste: () => void;
}

/** The one-button «Paste» chip a long-press (or a tap with the select tool) on empty canvas raises. */
export function PasteChip({ at, container, topInset, variant = 'compact', onPaste }: PasteChipProps) {
  const { t } = useWbStrings();
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const [size, setSize] = useState({ width: 112, height: variant === 'labeled' ? 56 : 44 });

  useLayoutEffect(() => {
    const element = chipRef.current;

    if (!element) return;

    const next = { width: element.offsetWidth, height: element.offsetHeight };

    setSize((current) => (current.width === next.width && current.height === next.height ? current : next));
  });

  const spot = placePasteChip(at, size, container, topInset);
  const look =
    variant === 'labeled'
      ? 'bg-paper text-ink border-ink/10 rounded-2xl border shadow-[0_12px_32px_-10px_rgba(15,23,42,0.35),0_2px_6px_rgba(15,23,42,0.08)]'
      : 'border-sk border-ink bg-paper text-ink shadow-sk rounded-md';

  return (
    <button
      ref={chipRef}
      className={`${look} absolute z-[30] flex items-center gap-2 whitespace-nowrap text-sm font-semibold ${variant === 'labeled' ? 'h-14 px-4' : 'h-11 px-4'}`}
      data-testid='wb-paste-chip'
      style={{ left: spot.left, top: spot.top, touchAction: 'none' }}
      type='button'
      onClick={onPaste}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
    >
      <ClipboardPaste aria-hidden className='h-5 w-5' />
      {t('selection.paste')}
    </button>
  );
}
