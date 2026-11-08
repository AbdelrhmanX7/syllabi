import React from 'react';

import { cn } from '../../cn';
import type { HeroUIColor, HeroUIVariant } from '../tokens';
import { INK_ON_BRAND } from '../tokens';
import { CLAY_FILL, CLAY_LABEL } from '../clay';

/**
 * da-v2 Listbox / ListboxItem / ListboxSection — drop-in for HeroUI's Listbox.
 *
 * Standalone selectable list (NOT inside a popover — for that, use Dropdown).
 *
 *   <Listbox aria-label='actions' selectionMode='single' onSelectionChange={...}>
 *     <ListboxSection title='File' showDivider>
 *       <ListboxItem key='new'>New</ListboxItem>
 *     </ListboxSection>
 *     <ListboxItem key='delete' color='danger' description='gone forever'>
 *       Delete
 *     </ListboxItem>
 *   </Listbox>
 *
 * Visual: scrapbook card panel (`bg-paper [border:2.5px_solid_var(--line)] rounded-sk shadow-sk-lg`).
 * Items: 12px×16px padding, hover citrine wash, selected = citrine fill + 3px ink
 * inline-start strip. Caveat font on `description`.
 *
 * Selection logic:
 *  - 'none' (default) — fires `onAction(key)` on click; no persistent state.
 *  - 'single' — exactly one selected key.
 *  - 'multiple' — set of selected keys; click toggles.
 *
 * Keyboard: ↑/↓ navigate, Enter/Space activates, Home/End jump.
 *
 * `startContent` sits at the start; check icon and shortcut at the end.
 */

export type ListboxVariant = 'solid' | 'flat' | 'bordered' | 'light' | 'shadow' | 'faded';
export type ListboxSelectionMode = 'none' | 'single' | 'multiple';

interface ItemDescriptor {
  key: string;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  isSelectable?: boolean;
  href?: string;
}

export interface ListboxItemClassNames {
  base?: string;
  wrapper?: string;
  title?: string;
  description?: string;
  shortcut?: string;
  selectedIcon?: string;
}

interface ListboxContextValue {
  selectionMode: ListboxSelectionMode;
  selectedKeys: Set<string>;
  toggle: (key: string) => void;
  disabledKeys: Set<string>;
  registerItem: (d: ItemDescriptor) => void;
  unregisterItem: (key: string) => void;
  activeKey: string | null;
  setActiveKey: (key: string | null) => void;
  hideSelectedIcon: boolean;
  itemColor?: HeroUIColor;
  itemVariant?: HeroUIVariant;
  itemClasses?: ListboxItemClassNames;
  shouldHighlightOnFocus: boolean;
}

const ListboxContext = React.createContext<ListboxContextValue | null>(null);

/* ============================================================
   <Listbox>
   ============================================================ */

export interface ListboxClassNames {
  base?: string;
  list?: string;
  emptyContent?: string;
}

export interface ListboxProps {
  'aria-label'?: string;
  children?: React.ReactNode | ((item: unknown) => React.ReactNode);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items?: Iterable<any>;
  selectionMode?: ListboxSelectionMode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectedKeys?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultSelectedKeys?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSelectionChange?: (keys: any) => void;
  disabledKeys?: Iterable<string>;
  disallowEmptySelection?: boolean;
  autoFocus?: boolean | 'first' | 'last';
  shouldHighlightOnFocus?: boolean;
  shouldFocusWrap?: boolean;
  variant?: ListboxVariant;
  color?: HeroUIColor;
  hideEmptyContent?: boolean;
  hideSelectedIcon?: boolean;
  emptyContent?: React.ReactNode;
  topContent?: React.ReactNode;
  bottomContent?: React.ReactNode;
  onAction?: (key: string) => void;
  className?: string;
  classNames?: ListboxClassNames;
  itemClasses?: ListboxItemClassNames;
  /** Pass-through for `dir`. */
  dir?: 'rtl' | 'ltr';
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

const VARIANT_BG: Record<ListboxVariant, string> = {
  solid: '[background-color:var(--card-bg)]',
  flat: '[background-color:var(--card-bg)]',
  bordered: '[background-color:var(--card-bg)]',
  light: 'bg-transparent !border-transparent !shadow-none',
  shadow: '[background-color:var(--card-bg)] !shadow-sk-lg',
  faded: '[background-color:var(--paper-2)]',
};

export function Listbox(props: ListboxProps) {
  const {
    'aria-label': ariaLabel,
    children,
    items,
    selectionMode = 'none',
    selectedKeys: selectedProp,
    defaultSelectedKeys,
    onSelectionChange,
    disabledKeys,
    disallowEmptySelection,
    autoFocus,
    shouldHighlightOnFocus = true,
    variant = 'solid',
    color,
    hideEmptyContent,
    hideSelectedIcon = false,
    emptyContent,
    topContent,
    bottomContent,
    onAction,
    className,
    classNames,
    itemClasses,
    dir,
  } = props;

  const isControlled = selectedProp !== undefined;
  const [internal, setInternal] = React.useState<Set<string>>(() => toKeySet(defaultSelectedKeys));
  const selectedKeys = isControlled ? toKeySet(selectedProp) : internal;
  const setSelectedKeys = (s: Set<string>) => {
    if (!isControlled) setInternal(s);
    onSelectionChange?.(s);
  };

  const disabledKeySet = React.useMemo(() => toKeySet(disabledKeys), [disabledKeys]);

  const [registry, setRegistry] = React.useState<Map<string, ItemDescriptor>>(new Map());
  const orderRef = React.useRef<string[]>([]);

  const registerItem = React.useCallback((d: ItemDescriptor) => {
    setRegistry((prev) => {
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

  const toggle = React.useCallback(
    (key: string) => {
      const desc = registry.get(key);
      if (desc?.isDisabled || disabledKeySet.has(key)) return;

      onAction?.(key);

      if (selectionMode !== 'none' && desc?.isSelectable !== false) {
        let next: Set<string>;
        if (selectionMode === 'multiple') {
          next = new Set(selectedKeys);
          if (next.has(key)) {
            if (!disallowEmptySelection || next.size > 1) next.delete(key);
          } else {
            next.add(key);
          }
        } else {
          if (selectedKeys.has(key) && !disallowEmptySelection) next = new Set();
          else next = new Set([key]);
        }
        setSelectedKeys(next);
      }
    },
    [registry, disabledKeySet, onAction, selectionMode, selectedKeys, disallowEmptySelection, setSelectedKeys],
  );

  // Auto-focus on mount
  const listRef = React.useRef<HTMLUListElement | null>(null);
  React.useEffect(() => {
    if (!autoFocus) return;
    const order = orderRef.current.filter((k) => !registry.get(k)?.isDisabled && !disabledKeySet.has(k));
    if (autoFocus === 'last') setActiveKey(order[order.length - 1] ?? null);
    else setActiveKey(order[0] ?? null);
    listRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- inject __itemKey via React `key` so <ListboxItem> registers ---------- */
  const renderedChildren = React.useMemo(() => {
    if (items && typeof children === 'function') {
      const arr: React.ReactNode[] = [];
      const itemsArr = Array.isArray(items)
        ? (items as Array<{ key?: string; id?: string }>)
        : Array.from(items as Iterable<{ key?: string; id?: string }>);
      itemsArr.forEach((item) => {
        const k = String((item as { key?: string; id?: string }).key ?? (item as { id?: string }).id ?? '');
        const node = (children as (it: unknown) => React.ReactNode)(item);
        if (React.isValidElement(node)) {
          arr.push(
            React.cloneElement(node as React.ReactElement, { key: k, __itemKey: k } as Partial<ListboxItemProps>),
          );
        } else {
          arr.push(node);
        }
      });

      return arr;
    }

    const walk = (nodes: React.ReactNode): React.ReactNode =>
      React.Children.map(nodes, (child) => {
        if (!React.isValidElement(child)) return child;
        const compName = (child.type as { displayName?: string })?.displayName;
        if (compName === 'ListboxItem' || compName === 'MenuItem') {
          const k = String((child.key ?? '') as string).replace(/^\.\$/, '');
          if (k) return React.cloneElement(child as React.ReactElement, { __itemKey: k } as Partial<ListboxItemProps>);

          return child;
        }
        if (compName === 'ListboxSection' || compName === 'MenuSection') {
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

  // `variant` includes Listbox-specific values ('shadow'|'faded') that aren't in
  // HeroUIVariant — narrow before threading through context.
  const itemVariant: HeroUIVariant | undefined =
    variant === 'shadow' || variant === 'faded' ? undefined : (variant as HeroUIVariant);

  const ctxValue: ListboxContextValue = {
    selectionMode,
    selectedKeys,
    toggle,
    disabledKeys: disabledKeySet,
    registerItem,
    unregisterItem,
    activeKey,
    setActiveKey,
    hideSelectedIcon,
    itemColor: color,
    itemVariant,
    itemClasses,
    shouldHighlightOnFocus,
  };

  const isLight = variant === 'light';

  return (
    <ListboxContext.Provider value={ctxValue}>
      <div
        className={cn(
          'flex flex-col p-1.5',
          !isLight && '!border-line !rounded-sk !border-[3px]',
          !isLight && variant !== 'shadow' && '!shadow-sk',
          VARIANT_BG[variant],
          className,
          classNames?.base,
        )}
        dir={dir}
      >
        {topContent}
        <ul
          ref={listRef}
          aria-label={ariaLabel}
          className={cn('flex min-w-[180px] flex-col gap-0.5 outline-none focus:outline-none', classNames?.list)}
          onKeyDown={onKey}
          role={selectionMode === 'none' ? 'listbox' : 'listbox'}
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
      </div>
    </ListboxContext.Provider>
  );
}

Listbox.displayName = 'Listbox';

/* ============================================================
   <ListboxSection>
   ============================================================ */

export interface ListboxSectionProps {
  title?: React.ReactNode;
  showDivider?: boolean;
  children?: React.ReactNode;
  className?: string;
  classNames?: { base?: string; heading?: string; group?: string; divider?: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items?: Iterable<any>;
  'aria-label'?: string;
}

export function ListboxSection(props: ListboxSectionProps) {
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
        // `line` is a plain var(), not an rgb triplet, so a `/35` opacity
        // modifier compiles to nothing — mix the alpha explicitly.
        <div
          aria-hidden
          className={cn(
            'mx-1 my-1 border-t-[2px] border-dashed border-[color-mix(in_oklch,var(--line)_35%,transparent)]',
            classNames?.divider,
          )}
        />
      ) : null}
    </li>
  );
}

ListboxSection.displayName = 'ListboxSection';

/* ============================================================
   <ListboxItem>
   ============================================================ */

export interface ListboxItemProps extends Omit<React.HTMLAttributes<HTMLLIElement>, 'color' | 'onClick'> {
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
  classNames?: ListboxItemClassNames;
  /** Stable id (HeroUI compat). */
  textValue?: string;
  /** HeroUI compat — ignored for Listbox (Menu uses it). */
  closeOnSelect?: boolean;
  children?: React.ReactNode;
  /** HeroUI compat — show a check icon for the selected item. */
  selectedIcon?: React.ReactNode;
}

export function ListboxItem(props: ListboxItemProps) {
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
    textValue: _tv,
    closeOnSelect: _co,
    selectedIcon,
    ...rest
  } = props;

  const ctx = React.useContext(ListboxContext);
  const key = String(__itemKey ?? '');
  const color = colorProp ?? ctx?.itemColor ?? 'default';

  const register = ctx?.registerItem;
  const unregister = ctx?.unregisterItem;

  React.useEffect(() => {
    if (!register || !unregister || !key) return;
    register({ key, isDisabled, isReadOnly, isSelectable, href });

    return () => unregister(key);
  }, [register, unregister, key, isDisabled, isReadOnly, isSelectable, href]);

  if (!ctx) return null;

  const isSelected = ctx.selectedKeys.has(key);
  const isActive = ctx.activeKey === key && ctx.shouldHighlightOnFocus;
  const showCheck = !ctx.hideSelectedIcon && ctx.selectionMode !== 'none' && isSelected;

  const handleAction = (e: React.MouseEvent | React.KeyboardEvent) => {
    if (isDisabled || isReadOnly) return;
    onClick?.(e as React.MouseEvent);
    onPress?.(e);
    if (key) ctx.toggle(key);
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
    // A literal, not `rounded-sk-sm`: that alias is a temporary compat shim pointing at the
    // clay radius, and anything depending on it loses its corners silently the day it goes.
    // Select and Autocomplete already hard-code 14 to match this item.
    'relative flex cursor-pointer items-center gap-2 px-4 py-3 text-[14px] font-bold rounded-[14px]',
    'transition-colors duration-[80ms] outline-none',
    'border-[1.5px] border-transparent',
    !isSelected && 'text-ink',
    color === 'danger' && 'text-sk-red',
    color === 'primary' && 'text-sk-primary',
    color === 'success' && 'text-sk-green',
    color === 'warning' && 'text-sk-amber',
    // Semantic secondary (`sk-secondary` -> --s-text), NOT the literal `sk-blue`
    // decoration token. See the same note on Breadcrumbs' COLOR_CLS.
    color === 'secondary' && 'text-sk-secondary',
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
              'font-hand text-ink/70 text-[13px] font-semibold',
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
            // `border-line/40` would emit no CSS (`line` isn't an rgb triplet) — mix the alpha.
            'bg-paper text-ink/70 font-hand inline-flex h-5 shrink-0 items-center justify-center rounded-[3px] border border-[color-mix(in_oklch,var(--line)_40%,transparent)] px-1 text-[10px] font-bold',
            classNames?.shortcut,
            ctx.itemClasses?.shortcut,
          )}
          dir='ltr'
        >
          {shortcut}
        </kbd>
      ) : null}
      {endContent ? <span className='shrink-0'>{endContent}</span> : null}
      {showCheck
        ? (selectedIcon ?? (
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
          ))
        : null}
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
          onClick={handleAction}
          onMouseEnter={() => ctx.setActiveKey(key)}
          rel={rel}
          role='option'
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
      role='option'
      {...rest}
    >
      {inner}
    </li>
  );
}

ListboxItem.displayName = 'ListboxItem';
