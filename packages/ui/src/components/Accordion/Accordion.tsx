import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import { cn } from '../../cn';
import { CLAY_FILL, CLAY_LABEL, clayVars } from '../clay';
import { HEROUI_COLOR_TEXT } from '../tokens';

/**
 * da-v2 Accordion / AccordionItem — drop-in for HeroUI's Accordion.
 *
 *   <Accordion variant selectionMode selectedKeys onSelectionChange itemClasses>
 *     <AccordionItem key title subtitle indicator startContent isDisabled>
 *       {children}
 *     </AccordionItem>
 *   </Accordion>
 *
 * Implementation:
 *  - State lives in Accordion. Each AccordionItem reads via context and registers
 *    using its `key` (passed through cloneElement as `__itemKey`).
 *  - Selection modes: single | multiple | none.
 *  - Expand/collapse uses motion.div with height 0 -> auto. Skipped when
 *    prefers-reduced-motion is set.
 *  - Indicator chevron uses CSS transform transition (not motion); 150ms.
 *  - Variants: light (hairline) | shadow (raised card per item) |
 *    bordered (group-wide frame) | splitted (raised card + 16px gap).
 *
 * TIER 2 — a raised SURFACE, not a pressable slab. `.clay-surface`, never
 * `.clay-btn`: the card does not travel, because what the user presses is the
 * trigger row inside it, and a whole card depressing under a header click would
 * claim the card itself is the button.
 *
 * The fill stays `var(--card-bg)` — already the right rung — and every clay
 * value is derived FROM it, so the panel cannot drift off the card colour.
 */

/** The card fill, and the clay values derived from it. One source, one lip. */
const CARD = 'var(--card-bg)';
const clayCard = (depth: number) =>
  ({ background: CARD, ...clayVars(CARD, { kind: 'surface', depth }) }) as React.CSSProperties;

/** A raised variant is one that paints its own card. `light` and `bordered` do not. */
const RAISED = new Set(['shadow', 'splitted']);

export type AccordionVariant = 'light' | 'shadow' | 'bordered' | 'splitted';
export type AccordionSelectionMode = 'single' | 'multiple' | 'none';
export type AccordionSelectionBehavior = 'toggle' | 'replace';

export interface AccordionItemClassNames {
  base?: string;
  heading?: string;
  trigger?: string;
  titleWrapper?: string;
  title?: string;
  subtitle?: string;
  startContent?: string;
  indicator?: string;
  content?: string;
}

export interface AccordionClassNames extends AccordionItemClassNames {
  // Same slots — provided per-item OR for the whole accordion.
}

interface AccordionContextValue {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  variant: AccordionVariant;
  isDisabled: boolean;
  isCompact: boolean;
  hideIndicator: boolean;
  showDivider: boolean;
  disableAnimation: boolean;
  disableIndicatorAnimation: boolean;
  itemClasses?: AccordionItemClassNames;
  totalItems: number;
}

const AccordionContext = React.createContext<AccordionContextValue | null>(null);

/* ============================================================
   <Accordion>
   ============================================================ */

export interface AccordionProps {
  children: React.ReactNode | ((item: unknown) => React.ReactNode);
  items?: Iterable<{ key?: string; id?: string; [k: string]: unknown }>;
  variant?: AccordionVariant;
  selectionMode?: AccordionSelectionMode;
  selectionBehavior?: AccordionSelectionBehavior;
  selectedKeys?: 'all' | Iterable<string>;
  defaultSelectedKeys?: 'all' | Iterable<string>;
  /** HeroUI compat — alias for defaultSelectedKeys at most call sites. */
  defaultExpandedKeys?: 'all' | Iterable<string>;
  onSelectionChange?: (keys: 'all' | Set<string>) => void;
  isCompact?: boolean;
  isDisabled?: boolean;
  hideIndicator?: boolean;
  showDivider?: boolean;
  fullWidth?: boolean;
  disableAnimation?: boolean;
  disableIndicatorAnimation?: boolean;
  /** Disable the seeded card tilt (shadow/splitted variants). Use for tall,
   *  expandable content cards where the rotation pushes the header off-screen
   *  (the tilt is around the card center, so a long expanded panel shifts its
   *  header sideways and clips against overflow boundaries).
   *  Left off, this follows the app's ScrapbookProvider; set either way here to
   *  override it for this accordion. */
  /**
   * Scrapbook-era seeded tilt. Accepted and ignored — clay has no rotation.
   * Kept so the six apps' call sites do not have to change.
   */
  disableTilt?: boolean;
  /** HeroUI compat — passthrough/stub. */
  motionProps?: Record<string, unknown>;
  classNames?: AccordionClassNames;
  itemClasses?: AccordionItemClassNames;
  className?: string;
  /** HeroUI compat — keyboard activation. */
  keyboardActivation?: 'automatic' | 'manual';
  dir?: 'rtl' | 'ltr';
}

export function Accordion(props: AccordionProps) {
  const {
    children,
    items,
    variant = 'light',
    selectionMode = 'single',
    selectionBehavior = 'toggle',
    selectedKeys: controlledKeys,
    defaultSelectedKeys,
    defaultExpandedKeys,
    onSelectionChange,
    isCompact = false,
    isDisabled = false,
    hideIndicator = false,
    showDivider = true,
    fullWidth = true,
    disableAnimation = false,
    disableIndicatorAnimation = false,
    disableTilt: _disableTilt,
    classNames,
    itemClasses,
    className,
  } = props;


  const isControlled = controlledKeys !== undefined;
  const initialDefault = defaultSelectedKeys ?? defaultExpandedKeys;
  const [internalKeys, setInternalKeys] = React.useState<'all' | Set<string>>(() => {
    if (initialDefault === 'all') return 'all';
    if (initialDefault) return new Set(Array.from(initialDefault, String));

    return new Set<string>();
  });

  const activeKeys = (() => {
    if (!isControlled) return internalKeys;
    if (controlledKeys === 'all') return 'all' as const;

    return new Set(Array.from(controlledKeys ?? [], String));
  })();

  const isOpen = React.useCallback(
    (key: string) => {
      if (activeKeys === 'all') return true;

      return activeKeys.has(key);
    },
    [activeKeys],
  );

  const updateKeys = React.useCallback(
    (next: 'all' | Set<string>) => {
      if (!isControlled) setInternalKeys(next);
      onSelectionChange?.(next);
    },
    [isControlled, onSelectionChange],
  );

  const toggle = React.useCallback(
    (key: string) => {
      if (selectionMode === 'none' || isDisabled) return;
      const current = activeKeys === 'all' ? new Set<string>(['__all__']) : new Set(activeKeys);
      if (selectionMode === 'single') {
        if (current.has(key)) {
          if (selectionBehavior === 'replace') return; // replace mode keeps it open
          updateKeys(new Set<string>());
        } else {
          updateKeys(new Set<string>([key]));
        }

        return;
      }
      // multiple
      if (current.has(key)) current.delete(key);
      else current.add(key);
      // We collapsed any "all" sentinel; rebuild a clean set.
      current.delete('__all__');
      updateKeys(current);
    },
    [activeKeys, isDisabled, selectionBehavior, selectionMode, updateKeys],
  );

  /* Render children (children may be a render-prop when items provided). */
  const renderedChildren: React.ReactNode = React.useMemo(() => {
    if (items && typeof children === 'function') {
      const arr: React.ReactNode[] = [];
      const itemsArr = Array.isArray(items)
        ? (items as Array<{ key?: string; id?: string }>)
        : Array.from(items as Iterable<{ key?: string; id?: string }>);
      itemsArr.forEach((item) => {
        const k = String(item.key ?? item.id ?? '');
        const node = (children as (it: typeof item) => React.ReactNode)(item);
        if (React.isValidElement(node)) {
          arr.push(
            React.cloneElement(node as React.ReactElement, { key: k, __itemKey: k } as Partial<AccordionItemProps>),
          );
        } else {
          arr.push(node);
        }
      });

      return arr;
    }

    return React.Children.map(children as React.ReactNode, (child) => {
      if (React.isValidElement(child)) {
        const k = String((child.key ?? '') as string).replace(/^\.\$/, '');

        return React.cloneElement(child as React.ReactElement, { __itemKey: k } as Partial<AccordionItemProps>);
      }

      return child;
    });
  }, [items, children]);

  const totalItems = React.Children.count(renderedChildren);

  const ctxValue: AccordionContextValue = {
    isOpen,
    toggle,
    variant,
    isDisabled,
    isCompact,
    hideIndicator,
    showDivider,
    disableAnimation,
    disableIndicatorAnimation,
    itemClasses: { ...itemClasses, ...classNames },
    totalItems,
  };

  return (
    <AccordionContext.Provider value={ctxValue}>
      <div
        className={cn(
          'flex w-full flex-col',
          variant === 'splitted' && 'gap-4',
          variant === 'bordered' &&
            'clay-surface divide-[color:var(--clay-edge)] overflow-hidden rounded-[20px] border-[3px] border-[color:var(--clay-edge)] divide-y-[2px]',
          fullWidth ? 'w-full' : 'w-fit',
          className,
        )}
        style={variant === 'bordered' ? clayCard(8) : undefined}
      >
        {renderedChildren}
      </div>
    </AccordionContext.Provider>
  );
}

Accordion.displayName = 'Accordion';

/* ============================================================
   <AccordionItem>
   ============================================================ */

export type AccordionIndicator = React.ReactNode | ((p: { isOpen: boolean; isDisabled: boolean }) => React.ReactNode);

export interface AccordionItemProps {
  /** Provide via React `key`. Mirrored at runtime via __itemKey. */
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  indicator?: AccordionIndicator;
  startContent?: React.ReactNode;
  isDisabled?: boolean;
  hideIndicator?: boolean;
  keepContentMounted?: boolean;
  classNames?: AccordionItemClassNames;
  className?: string;
  children?: React.ReactNode;
  /** Internal — supplied by <Accordion>. */
  __itemKey?: string;
  /** HeroUI compat — kept for parity. */
  'aria-label'?: string;
  /** HeroUI compat — kept for parity. */
  textValue?: string;
}

export function AccordionItem(props: AccordionItemProps) {
  const ctx = React.useContext(AccordionContext);
  const reduceMotion = useReducedMotion();
  const {
    title,
    subtitle,
    indicator,
    startContent,
    isDisabled,
    hideIndicator: itemHideIndicator,
    keepContentMounted,
    classNames,
    className,
    children,
    __itemKey,
    'aria-label': ariaLabel,
  } = props;

  if (!ctx) {
    if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn('AccordionItem must be a descendant of Accordion.');
    }

    return null;
  }

  const key = String(__itemKey ?? '');
  const open = ctx.isOpen(key);
  const disabled = Boolean(isDisabled || ctx.isDisabled);
  const showIndicator = !(itemHideIndicator || ctx.hideIndicator);


  const headerId = `${key}-header`;
  const panelId = `${key}-panel`;

  const slot = ctx.itemClasses ?? {};

  /* Trigger row visuals per variant */
  const variantBase = (() => {
    switch (ctx.variant) {
      case 'light':
        return cn(
          'relative bg-transparent',
          // A divider is not a rim: clay's 3px belongs to an object's own edge,
          // and at that weight an internal rule between rows reads as a bar.
          ctx.showDivider && 'border-b-[2px] border-[color:var(--clay-edge)]',
          // The open marker: a brand strip down the leading edge, replacing the
          // scrapbook's citrine. Brand, not citrine, because citrine is a
          // scrapbook constant and dies with it.
          open &&
            'before:bg-[color:var(--clay-mark)] before:absolute before:start-0 before:top-0 before:h-full before:w-[4px]',
        );
      case 'shadow':
      case 'splitted':
        return cn('clay-surface relative rounded-[18px] border-[3px] border-[color:var(--clay-edge)]');
      case 'bordered':
        return 'relative bg-transparent';
    }
  })();

  /* Indicator (chevron) */
  const renderIndicator = () => {
    if (!showIndicator) return null;
    if (typeof indicator === 'function') {
      return (
        <span className={cn('flex h-6 w-6 items-center justify-center', classNames?.indicator, slot.indicator)}>
          {indicator({ isOpen: open, isDisabled: disabled })}
        </span>
      );
    }
    if (indicator) {
      return (
        <span
          className={cn(
            'flex h-6 w-6 items-center justify-center transition-transform duration-150',
            open && !ctx.disableIndicatorAnimation && 'rotate-90',
            classNames?.indicator,
            slot.indicator,
          )}
        >
          {indicator}
        </span>
      );
    }

    return (
      <span
        aria-hidden
        className={cn(
          'text-ink inline-flex h-6 w-6 items-center justify-center',
          'transition-transform duration-150',
          open && !ctx.disableIndicatorAnimation && 'rotate-90',
          classNames?.indicator,
          slot.indicator,
        )}
      >
        <svg fill='none' height='14' stroke='currentColor' strokeWidth='2.5' viewBox='0 0 24 24' width='14'>
          <path d='M9 18l6-6-6-6' strokeLinecap='round' strokeLinejoin='round' />
        </svg>
      </span>
    );
  };

  const triggerVerticalPad = ctx.isCompact ? 'py-2' : 'py-4';
  const triggerHorizontalPad = ctx.variant === 'light' || ctx.variant === 'bordered' ? 'px-3' : 'px-4';

  return (
    <div
      className={cn(variantBase, className, classNames?.base, slot.base)}
      style={{
        // `--clay-mark` is the open-state strip on `light`, which paints no card
        // of its own and so has no clay vars from the branch below.
        //
        // It reads `HEROUI_COLOR_TEXT`, NOT `CLAY_FILL`. A fill token is not a
        // mark token: the raw brand is meant to be painted UNDER a label, and on
        // a dark card the strip measured 2.49:1 — below the 3:1 an indicator
        // owes, since "which item is open" is carried here. `--p-text` is the
        // brand lightened for exactly this in dark and identical in light.
        ['--clay-mark' as string]: HEROUI_COLOR_TEXT.primary,
        ...(RAISED.has(ctx.variant) ? clayCard(6) : { '--clay-edge': clayCard(6)['--clay-edge' as never] }),
      } as React.CSSProperties}
    >
      <h3 className={cn('m-0 p-0', classNames?.heading, slot.heading)} id={headerId}>
        <button
          aria-controls={panelId}
          aria-disabled={disabled}
          aria-expanded={open}
          aria-label={ariaLabel}
          className={cn(
            'group flex w-full items-center gap-3 text-start outline-none',
            triggerVerticalPad,
            triggerHorizontalPad,
            'transition-colors duration-150',
            disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-ink/5 cursor-pointer',
            // INSET indicator. The trigger fills its item edge-to-edge and the item is
            // `overflow-hidden`, which clips to the PADDING box — an outward 3px ring sat
            // exactly on the item's 3px border and was clipped away on every side
            // (measured: trigger 1641.2-1783.8 inside a padding box starting at 1641.2).
            // A negative offset draws the indicator inside the trigger, where nothing can
            // clip it, and `outline` cannot collide with a box-shadow the way a ring does.
            'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-[-3px]',
            'focus-visible:outline-[color:var(--clay-mark)]',
            classNames?.trigger,
            slot.trigger,
          )}
          disabled={disabled}
          onClick={() => !disabled && ctx.toggle(key)}
          type='button'
        >
          {startContent ? (
            <span
              className={cn(
                'clay-surface flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border-[3px] border-[color:var(--clay-edge)]',
                classNames?.startContent,
                slot.startContent,
              )}
              style={{
                background: CLAY_FILL.primary,
                color: CLAY_LABEL.primary,
                ...clayVars(CLAY_FILL.primary, { kind: 'brand', depth: 3 }),
              }}
            >
              {startContent}
            </span>
          ) : null}
          <span className={cn('flex flex-1 flex-col gap-0.5 text-start', classNames?.titleWrapper, slot.titleWrapper)}>
            {title ? (
              <span className={cn('text-ink text-[15px] font-extrabold', classNames?.title, slot.title)}>{title}</span>
            ) : null}
            {subtitle ? (
              <span
                className={cn('font-hand text-ink/70 text-[15px] leading-tight', classNames?.subtitle, slot.subtitle)}
              >
                {subtitle}
              </span>
            ) : null}
          </span>
          {renderIndicator()}
        </button>
      </h3>

      <AnimatePresence initial={false}>
        {open || keepContentMounted ? (
          <motion.div
            animate={
              ctx.disableAnimation || reduceMotion
                ? { height: open ? 'auto' : 0, opacity: open ? 1 : 0 }
                : { height: open ? 'auto' : 0, opacity: open ? 1 : 0 }
            }
            aria-labelledby={headerId}
            className='overflow-hidden'
            exit={ctx.disableAnimation || reduceMotion ? undefined : { height: 0, opacity: 0 }}
            id={panelId}
            initial={ctx.disableAnimation || reduceMotion ? false : { height: 0, opacity: 0 }}
            role='region'
            style={open ? undefined : { display: keepContentMounted && !open ? 'none' : undefined }}
            transition={{ duration: 0.22, ease: [0.3, 0.6, 0.2, 1.2] }}
          >
            <div
              className={cn(
                'text-ink/85 px-4 pb-4 pt-1 text-[14px]',
                // The paper-grain `sk-dots` and its radial-gradient are gone with
                // the scrapbook; the open rule matches the trigger's strip.
                ctx.variant === 'light' && open && 'border-s-[4px] border-[color:var(--clay-mark)] ps-3',
                classNames?.content,
                slot.content,
              )}
            >
              {children}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

AccordionItem.displayName = 'AccordionItem';
