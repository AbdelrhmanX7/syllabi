import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';

import { cn } from '../../cn';
import { lockBodyScroll } from '../../body-scroll-lock';
import { clayVars } from '../clay';
import { NestedInCard } from '../Card/Card';

/**
 * da-v2 Modal — drop-in for HeroUI Modal. Mirrors the sub-component pattern:
 * `<Modal isOpen onOpenChange> <ModalContent> <ModalHeader/><ModalBody/><ModalFooter/></ModalContent></Modal>`
 *
 * Differences from HeroUI:
 *  - Built on framer-motion / motion (already in apps/web), not RAC.
 *  - Portals to document.body so the modal escapes any clipped/positioned
 *    ancestor (sidebars, drawers, scrollable cards, transformed parents).
 *  - HeroUI's `backdrop`, `placement`, `scrollBehavior`, slot props are not
 *    fully replicated. See report.
 */

interface ModalContextValue {
  onClose: () => void;
}

const ModalContext = React.createContext<ModalContextValue | null>(null);

export interface ModalProps {
  isOpen: boolean;
  onClose?: () => void;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  /** HeroUI compat — controls overlay click. Default true. */
  isDismissable?: boolean;
  /** HeroUI compat — controls Escape key. Default true. */
  isKeyboardDismissDisabled?: boolean;
  /**
   * @deprecated No-op. Washi tape was a scrapbook decoration and died with it —
   * clay is a moulded slab, and a paper strip taped to one reads as a different
   * material. Kept accepted so existing call sites still compile.
   */
  withTape?: boolean;
  /** @deprecated No-op. See `withTape`. */
  tapeColor?: 'yellow' | 'pink' | 'blue' | 'green';
  /** Container max width. */
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | 'full';
  className?: string;
  classNames?: {
    base?: string;
    backdrop?: string;
    wrapper?: string;
    body?: string;
    header?: string;
    footer?: string;
    closeButton?: string;
  };
  /** HeroUI compat — kept for API parity, not used internally. */
  hideCloseButton?: boolean;
  scrollBehavior?: 'normal' | 'inside' | 'outside';
  placement?: 'center' | 'top' | 'bottom' | 'top-center' | 'bottom-center' | 'auto';
  /** HeroUI compat — backdrop variant. We always render translucent + blur. */
  backdrop?: 'transparent' | 'opaque' | 'blur';
  /** HeroUI compat — controls the close-on-outside behavior. Accepts the
   * same loose signature HeroUI uses (Element-ish input). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shouldCloseOnInteractOutside?: (element: any) => boolean;
  /** HeroUI compat — passed as motion `transition` overrides. We accept and discard for parity. */
  motionProps?: Record<string, unknown>;
  /** HeroUI compat — custom close button. */
  closeButton?: React.ReactNode;
  /** HeroUI compat — portal target. We don't portal yet. */
  portalContainer?: Element | HTMLElement | null;
  /** Pass-through for `dir`/etc. */
  dir?: 'rtl' | 'ltr';
}

/**
 * The panel's clay vars.
 *
 * `.clay-panel`, not `.clay-surface`: `.clay-surface` lifts its lip on hover,
 * which is right for a genuinely clickable card and wrong for a dialog — the
 * pointer is inside one for as long as it is open, so the panel would sit
 * permanently 2px shallower and pop when the cursor left.
 *
 * `control`, not `surface`, is measured rather than assumed: a dialog's ground
 * is a SCRIM, not a canvas. On a near-black scrim the lip measures 1.10:1 —
 * invisible at any depth — so the rim has to carry the boundary. `surface`
 * leaves it at 1.47:1 against the scrim in dark; `control` puts it at 5.45:1.
 * See `.clay/modal-drawer.md` §4.
 *
 * `from` follows the anchor: a centred dialog rests on the page and its lip
 * falls DOWN, but a bottom sheet is flush with the viewport bottom, so its lip
 * has to fall UP — inward — or it renders off-screen. Same reasoning as the
 * Drawer's placements.
 */
const panelClay = (sheet: boolean): React.CSSProperties =>
  clayVars('var(--card-bg)', { kind: 'control', depth: 8, from: sheet ? 'top' : 'bottom' });

const SIZE: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-[360px]',
  md: 'max-w-[440px]',
  lg: 'max-w-[560px]',
  xl: 'max-w-[720px]',
  '2xl': 'max-w-[820px]',
  '3xl': 'max-w-[920px]',
  '4xl': 'max-w-[1024px]',
  '5xl': 'max-w-[1152px]',
  full: 'max-w-[calc(100vw-32px)]',
};

export function Modal({
  isOpen,
  onClose,
  onOpenChange,
  children,
  isDismissable = true,
  isKeyboardDismissDisabled,
  withTape: _withTape,
  tapeColor: _tapeColor,
  size = 'md',
  className,
  classNames,
  hideCloseButton: _hcb,
  scrollBehavior: _sb,
  placement = 'auto',
  backdrop: _bd,
  shouldCloseOnInteractOutside: _sco,
  motionProps: _mp,
  closeButton: _cb,
  portalContainer,
  dir,
}: ModalProps) {
  const handleClose = React.useCallback(() => {
    onClose?.();
    onOpenChange?.(false);
  }, [onClose, onOpenChange]);

  // SSR-safe mount flag — createPortal needs document, which doesn't exist on the server.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Body scroll lock + ESC handler.
  //
  // The lock is refcounted (see body-scroll-lock.ts). This used to capture
  // `document.body.style.overflow` and restore it, which is correct for one modal and
  // wrong for two: a modal opening over an already-locked page captures 'hidden' as
  // its "previous" and restores it on close, leaving the page permanently unscrollable
  // with nothing on screen to explain it.
  React.useEffect(() => {
    if (!isOpen) return;
    const releaseScroll = lockBodyScroll();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isKeyboardDismissDisabled) handleClose();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      releaseScroll();
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen, handleClose, isKeyboardDismissDisabled]);

  // Placement. Default 'auto' = bottom sheet on mobile (rises from the bottom edge —
  // the native mobile pattern), centered card on sm+. 'bottom' forces the sheet at
  // every size; 'center'/'top' pin it there. Bottom-anchoring on mobile also stops
  // small dialogs floating dead-center on tall phones.
  const isBottom = placement === 'bottom' || placement === 'bottom-center';
  const isTop = placement === 'top' || placement === 'top-center';
  const isAuto = placement === 'auto';
  const sheet = isBottom || isAuto; // bottom-anchored (always, or on mobile for auto)

  const content = (
    <ModalContext.Provider value={{ onClose: handleClose }}>
      <AnimatePresence>
        {isOpen ? (
          <motion.div
            animate={{ opacity: 1 }}
            aria-modal='true'
            className={cn(
              'fixed inset-0 z-[100] flex justify-center bg-black/40 backdrop-blur-sm',
              isBottom
                ? 'items-end'
                : isAuto
                  ? 'items-end sm:items-center sm:p-6'
                  : isTop
                    ? 'items-start p-6'
                    : 'items-center p-6',
              classNames?.backdrop,
              classNames?.wrapper,
            )}
            dir={dir}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            onClick={isDismissable ? handleClose : undefined}
            role='dialog'
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <motion.div
              className={cn(
                // max-h + flex column so tall content (e.g. a long lecture list) scrolls
                // INSIDE the dialog instead of overflowing the viewport — otherwise the
                // header/close gets pushed off-screen and the body scroll-lock traps the app.
                'relative flex max-h-[88dvh] w-full flex-col',
                // Tier 2: raised, never pressed. `.clay-surface` carries the lip;
                // there is no press ladder, because a dialog you can push down is
                // an affordance that lies about what it does.
                'clay-panel [background-color:var(--card-bg)]',
                // The width and the colour are written as two SEPARATE arbitrary
                // values, and the colour is explicitly typed `[color:…]`. The bug
                // this file used to carry was `border-sk` + `border-line` — a custom
                // WIDTH token and a custom COLOUR token, which both look like
                // `border-{value}` to tailwind-merge, so it filed them in one group
                // and kept only the last, emitting `border-width: 0px`. A typed
                // colour and a bare length are different groups; verified rendering
                // at 3px with the clay edge, not 0px.
                'border-[3px] border-[color:var(--clay-edge)]',
                SIZE[size],
                sheet ? 'rounded-t-[24px] sm:rounded-[24px]' : 'rounded-[24px]',
                isBottom && 'sm:mb-6',
                className,
                classNames?.base,
              )}
              onClick={(e) => e.stopPropagation()}
              // Set ON the panel, not inherited from `:root` — this subtree is
              // portalled to document.body, so anything scoped to the app wrapper
              // would not reach it.
              style={panelClay(isBottom)}
              {...(sheet
                ? {
                    animate: { y: 0 },
                    exit: { y: '100%' },
                    initial: { y: '100%' },
                    transition: { duration: 0.25, ease: [0.3, 0.6, 0.2, 1.2] },
                  }
                : {
                    animate: { opacity: 1, scale: 1 },
                    exit: { opacity: 0, scale: 0.95 },
                    initial: { opacity: 0, scale: 0.92 },
                    transition: { duration: 0.22, ease: [0.3, 0.6, 0.2, 1.2] },
                  })}
            >
              {/* ModalContent fills the height-capped card as a flex column; ModalBody
                  scrolls while ModalHeader/Footer stay pinned (see those components). */}
              {/* A Card inside a dialog is nested elevation, but `NestedInCard` only sees
                  CARD ancestors, so without this the card paints `--card-bg` on the
                  panel's own `--card-bg` at 1.000:1 and its boundary disappears. The
                  KNOWN LIMIT documented on that context in `Card/Card.tsx` names this
                  component as the place to close it. Light is a no-op (`--surface-1`
                  and `--surface-2` are the same value there); dark gains a 1.11:1 step. */}
              <NestedInCard.Provider value={true}>{children}</NestedInCard.Provider>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </ModalContext.Provider>
  );

  // Don't portal until mounted (SSR safety).
  if (!mounted) return null;

  // Portal target: explicit prop > document.body.
  const target: Element = portalContainer ?? document.body;

  return createPortal(content, target);
}

/* ----------------------- Sub-components ----------------------- */

/**
 * Note: HeroUI's <ModalContent> takes a render-prop child `(onClose) => ReactNode`
 * OR plain ReactNode. We support both.
 */
export interface ModalContentProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  children: React.ReactNode | ((onClose: () => void) => React.ReactNode);
}

export const ModalContent = React.forwardRef<HTMLDivElement, ModalContentProps>(function ModalContent(
  { children, className, ...rest },
  ref,
) {
  const ctx = React.useContext(ModalContext);
  const onClose = ctx?.onClose ?? (() => {});

  return (
    /*
     * Vertical padding only. The horizontal inset lives on the header/body/footer instead,
     * so their dividers run the full width of the card — a rule that stops 24px short of
     * both edges reads as a clipped line rather than a deliberate separator. It is also 4px
     * tighter than the `p-6` this replaced, which spent 48px of a 390px phone on margin.
     */
    <div ref={ref} className={cn('flex min-h-0 flex-col gap-3 py-5', className)} {...rest}>
      {typeof children === 'function' ? children(onClose) : children}
    </div>
  );
});

export const ModalHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function ModalHeader(
  { className, ...rest },
  ref,
) {
  // shrink-0 keeps the header pinned at the top while ModalBody scrolls. The rule beneath
  // it marks where the title ends and the scrolling body begins — without it a dialog whose
  // body is already scrolled reads as one undifferentiated column of text. `--line-soft` is
  // the divider token; the drawn ink outline would be far too loud inside a card.
  return (
    <div
      ref={ref}
      className={cn(
        'text-ink border-line-soft flex shrink-0 flex-col gap-1 border-b px-5 pb-3 text-[20px] font-black',
        className,
      )}
      {...rest}
    />
  );
});

export const ModalBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function ModalBody(
  { className, ...rest },
  ref,
) {
  // The scroll region: shrinks (min-h-0) and scrolls when the card hits its max height,
  // so the header/footer stay pinned and tall content (e.g. a lecture list) scrolls here.
  return (
    <div
      ref={ref}
      /*
       * `px-5` carries the card's horizontal inset (ModalContent no longer does — see there),
       * and it doubles as the room this scroll box needs: `overflow-y-auto` forces the other
       * axis to `auto` too, so a control flush against the inline edge would have its hard
       * offset shadow clipped, or raise a phantom horizontal scrollbar. Inputs, Radio and
       * Checkbox all draw one.
       *
       * `pt-4 pb-9` is the CLAY half of that same requirement, and it was missing. The
       * sentence above was written for the scrapbook's 4px diagonal shadow; clay casts far
       * further. Overflow clips at the PADDING box, so with no vertical padding at all every
       * clay child was sliced flush against this box's edges. Measured on a `<Card>`
       * (`depth: 8`, so `0 8px 0` lip + `0 10px 26.4px` glow):
       *
       *   bottom  needs 36.4px  had 0  ->  the solid 8px lip itself was cut
       *   top     needs 16.4px  had 0
       *   inline  needs 26.4px  had 20px
       *
       * Vertical is fixed here; the inline 6.4px is deliberately left. It falls in the blur's
       * tail — 6.4px short of a 26.4px radius is roughly 2 sigma out, under 1% effective alpha
       * — and closing it would mean moving the header, body and footer gutters together in six
       * apps to keep the dividers aligned, for something no screenshot shows.
       */
      className={cn('text-ink/75 flex min-h-0 flex-col gap-2 overflow-y-auto px-5 pt-4 pb-9 text-[14px]', className)}
      {...rest}
    />
  );
});

export const ModalFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function ModalFooter(
  { className, ...rest },
  ref,
) {
  // ONE ROW AT EVERY WIDTH. This used to stack below `sm:` because two `w-full` buttons in
  // a single row overflowed and the second was clipped off-screen. That
  // is fixed at the source now — Button's base class stopped forbidding flex shrink (see the
  // `min-w-fit` note there) — so the stack was buying nothing except a two-line footer on
  // exactly the screens with the least vertical room to spare. Two actions fit side by side
  // at 360px.
  //
  // The rule above it closes the pair with the header's: title, body, actions, each visibly
  // its own region.
  return (
    <div
      ref={ref}
      className={cn(
        'border-line-soft flex shrink-0 flex-row items-center justify-end gap-2 border-t px-5 pt-3',
        className,
      )}
      {...rest}
    />
  );
});

/**
 * HeroUI exposes `useDisclosure()` returning { isOpen, onOpen, onClose, onOpenChange }.
 * Lightweight reimplementation so call sites that import it don't break.
 */
export function useDisclosure(opts?: { defaultOpen?: boolean }) {
  const [isOpen, setIsOpen] = React.useState(Boolean(opts?.defaultOpen));
  const onOpen = React.useCallback(() => setIsOpen(true), []);
  const onClose = React.useCallback(() => setIsOpen(false), []);
  const onOpenChange = React.useCallback(
    (open?: boolean) => setIsOpen((prev) => (open === undefined ? !prev : open)),
    [],
  );

  return { isOpen, onOpen, onClose, onOpenChange };
}
