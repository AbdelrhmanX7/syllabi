import React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';

import { cn } from '../../cn';
import { CLAY_FILL, CLAY_LABEL, clayVars } from '../clay';
import {
  INK,
  PAPER,
  SHADOW_C,
} from '../tokens';
import type { HeroUIRadius, HeroUISize } from '../tokens';

/**
 * da-v2 Tooltip — drop-in replacement for @heroui/react Tooltip.
 *
 * Mirrors the HeroUI prop API (content/placement/color/size/radius/delay/
 * closeDelay/showArrow/isOpen/defaultOpen/onOpenChange/isDisabled/
 * isDismissable/shouldFlip/containerPadding/offset/crossOffset).
 *
 * Implementation notes:
 *  - Renders the panel via createPortal into `portalContainer` (default
 *    document.body) — guarded by a `mounted` flag so SSR never tries to
 *    access document.
 *  - Position is computed once on open from getBoundingClientRect() and
 *    recomputed on window resize/scroll (passive listeners). No polling.
 *  - Hover/focus open/close timers use setTimeout; opposite events cancel
 *    the pending timer.
 *  - The single child trigger is cloned to inject event handlers + ref;
 *    if the child has a ref it is merged.
 */

export type TooltipPlacement =
  | 'top'
  | 'top-start'
  | 'top-end'
  | 'bottom'
  | 'bottom-start'
  | 'bottom-end'
  | 'left'
  | 'left-start'
  | 'left-end'
  | 'right'
  | 'right-start'
  | 'right-end';

export type TooltipColor =
  | 'default'
  | 'primary'
  | 'secondary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'foreground'
  | 'inverse';

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  placement?: TooltipPlacement;
  color?: TooltipColor;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  shadow?: 'sm' | 'md' | 'lg';
  delay?: number;
  closeDelay?: number;
  showArrow?: boolean;
  isOpen?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  isDisabled?: boolean;
  isDismissable?: boolean;
  shouldFlip?: boolean;
  containerPadding?: number;
  offset?: number;
  crossOffset?: number;
  classNames?: { base?: string; content?: string; arrow?: string };
  className?: string;
  /** HeroUI compat — accepted, passed through. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  motionProps?: any;
  /**
  * @deprecated No-op. Seeded rotation was a scrapbook device and died with
  * it — a tilted clay slab reads as broken, not as paper. Kept accepted so
  * existing call sites still compile.
  */
  /**
   * @deprecated No-op. Seeded rotation was a scrapbook device and died with it —
   * a tilted clay slab reads as broken, not as paper. Kept accepted so existing
   * call sites still compile.
   */
  rotate?: number;
  /** Portal target override. Needed when an ancestor is in native fullscreen: content portaled to
   * document.body is not rendered while another element is fullscreen, so the panel must portal
   * INTO the fullscreen element. Defaults to document.body. */
  portalContainer?: Element | null;
  /** HeroUI compat — kept for parity. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  triggerRef?: React.RefObject<any>;
  /** HeroUI compat — kept for parity, not deeply mirrored. */
  showOnFocusVisible?: boolean;
}

const SIZE_PADDING: Record<HeroUISize, string> = {
  sm: 'px-2.5 py-1 text-[12px]',
  md: 'px-3 py-1.5 text-[13px]',
  lg: 'px-3.5 py-2 text-[14px]',
};

const RADIUS_CLASS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
};

interface ColorTokens {
  bg: string;
  fg: string;
  border: string;
  shadow: string;
}

/**
 * EVERY colour takes the `control` profile, including the saturated ones — which
 * is not what `clayKindFor` would return, and is deliberate.
 *
 * A tooltip floats over ARBITRARY content. It has no ground: the thing behind it
 * is whatever the trigger happened to be sitting on, and in the worst case that
 * is the tooltip's own colour (a primary tooltip over a primary button is 1:1).
 * So the one contrast that can be GUARANTEED is rim-vs-fill, and `control`
 * (a 50% mix) is what maximises it — `surface` leaves it at 1.25:1 and `brand`
 * at ~1.3:1.
 *
 * This is the same ground-dependence term the Modal/Drawer port found, at its
 * limit: there, the ground was a known scrim; here it is unknowable, so the rim
 * has to carry the boundary unconditionally.
 */
function colorTokens(color: TooltipColor): ColorTokens {
  if (color === 'default') {
    // `--card-bg`, not `--paper`: a floating panel is a raised surface, and
    // `--paper` is the PAGE rung in light.
    return { bg: 'var(--card-bg)', fg: INK, border: 'var(--clay-edge)', shadow: SHADOW_C };
  }
  if (color === 'inverse' || color === 'foreground') {
    // The classic dark tooltip. Kept: it is a deliberate inversion, not a rung
    // mistake, and it is the one variant whose fill separates itself from almost
    // any ground.
    return { bg: INK, fg: PAPER, border: 'var(--clay-edge)', shadow: SHADOW_C };
  }

  return { bg: CLAY_FILL[color], fg: CLAY_LABEL[color], border: 'var(--clay-edge)', shadow: SHADOW_C };
}

/** Fill for `clayVars` — same string the panel paints, so rim and arrow agree. */
function clayFillFor(color: TooltipColor): string {
  if (color === 'default') return 'var(--card-bg)';
  if (color === 'inverse' || color === 'foreground') return INK;

  return CLAY_FILL[color];
}

/** Lip depth. Chip-scale: 4 is the shallowest depth that still keeps hover and
 *  active distinct, and a tooltip is a small object. `lg` goes one deeper. */
const SHADOW_DEPTH: Record<NonNullable<TooltipProps['shadow']>, number> = { sm: 3, md: 4, lg: 6 };

interface Position {
  top: number;
  left: number;
  /** Where the trigger sits relative to the panel — used for arrow placement. */
  side: 'top' | 'bottom' | 'left' | 'right';
}

export function Tooltip(props: TooltipProps) {
  const {
    content,
    children,
    placement = 'top',
    color = 'default',
    size = 'md',
    radius = 'md',
    shadow = 'md',
    delay = 0,
    closeDelay = 500,
    showArrow = false,
    isOpen: controlledOpen,
    defaultOpen,
    onOpenChange,
    isDisabled,
    isDismissable = false,
    shouldFlip = true,
    containerPadding = 12,
    offset = 7,
    crossOffset = 0,
    classNames,
    className,
    rotate: _rotate,
    portalContainer,
  } = props;


  const [mounted, setMounted] = React.useState(false);
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(Boolean(defaultOpen));
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? Boolean(controlledOpen) : uncontrolledOpen;

  const [position, setPosition] = React.useState<Position | null>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);

  const openTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const tooltipId = React.useId();

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const clearTimers = React.useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const scheduleOpen = React.useCallback(() => {
    if (isDisabled) return;
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (open) return;
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => setOpen(true), Math.max(0, delay));
  }, [isDisabled, open, delay, setOpen]);

  const scheduleClose = React.useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (!open) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), Math.max(0, closeDelay));
  }, [open, closeDelay, setOpen]);

  // Compute position based on placement & viewport
  const computePosition = React.useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const panel = panelRef.current;
    const panelRect = panel?.getBoundingClientRect();
    const panelW = panelRect?.width ?? 0;
    const panelH = panelRect?.height ?? 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const place = (p: TooltipPlacement): Position => {
      const [base, align] = p.split('-') as [string, string | undefined];
      let top = 0;
      let left = 0;
      let side: Position['side'] = 'top';

      if (base === 'top') {
        side = 'bottom'; // arrow points down to trigger
        top = rect.top - panelH - offset;
        left = rect.left + rect.width / 2 - panelW / 2;
        if (align === 'start') left = rect.left;
        if (align === 'end') left = rect.right - panelW;
        left += crossOffset;
      } else if (base === 'bottom') {
        side = 'top';
        top = rect.bottom + offset;
        left = rect.left + rect.width / 2 - panelW / 2;
        if (align === 'start') left = rect.left;
        if (align === 'end') left = rect.right - panelW;
        left += crossOffset;
      } else if (base === 'left') {
        side = 'right';
        left = rect.left - panelW - offset;
        top = rect.top + rect.height / 2 - panelH / 2;
        if (align === 'start') top = rect.top;
        if (align === 'end') top = rect.bottom - panelH;
        top += crossOffset;
      } else if (base === 'right') {
        side = 'left';
        left = rect.right + offset;
        top = rect.top + rect.height / 2 - panelH / 2;
        if (align === 'start') top = rect.top;
        if (align === 'end') top = rect.bottom - panelH;
        top += crossOffset;
      }

      return { top, left, side };
    };

    let pos = place(placement);

    if (shouldFlip && panelRect) {
      const overflowsTop = pos.top < containerPadding;
      const overflowsBottom = pos.top + panelH > vh - containerPadding;
      const overflowsLeft = pos.left < containerPadding;
      const overflowsRight = pos.left + panelW > vw - containerPadding;

      const base = placement.split('-')[0];
      let flipped: TooltipPlacement | null = null;
      if (base === 'top' && overflowsTop) flipped = placement.replace('top', 'bottom') as TooltipPlacement;
      else if (base === 'bottom' && overflowsBottom) flipped = placement.replace('bottom', 'top') as TooltipPlacement;
      else if (base === 'left' && overflowsLeft) flipped = placement.replace('left', 'right') as TooltipPlacement;
      else if (base === 'right' && overflowsRight) flipped = placement.replace('right', 'left') as TooltipPlacement;
      if (flipped) pos = place(flipped);
    }

    // Clamp to viewport edges
    pos.left = Math.max(containerPadding, Math.min(pos.left, vw - panelW - containerPadding));
    pos.top = Math.max(containerPadding, Math.min(pos.top, vh - panelH - containerPadding));

    setPosition(pos);
  }, [placement, offset, crossOffset, shouldFlip, containerPadding]);

  // Recompute on open + resize + scroll
  React.useEffect(() => {
    if (!open) return;
    // Two-pass: first pass before measuring panel; the panel mounts then we
    // recompute with measured dimensions.
    computePosition();
    const r = requestAnimationFrame(() => computePosition());
    const onResize = () => computePosition();
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('scroll', onResize, { passive: true, capture: true });

    return () => {
      cancelAnimationFrame(r);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open, computePosition]);

  // Esc + outside-click
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearTimers();
        setOpen(false);
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (!isDismissable) return;
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      clearTimers();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
    };
  }, [open, isDismissable, clearTimers, setOpen]);

  // Cleanup timers on unmount
  React.useEffect(() => clearTimers, [clearTimers]);

  const tokens = colorTokens(color);
  const sh = SHADOW_DEPTH[shadow];

  // Clone child to attach handlers + ref
  type RefChild = React.ReactElement & { ref?: React.Ref<unknown> };
  const childRef = (children as RefChild).ref;

  const setTriggerRef = (node: HTMLElement | null) => {
    triggerRef.current = node;
    if (typeof childRef === 'function') (childRef as (n: HTMLElement | null) => void)(node);
    else if (childRef && typeof childRef === 'object')
      (childRef as React.MutableRefObject<HTMLElement | null>).current = node;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const childProps: Record<string, any> = (children.props as any) ?? {};
  const trigger = React.cloneElement(children, {
    ref: setTriggerRef,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      childProps.onMouseEnter?.(e);
      scheduleOpen();
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      childProps.onMouseLeave?.(e);
      scheduleClose();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(e);
      scheduleOpen();
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(e);
      scheduleClose();
    },
    'aria-describedby': open ? tooltipId : childProps['aria-describedby'],
  } as React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> });

  // Decide font: Caveat for short string content
  const isShortString = typeof content === 'string' && content.length <= 18;
  const arrowSize = 8;
  const arrowSvg =
    showArrow && position ? (
      <svg
        aria-hidden
        className={cn('pointer-events-none absolute', classNames?.arrow)}
        height={arrowSize}
        style={(() => {
          // Arrow sits on the side of the panel facing the trigger
          const s: React.CSSProperties = {};
          if (position.side === 'top') {
            s.top = -arrowSize + 3;
            s.left = '50%';
            s.transform = 'translateX(-50%)';
          }
          if (position.side === 'bottom') {
            s.bottom = -arrowSize + 3;
            s.left = '50%';
            s.transform = 'translateX(-50%) rotate(180deg)';
          }
          if (position.side === 'left') {
            s.left = -arrowSize + 3;
            s.top = '50%';
            s.transform = 'translateY(-50%) rotate(-90deg)';
          }
          if (position.side === 'right') {
            s.right = -arrowSize + 3;
            s.top = '50%';
            s.transform = 'translateY(-50%) rotate(90deg)';
          }

          return s;
        })()}
        viewBox='0 0 16 8'
        width={arrowSize * 2}
      >
        {/* Open path — no `Z`. SVG fills an unclosed path as if it were closed,
            so the triangle is still solid, but the BASE line is never stroked.
            That base is what sits on the panel edge, and stroking it draws a rim
            straight across the join: the seam. The two slanted sides still carry
            the rim, so the arrow reads as an extrusion of the panel rather than
            a separate shape stuck to it. `--clay-edge` is inherited from the
            panel, so arrow and panel can never disagree about their rim. */}
        <path d='M0 8 L8 0 L16 8' fill={tokens.bg} stroke='var(--clay-edge)' strokeLinejoin='round' strokeWidth={3} />
      </svg>
    ) : null;

  const panel =
    mounted && position ? (
      <AnimatePresence>
        {open && !isDisabled ? (
          <motion.div
            ref={panelRef}
            animate={{ opacity: 1, scale: 1 }}
            aria-hidden={!open}
            className={cn(
              'pointer-events-auto fixed z-[1000] inline-flex max-w-xs items-center justify-center whitespace-pre-wrap break-words font-bold',
              // `.clay-panel`, not `.clay-surface`: a tooltip is not pressable,
              // and it is already under the pointer by definition — a hover lift
              // would fire the moment it appeared.
              'clay-panel border-[3px]',
              SIZE_PADDING[size],
              RADIUS_CLASS[radius],
              isShortString && 'font-hand text-[15px] tracking-normal',
              classNames?.base,
              classNames?.content,
              className,
            )}
            exit={{ opacity: 0, scale: 0.95 }}
            id={tooltipId}
            initial={{ opacity: 0, scale: 0.95 }}
            onMouseEnter={() => {
              if (closeTimer.current) {
                clearTimeout(closeTimer.current);
                closeTimer.current = null;
              }
            }}
            onMouseLeave={scheduleClose}
            role='tooltip'
            style={{
              top: position.top,
              left: position.left,
              background: tokens.bg,
              color: tokens.fg,
              borderColor: tokens.border,
              ...clayVars(clayFillFor(color), { kind: 'control', depth: sh }),
            }}
            transition={{ duration: 0.12, ease: [0.3, 0.6, 0.2, 1.2] }}
          >
            {content}
            {arrowSvg}
          </motion.div>
        ) : null}
      </AnimatePresence>
    ) : null;

  return (
    <>
      {trigger}
      {mounted && typeof document !== 'undefined' ? createPortal(panel, portalContainer ?? document.body) : null}
    </>
  );
}

Tooltip.displayName = 'Tooltip';
