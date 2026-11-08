import React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';

import { cn } from '../../cn';
import { clayVars } from '../clay';
import { lockBodyScroll } from '../../body-scroll-lock';

import type { HeroUIRadius, HeroUISize } from '../tokens';

/**
 * da-v2 Popover — drop-in replacement for @heroui/react Popover.
 *
 * Three-component composition:
 *   <Popover isOpen onOpenChange placement showArrow ...>
 *     <PopoverTrigger><button>open</button></PopoverTrigger>
 *     <PopoverContent>{anyContent}</PopoverContent>
 *   </Popover>
 *
 * Implementation notes:
 *  - Open state lives on Popover; PopoverTrigger and PopoverContent read it via
 *    PopoverContext.
 *  - PopoverTrigger clones its single child to attach onClick + aria-expanded.
 *  - PopoverContent renders portaled to document.body when open. SSR-safe via
 *    a `mounted` flag (no document access until client hydration).
 *  - Position math is the same shape as Tooltip's: capture trigger rect on
 *    open, compute placement, flip on overflow when shouldFlip. Recompute on
 *    window resize/scroll (passive listeners).
 *  - Outside-click + Escape close, gated by isDismissable / isKeyboardDismissDisabled.
 *  - shouldBlockScroll locks body overflow on open (Modal-style).
 *  - backdrop variants: 'transparent' renders no backdrop; 'opaque' = bg-black/40;
 *    'blur' = bg-black/20 backdrop-blur-sm. Backdrop click closes when isDismissable.
 *  - triggerScaleOnOpen scales the trigger to 0.97 while open (visual feedback).
 *  - Animation: 140ms scale 0.96 -> 1 + fade. Origin = trigger-facing corner.
 */

export type PopoverPlacement =
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

export type PopoverBackdrop = 'transparent' | 'opaque' | 'blur';
export type PopoverTriggerType = 'dialog' | 'menu' | 'listbox' | 'tree' | 'grid';
export type PopoverShadow = 'sm' | 'md' | 'lg';

export interface PopoverClassNames {
  base?: string;
  content?: string;
  trigger?: string;
  backdrop?: string;
  arrow?: string;
}

export interface PopoverProps {
  children: React.ReactNode;
  isOpen?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: PopoverPlacement;
  showArrow?: boolean;
  shouldBlockScroll?: boolean;
  shouldCloseOnBlur?: boolean;
  shouldCloseOnInteractOutside?: (el: Element) => boolean;
  isDismissable?: boolean;
  isKeyboardDismissDisabled?: boolean;
  shouldFlip?: boolean;
  containerPadding?: number;
  offset?: number;
  crossOffset?: number;
  triggerScaleOnOpen?: boolean;
  triggerType?: PopoverTriggerType;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  shadow?: PopoverShadow;
  backdrop?: PopoverBackdrop;
  /**
   * Scrapbook-era seeded tilt. Accepted and ignored — clay has no rotation.
   * Kept so the six apps' call sites do not have to change.
   */
  rotate?: number;
  /** HeroUI compat — accepted, passthrough/stub. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  motionProps?: any;
  classNames?: PopoverClassNames;
  className?: string;
  portalContainer?: Element | HTMLElement | null;
  /** HeroUI compat — accepted, ignored. */
  showCloseButton?: boolean;
  /** HeroUI compat — kept for parity. */
  isDisabled?: boolean;
  /** HeroUI compat — kept for parity. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  triggerRef?: React.RefObject<any>;
  /** Pass-through for `dir`. */
  dir?: 'rtl' | 'ltr';
}

const SIZE_PADDING: Record<HeroUISize, string> = {
  sm: 'p-3 text-[13px]',
  md: 'p-4 text-[14px]',
  lg: 'p-5 text-[15px]',
};

// Clay's ladder. Written out, not interpolated — the JIT cannot read a template
// literal.
const RADIUS_CLASS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-[10px]',
  md: 'rounded-[14px]',
  lg: 'rounded-[20px]',
  full: 'rounded-[24px]',
};

/** Lip depth per `shadow` step — was a DIAGONAL `Npx Npx 0`, now straight down. */
const SHADOW_DEPTH: Record<PopoverShadow, number> = { sm: 5, md: 7, lg: 9 };

/**
 * The panel fill. Already the right rung before this port — the arrow is a
 * cut-out of the panel and is filled from the SAME token, so the two cannot
 * separate into a visible seam.
 */
const CARD = 'var(--card-bg)';

interface Position {
  top: number;
  left: number;
  /** Where the trigger sits relative to the panel — used for arrow placement. */
  side: 'top' | 'bottom' | 'left' | 'right';
  /** transform-origin string for entry animation. */
  origin: string;
  /**
   * Set only when the panel is taller than the room on its side of the trigger: the panel is capped
   * to that room and scrolls, instead of being clamped onto (and covering) its own trigger.
   */
  maxHeight?: number;
}

interface PopoverContextValue {
  open: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  panelRef: React.MutableRefObject<HTMLDivElement | null>;
  position: Position | null;
  panelId: string;
  triggerId: string;
  triggerScaleOnOpen: boolean;
  triggerType: PopoverTriggerType;
  classNames?: PopoverClassNames;
  showArrow: boolean;
  size: HeroUISize;
  radius: HeroUIRadius;
  shadow: PopoverShadow;
  backdrop: PopoverBackdrop;
  isDismissable: boolean;
  shouldCloseOnInteractOutside?: (el: Element) => boolean;
  className?: string;
  isDisabled?: boolean;
  portalContainer?: Element | HTMLElement | null;
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

export function Popover(props: PopoverProps) {
  const {
    children,
    isOpen: controlledOpen,
    defaultOpen,
    onOpenChange,
    placement = 'bottom',
    showArrow = false,
    shouldBlockScroll = false,
    shouldCloseOnInteractOutside,
    isDismissable = true,
    isKeyboardDismissDisabled = false,
    shouldFlip = true,
    containerPadding = 12,
    offset = 7,
    crossOffset = 0,
    triggerScaleOnOpen = false,
    triggerType = 'dialog',
    size = 'md',
    radius = 'md',
    shadow = 'md',
    backdrop = 'transparent',
    rotate: _rotate,
    classNames,
    className,
    portalContainer,
    isDisabled,
    dir,
  } = props;


  const [mounted, setMounted] = React.useState(false);
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(Boolean(defaultOpen));
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? Boolean(controlledOpen) : uncontrolledOpen;

  const triggerRef = React.useRef<HTMLElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = React.useState<Position | null>(null);
  // The panel's own CSS max-height (its className), read once per open before any inline cap.
  const classMaxHeightRef = React.useRef<number | null>(null);

  const panelId = React.useId();
  const triggerId = React.useId();

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (isDisabled && next) return;
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange, isDisabled],
  );

  const toggle = React.useCallback(() => {
    setOpen(!open);
  }, [open, setOpen]);

  /* ---------- position math (lifted from Tooltip) ---------- */
  const computePosition = React.useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const panel = panelRef.current;
    // LAYOUT size, not getBoundingClientRect: the panel opens at `scale: 0.96` and the first two
    // measurements land mid-animation, so the rect was 4% short and a `top` panel was placed that
    // much too low — over its own trigger (a toolbar docked at the bottom lost its row under it).
    // The natural height is the content's full height (scrollHeight + borders), capped by the
    // panel's own CSS max-height (read before this code ever writes an inline one).
    if (panel && classMaxHeightRef.current === null) {
      const cssMax = Number.parseFloat(getComputedStyle(panel).maxHeight);

      classMaxHeightRef.current = Number.isFinite(cssMax) ? cssMax : Number.POSITIVE_INFINITY;
    }
    const panelW = panel?.offsetWidth ?? 0;
    const naturalH = panel ? panel.scrollHeight + (panel.offsetHeight - panel.clientHeight) : 0;
    let panelH = Math.min(naturalH, classMaxHeightRef.current ?? Number.POSITIVE_INFINITY);
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const place = (p: PopoverPlacement): Position => {
      const [base, align] = p.split('-') as [string, string | undefined];
      let top = 0;
      let left = 0;
      let side: Position['side'] = 'top';
      let origin = 'top center';

      if (base === 'top') {
        side = 'bottom';
        top = rect.top - panelH - offset;
        left = rect.left + rect.width / 2 - panelW / 2;
        if (align === 'start') left = rect.left;
        if (align === 'end') left = rect.right - panelW;
        left += crossOffset;
        origin = align === 'start' ? 'bottom left' : align === 'end' ? 'bottom right' : 'bottom center';
      } else if (base === 'bottom') {
        side = 'top';
        top = rect.bottom + offset;
        left = rect.left + rect.width / 2 - panelW / 2;
        if (align === 'start') left = rect.left;
        if (align === 'end') left = rect.right - panelW;
        left += crossOffset;
        origin = align === 'start' ? 'top left' : align === 'end' ? 'top right' : 'top center';
      } else if (base === 'left') {
        side = 'right';
        left = rect.left - panelW - offset;
        top = rect.top + rect.height / 2 - panelH / 2;
        if (align === 'start') top = rect.top;
        if (align === 'end') top = rect.bottom - panelH;
        top += crossOffset;
        origin = align === 'start' ? 'top right' : align === 'end' ? 'bottom right' : 'center right';
      } else if (base === 'right') {
        side = 'left';
        left = rect.right + offset;
        top = rect.top + rect.height / 2 - panelH / 2;
        if (align === 'start') top = rect.top;
        if (align === 'end') top = rect.bottom - panelH;
        top += crossOffset;
        origin = align === 'start' ? 'top left' : align === 'end' ? 'bottom left' : 'center left';
      }

      return { top, left, side, origin };
    };

    let pos = place(placement);

    if (shouldFlip && panel) {
      const overflowsTop = pos.top < containerPadding;
      const overflowsBottom = pos.top + panelH > vh - containerPadding;
      const overflowsLeft = pos.left < containerPadding;
      const overflowsRight = pos.left + panelW > vw - containerPadding;

      const base = placement.split('-')[0];
      let flipped: PopoverPlacement | null = null;
      // Above/below: flip only to a side with MORE room. Flipping a menu off a bottom-docked toolbar
      // «below» a trigger that sits at the screen edge left it nowhere to go but back over the toolbar.
      const roomAbove = rect.top - offset - containerPadding;
      const roomBelow = vh - rect.bottom - offset - containerPadding;
      if (base === 'top' && overflowsTop && roomBelow > roomAbove)
        flipped = placement.replace('top', 'bottom') as PopoverPlacement;
      else if (base === 'bottom' && overflowsBottom && roomAbove > roomBelow)
        flipped = placement.replace('bottom', 'top') as PopoverPlacement;
      else if (base === 'left' && overflowsLeft) flipped = placement.replace('left', 'right') as PopoverPlacement;
      else if (base === 'right' && overflowsRight) flipped = placement.replace('right', 'left') as PopoverPlacement;
      if (flipped) pos = place(flipped);
    }

    // Still taller than the room on its side (a menu over a toolbar docked at the screen edge, a
    // short split-screen window): cap it to that room so it scrolls inside, and re-place it there.
    // The old clamp pushed it back on screen by sliding it over the trigger it belongs to.
    if (panel && (pos.side === 'bottom' || pos.side === 'top')) {
      const room =
        pos.side === 'bottom' ? rect.top - offset - containerPadding : vh - rect.bottom - offset - containerPadding;

      if (panelH > room && room > 0) {
        panelH = room;
        pos.maxHeight = room;
        pos.top = pos.side === 'bottom' ? rect.top - panelH - offset : rect.bottom + offset;
      }
    }

    pos.left = Math.max(containerPadding, Math.min(pos.left, vw - panelW - containerPadding));
    pos.top = Math.max(containerPadding, Math.min(pos.top, vh - panelH - containerPadding));

    setPosition((prev) =>
      prev &&
      prev.top === pos.top &&
      prev.left === pos.left &&
      prev.side === pos.side &&
      prev.maxHeight === pos.maxHeight
        ? prev
        : pos,
    );
  }, [placement, offset, crossOffset, shouldFlip, containerPadding]);

  // Compute on open + reposition on resize/scroll, and whenever the panel's content changes size
  // (a settings panel that grows a section when an option flips must not run off screen).
  React.useEffect(() => {
    if (!open) {
      setPosition(null);
      classMaxHeightRef.current = null;

      return;
    }
    computePosition();
    const r = requestAnimationFrame(() => computePosition());
    const onResize = () => computePosition();
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('scroll', onResize, { passive: true, capture: true });
    let observer: ResizeObserver | null = null;
    const panel = panelRef.current;

    if (panel && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => computePosition());
      Array.from(panel.children).forEach((child) => observer?.observe(child));
    }

    return () => {
      cancelAnimationFrame(r);
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open, computePosition]);

  // On close, let go of the trigger's focus: a toolbar icon kept a focus ring after its popover shut
  // (Esc counts as keyboard use, so the browser drew :focus-visible on the still-focused trigger).
  const wasOpen = React.useRef(open);
  React.useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement as HTMLElement | null;
      if (active && triggerRef.current?.contains(active)) active.blur();
    }
    wasOpen.current = open;
  }, [open]);

  // Outside-click + Esc handling
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (isKeyboardDismissDisabled) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (!isDismissable) return;
      const target = e.target as Element | null;
      if (!target) return;
      if (panelRef.current?.contains(target as Node)) return;
      if (triggerRef.current?.contains(target as Node)) return;
      if (shouldCloseOnInteractOutside && !shouldCloseOnInteractOutside(target)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
    };
  }, [open, isDismissable, isKeyboardDismissDisabled, shouldCloseOnInteractOutside, setOpen]);

  // Body scroll lock — counted, because a popover is very often opened OVER a modal.
  // Capture-then-restore reads the modal's own 'hidden' as its "previous" and puts it
  // back on close, locking the page for good. See `body-scroll-lock.ts`.
  React.useEffect(() => {
    if (!open || !shouldBlockScroll) return;

    return lockBodyScroll();
  }, [open, shouldBlockScroll]);

  const ctxValue: PopoverContextValue = {
    open,
    setOpen,
    toggle,
    triggerRef,
    panelRef,
    position,
    panelId,
    triggerId,
    triggerScaleOnOpen,
    triggerType,
    classNames,
    showArrow,
    size,
    radius,
    shadow,
    backdrop,
    isDismissable,
    shouldCloseOnInteractOutside,
    className,
    isDisabled,
    portalContainer,
  };

  // Backdrop layer (separate from the panel, painted behind on portal).
  const backdropLayer =
    open && backdrop !== 'transparent' && mounted ? (
      <motion.div
        animate={{ opacity: 1 }}
        aria-hidden
        className={cn(
          'fixed inset-0 z-[999]',
          backdrop === 'opaque' && 'bg-black/40',
          backdrop === 'blur' && 'bg-black/20 backdrop-blur-sm',
          classNames?.backdrop,
        )}
        dir={dir}
        exit={{ opacity: 0 }}
        initial={{ opacity: 0 }}
        onClick={isDismissable ? () => setOpen(false) : undefined}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      />
    ) : null;

  const portalTarget =
    mounted && typeof document !== 'undefined' ? ((portalContainer as HTMLElement | null) ?? document.body) : null;

  return (
    <PopoverContext.Provider value={ctxValue}>
      {children}
      {portalTarget ? createPortal(<AnimatePresence>{backdropLayer}</AnimatePresence>, portalTarget) : null}
    </PopoverContext.Provider>
  );
}

Popover.displayName = 'Popover';

/* ============================================================
   <PopoverTrigger>
   Clones its single child to attach click + aria.
   ============================================================ */

export interface PopoverTriggerProps {
  children: React.ReactElement;
  /** HeroUI compat — kept for parity. */
  className?: string;
}

export function PopoverTrigger({ children }: PopoverTriggerProps) {
  const ctx = React.useContext(PopoverContext);
  if (!ctx) {
    if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn('PopoverTrigger must be a descendant of Popover.');
    }

    return children;
  }

  type RefChild = React.ReactElement & { ref?: React.Ref<unknown> };
  const childRef = (children as RefChild).ref;
  const setTriggerRef = (node: HTMLElement | null) => {
    ctx.triggerRef.current = node;
    if (typeof childRef === 'function') (childRef as (n: HTMLElement | null) => void)(node);
    else if (childRef && typeof childRef === 'object')
      (childRef as React.MutableRefObject<HTMLElement | null>).current = node;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const childProps: Record<string, any> = (children.props as any) ?? {};

  const ariaHasPopup =
    ctx.triggerType === 'dialog'
      ? 'dialog'
      : ctx.triggerType === 'menu'
        ? 'menu'
        : ctx.triggerType === 'listbox'
          ? 'listbox'
          : ctx.triggerType === 'tree'
            ? 'tree'
            : 'grid';

  const triggerScaleStyle: React.CSSProperties =
    ctx.triggerScaleOnOpen && ctx.open
      ? {
          transform: `scale(0.97) ${childProps.style?.transform ?? ''}`.trim(),
          transition: 'transform 120ms ease-out',
        }
      : {
          transition: 'transform 120ms ease-out',
        };

  return React.cloneElement(children, {
    ref: setTriggerRef,
    id: childProps.id ?? ctx.triggerId,
    'aria-haspopup': ariaHasPopup,
    'aria-expanded': ctx.open,
    'aria-controls': ctx.open ? ctx.panelId : undefined,
    'data-open': ctx.open ? 'true' : 'false',
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      childProps.onClick?.(e);
      if (e.defaultPrevented) return;
      if (ctx.isDisabled) return;
      ctx.toggle();
    },
    style: { ...(childProps.style as React.CSSProperties | undefined), ...triggerScaleStyle },
  } as React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> });
}

PopoverTrigger.displayName = 'PopoverTrigger';

/* ============================================================
   <PopoverContent>
   Renders portaled scrapbook surface when open.
   ============================================================ */

export interface PopoverContentProps {
  children?: React.ReactNode | ((titleProps: { id: string }) => React.ReactNode);
  className?: string;
  style?: React.CSSProperties;
  /** Forwarded to the inner panel. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export function PopoverContent(props: PopoverContentProps) {
  const ctx = React.useContext(PopoverContext);
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!ctx) {
    if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn('PopoverContent must be a descendant of Popover.');
    }

    return null;
  }

  const { children, className, style, ...rest } = props;
  const sh = SHADOW_DEPTH[ctx.shadow];

  const arrowSize = 8;
  const arrowSvg =
    ctx.showArrow && ctx.position ? (
      <svg
        aria-hidden
        className={cn('pointer-events-none absolute', ctx.classNames?.arrow)}
        height={arrowSize}
        style={(() => {
          const s: React.CSSProperties = {};
          if (ctx.position.side === 'top') {
            s.top = -arrowSize + 1;
            s.left = '50%';
            s.transform = 'translateX(-50%)';
          }
          if (ctx.position.side === 'bottom') {
            s.bottom = -arrowSize + 1;
            s.left = '50%';
            s.transform = 'translateX(-50%) rotate(180deg)';
          }
          if (ctx.position.side === 'left') {
            s.left = -arrowSize + 1;
            s.top = '50%';
            s.transform = 'translateY(-50%) rotate(-90deg)';
          }
          if (ctx.position.side === 'right') {
            s.right = -arrowSize + 1;
            s.top = '50%';
            s.transform = 'translateY(-50%) rotate(90deg)';
          }

          return s;
        })()}
        viewBox='0 0 16 8'
        width={arrowSize * 2}
      >
        {/* The arrow is a cut-out of the PANEL, so it must be filled with the panel's own
            surface — `var(--card-bg)`, the same token the panel paints (see the className
            below). It used to use PAPER (`--paper`), which is the PAGE rung of the surface
            ladder, not the card rung: the arrow rendered one step darker than the panel it
            grows out of. Barely visible under `light` (ΔL 0.019, 1.02:1) and three times
            more so under a warm palette, where --paper is #faf8f5 against a #ffffff panel
            (ΔL 0.0595, 1.06:1) — the same step the ladder uses to separate a card from the
            page, which is exactly the step that must NOT appear inside one surface. */}
        {/* Stroke follows the panel's clay rim, not the scrapbook LINE, and at
            the panel's 3px rather than 1.5 — an arrow outlined a different
            weight or colour from the panel reads as a seam just as surely as a
            mismatched fill does. `--clay-edge` is inherited from the panel. */}
        <path
          // OPEN path — no `Z`. Closing it strokes the triangle's BASE, which
          // lands inside the panel and draws a 3px bar straight across the
          // junction: the exact seam the arrow exists to avoid, and one the old
          // 1.5px stroke merely made quieter. SVG fills an open path as if
          // closed, so the triangle is still solid; only the two slanted sides
          // take the rim. The base is then covered by the panel's own fill.
          d='M0 8 L8 0 L16 8'
          fill={CARD}
          stroke='var(--clay-edge)'
          strokeLinejoin='round'
          strokeWidth={3}
        />
      </svg>
    ) : null;

  const portalTarget =
    mounted && typeof document !== 'undefined' ? ((ctx.portalContainer as HTMLElement | null) ?? document.body) : null;

  if (!portalTarget) return null;

  const titleId = `${ctx.panelId}-title`;
  const renderedChildren = typeof children === 'function' ? children({ id: titleId }) : children;

  return createPortal(
    <AnimatePresence>
      {ctx.open ? (
        <motion.div
          ref={ctx.panelRef}
          animate={{ opacity: 1, scale: 1 }}
          aria-labelledby={titleId}
          aria-modal={ctx.triggerType === 'dialog' ? 'true' : undefined}
          className={cn(
            // `.clay-panel` — raised, no hover rule. A floating panel answering
            // the cursor is the affordance lie one step quieter.
            'clay-panel pointer-events-auto fixed z-[1000] border-[3px] border-[color:var(--clay-edge)]',
            'min-w-[160px] max-w-[min(90vw,520px)]',
            SIZE_PADDING[ctx.size],
            RADIUS_CLASS[ctx.radius],
            ctx.classNames?.base,
            ctx.classNames?.content,
            ctx.className,
            className,
          )}
          exit={{ opacity: 0, scale: 0.96 }}
          id={ctx.panelId}
          initial={{ opacity: 0, scale: 0.96 }}
          onClick={(e) => e.stopPropagation()}
          role={ctx.triggerType === 'dialog' ? 'dialog' : undefined}
          style={{
            top: ctx.position?.top ?? -9999,
            left: ctx.position?.left ?? -9999,
            visibility: ctx.position ? 'visible' : 'hidden',
            background: CARD,
            ...clayVars(CARD, { kind: 'surface', depth: sh }),
            transformOrigin: ctx.position?.origin ?? 'center',
            ...(ctx.position?.maxHeight !== undefined
              ? { maxHeight: ctx.position.maxHeight, overflowY: 'auto' as const }
              : null),
            ...style,
          }}
          transition={{ duration: 0.14, ease: [0.3, 0.6, 0.2, 1.2] }}
          {...rest}
        >
          <span aria-hidden id={titleId} style={{ display: 'none' }} />
          {renderedChildren}
          {arrowSvg}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    portalTarget,
  );
}

PopoverContent.displayName = 'PopoverContent';
