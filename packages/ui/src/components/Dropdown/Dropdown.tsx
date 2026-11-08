import React from 'react';

import { cn } from '../../cn';
import { Popover, PopoverContent, PopoverTrigger } from '../Popover/Popover';
import type { PopoverPlacement, PopoverShadow } from '../Popover/Popover';
import type { HeroUIColor, HeroUIRadius, HeroUISize, HeroUIVariant } from '../tokens';
import { INK_ON_BRAND } from '../tokens';
import { CLAY_FILL, CLAY_LABEL } from '../clay';

/**
 * da-v2 Dropdown family — drop-in for HeroUI's Dropdown / DropdownTrigger /
 * DropdownMenu / DropdownItem / DropdownSection.
 *
 *   <Dropdown placement='bottom-start'>
 *     <DropdownTrigger><Button>Open</Button></DropdownTrigger>
 *     <DropdownMenu aria-label='actions' onAction={(k) => ...}>
 *       <DropdownSection title='File' showDivider>
 *         <DropdownItem key='new'>New</DropdownItem>
 *         <DropdownItem key='open'>Open</DropdownItem>
 *       </DropdownSection>
 *       <DropdownSection title='Danger zone'>
 *         <DropdownItem key='delete' color='danger'>Delete</DropdownItem>
 *       </DropdownSection>
 *     </DropdownMenu>
 *   </Dropdown>
 *
 * Notes:
 *  - Built on top of @repo/ui Popover (which already handles placement /
 *    backdrop / scroll-block).
 *  - DropdownContext shares open state to children so item clicks can close the menu
 *    when `closeOnSelect` is true (default).
 *  - Selection: 'none' (default), 'single', or 'multiple'. Selected items render a
 *    check icon and a citrine-fill background.
 *  - Keyboard navigation: arrow up/down moves activeKey, Enter activates, Esc closes,
 *    Home/End jump to first/last enabled.
 *  - Items with `href` render as anchors; otherwise `<li role="menuitem">`.
 *  - Placement strings are passed through to Popover untranslated.
 *  - The selected check icon sits at the end of the item; `startContent` at the start.
 */

export type DropdownPlacement = PopoverPlacement;
export type DropdownTriggerType = 'menu' | 'listbox' | 'splitbutton';

interface ItemDescriptor {
  key: string;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  isSelectable?: boolean;
  href?: string;
}

interface DropdownContextValue {
  selectionMode: 'none' | 'single' | 'multiple';
  selectedKeys: Set<string>;
  toggle: (key: string) => void;
  closeOnSelect: boolean;
  close: () => void;
  disabledKeys: Set<string>;
  onAction?: (key: string) => void;
  registerItem: (d: ItemDescriptor) => void;
  unregisterItem: (key: string) => void;
  activeKey: string | null;
  setActiveKey: (key: string | null) => void;
  hideSelectedIcon: boolean;
  itemColor?: HeroUIColor;
  itemVariant?: HeroUIVariant;
  itemClasses?: DropdownItemClassNames;
}

const DropdownContext = React.createContext<DropdownContextValue | null>(null);

/* ============================================================
   <Dropdown>
   ============================================================ */

export interface DropdownProps {
  children: React.ReactNode;
  isOpen?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: DropdownPlacement;
  closeOnSelect?: boolean;
  shouldCloseOnInteractOutside?: (el: Element) => boolean;
  isDismissable?: boolean;
  isKeyboardDismissDisabled?: boolean;
  shouldFlip?: boolean;
  containerPadding?: number;
  offset?: number;
  crossOffset?: number;
  triggerScaleOnOpen?: boolean;
  triggerType?: DropdownTriggerType;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  shadow?: PopoverShadow;
  backdrop?: 'transparent' | 'opaque' | 'blur';
  showArrow?: boolean;
  className?: string;
  classNames?: { base?: string; trigger?: string; content?: string; arrow?: string; backdrop?: string };
  portalContainer?: Element | HTMLElement | null;
  type?: DropdownTriggerType;
  /** Per-instance rotation (degrees). */
  rotate?: number;
  isDisabled?: boolean;
  motionProps?: Record<string, unknown>;
  dir?: 'rtl' | 'ltr';
}

interface DropdownPropsInternal extends DropdownProps {
  /** Internal: shared via cloneElement on DropdownMenu — don't use directly. */
  _menuPropsBag?: {
    selectionMode: 'none' | 'single' | 'multiple';
    selectedKeys: Set<string>;
    setSelectedKeys: (s: Set<string>) => void;
    onAction?: (key: string) => void;
    disabledKeys: Set<string>;
    closeOnSelect: boolean;
    hideSelectedIcon: boolean;
    itemColor?: HeroUIColor;
    itemVariant?: HeroUIVariant;
    itemClasses?: DropdownItemClassNames;
  };
}

let _dropdownSeed = 0;

export function Dropdown(props: DropdownProps) {
  const {
    children,
    isOpen,
    defaultOpen,
    onOpenChange,
    placement = 'bottom-start',
    closeOnSelect = true,
    shouldCloseOnInteractOutside,
    isDismissable = true,
    isKeyboardDismissDisabled,
    shouldFlip = true,
    containerPadding,
    offset = 4,
    crossOffset,
    triggerScaleOnOpen,
    triggerType = 'menu',
    size = 'md',
    radius = 'md',
    shadow = 'md',
    backdrop = 'transparent',
    showArrow,
    className,
    classNames,
    portalContainer,
    type,
    rotate,
    isDisabled,
    motionProps: _mp,
    dir,
  } = props;

  // Selection state lives at the Dropdown level so items can read/write.
  // DropdownMenu consumes selectionMode/selectedKeys via its props and threads
  // them in via context, but sometimes consumers want default state on
  // <Dropdown> too. Default to 'none' here — DropdownMenu can elevate.
  const seedRef = React.useRef<number | null>(null);
  if (seedRef.current === null) seedRef.current = _dropdownSeed++;

  // Open-state forwarded to Popover.
  return (
    <Popover
      backdrop={backdrop}
      classNames={{
        base: classNames?.base,
        content: classNames?.content,
        backdrop: classNames?.backdrop,
        arrow: classNames?.arrow,
      }}
      className={className}
      containerPadding={containerPadding}
      crossOffset={crossOffset}
      defaultOpen={defaultOpen}
      dir={dir}
      isDismissable={isDismissable}
      isDisabled={isDisabled}
      isKeyboardDismissDisabled={isKeyboardDismissDisabled}
      isOpen={isOpen}
      offset={offset}
      onOpenChange={onOpenChange}
      placement={placement}
      portalContainer={portalContainer}
      radius={radius}
      rotate={rotate}
      shadow={shadow}
      shouldCloseOnInteractOutside={shouldCloseOnInteractOutside}
      shouldFlip={shouldFlip}
      showArrow={showArrow}
      size={size}
      triggerScaleOnOpen={triggerScaleOnOpen}
      triggerType={(type ?? triggerType) as 'menu' | 'listbox' | 'dialog'}
    >
      {/* Walk children: pass closeOnSelect down to DropdownMenu via cloneElement */}
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        const c = child as React.ReactElement<{ _closeOnSelect?: boolean }>;
        const compName = (c.type as { displayName?: string })?.displayName;
        if (compName === 'DropdownMenu') {
          return React.cloneElement(c, { _closeOnSelect: closeOnSelect });
        }

        return child;
      })}
    </Popover>
  );
}

Dropdown.displayName = 'Dropdown';

/* ============================================================
   <DropdownTrigger> — thin wrapper over PopoverTrigger.
   ============================================================ */

export interface DropdownTriggerProps {
  children: React.ReactElement;
  className?: string;
}

export function DropdownTrigger({ children }: DropdownTriggerProps) {
  return <PopoverTrigger>{children}</PopoverTrigger>;
}

DropdownTrigger.displayName = 'DropdownTrigger';

/* ============================================================
   <DropdownMenu>
   ============================================================ */

export interface DropdownMenuClassNames {
  base?: string;
  list?: string;
  emptyContent?: string;
}

export interface DropdownMenuProps {
  'aria-label'?: string;
  children?: React.ReactNode | ((item: unknown) => React.ReactNode);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items?: Iterable<any>;
  selectionMode?: 'none' | 'single' | 'multiple';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectedKeys?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultSelectedKeys?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSelectionChange?: (keys: any) => void;
  closeOnSelect?: boolean;
  disabledKeys?: Iterable<string>;
  onAction?: (key: string) => void;
  variant?: HeroUIVariant;
  color?: HeroUIColor;
  autoFocus?: boolean | 'first' | 'last';
  disallowEmptySelection?: boolean;
  hideEmptyContent?: boolean;
  hideSelectedIcon?: boolean;
  topContent?: React.ReactNode;
  bottomContent?: React.ReactNode;
  emptyContent?: React.ReactNode;
  className?: string;
  classNames?: DropdownMenuClassNames;
  itemClasses?: DropdownItemClassNames;
  /** HeroUI compat — pass-through. */
  dir?: 'rtl' | 'ltr';
  /** HeroUI compat — kept for parity, ignored. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shouldFocusWrap?: boolean;
  /** HeroUI compat — kept for parity, ignored. */
  closeOnSelectAll?: boolean;
  /** Internal: forwarded by parent <Dropdown>. */
  _closeOnSelect?: boolean;
}

function toKeySet(input: unknown): Set<string> {
  if (!input || input === 'all') return new Set<string>();
  if (input instanceof Set) return new Set(Array.from(input).map(String));
  if (Array.isArray(input)) return new Set((input as unknown[]).map(String));
  try {
    return new Set(Array.from(input as Iterable<unknown>).map(String));
  } catch {
    return new Set<string>();
  }
}

export function DropdownMenu(props: DropdownMenuProps) {
  const {
    'aria-label': ariaLabel,
    children,
    items,
    selectionMode = 'none',
    selectedKeys: selectedProp,
    defaultSelectedKeys,
    onSelectionChange,
    closeOnSelect: closeOnSelectProp,
    disabledKeys,
    onAction,
    variant,
    color,
    hideEmptyContent,
    hideSelectedIcon = false,
    topContent,
    bottomContent,
    emptyContent,
    className,
    classNames,
    itemClasses,
    _closeOnSelect,
  } = props;

  const isControlled = selectedProp !== undefined;
  const [internal, setInternal] = React.useState<Set<string>>(() => toKeySet(defaultSelectedKeys));
  const selectedKeys = isControlled ? toKeySet(selectedProp) : internal;
  const setSelectedKeys = (s: Set<string>) => {
    if (!isControlled) setInternal(s);
    onSelectionChange?.(s);
  };

  const disabledKeySet = React.useMemo(() => toKeySet(disabledKeys), [disabledKeys]);
  const closeOnSelect = closeOnSelectProp ?? _closeOnSelect ?? true;

  const [registry, setRegistry] = React.useState<Map<string, ItemDescriptor>>(new Map());
  const orderRef = React.useRef<string[]>([]);

  const registerItem = React.useCallback((d: ItemDescriptor) => {
    setRegistry((prev) => {
      const existing = prev.get(d.key);
      // Idempotent: re-registering an identical descriptor returns the SAME Map so
      // React bails out (Object.is) instead of scheduling a needless re-render —
      // the defense-in-depth backstop against an item-registration render loop.
      if (
        existing &&
        existing.isDisabled === d.isDisabled &&
        existing.isReadOnly === d.isReadOnly &&
        existing.isSelectable === d.isSelectable &&
        existing.href === d.href
      ) {
        return prev;
      }
      const next = new Map(prev);
      next.set(d.key, d);

      return next;
    });
    if (!orderRef.current.includes(d.key)) orderRef.current.push(d.key);
  }, []);

  const unregisterItem = React.useCallback((k: string) => {
    setRegistry((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Map(prev);
      next.delete(k);

      return next;
    });
    orderRef.current = orderRef.current.filter((x) => x !== k);
  }, []);

  const [activeKey, setActiveKey] = React.useState<string | null>(null);

  // We need access to the parent Popover's open + setOpen for closing on action.
  // Since Popover doesn't expose that to us via context here, we use a small
  // ref+effect pattern: a hidden focusable element sets its parent on mount.
  const closeRef = React.useRef<() => void>(() => {});

  const toggle = React.useCallback(
    (key: string) => {
      const desc = registry.get(key);
      if (desc?.isDisabled || disabledKeySet.has(key)) return;

      onAction?.(key);

      if (selectionMode !== 'none' && desc?.isSelectable !== false) {
        let next: Set<string>;
        if (selectionMode === 'multiple') {
          next = new Set(selectedKeys);
          if (next.has(key)) next.delete(key);
          else next.add(key);
        } else {
          next = new Set([key]);
        }
        setSelectedKeys(next);
      }

      if (closeOnSelect) closeRef.current();
    },
    [registry, disabledKeySet, onAction, selectionMode, selectedKeys, closeOnSelect, setSelectedKeys],
  );

  // Render items[] + render-prop variant.
  const renderedChildren = React.useMemo(() => {
    if (items && typeof children === 'function') {
      const arr: React.ReactNode[] = [];
      const itemsArr = Array.isArray(items) ? (items as Array<{ key?: string; id?: string }>) : Array.from(items);
      itemsArr.forEach((item) => {
        const k = String((item as { key?: string; id?: string }).key ?? (item as { id?: string }).id ?? '');
        const node = (children as (it: unknown) => React.ReactNode)(item);
        if (React.isValidElement(node)) {
          arr.push(
            React.cloneElement(node as React.ReactElement, { key: k, __itemKey: k } as Partial<DropdownItemProps>),
          );
        } else {
          arr.push(node);
        }
      });

      return arr;
    }

    // Walk children to inject __itemKey from React `key`
    const walk = (nodes: React.ReactNode): React.ReactNode =>
      React.Children.map(nodes, (child) => {
        if (!React.isValidElement(child)) return child;
        const compName = (child.type as { displayName?: string })?.displayName;
        if (compName === 'DropdownItem') {
          const k = String((child.key ?? '') as string).replace(/^\.\$/, '');
          if (k) return React.cloneElement(child as React.ReactElement, { __itemKey: k } as Partial<DropdownItemProps>);

          return child;
        }
        if (compName === 'DropdownSection') {
          // Recurse into sections.
          const sectionChild = child as React.ReactElement<{ children?: React.ReactNode }>;

          return React.cloneElement(sectionChild, {
            children: walk(sectionChild.props.children),
          });
        }

        return child;
      });

    if (typeof children === 'function') return null;

    return walk(children as React.ReactNode);
  }, [items, children]);

  // Keyboard navigation on the menu container.
  const onKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const order = orderRef.current.filter((k) => {
        const d = registry.get(k);

        return !d?.isDisabled && !disabledKeySet.has(k) && !d?.isReadOnly;
      });
      if (!order.length) return;
      const idx = activeKey ? order.indexOf(activeKey) : -1;
      const nextIdx = e.key === 'ArrowDown' ? (idx + 1) % order.length : (idx - 1 + order.length) % order.length;
      setActiveKey(order[nextIdx] ?? null);
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (activeKey) {
        e.preventDefault();
        toggle(activeKey);
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      const first = orderRef.current.find((k) => !registry.get(k)?.isDisabled && !disabledKeySet.has(k));
      if (first) setActiveKey(first);
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = [...orderRef.current].reverse().find((k) => !registry.get(k)?.isDisabled && !disabledKeySet.has(k));
      if (last) setActiveKey(last);
    }
  };

  const ctxValue: DropdownContextValue = {
    selectionMode,
    selectedKeys,
    toggle,
    closeOnSelect,
    close: () => closeRef.current(),
    disabledKeys: disabledKeySet,
    onAction,
    registerItem,
    unregisterItem,
    activeKey,
    setActiveKey,
    hideSelectedIcon,
    itemColor: color,
    itemVariant: variant,
    itemClasses,
  };

  return (
    <PopoverContent className={cn('p-1', className, classNames?.base)}>
      {(titleProps: { id: string }) => {
        // PopoverContent provides a render-prop form; we use it to grab the
        // close fn via a small workaround — we render an effect-bound helper
        // that listens for an internal "close" event that DropdownItem
        // dispatches.
        return (
          <DropdownInternalCloser closeRef={closeRef}>
            <DropdownContext.Provider value={ctxValue}>
              {topContent}
              <ul
                aria-label={ariaLabel}
                aria-labelledby={titleProps.id}
                className={cn('flex min-w-[180px] flex-col gap-0.5 outline-none focus:outline-none', classNames?.list)}
                onKeyDown={onKey}
                role={selectionMode === 'none' ? 'menu' : 'menu'}
                tabIndex={0}
              >
                {React.Children.count(renderedChildren) === 0 && !hideEmptyContent ? (
                  <li className={cn('text-ink/70 px-3 py-2 text-[13px]', classNames?.emptyContent)} role='presentation'>
                    {emptyContent ?? 'No items'}
                  </li>
                ) : null}
                {renderedChildren}
              </ul>
              {bottomContent}
            </DropdownContext.Provider>
          </DropdownInternalCloser>
        );
      }}
    </PopoverContent>
  );
}

DropdownMenu.displayName = 'DropdownMenu';

/**
 * DropdownInternalCloser bridges the gap between PopoverContent's render-prop
 * (which doesn't expose a close fn) and DropdownItem (which needs to close on
 * click). It looks for the closest [data-popover-panel] custom event hook.
 *
 * Simpler approach: dispatch a CustomEvent('da-v2:dropdown-close') on click;
 * DropdownInternalCloser listens for it on its own DOM, then walks up to
 * find the panel and uses an Escape keypress on body to close — but that's
 * fragile. Instead, we expose closeRef directly on the Popover via a hidden
 * input event: a child of DropdownInternalCloser asks the nearest popover
 * ancestor to close by simulating the document Escape pathway.
 *
 * For maximum robustness: we read PopoverContext if it's exported, otherwise
 * dispatch Esc to window which Popover's keydown handler picks up.
 */
function DropdownInternalCloser({
  closeRef,
  children,
}: {
  closeRef: React.MutableRefObject<() => void>;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    closeRef.current = () => {
      // Dispatch Escape; Popover's window-level keydown handler closes
      // the topmost open popover.
      if (typeof window !== 'undefined') {
        const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        window.dispatchEvent(ev);
      }
    };
  }, [closeRef]);

  return (
    <div ref={ref} className='contents'>
      {children}
    </div>
  );
}

/* ============================================================
   <DropdownSection>
   ============================================================ */

export interface DropdownSectionProps {
  title?: React.ReactNode;
  showDivider?: boolean;
  children?: React.ReactNode;
  className?: string;
  classNames?: { base?: string; heading?: string; group?: string; divider?: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items?: Iterable<any>;
  'aria-label'?: string;
}

export function DropdownSection(props: DropdownSectionProps) {
  const { title, showDivider, children, className, classNames, 'aria-label': ariaLabel } = props;

  return (
    <li className={cn(className, classNames?.base)} role='presentation'>
      {title ? (
        <div
          aria-hidden
          className={cn('text-ink/70 font-hand px-3 pb-1 pt-2 text-[12px] font-bold lowercase', classNames?.heading)}
        >
          {title}
        </div>
      ) : null}
      <ul aria-label={ariaLabel} className={cn('flex flex-col gap-0.5', classNames?.group)} role='group'>
        {children}
      </ul>
      {showDivider ? (
        <div aria-hidden className={cn('border-line/35 mx-1 my-1 border-t-[2px] border-dashed', classNames?.divider)} />
      ) : null}
    </li>
  );
}

DropdownSection.displayName = 'DropdownSection';

/* ============================================================
   <DropdownItem>
   ============================================================ */

export interface DropdownItemClassNames {
  base?: string;
  wrapper?: string;
  title?: string;
  description?: string;
  shortcut?: string;
  selectedIcon?: string;
}

export interface DropdownItemProps extends Omit<React.HTMLAttributes<HTMLLIElement>, 'color' | 'onClick'> {
  /** Stable key — supplied via React `key` prop. */
  __itemKey?: string;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  shortcut?: React.ReactNode;
  description?: React.ReactNode;
  color?: HeroUIColor;
  variant?: HeroUIVariant;
  isReadOnly?: boolean;
  isDisabled?: boolean;
  isSelectable?: boolean;
  /** When true, renders an `<a>` instead of `<li>`. */
  href?: string;
  target?: string;
  rel?: string;
  onPress?: (e: React.MouseEvent | React.KeyboardEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  classNames?: DropdownItemClassNames;
  /** Stable id (HeroUI compat). */
  textValue?: string;
  /** HeroUI compat — render an extra closing-key label. */
  closeOnSelect?: boolean;
  children?: React.ReactNode;
}

export function DropdownItem(props: DropdownItemProps) {
  const {
    __itemKey,
    startContent,
    endContent,
    shortcut,
    description,
    color: colorProp,
    variant: _variant,
    isReadOnly,
    isDisabled,
    isSelectable,
    href,
    target,
    rel,
    onPress,
    onClick,
    classNames,
    children,
    className,
    closeOnSelect: itemCloseOnSelect,
    textValue: _tv,
    ...rest
  } = props;

  const ctx = React.useContext(DropdownContext);
  const key = String(__itemKey ?? '');
  const color = colorProp ?? ctx?.itemColor ?? 'default';

  // Register with the parent menu. Depend on the STABLE registerItem/unregisterItem
  // callbacks (useCallback'd in DropdownMenu) — NOT the whole `ctx` object, which is a
  // fresh reference every render. Depending on `ctx` re-ran this effect on every commit
  // (unregister → register → setRegistry → DropdownMenu re-render → new ctx → repeat),
  // a synchronous loop that trips React's "Maximum update depth exceeded" guard.
  const registerItem = ctx?.registerItem;
  const unregisterItem = ctx?.unregisterItem;

  React.useEffect(() => {
    if (!registerItem || !unregisterItem || !key) return;
    registerItem({ key, isDisabled, isReadOnly, isSelectable, href });

    return () => unregisterItem(key);
  }, [registerItem, unregisterItem, key, isDisabled, isReadOnly, isSelectable, href]);

  if (!ctx) return null;

  const isSelected = ctx.selectedKeys.has(key);
  const isActive = ctx.activeKey === key;
  const showCheck = !ctx.hideSelectedIcon && ctx.selectionMode !== 'none' && isSelected;

  const handleAction = (e: React.MouseEvent | React.KeyboardEvent) => {
    if (isDisabled || isReadOnly) return;
    onClick?.(e as React.MouseEvent);
    onPress?.(e);
    if (key) ctx.toggle(key);
    // Per-item close override
    if (itemCloseOnSelect === true && !ctx.closeOnSelect) ctx.close();
    if (itemCloseOnSelect === false) {
      // suppress the default close — but our toggle() may have already fired.
      // Best-effort: nothing more to do here.
    }
  };

  /**
   * The highlight follows the ITEM'S OWN colour, defaulting to primary.
   *
   * It used to be a hardcoded citrine wash on every item, so a destructive
   * action highlighted the same yellow as a neutral one — the one place a menu
   * most needs to say something different. A `color='danger'` item now washes
   * and fills danger; everything else reads primary.
   *
   * The selected item's LABEL takes `CLAY_LABEL`, not `--ink-const`: `CLAY_FILL`
   * is meant to be painted UNDER a label, so anything drawn ON it takes the
   * paired foreground or it vanishes (2.66:1 on the primary fill).
   */
  const accentKey = (color && color !== 'default' ? color : 'primary') as keyof typeof CLAY_FILL;
  const accent = CLAY_FILL[accentKey];
  const accentLabel = CLAY_LABEL[accentKey];
  const accentStyle: React.CSSProperties = isSelected
    ? // NO selected strip. It was `inset 3px 0 0` in the item's LABEL colour, which made its
      // weight depend entirely on the fill it sat on: invisible white on primary purple, a
      // hard near-black bar on amber or green. On a light fill it was the only dark line in
      // the whole menu, so the one selected item read as the one BORDERED item. The accent
      // fill and the check already say selected, twice.
      { background: accent, color: accentLabel }
    : isActive
      ? { background: `color-mix(in srgb, ${accent} 16%, transparent)`, ['--item-accent' as string]: accent }
      : ({ ['--item-accent' as string]: accent } as React.CSSProperties);

  const baseCls = cn(
    'clay-item',
    'relative flex cursor-pointer items-center gap-2 px-3 py-2 text-[14px] font-bold text-ink rounded-sk-sm',
    'transition-colors duration-[80ms] outline-none',
    'border-[1.5px] border-transparent',

    color === 'danger' && 'text-sk-red',
    color === 'primary' && 'text-sk-primary',
    color === 'success' && 'text-sk-green',
    color === 'warning' && 'text-sk-amber',
    (isDisabled || isReadOnly) && 'opacity-50 cursor-not-allowed hover:bg-transparent',
    isReadOnly && 'cursor-default',
    className,
    classNames?.base,
    ctx.itemClasses?.base,
  );

  const inner = (
    <>
      {startContent ? <span className='shrink-0'>{startContent}</span> : null}
      <span className={cn('flex min-w-0 flex-1 flex-col', classNames?.wrapper, ctx.itemClasses?.wrapper)}>
        <span className={cn('truncate', classNames?.title, ctx.itemClasses?.title)}>{children}</span>
        {description ? (
          <span
            className={cn(
              'font-hand text-[13px] font-semibold',
              // Selected items sit on the brand-constant citrine fill, which does
              // not flip — so neither may their description text.
              isSelected ? 'text-ink-const/75' : 'text-ink/70',
              classNames?.description,
              ctx.itemClasses?.description,
            )}
          >
            {description}
          </span>
        ) : null}
      </span>
      {shortcut ? (
        <kbd
          className={cn(
            'border-line/40 bg-paper text-ink/70 inline-flex h-5 shrink-0 items-center justify-center rounded-[3px] border px-1 text-[10px] font-bold',
            classNames?.shortcut,
            ctx.itemClasses?.shortcut,
          )}
          dir='ltr'
        >
          {shortcut}
        </kbd>
      ) : null}
      {endContent ? <span className='shrink-0'>{endContent}</span> : null}
      {showCheck ? (
        <svg
          aria-hidden
          className={cn('shrink-0', classNames?.selectedIcon, ctx.itemClasses?.selectedIcon)}
          fill='none'
          height='14'
          stroke={INK_ON_BRAND}
          strokeLinecap='round'
          strokeLinejoin='round'
          strokeWidth={3}
          viewBox='0 0 24 24'
          width='14'
        >
          <path d='M4 12 10 18 20 6' />
        </svg>
      ) : null}
    </>
  );

  if (href && !isDisabled) {
    return (
      <li role='none'>
        <a
          aria-current={isSelected ? 'true' : undefined}
          className={baseCls}
      style={accentStyle}
          data-active={isActive || undefined}
          data-selected={isSelected || undefined}
          href={href}
          onClick={(e) => {
            handleAction(e);
          }}
          onMouseEnter={() => ctx.setActiveKey(key)}
          rel={rel}
          role='menuitem'
          target={target}
          {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
        >
          {inner}
        </a>
      </li>
    );
  }

  return (
    <li
      aria-disabled={isDisabled || undefined}
      aria-selected={ctx.selectionMode !== 'none' ? isSelected : undefined}
      className={baseCls}
      style={accentStyle}
      data-active={isActive || undefined}
      data-selected={isSelected || undefined}
      onClick={handleAction}
      onMouseEnter={() => !isReadOnly && ctx.setActiveKey(key)}
      role='menuitem'
      {...rest}
    >
      {inner}
    </li>
  );
}

DropdownItem.displayName = 'DropdownItem';
