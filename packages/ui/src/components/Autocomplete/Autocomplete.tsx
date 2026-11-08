import React from 'react';
import { AnimatePresence, motion } from 'motion/react';

import { cn } from '../../cn';
import { CLAY_FILL, CLAY_LABEL, clayVars } from '../clay';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';
import { HEROUI_COLOR_TEXT } from '../tokens';

/**
 * da-v2 Autocomplete + AutocompleteItem — drop-in for HeroUI's <Autocomplete>.
 *
 * Combines a clay FIELD trigger with a portaled-style listbox panel
 * that filters on inputValue. Composition mirrors HeroUI's external API (the
 * underlying primitives here are hand-rolled Input + Popover-style panel).
 *
 * HeroUI shape mirrored:
 *   <Autocomplete
 *     label placeholder
 *     items defaultItems
 *     inputValue defaultInputValue onInputChange
 *     selectedKey defaultSelectedKey onSelectionChange
 *     allowsCustomValue allowsEmptyCollection
 *     menuTrigger='focus' | 'manual' | 'input'
 *     isClearable isDisabled isRequired isInvalid
 *     errorMessage description
 *     size radius variant
 *     startContent endContent
 *     classNames listboxProps popoverProps inputProps
 *   >
 *     {(item) => <AutocompleteItem key={item.id}>{item.label}</AutocompleteItem>}
 *   </Autocomplete>
 */

export type AutocompleteVariant = 'flat' | 'bordered' | 'underlined' | 'faded';
export type AutocompleteMenuTrigger = 'focus' | 'manual' | 'input';

/*
 * `Input.tsx`'s field, matched not re-derived — an Autocomplete must be
 * indistinguishable from an Input beside it in the same form. Fields are FLAT
 * under clay: no inset, no groove, no lip; the border does the structural work
 * and changes colour on hover and focus.
 */
const SIZE: Record<HeroUISize, string> = {
  sm: 'h-11 text-[15px]',
  md: 'h-[52px] text-[16px]',
  lg: 'h-[60px] text-[17px]',
};

// Clay's radius ladder, written out — the JIT cannot see through a template literal.
const RADIUS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-[14px]',
  md: 'rounded-[18px]',
  lg: 'rounded-[20px]',
  full: 'rounded-full',
};

const FG = 'hsl(var(--heroui-foreground))';
const SURFACE = CLAY_FILL.default;
const MUTED = `color-mix(in srgb, ${FG} 62%, ${SURFACE})`;

const FACE: Record<AutocompleteVariant, string> = {
  bordered: SURFACE,
  flat: 'hsl(var(--heroui-content2))',
  faded: 'hsl(var(--heroui-content3))',
  underlined: 'transparent',
};

const edgeOf = (fill: string) => (clayVars(fill, { kind: 'control' }) as Record<string, string>)['--clay-edge'];
const HOVER_EDGE = edgeOf('hsl(var(--heroui-content4, var(--heroui-content3)))');

interface AutocompleteStyle extends React.CSSProperties {
}

/*
 * Invalid is marked with a GLYPH, not the scrapbook's hand-drawn scribble.
 * Input.tsx's reasoning applies unchanged: a differently-coloured border is
 * exactly what "invalid" must not be mistaken for, so the state needs a signal
 * that is not colour. `errorMessage` is optional, so the glyph cannot be left
 * to it. Same mark, same placement, same danger token as Input.
 */
const ALERT_GLYPH = (
  <svg
    aria-hidden='true'
    fill='none'
    height='16'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2.4}
    viewBox='0 0 24 24'
    width='16'
  >
    <path d='m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z' />
    <path d='M12 9v4' />
    <path d='M12 17h.01' />
  </svg>
);

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    aria-hidden
    className={cn('shrink-0 transition-transform duration-150', open && 'rotate-180')}
    fill='none'
    height='16'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2.6}
    viewBox='0 0 24 24'
    width='16'
  >
    <path d='m6 9 6 6 6-6' />
  </svg>
);

/* ============================================================
   Item descriptor + context (so AutocompleteItem can register).
   ============================================================ */

interface AutocompleteItemDescriptor {
  key: string;
  textValue: string;
  label: React.ReactNode;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  description?: React.ReactNode;
  isDisabled?: boolean;
}

interface AutocompleteContextValue {
  selectedKey: string | null;
  activeKey: string | null;
  setActiveKey: (k: string | null) => void;
  registerItem: (d: AutocompleteItemDescriptor) => void;
  unregisterItem: (k: string) => void;
  selectKey: (k: string) => void;
  inputValue: string;
  filterMatches: (textValue: string) => boolean;
}

const AutocompleteContext = React.createContext<AutocompleteContextValue | null>(null);

/* ============================================================
   <AutocompleteItem>
   ============================================================ */

export interface AutocompleteItemProps extends Omit<React.HTMLAttributes<HTMLLIElement>, 'onClick' | 'children'> {
  value?: string;
  textValue?: string;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  description?: React.ReactNode;
  isDisabled?: boolean;
  children?: React.ReactNode;
  /**
   * The item's own accent — drives its hover wash and selected fill, so a
   * destructive option can say so. Defaults to primary. Matches `<ListboxItem>`
   * and `<SelectItem>`. Additive: existing call sites keep the primary default.
   */
  color?: HeroUIColor;
  /** Internal — supplied by Autocomplete via cloneElement. */
  __itemKey?: string;
}

export function AutocompleteItem(props: AutocompleteItemProps) {
  const {
    value,
    textValue,
    startContent,
    endContent,
    description,
    isDisabled,
    children,
    className,
    color,
    __itemKey,
    ...rest
  } = props;

  const ctx = React.useContext(AutocompleteContext);
  const key = String(value ?? __itemKey ?? '');
  const computedTextValue = textValue ?? (typeof children === 'string' ? children : key);

  // Depend on the stable register/unregister callbacks rather than ctx as a
  // whole — ctx identity changes with selection/filter state, and re-running
  // registration on those changes would loop (registration itself updates
  // the parent's itemsMap, which feeds filterMatches in ctx).
  const registerItem = ctx?.registerItem;
  const unregisterItem = ctx?.unregisterItem;
  React.useEffect(() => {
    if (!registerItem || !unregisterItem || !key) return;
    registerItem({
      key,
      textValue: computedTextValue,
      label: children,
      startContent,
      endContent,
      description,
      isDisabled,
    });

    return () => unregisterItem(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerItem, unregisterItem, key, computedTextValue, isDisabled]);

  if (!ctx) return null;

  // Filter: hide when input doesn't match.
  if (!ctx.filterMatches(computedTextValue)) return null;

  const isSelected = ctx.selectedKey === key;
  const isActive = ctx.activeKey === key;

  /**
   * The highlight follows the ITEM'S OWN colour, defaulting to primary — the
   * recipe `Listbox` landed on, matched so a `<Select>`, an `<Autocomplete>` and
   * a standalone menu all highlight identically. The old hardcoded citrine wash
   * made a destructive option look the same as a neutral one.
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

  return (
    <li
      aria-disabled={isDisabled || undefined}
      aria-selected={isSelected}
      className={cn(
        'clay-item',
        'relative flex cursor-pointer items-center gap-2 rounded-[14px] px-4 py-3 text-[14px] font-bold',
        'transition-colors duration-[80ms] outline-none',
        !isSelected && 'text-ink',
        isDisabled && 'cursor-not-allowed opacity-40',
        className,
      )}
      style={accentStyle}
      onClick={(e) => {
        if (isDisabled) return;
        e.stopPropagation();
        ctx.selectKey(key);
      }}
      onMouseEnter={() => !isDisabled && ctx.setActiveKey(key)}
      role='option'
      {...rest}
    >
      {startContent ? <span className='shrink-0'>{startContent}</span> : null}
      <span className='flex flex-1 flex-col'>
        <span>{children}</span>
        {description ? (
          <span className={cn('text-[13px] font-semibold', isSelected ? 'opacity-80' : 'text-ink-muted')}>
            {description}
          </span>
        ) : null}
      </span>
      {endContent ? <span className='shrink-0'>{endContent}</span> : null}
      {isSelected ? (
        <svg
          className='shrink-0'
          fill='none'
          height='14'
          stroke='currentColor'
          strokeLinecap='round'
          strokeLinejoin='round'
          strokeWidth={3}
          viewBox='0 0 24 24'
          width='14'
        >
          <path d='M4 12 10 18 20 6' />
        </svg>
      ) : null}
    </li>
  );
}

AutocompleteItem.displayName = 'AutocompleteItem';

/* ============================================================
   <Autocomplete>
   ============================================================ */

export interface AutocompleteProps {
  label?: React.ReactNode;
  placeholder?: string;
  description?: React.ReactNode;
  errorMessage?: React.ReactNode;
  isInvalid?: boolean;
  isDisabled?: boolean;
  isRequired?: boolean;
  isClearable?: boolean;
  isReadOnly?: boolean;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  color?: HeroUIColor;
  variant?: AutocompleteVariant;
  /**
   * Scrapbook seeded tilt. Accepted and IGNORED under clay — a clay field does
   * not tilt. Kept so call sites do not have to change.
   */
  rotate?: number;
  fullWidth?: boolean;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  /** Items array (with `key` or `id` field) — used with render-prop children. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items?: Iterable<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultItems?: Iterable<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  children?: React.ReactNode | ((item: any) => React.ReactNode);
  inputValue?: string;
  defaultInputValue?: string;
  onInputChange?: (value: string) => void;
  selectedKey?: string | null;
  defaultSelectedKey?: string | null;
  onSelectionChange?: (key: string | null) => void;
  allowsCustomValue?: boolean;
  allowsEmptyCollection?: boolean;
  menuTrigger?: AutocompleteMenuTrigger;
  isOpen?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  labelPlacement?: 'inside' | 'outside' | 'outside-left';
  className?: string;
  classNames?: {
    base?: string;
    label?: string;
    mainWrapper?: string;
    inputWrapper?: string;
    input?: string;
    selectorButton?: string;
    clearButton?: string;
    listbox?: string;
    listboxWrapper?: string;
    popoverContent?: string;
    helperWrapper?: string;
    description?: string;
    errorMessage?: string;
    endContentWrapper?: string;
  };
  /** HeroUI compat — kept for parity; loosely passed through. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputProps?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listboxProps?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  popoverProps?: any;
  emptyContent?: React.ReactNode;
  name?: string;
  id?: string;
  dir?: 'rtl' | 'ltr';
  style?: React.CSSProperties;
  /** HeroUI compat — value-based API for non-keyed usage. */
  value?: string;
  defaultValue?: string;
}

export function Autocomplete(props: AutocompleteProps) {
  const {
    label,
    placeholder,
    description,
    errorMessage,
    isInvalid,
    isDisabled,
    isRequired,
    isClearable = true,
    isReadOnly,
    size = 'md',
    radius = 'md',
    color = 'default',
    variant = 'bordered',
    rotate: _rotate,
    fullWidth = true,
    startContent,
    endContent,
    items,
    defaultItems,
    children,
    inputValue: inputValueProp,
    defaultInputValue,
    onInputChange,
    selectedKey: selectedKeyProp,
    defaultSelectedKey,
    onSelectionChange,
    allowsCustomValue,
    allowsEmptyCollection = true,
    menuTrigger = 'focus',
    isOpen: openProp,
    defaultOpen,
    onOpenChange,
    labelPlacement: _labelPlacement,
    className,
    classNames,
    name,
    id,
    dir,
    style,
    emptyContent,
    inputProps: _inputProps,
    listboxProps: _listboxProps,
    popoverProps: _popoverProps,
  } = props;


  const reactId = React.useId();
  const triggerId = id ?? reactId;
  const listboxId = `${triggerId}-list`;

  /* ---------- registered items ---------- */
  const [itemsMap, setItemsMap] = React.useState<Map<string, AutocompleteItemDescriptor>>(new Map());
  // Mirror itemsMap in a ref so ctx callbacks (selectKey/filterMatches) can
  // read it without depending on it — registration mutates itemsMap, and a
  // dependency would change ctx identity, re-running every item's
  // registration effect in an infinite loop.
  const itemsMapRef = React.useRef(itemsMap);
  itemsMapRef.current = itemsMap;
  const orderRef = React.useRef<string[]>([]);
  const registerItem = React.useCallback((d: AutocompleteItemDescriptor) => {
    setItemsMap((prev) => {
      const next = new Map(prev);
      next.set(d.key, d);

      return next;
    });
    if (!orderRef.current.includes(d.key)) orderRef.current.push(d.key);
  }, []);
  const unregisterItem = React.useCallback((k: string) => {
    setItemsMap((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Map(prev);
      next.delete(k);

      return next;
    });
    orderRef.current = orderRef.current.filter((x) => x !== k);
  }, []);

  /* ---------- selected key ---------- */
  const isSelectedControlled = selectedKeyProp !== undefined;
  const [internalSelected, setInternalSelected] = React.useState<string | null>(defaultSelectedKey ?? null);
  const selectedKey = isSelectedControlled ? (selectedKeyProp ?? null) : internalSelected;

  /* ---------- input value (text in the field) ---------- */
  const isInputControlled = inputValueProp !== undefined;
  const [internalInput, setInternalInput] = React.useState<string>(() => {
    if (defaultInputValue !== undefined) return defaultInputValue;

    return '';
  });
  const inputValue = isInputControlled ? (inputValueProp ?? '') : internalInput;

  // When selectedKey changes externally and we don't have a typed input, sync display.
  React.useEffect(() => {
    if (selectedKey === null) return;
    const desc = itemsMap.get(selectedKey);
    if (desc && !isInputControlled && !allowsCustomValue) {
      setInternalInput(desc.textValue);
    }
  }, [selectedKey, itemsMap, isInputControlled, allowsCustomValue]);

  /* ---------- open state ---------- */
  const isOpenControlled = openProp !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(Boolean(defaultOpen));
  const open = isOpenControlled ? Boolean(openProp) : internalOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isOpenControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isOpenControlled, onOpenChange],
  );

  /* ---------- active key ---------- */
  const [activeKey, setActiveKey] = React.useState<string | null>(null);

  /* ---------- filter ---------- */
  // Depends on itemsMap (not the ref) on purpose: identity must change when
  // registrations land so already-mounted items re-render through ctx and
  // re-evaluate their visibility. Registration effects don't depend on ctx,
  // so this can't loop.
  const filterMatches = React.useCallback(
    (textValue: string) => {
      if (!inputValue) return true;
      // If the typed text matches the selected item exactly, show all options.
      if (selectedKey !== null) {
        const sel = itemsMap.get(selectedKey);
        if (sel && sel.textValue === inputValue) return true;
      }

      return textValue.toLowerCase().includes(inputValue.toLowerCase());
    },
    [inputValue, selectedKey, itemsMap],
  );

  /* ---------- selection ---------- */
  const selectKey = React.useCallback(
    (k: string) => {
      const desc = itemsMapRef.current.get(k);
      if (!isSelectedControlled) setInternalSelected(k);
      onSelectionChange?.(k);
      if (desc) {
        if (!isInputControlled) setInternalInput(desc.textValue);
        onInputChange?.(desc.textValue);
      }
      setOpen(false);
      setActiveKey(null);
    },
    [isSelectedControlled, onSelectionChange, isInputControlled, onInputChange, setOpen],
  );

  const clear = React.useCallback(() => {
    if (!isSelectedControlled) setInternalSelected(null);
    onSelectionChange?.(null);
    if (!isInputControlled) setInternalInput('');
    onInputChange?.('');
  }, [isSelectedControlled, onSelectionChange, isInputControlled, onInputChange]);

  /* ---------- click-outside + escape ---------- */
  const rootRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  /* ---------- input handlers ---------- */
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (!isInputControlled) setInternalInput(v);
    onInputChange?.(v);
    if (menuTrigger === 'input' && !open) setOpen(true);
    if (menuTrigger === 'focus' && !open) setOpen(true);
    // When typing, clear selection if it no longer matches and customValue is not allowed.
    if (selectedKey !== null) {
      const desc = itemsMap.get(selectedKey);
      if (desc && desc.textValue !== v) {
        if (!isSelectedControlled) setInternalSelected(null);
        onSelectionChange?.(null);
      }
    }
    setActiveKey(null);
  };

  const handleFocus = () => {
    if (isDisabled || isReadOnly) return;
    if (menuTrigger === 'focus') setOpen(true);
  };

  /* Clicking anywhere on the field opens the menu — a focus event alone
     misses clicks on an already-focused input and on the wrapper box. */
  const handleFieldClick = () => {
    if (isDisabled || isReadOnly || menuTrigger === 'manual') return;
    inputRef.current?.focus();
    if (!open) setOpen(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isDisabled) return;
    const visible = orderRef.current.filter((k) => {
      const d = itemsMap.get(k);
      if (!d || d.isDisabled) return false;

      return filterMatches(d.textValue);
    });

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);

        return;
      }
      if (!visible.length) return;
      const idx = activeKey ? visible.indexOf(activeKey) : -1;
      setActiveKey(visible[(idx + 1) % visible.length] ?? null);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);

        return;
      }
      if (!visible.length) return;
      const idx = activeKey ? visible.indexOf(activeKey) : -1;
      const next = idx <= 0 ? visible.length - 1 : idx - 1;
      setActiveKey(visible[next] ?? null);
    } else if (e.key === 'Enter') {
      if (open && activeKey) {
        e.preventDefault();
        selectKey(activeKey);
      } else if (allowsCustomValue) {
        // Custom value commit — leave inputValue as-is, clear selection.
        if (!isSelectedControlled) setInternalSelected(null);
        onSelectionChange?.(null);
        setOpen(false);
      }
    } else if (e.key === 'Tab') {
      setOpen(false);
    } else if (e.key === 'Home') {
      if (open && visible.length) {
        e.preventDefault();
        setActiveKey(visible[0] ?? null);
      }
    } else if (e.key === 'End') {
      if (open && visible.length) {
        e.preventDefault();
        setActiveKey(visible[visible.length - 1] ?? null);
      }
    }
  };

  /* ---------- render items ---------- */
  const renderedChildren = React.useMemo(() => {
    const itemsIter = items ?? defaultItems;
    if (itemsIter && typeof children === 'function') {
      const arr: React.ReactNode[] = [];
      const itemsArr = Array.isArray(itemsIter)
        ? (itemsIter as Array<{ key?: string; id?: string; value?: string; [k: string]: unknown }>)
        : Array.from(itemsIter as Iterable<{ key?: string; id?: string; value?: string; [k: string]: unknown }>);
      itemsArr.forEach((item, idx) => {
        const node = (children as (it: typeof item) => React.ReactNode)(item);
        if (React.isValidElement(node)) {
          // Prefer the React `key` the consumer set on the returned element
          // (e.g. `<AutocompleteItem key={item.value}>`). Fall back to common id fields, then index.
          const elementKey = node.key != null ? String(node.key) : '';
          const k = elementKey || String(item.key ?? item.id ?? item.value ?? idx);
          arr.push(
            React.cloneElement(node as React.ReactElement, { key: k, __itemKey: k } as Partial<AutocompleteItemProps>),
          );
        } else {
          arr.push(node);
        }
      });

      return arr;
    }

    if (Array.isArray(children) || React.isValidElement(children)) {
      return React.Children.map(children, (child) => {
        if (React.isValidElement(child)) {
          const k = String((child.key ?? '') as string).replace(/^\.\$/, '');

          return React.cloneElement(child as React.ReactElement, { __itemKey: k } as Partial<AutocompleteItemProps>);
        }

        return child;
      });
    }

    return children;
  }, [items, defaultItems, children]);

  /* ---------- styling: Input.tsx's field, matched exactly ---------- */
  const isUnderlined = variant === 'underlined';
  const face = FACE[variant];
  // The focus/invalid border takes the brand as a MARK, not a FILL — the raw
  // brand measures ~1.9-2.9:1 against a dark field. The `*-text` tokens are the
  // brand corrected to read AGAINST the theme.
  const focusEdge = isInvalid ? HEROUI_COLOR_TEXT.danger : HEROUI_COLOR_TEXT.primary;

  const baseStyle = {
    background: face,
    ...clayVars(isUnderlined ? SURFACE : face, {
      shapeFrom: isInvalid ? CLAY_FILL.danger : color === 'default' ? undefined : CLAY_FILL[color],
      // Profile follows the SHAPE's luminance, not the face's and not the
      // `color` prop — `clayKindFor` selects by colour NAME and cannot answer it.
      kind: isInvalid || color !== 'default' ? 'brand' : 'control',
      // Matches Input and Select: a field is raised, but shallower than a button.
      depth: 4,
    }),
    '--clay-edge-hover': HOVER_EDGE,
    '--clay-focus': focusEdge,
    '--clay-muted': MUTED,
  } as React.CSSProperties;

  // Memoized so item registration effects (which depend on ctx) don't re-run
  // every parent render — see the matching note in Select's ctxValue.
  const ctxValue = React.useMemo<AutocompleteContextValue>(
    () => ({
      selectedKey,
      activeKey,
      setActiveKey,
      registerItem,
      unregisterItem,
      selectKey,
      inputValue,
      filterMatches,
    }),
    [selectedKey, activeKey, registerItem, unregisterItem, selectKey, inputValue, filterMatches],
  );

  const visibleCount = React.useMemo(() => {
    let n = 0;
    itemsMap.forEach((d) => {
      if (filterMatches(d.textValue)) n += 1;
    });

    return n;
  }, [itemsMap, filterMatches]);

  return (
    <AutocompleteContext.Provider value={ctxValue}>
      <div
        ref={rootRef}
        className={cn('flex flex-col gap-1.5', fullWidth && 'w-full', className, classNames?.base)}
        dir={dir}
        style={style}
      >
        {label ? (
          <label
            className={cn(
              'text-ink text-[13px] font-bold',
              isRequired && "after:text-sk-red after:ms-1 after:content-['*']",
              classNames?.label,
            )}
            htmlFor={triggerId}
          >
            {label}
          </label>
        ) : null}
        <div className={cn('relative', classNames?.mainWrapper)}>
          <div
            className={cn(
              'relative flex items-center gap-2 px-5',
              // Only the border colour animates — a flat field, border doing the work.
              'transition-[border-color,outline-color] duration-150 motion-reduce:transition-none',
              // `.clay-panel` paints `--clay-rest`; see the note in Select.
              !isUnderlined && 'clay-panel border-[2px] border-[color:var(--clay-edge)]',
              isUnderlined && 'rounded-none border-x-0 border-b-[2px] border-t-0 border-[color:var(--clay-edge)]',
              !isDisabled && 'hover:border-[color:var(--clay-edge-hover)]',
              isDisabled && 'cursor-not-allowed opacity-50',
              !isDisabled && !isReadOnly && 'cursor-text',
              /*
               * Focus: border takes the brand AND thickens, via a 1px `outline`
               * at offset 0 flush outside the 2px border — one 3px edge, no
               * layout shift, `box-shadow` uninvolved. Two separate properties,
               * so neither can silently replace the other. The old construction
               * had to compose `!important` box-shadows precisely because
               * Tailwind's ring compiles to one and lost to the base rule.
               */
              'focus-within:outline focus-within:outline-[1px] focus-within:outline-offset-0',
              'focus-within:outline-[color:var(--clay-focus)]',
              'has-[:focus-visible]:border-[color:var(--clay-focus)]',
              SIZE[size],
              isUnderlined ? 'rounded-none' : RADIUS[radius],
              classNames?.inputWrapper,
            )}
            onClick={handleFieldClick}
            style={baseStyle as React.CSSProperties}
          >
            {startContent}
            <input
              aria-autocomplete='list'
              aria-controls={open ? listboxId : undefined}
              aria-expanded={open}
              aria-invalid={isInvalid || undefined}
              autoComplete='off'
              className={cn(
                // min-w-0: an <input> has an intrinsic min width (~its `size` attr, 20 chars),
                // and a flex item won't shrink below that without it — the input then overflows
                // the bordered wrapper and shoves the chevron outside the box at narrow widths.
                // Placeholder uses the body face (no `font-hand`), same as `Input.tsx`.
                'text-ink w-full min-w-0 flex-1 bg-transparent font-bold outline-none placeholder:font-semibold placeholder:text-[color:var(--clay-muted)]',
                size === 'lg'
                  ? 'placeholder:text-[20px]'
                  : size === 'sm'
                    ? 'placeholder:text-[16px]'
                    : 'placeholder:text-[18px]',
                classNames?.input,
              )}
              ref={inputRef}
              disabled={isDisabled}
              id={triggerId}
              name={name}
              onChange={handleInputChange}
              onFocus={handleFocus}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              readOnly={isReadOnly}
              required={isRequired}
              role='combobox'
              type='text'
              value={inputValue}
            />
            <span className={cn('flex shrink-0 items-center gap-1', classNames?.endContentWrapper)}>
              {isClearable && (inputValue || selectedKey !== null) ? (
                <button
                  aria-label='Clear'
                  className={cn(
                    'text-ink/60 hover:text-ink inline-flex h-5 w-5 items-center justify-center rounded-full',
                    classNames?.clearButton,
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    clear();
                  }}
                  tabIndex={-1}
                  type='button'
                >
                  <svg
                    fill='none'
                    height='12'
                    stroke='currentColor'
                    strokeLinecap='round'
                    strokeWidth={2.4}
                    viewBox='0 0 24 24'
                    width='12'
                  >
                    <path d='M18 6 6 18M6 6l12 12' />
                  </svg>
                </button>
              ) : null}
              {endContent}
              <button
                aria-label={open ? 'Close menu' : 'Open menu'}
                className={cn(
                  'text-ink/70 hover:text-ink inline-flex h-6 w-6 shrink-0 items-center justify-center',
                  classNames?.selectorButton,
                )}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!isDisabled) setOpen(!open);
                }}
                tabIndex={-1}
                type='button'
              >
                <ChevronIcon open={open} />
              </button>
            </span>
            {isInvalid ? (
              <span
                aria-hidden='true'
                className='inline-flex shrink-0 items-center justify-center'
                style={{ color: HEROUI_COLOR_TEXT.danger }}
              >
                {ALERT_GLYPH}
              </span>
            ) : null}
          </div>

          <AnimatePresence>
            {open ? (
              <motion.div
                animate={{ opacity: 1, y: 0, rotate: -0.3 }}
                className={cn('absolute z-50 mt-2 w-full', classNames?.popoverContent, classNames?.listboxWrapper)}
                exit={{ opacity: 0, y: -4, rotate: 0 }}
                initial={{ opacity: 0, y: -6, rotate: 0 }}
                transition={{ duration: 0.16, ease: [0.3, 0.6, 0.2, 1.2] }}
              >
                <ul
                  aria-label={typeof label === 'string' ? label : undefined}
                  className={cn(
                    'relative max-h-[260px] overflow-auto',
                    // See the note on Select's panel: `.clay-panel` reads
                    // `--clay-rest`, and an undefined `var(--clay-edge)` inside
                    // the `border` SHORTHAND invalidates it to `0px`. Both vars
                    // are set inline below, on this element.
                    'clay-panel [border:3px_solid_var(--clay-edge)] rounded-[18px] p-1',
                    classNames?.listbox,
                  )}
                  style={{
                    background: 'var(--card-bg)',
                    ...clayVars('var(--card-bg)', { kind: 'surface', depth: 8 }),
                  }}
                  id={listboxId}
                  role='listbox'
                >
                  {/* decorative tape */}
                  <span
                    aria-hidden
                    className='hidden'
                    style={{ left: '50%', top: -10, marginLeft: -40 }}
                  />
                  {renderedChildren}
                  {visibleCount === 0 && allowsEmptyCollection ? (
                    <li className='text-ink-muted px-4 py-3 text-[14px] font-semibold'>{emptyContent ?? 'No results'}</li>
                  ) : null}
                </ul>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        {description || errorMessage ? (
          <div className={cn('flex flex-col gap-0.5', classNames?.helperWrapper)}>
            {errorMessage ? (
              <span className={cn('text-sk-red text-[13px] font-bold', classNames?.errorMessage)}>
                {errorMessage}
              </span>
            ) : description ? (
              <span className={cn('text-ink-muted text-[13px] font-medium', classNames?.description)}>
                {description}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </AutocompleteContext.Provider>
  );
}

Autocomplete.displayName = 'Autocomplete';
