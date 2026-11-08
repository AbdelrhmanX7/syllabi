import React from 'react';

import { cn } from '../../cn';
import { CLAY_FILL, clayVars } from '../clay';
import { Drawer, DrawerBody, DrawerContent, DrawerHeader } from '../Drawer';
import { Popover, PopoverContent, PopoverTrigger } from '../Popover';
import { CONTROL_HEIGHT, CONTROL_TEXT, FIELD_RADIUS } from '../sizing';
import { HEROUI_COLOR_TEXT, INK, INK_MUTED } from '../tokens';
import type { HeroUISize } from '../tokens';

/*
 * Shared pieces of DatePicker / TimePicker: the field that opens the panel, the
 * Popover-or-bottom-sheet shell, and the flat cell every day / hour / minute is drawn with.
 *
 * Old Android WebViews (Chrome ~90-103) are a target, so nothing here uses `:has()`, `color-mix()`
 * or `dvh` — focus is styled on the button itself and the muted ink is a token.
 */

const PHONE_QUERY = '(max-width: 639px)';

/** True under 640px — the panel becomes a bottom sheet there. False during SSR and the first paint. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(PHONE_QUERY);
    const sync = () => setPhone(mq.matches);

    sync();
    // `addListener` is the pre-Chrome-45 / old-Safari spelling of the same thing.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', sync);

      return () => mq.removeEventListener('change', sync);
    }
    mq.addListener(sync);

    return () => mq.removeListener(sync);
  }, []);

  return phone;
}

/**
 * Move focus into the panel once it can take it. The Popover keeps its panel `visibility:hidden`
 * until it has measured a position, and a hidden element ignores `focus()`, so retry for a few frames.
 */
export function useFocusOnOpen(containerRef: React.RefObject<HTMLElement | null>, selector: string) {
  React.useEffect(() => {
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const el = containerRef.current?.querySelector<HTMLElement>(selector);

      if (el) {
        el.focus({ preventScroll: true });
        if (document.activeElement === el) return;
      }
      if (++tries < 20) frame = requestAnimationFrame(attempt);
    };

    frame = requestAnimationFrame(attempt);

    return () => cancelAnimationFrame(frame);
    // Only on mount — the panel remounts every time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const FIELD_FACE = CLAY_FILL.default;
const FIELD_EDGE = (clayVars(FIELD_FACE, { kind: 'control' }) as Record<string, string>)['--clay-edge'];
const FIELD_EDGE_HOVER = (
  clayVars('hsl(var(--heroui-content4, var(--heroui-content3)))', { kind: 'control' }) as Record<string, string>
)['--clay-edge'];

export interface PickerShellProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name of the field, e.g. "Date". The shown value is appended to it. */
  label: string;
  /** What the field shows: the formatted value, or '' for the placeholder. */
  display: string;
  placeholder: string;
  icon: React.ReactNode;
  size: HeroUISize;
  isDisabled?: boolean;
  fullWidth?: boolean;
  id?: string;
  className?: string;
  /** Panel width on a tablet/desktop; the phone sheet is full width. */
  panelClassName?: string;
  /**
   * Rough height of the open panel. When the viewport has less room than this both above and below the
   * field (a landscape tablet with the field mid-screen), the panel opens as a bottom sheet instead of a
   * Popover that would have to scroll.
   */
  panelHeight?: number;
  children: React.ReactNode;
}

/** The field + its Popover (≥ 640px) or bottom sheet (< 640px). */
export function PickerShell({
  isOpen,
  onOpenChange,
  label,
  display,
  placeholder,
  icon,
  size,
  isDisabled,
  fullWidth = true,
  id,
  className,
  panelClassName,
  panelHeight = 0,
  children,
}: PickerShellProps) {
  const phone = useIsPhone();
  const fieldRef = React.useRef<HTMLButtonElement | null>(null);
  // Decided each time the panel opens, and kept through the close so the sheet can animate out.
  const [tooShort, setTooShort] = React.useState(false);
  const sheet = phone || tooShort;

  const openChange = React.useCallback(
    (next: boolean) => {
      if (next && !phone && panelHeight > 0) {
        const rect = fieldRef.current?.getBoundingClientRect();

        // 7px Popover offset + 12px viewport padding on the side it opens to.
        if (rect) setTooShort(Math.max(window.innerHeight - rect.bottom, rect.top) - 19 < panelHeight);
      }
      onOpenChange(next);
    },
    [phone, panelHeight, onOpenChange],
  );

  // Esc closes only the picker. Caught on the way down (capture) so a sheet or modal the field sits in,
  // which also listens for Esc on window, does not close along with it.
  React.useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      openChange(false);
    };

    window.addEventListener('keydown', onKey, true);

    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, openChange]);

  const field = (
    <button
      ref={fieldRef}
      aria-label={`${label}: ${display || 'Not set'}`}
      className={cn(
        'relative inline-flex min-w-0 items-center gap-2 border-2 px-3 text-left font-semibold',
        'border-[color:var(--pk-edge)] transition-[border-color,outline-color] duration-150 motion-reduce:transition-none',
        !isDisabled && 'hover:border-[color:var(--pk-edge-hover)]',
        'focus:outline-none focus-visible:border-[color:var(--pk-focus)] focus-visible:outline focus-visible:outline-1',
        'focus-visible:outline-offset-0 focus-visible:outline-[color:var(--pk-focus)]',
        'data-[open=true]:border-[color:var(--pk-focus)]',
        isDisabled && 'cursor-not-allowed opacity-50',
        CONTROL_HEIGHT[size],
        CONTROL_TEXT[size],
        FIELD_RADIUS,
        fullWidth && 'w-full',
        className,
      )}
      data-open={isOpen ? 'true' : 'false'}
      disabled={isDisabled}
      id={id}
      style={
        {
          background: `var(--field-bg, ${FIELD_FACE})`,
          color: INK,
          // An app can point `--field-edge` / `--field-bg` at its own field rim and face so the picker matches its inputs.
          '--pk-edge': `var(--field-edge, ${FIELD_EDGE})`,
          '--pk-edge-hover': FIELD_EDGE_HOVER,
          '--pk-focus': HEROUI_COLOR_TEXT.primary,
        } as React.CSSProperties
      }
      type='button'
      onClick={sheet ? () => openChange(true) : undefined}
    >
      <span aria-hidden className='inline-flex shrink-0' style={{ color: INK_MUTED }}>
        {icon}
      </span>
      <span
        className={cn('min-w-0 flex-1 truncate tabular-nums', !display && 'font-medium')}
        style={display ? undefined : { color: INK_MUTED }}
      >
        {display || placeholder}
      </span>
    </button>
  );

  if (sheet) {
    return (
      <>
        {field}
        <Drawer isOpen={isOpen} placement='bottom' radius='lg' size='md' onOpenChange={openChange}>
          <DrawerContent>
            <DrawerHeader className='pb-1 text-[16px]'>{label}</DrawerHeader>
            <DrawerBody className='pt-2'>{children}</DrawerBody>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <Popover
      isDisabled={isDisabled}
      isOpen={isOpen}
      placement='bottom-start'
      radius='lg'
      size='sm'
      onOpenChange={openChange}
    >
      <PopoverTrigger>{field}</PopoverTrigger>
      <PopoverContent aria-label={label} className={panelClassName}>
        {children}
      </PopoverContent>
    </Popover>
  );
}

export interface CellProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  selected?: boolean;
  /** Ringed (today / now). */
  ringed?: boolean;
  /** Muted ink (a day from the next or previous month). */
  muted?: boolean;
  /** Visually and functionally off, but still focusable so arrow keys can pass over it. */
  unavailable?: boolean;
  /** Taller cells for a finger on a phone. */
  comfy?: boolean;
}

/**
 * One flat cell (day, hour, minute, AM/PM). No lip and no shadow: these sit packed in a grid
 * inside a floating panel, where a clay edge per cell would touch its neighbours.
 */
export const Cell = React.forwardRef<HTMLButtonElement, CellProps>(function Cell(
  { selected, ringed, muted, unavailable, comfy, className, style, onClick, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-disabled={unavailable || undefined}
      className={cn(
        'inline-flex w-full items-center justify-center rounded-md text-[14px] tabular-nums select-none',
        'transition-colors duration-100 motion-reduce:transition-none',
        'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1',
        'focus-visible:outline-[color:var(--p-text)]',
        comfy ? 'h-11' : 'h-10',
        selected ? 'font-extrabold' : muted ? 'font-medium' : 'font-semibold',
        !selected && !unavailable && 'hover:bg-[color:var(--surface-3)]',
        unavailable && 'cursor-not-allowed line-through opacity-40',
        className,
      )}
      style={{
        background: selected ? 'var(--p)' : undefined,
        color: selected ? 'var(--p-fg)' : muted ? INK_MUTED : INK,
        boxShadow: ringed && !selected ? 'inset 0 0 0 2px var(--p-text)' : undefined,
        ...style,
      }}
      type='button'
      onClick={(event) => {
        if (unavailable) {
          event.preventDefault();

          return;
        }
        onClick?.(event);
      }}
      {...rest}
    >
      {children}
    </button>
  );
});

export const CalendarIcon = (
  <svg
    fill='none'
    height='18'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2}
    viewBox='0 0 24 24'
    width='18'
  >
    <rect height='18' rx='2' width='18' x='3' y='4' />
    <path d='M16 2v4M8 2v4M3 10h18' />
  </svg>
);

export const ClockIcon = (
  <svg
    fill='none'
    height='18'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2}
    viewBox='0 0 24 24'
    width='18'
  >
    <circle cx='12' cy='12' r='9' />
    <path d='M12 7v5l3 2' />
  </svg>
);

export const ChevronLeft = (
  <svg fill='none' stroke='currentColor' strokeLinecap='round' strokeLinejoin='round' strokeWidth={2.4} viewBox='0 0 24 24'>
    <path d='m15 18-6-6 6-6' />
  </svg>
);

export const ChevronRight = (
  <svg fill='none' stroke='currentColor' strokeLinecap='round' strokeLinejoin='round' strokeWidth={2.4} viewBox='0 0 24 24'>
    <path d='m9 18 6-6-6-6' />
  </svg>
);
