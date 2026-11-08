import React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';

import { cn } from '../../cn';
import { lockBodyScroll } from '../../body-scroll-lock';
import { clayVars } from '../clay';
import { NestedInCard } from '../Card/Card';

/**
 * da-v2 Drawer — drop-in for HeroUI Drawer. Edge-anchored Modal variant.
 *
 *   <Drawer isOpen onOpenChange placement size>
 *     <DrawerContent>
 *       <DrawerHeader>{title}</DrawerHeader>
 *       <DrawerBody>{content}</DrawerBody>
 *       <DrawerFooter>{actions}</DrawerFooter>
 *     </DrawerContent>
 *   </Drawer>
 *
 * Implementation notes:
 *  - Reuses Modal's body-scroll-lock + Esc handler logic.
 *  - Slide-in animation from anchor edge using motion.div.
 *  - Sizes map to width (left/right) or max column width (top/bottom sheets;
 *    height is content-driven, capped at the viewport).
 *  - Portal to document.body via SSR-safe `mounted` flag.
 *  - 'left' / 'right' are physical edges (the app is LTR-only).
 */

export type DrawerPlacement = 'top' | 'right' | 'bottom' | 'left';
export type DrawerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | 'full';
export type DrawerRadius = 'none' | 'sm' | 'md' | 'lg';
export type DrawerBackdrop = 'transparent' | 'opaque' | 'blur';
export type DrawerScrollBehavior = 'normal' | 'inside' | 'outside';

export interface DrawerClassNames {
  wrapper?: string;
  base?: string;
  header?: string;
  body?: string;
  footer?: string;
  backdrop?: string;
  closeButton?: string;
}

export interface DrawerProps {
  isOpen: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onClose?: () => void;
  children: React.ReactNode;
  placement?: DrawerPlacement;
  size?: DrawerSize;
  radius?: DrawerRadius;
  backdrop?: DrawerBackdrop;
  scrollBehavior?: DrawerScrollBehavior;
  isDismissable?: boolean;
  isKeyboardDismissDisabled?: boolean;
  shouldBlockScroll?: boolean;
  hideCloseButton?: boolean;
  closeButton?: React.ReactNode;
  /** HeroUI compat — accepted, passthrough/stub. */
  motionProps?: Record<string, unknown>;
  classNames?: DrawerClassNames;
  className?: string;
  portalContainer?: Element | HTMLElement | null;
  /** Decorative tape strip on the inward edge. Default true. */
  /**
   * @deprecated No-op. Washi tape was a scrapbook decoration and died with it.
   * Kept accepted so existing call sites still compile.
   */
  withTape?: boolean;
  /** @deprecated No-op. See `withTape`. */
  tapeColor?: 'yellow' | 'pink' | 'blue' | 'green';
  dir?: 'rtl' | 'ltr';
  /** HeroUI compat — kept for parity. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shouldCloseOnInteractOutside?: (el: any) => boolean;
}

interface DrawerContextValue {
  onClose: () => void;
  hideCloseButton: boolean;
  closeButton: React.ReactNode | undefined;
  classNames?: DrawerClassNames;
  scrollBehavior: DrawerScrollBehavior;
  placement: DrawerPlacement;
}

const DrawerContext = React.createContext<DrawerContextValue | null>(null);

/* Sizes for left/right placements (width) */
const SIZE_W: Record<DrawerSize, string> = {
  xs: 'w-[280px]',
  sm: 'w-[320px]',
  md: 'w-[400px]',
  lg: 'w-[500px]',
  xl: 'w-[600px]',
  '2xl': 'w-[720px]',
  '3xl': 'w-[800px]',
  '4xl': 'w-[880px]',
  '5xl': 'w-[960px]',
  full: 'w-screen',
};

/* Max column width for top/bottom placements (sheet-style: the panel is a
   centered column, full-width on mobile). Height is always content-driven. */
const SIZE_MAXW: Record<DrawerSize, string> = {
  xs: 'max-w-[280px]',
  sm: 'max-w-[320px]',
  md: 'max-w-[400px]',
  lg: 'max-w-[500px]',
  xl: 'max-w-[600px]',
  '2xl': 'max-w-[720px]',
  '3xl': 'max-w-[800px]',
  '4xl': 'max-w-[880px]',
  '5xl': 'max-w-[960px]',
  full: 'max-w-none',
};

/**
 * The panel's clay vars, keyed by which edge the lip falls from.
 *
 * `.clay-panel`, not `.clay-surface`: `.clay-surface` lifts its lip on hover,
 * which is right for a genuinely clickable card and wrong for a dialog — the
 * pointer is inside one for as long as it is open, so the panel would sit
 * permanently 2px shallower and pop when the cursor left.
 *
 * `from` is the physical edge the lip falls TOWARD, i.e. the drawer's inward
 * edge — the opposite of where it is anchored. `visualPlacement` is the
 * physical edge.
 *
 * `control`, not `surface`, is measured rather than assumed: a drawer's ground
 * is a SCRIM. On a near-black scrim the lip measures 1.10:1 — invisible at any
 * depth — so the rim carries the boundary. `surface` leaves it at 1.47:1 in
 * dark; `control` puts it at 5.45:1. See `.clay/modal-drawer.md` §4.
 */
const LIP_FROM: Record<'top' | 'right' | 'bottom' | 'left', 'top' | 'right' | 'bottom' | 'left'> = {
  right: 'left',
  left: 'right',
  top: 'bottom',
  bottom: 'top',
};

const panelClay = (placement: 'top' | 'right' | 'bottom' | 'left'): React.CSSProperties =>
  clayVars('var(--card-bg)', { kind: 'control', depth: 8, from: LIP_FROM[placement] });

const RADIUS_CLASS_LEFT: Record<DrawerRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-r-[10px]',
  md: 'rounded-r-[16px]',
  lg: 'rounded-r-[24px]',
};
const RADIUS_CLASS_RIGHT: Record<DrawerRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-l-[10px]',
  md: 'rounded-l-[16px]',
  lg: 'rounded-l-[24px]',
};
const RADIUS_CLASS_TOP: Record<DrawerRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-b-[10px]',
  md: 'rounded-b-[16px]',
  lg: 'rounded-b-[24px]',
};
const RADIUS_CLASS_BOTTOM: Record<DrawerRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-t-[10px]',
  md: 'rounded-t-[16px]',
  lg: 'rounded-t-[24px]',
};

export function Drawer(props: DrawerProps) {
  const {
    isOpen,
    onOpenChange,
    onClose,
    children,
    placement = 'right',
    size,
    radius = 'md',
    backdrop = 'opaque',
    scrollBehavior = 'inside',
    isDismissable = true,
    isKeyboardDismissDisabled = false,
    shouldBlockScroll = true,
    hideCloseButton = false,
    closeButton,
    classNames,
    className,
    portalContainer,
    withTape: _withTape,
    tapeColor: _tapeColor,
    dir,
  } = props;

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);

  const handleClose = React.useCallback(() => {
    onClose?.();
    onOpenChange?.(false);
  }, [onClose, onOpenChange]);

  // Body scroll lock + Esc.
  React.useEffect(() => {
    if (!isOpen || !shouldBlockScroll) return;

    // Counted, not capture-then-restore: a drawer opened over a modal (or during the
    // overlap of a route transition) would otherwise restore the other lock's 'hidden'
    // and leave the page unscrollable with nothing on screen. See `body-scroll-lock.ts`.
    const releaseScroll = lockBodyScroll();
    const onKey = (e: KeyboardEvent) => {
      if (!isKeyboardDismissDisabled && e.key === 'Escape') handleClose();
    };

    window.addEventListener('keydown', onKey);

    return () => {
      releaseScroll();
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen, shouldBlockScroll, isKeyboardDismissDisabled, handleClose]);

  const portalTarget =
    mounted && typeof document !== 'undefined' ? ((portalContainer as HTMLElement | null) ?? document.body) : null;

  /* Slide-in edge — placements are physical. */
  const visualPlacement: DrawerPlacement = placement;

  /* Initial / animate / exit per placement */
  const motionVariants = (() => {
    switch (visualPlacement) {
      case 'right':
        return {
          initial: { x: '100%', opacity: 0.85 },
          animate: { x: 0, opacity: 1 },
          exit: { x: '100%', opacity: 0 },
        };
      case 'left':
        return {
          initial: { x: '-100%', opacity: 0.85 },
          animate: { x: 0, opacity: 1 },
          exit: { x: '-100%', opacity: 0 },
        };
      case 'top':
        return {
          initial: { y: '-100%', opacity: 0.85 },
          animate: { y: 0, opacity: 1 },
          exit: { y: '-100%', opacity: 0 },
        };
      case 'bottom':
        return {
          initial: { y: '100%', opacity: 0.85 },
          animate: { y: 0, opacity: 1 },
          exit: { y: '100%', opacity: 0 },
        };
    }
  })();

  /* Wrapper layout per placement. The panel is pinned to its edge with a
     physical auto-margin (NOT logical justify-*): visualPlacement is
     physical. */
  const isVertical = visualPlacement === 'top' || visualPlacement === 'bottom';
  const wrapperLayout = cn('items-stretch', isVertical && 'flex-col');
  const cardAnchor = (() => {
    switch (visualPlacement) {
      case 'right':
        return 'ml-auto';
      case 'left':
        return 'mr-auto';
      case 'top':
        return 'mb-auto';
      case 'bottom':
        return 'mt-auto';
    }
  })();

  /* Card sizing per axis. Vertical drawers are centered sheet columns:
     content-driven height capped at the viewport, `size` caps the width. */
  const cardSize = !isVertical
    ? cn(SIZE_W[size ?? 'md'], 'h-full')
    : cn('mx-auto h-auto max-h-[92dvh] w-full', SIZE_MAXW[size ?? '2xl']);

  /* Inward-edge styles: rim + radius on the inward edge only.
     Three of a drawer's four edges are flush against the viewport, so only the
     inward one is ever seen — measured gaps for a right drawer are L0/T0/B0/R500.
     Drawing a rim on all four would put 3px of clay under the screen edge. */
  const cardEdgeStyles = (() => {
    switch (visualPlacement) {
      case 'right':
        return cn('border-l-[3px]', RADIUS_CLASS_RIGHT[radius]);
      case 'left':
        return cn('border-r-[3px]', RADIUS_CLASS_LEFT[radius]);
      case 'top':
        return cn('border-b-[3px] sm:border-x-[3px]', RADIUS_CLASS_TOP[radius]);
      case 'bottom':
        return cn('border-t-[3px] sm:border-x-[3px]', RADIUS_CLASS_BOTTOM[radius]);
    }
  })();


  const ctxValue: DrawerContextValue = {
    onClose: handleClose,
    hideCloseButton,
    closeButton,
    classNames,
    scrollBehavior,
    placement: visualPlacement,
  };

  const node = (
    <DrawerContext.Provider value={ctxValue}>
      <AnimatePresence>
        {isOpen ? (
          <motion.div
            animate={{ opacity: 1 }}
            aria-modal='true'
            className={cn(
              'fixed inset-0 z-[100] flex',
              wrapperLayout,
              backdrop === 'opaque' && 'bg-black/40',
              backdrop === 'blur' && 'bg-black/20 backdrop-blur-sm',
              classNames?.wrapper,
              classNames?.backdrop,
            )}
            dir={dir}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            onClick={isDismissable ? handleClose : undefined}
            role='dialog'
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <motion.div
              animate={motionVariants?.animate}
              className={cn(
                'relative flex flex-col',
                // Tier 2: raised, never pressed — `.clay-surface`, no press ladder.
                'clay-panel [background-color:var(--card-bg)] border-[color:var(--clay-edge)]',
                cardAnchor,
                cardSize,
                cardEdgeStyles,
                scrollBehavior === 'outside' && 'overflow-auto',
                className,
                classNames?.base,
              )}
              exit={motionVariants?.exit}
              initial={motionVariants?.initial}
              onClick={(e) => e.stopPropagation()}
              // On the panel itself: this subtree is portalled to document.body,
              // so vars scoped to the app wrapper would never reach it.
              style={panelClay(visualPlacement)}
              transition={{ duration: 0.24, ease: [0.25, 0.8, 0.25, 1] }}
            >
              {/* The same KNOWN LIMIT `Card/Card.tsx` documents on this context: it only
                  sees CARD ancestors, so a Card in a drawer painted `--card-bg` on this
                  panel's own `--card-bg` at 1.000:1 and lost its boundary entirely. That
                  file names Modal and Drawer as the two places to close it. Light is a
                  no-op (`--surface-1` and `--surface-2` are one value there); dark gains
                  a 1.11:1 step. */}
              <NestedInCard.Provider value={true}>{children}</NestedInCard.Provider>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </DrawerContext.Provider>
  );

  if (!portalTarget) return null;

  return createPortal(node, portalTarget);
}

Drawer.displayName = 'Drawer';

/* ============================================================
   Sub-components
   ============================================================ */

export interface DrawerContentProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  children: React.ReactNode | ((onClose: () => void) => React.ReactNode);
}

export const DrawerContent = React.forwardRef<HTMLDivElement, DrawerContentProps>(function DrawerContent(
  { children, className, ...rest },
  ref,
) {
  const ctx = React.useContext(DrawerContext);
  const onClose = ctx?.onClose ?? (() => {});
  const inside = ctx?.scrollBehavior === 'inside';

  const closeButton = ctx?.hideCloseButton
    ? null
    : (ctx?.closeButton ?? (
        <button
          aria-label='Close'
          className={cn(
            // The ONE pressable thing in a Drawer, so the ONLY thing here that
            // gets a press ladder — tier 1 at small-control scale, depth 4.
            // Travel equals `depth - lip` so the bottom edge does not move:
            // rest 0/4, hover 2/2, active 3/1.
            'clay-btn absolute z-[2] flex h-8 w-8 items-center justify-center rounded-full',
            'border-[3px] border-[color:var(--clay-edge)] [background-color:var(--card-bg)]',
            'top-3 right-3',
            'transition-[transform,box-shadow] duration-150',
            'hover:translate-y-[2px] active:translate-y-[3px]',
            'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
            ctx?.classNames?.closeButton,
          )}
          style={clayVars('var(--card-bg)', { kind: 'control', depth: 4 })}
          onClick={onClose}
          type='button'
        >
          <svg fill='none' height='14' stroke='currentColor' strokeWidth='2.5' viewBox='0 0 24 24' width='14'>
            <path d='M18 6L6 18M6 6l12 12' strokeLinecap='round' strokeLinejoin='round' />
          </svg>
        </button>
      ));

  return (
    <div
      ref={ref}
      className={cn('relative flex flex-1 flex-col', inside ? 'overflow-hidden' : '', className)}
      {...rest}
    >
      {closeButton}
      {typeof children === 'function' ? children(onClose) : children}
    </div>
  );
});

export const DrawerHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function DrawerHeader({ className, ...rest }, ref) {
    const ctx = React.useContext(DrawerContext);

    return (
      <div
        ref={ref}
        className={cn(
          'text-ink flex flex-row items-center gap-2 px-6 pb-4 pt-5 text-[18px] font-black',
          // keep the inline-end corner clear of the absolute close button
          !ctx?.hideCloseButton && 'pe-14',
          ctx?.classNames?.header,
          className,
        )}
        {...rest}
      />
    );
  },
);

export const DrawerBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function DrawerBody(
  { className, ...rest },
  ref,
) {
  const ctx = React.useContext(DrawerContext);
  const inside = ctx?.scrollBehavior === 'inside';

  return (
    <div
      ref={ref}
      className={cn(
        /*
         * `pt-4 pb-9` for the same reason as `ModalBody` — see the long note there. `py-2`
         * gave a clay child 8px where its lip alone needs 8px and its glow reaches 36.4px
         * below, and overflow clips at the PADDING box, so every Card in a drawer was cut
         * flush. `px-6`'s 24px covers the inline axis to within 2.4px of the 26.4px blur
         * radius, which is why only the block axis moves here.
         *
         * Unconditional, not gated on `inside`: with `scrollBehavior='outside'` the panel
         * itself takes `overflow-auto` and DrawerContent is `overflow-hidden`, so a clip box
         * exists either way — and the spacing should not change under the caller when they
         * flip that prop.
         */
        'text-ink/85 flex flex-col gap-2 px-6 pt-4 pb-9 text-[14px]',
        inside && 'flex-1 overflow-auto',
        ctx?.classNames?.body,
        className,
      )}
      {...rest}
    />
  );
});

export const DrawerFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function DrawerFooter({ className, ...rest }, ref) {
    const ctx = React.useContext(DrawerContext);

    return (
      <div
        ref={ref}
        className={cn(
          'border-line-soft mt-auto flex items-center justify-end gap-2 border-t-[1.5px] px-6 py-4',
          ctx?.classNames?.footer,
          className,
        )}
        {...rest}
      />
    );
  },
);
