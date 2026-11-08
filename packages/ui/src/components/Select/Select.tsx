import React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';

import { cn } from '../../cn';
import { useValidation } from '../useValidation';
import { CLAY_FILL, CLAY_LABEL, clayVars } from '../clay';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';
import { HEROUI_COLOR_TEXT } from '../tokens';

/**
 * da-v2 Select / SelectItem — drop-in for HeroUI's Select.
 *
 * Mirrors the HeroUI prop API surface seen across apps (admin/web):
 *   <Select label items selectionMode='single'|'multiple' selectedKeys defaultSelectedKeys
 *           onSelectionChange placeholder isDisabled isInvalid errorMessage description
 *           size radius variant startContent endContent isClearable isLoading classNames>
 *     <SelectItem key value startContent endContent textValue>{label}</SelectItem>
 *   </Select>
 *
 * HeroUI's `onSelectionChange(keys)` is called with a `Set<Key>`-like value; we call
 * with a real `Set<string>`. `onChange(e)` is also invoked for native-like usage —
 * many call sites read `e.target.value` directly.
 *
 * Known divergences from HeroUI (added to plan's Known leaky abstractions):
 *  - Headless logic is hand-rolled (not @react-aria/select). Keyboard-nav is
 *    arrow up/down/Enter/Escape/Home/End; type-to-search is not implemented.
 *  - `items` + render-prop child `(item) => <SelectItem ... />` is supported.
 *  - Listbox is portaled to <body> and positioned fixed against the trigger (with
 *    flip-up when there's no room below) so it escapes clipping ancestors (modal/sheet
 *    overflow + transform). Selected-item labels are cached so they survive the items
 *    unmounting on close.
 */

export type SelectVariant = 'flat' | 'bordered' | 'underlined' | 'faded';

/*
 * The trigger is a FIELD, and the bar for this port is that it must be
 * indistinguishable from an `<Input>` standing next to it in the same form.
 * Everything below is `Input.tsx`'s, matched rather than re-derived — heights,
 * radii, faces, edges, the hover darkening and the no-layout-shift focus.
 *
 * Fields are FLAT under clay. Not recessed: no inset, no groove, no lip. The
 * border does the structural work and changes colour on hover and focus. (The
 * recessed reading was built and measured before the owner chose this — see
 * `.clay/select-autocomplete.md`.)
 *
 * `min-h` rather than Input's fixed `h`: a multi-select trigger grows with its
 * chips. Same numbers, so a single-value Select lines up with an Input exactly.
 */
const SIZE: Record<HeroUISize, string> = {
  sm: 'min-h-11 text-[15px]',
  md: 'min-h-[52px] text-[16px]',
  lg: 'min-h-[60px] text-[17px]',
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
/** Helper/placeholder text: mixed toward the surface, not faded with opacity. */
const MUTED = `color-mix(in srgb, ${FG} 62%, ${SURFACE})`;

/** With the field flat, `variant` is exactly a border/fill combination. Input's map. */
const FACE: Record<SelectVariant, string> = {
  bordered: SURFACE,
  flat: 'hsl(var(--heroui-content2))',
  faded: 'hsl(var(--heroui-content3))',
  underlined: 'transparent',
};

/**
 * The resting border and the darker one it moves to on hover. Both from
 * `clayVars`, but from different FILLS rather than different profiles —
 * `control` is already the darkest mix the helper offers, so "darker than the
 * resting border" cannot be asked for as a profile. Input's approach.
 */
const edgeOf = (fill: string) => (clayVars(fill, { kind: 'control' }) as Record<string, string>)['--clay-edge'];
const HOVER_EDGE = edgeOf('hsl(var(--heroui-content4, var(--heroui-content3)))');

/* ============================================================
   Item type + context (so <SelectItem> can register w/ <Select>)
   ============================================================ */

interface SelectItemDescriptor {
  key: string;
  textValue: string;
  label: React.ReactNode;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  description?: React.ReactNode;
  isDisabled?: boolean;
}

interface SelectContextValue {
  selectedKeys: Set<string>;
  toggle: (key: string) => void;
  selectionMode: 'single' | 'multiple';
  closeOnSelect: boolean;
  close: () => void;
  registerItem: (descriptor: SelectItemDescriptor) => void;
  unregisterItem: (key: string) => void;
  activeKey: string | null;
  setActiveKey: (key: string | null) => void;
}

const SelectContext = React.createContext<SelectContextValue | null>(null);

/* ============================================================
   <SelectItem>
   ============================================================ */

export interface SelectItemProps extends Omit<React.HTMLAttributes<HTMLLIElement>, 'onClick' | 'children'> {
  /** Stable identifier — HeroUI uses `key` as the keyboard-nav id. Provide via React `key` prop OR via this `value` prop. */
  value?: string;
  /** HeroUI compat — fallback when `key` is not a string (search/aria text). */
  textValue?: string;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  description?: React.ReactNode;
  isDisabled?: boolean;
  children?: React.ReactNode;
  /**
   * The item's own accent — drives its hover wash and its selected fill, so a
   * destructive option can say so. Defaults to primary. Matches `<ListboxItem>`.
   * Additive: existing call sites keep the primary default without changing.
   */
  color?: HeroUIColor;
  /** Internal — supplied by <Select> via `React.cloneElement` so we can read the `key`. */
  __itemKey?: string;
}

export function SelectItem(props: SelectItemProps) {
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

  const ctx = React.useContext(SelectContext);
  const key = String(value ?? __itemKey ?? '');

  // Compute a string textValue for aria/search.
  const computedTextValue = textValue ?? (typeof children === 'string' ? children : key);

  // Register this item w/ the parent <Select>. Effect registration so unmount cleans up.
  React.useEffect(() => {
    if (!ctx || !key) return;
    ctx.registerItem({
      key,
      textValue: computedTextValue,
      label: children,
      startContent,
      endContent,
      description,
      isDisabled,
    });

    return () => ctx.unregisterItem(key);
    // children/start/end may be JSX; we stringify-ish via key only, so register on identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key, computedTextValue, isDisabled]);

  if (!ctx) return null;

  const isSelected = ctx.selectedKeys.has(key);
  const isActive = ctx.activeKey === key;

  /**
   * The highlight follows the ITEM'S OWN colour, defaulting to primary — the
   * same recipe `Listbox` landed on, matched rather than re-invented so a
   * `<Select>` and a standalone menu do not highlight differently. A hardcoded
   * citrine wash made a destructive option look identical to a neutral one,
   * which is the single place a menu most needs to say something different.
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
        ctx.toggle(key);
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

SelectItem.displayName = 'SelectItem';

/* ============================================================
   <Select>
   ============================================================ */

type SelectKeysInput = Iterable<string> | 'all' | string[] | Set<string> | null | undefined;

function toKeySet(input: SelectKeysInput): Set<string> {
  if (!input || input === 'all') return new Set<string>();
  if (input instanceof Set) return new Set(Array.from(input).map(String));
  if (Array.isArray(input)) return new Set(input.map(String));
  // Iterable
  return new Set(Array.from(input as Iterable<string>).map(String));
}

export interface SelectProps {
  label?: React.ReactNode;
  placeholder?: React.ReactNode;
  description?: React.ReactNode;
  errorMessage?: React.ReactNode;
  isInvalid?: boolean;
  isDisabled?: boolean;
  isRequired?: boolean;
  isLoading?: boolean;
  /**
   * CLEARABLE BY DEFAULT (owner decision, 2026-08-14): a Select holding a
   * selection offers ✕ unless it opts out. Opt-outs: `isClearable={false}`,
   * `isRequired` (a required field must hold a value; explicit
   * `isClearable` wins even then), or `disallowEmptySelection`.
   */
  isClearable?: boolean;
  onClear?: () => void;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  color?: HeroUIColor;
  variant?: SelectVariant;
  selectionMode?: 'single' | 'multiple';
  selectedKeys?: SelectKeysInput;
  defaultSelectedKeys?: SelectKeysInput;
  disabledKeys?: Iterable<string>;
  /** HeroUI-style — fires with a `Set<string>` of selected keys.
   * Typed as `any` to match HeroUI's loose signature (`"all" | Iterable<Key>`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSelectionChange?: (keys: any) => void;
  /** Native-like — fires with a synthetic event whose `target.value` is the first selected key.
   * Mirrors HeroUI's behavior when consumers spread native handlers. */
  onChange?: (event: { target: { value: string; name?: string } }) => void;
  /** HeroUI compat — receives the new value(s). Mirrors HeroUI single-select semantic. */
  onValueChange?: (value: string | string[]) => void;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  /** Auto-close on selection (HeroUI default true for single, false for multi). */
  closeOnSelect?: boolean;
  className?: string;
  classNames?: {
    base?: string;
    label?: string;
    mainWrapper?: string;
    trigger?: string;
    innerWrapper?: string;
    selectorIcon?: string;
    value?: string;
    listbox?: string;
    listboxWrapper?: string;
    popoverContent?: string;
    helperWrapper?: string;
    description?: string;
    errorMessage?: string;
  };
  /**
   * Scrapbook seeded tilt. Accepted and IGNORED under clay — a clay field does
   * not tilt. Kept so call sites do not have to change.
   */
  rotate?: number;
  fullWidth?: boolean;
  labelPlacement?: 'inside' | 'outside' | 'outside-left';
  /** HeroUI's renderValue lets consumers control the trigger label. */
  renderValue?: (items: Array<{ key: string; textValue: string; data?: unknown }>) => React.ReactNode;
  /** HeroUI compat — when provided, render via this fn instead of children. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items?: Iterable<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  children?: React.ReactNode | ((item: any) => React.ReactNode);
  name?: string;
  id?: string;
  /** HeroUI compat — kept for parity, ignored. */
  validate?: (value: string | string[]) => string | null | undefined | true;
  scrollRef?: React.Ref<HTMLUListElement>;
  popoverProps?: Record<string, unknown>;
  listboxProps?: Record<string, unknown>;
  /** "aria-label" for accessibility when there's no visible label. */
  'aria-label'?: string;
  /** Allow consumers to pin the listbox open; rare. */
  isOpen?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** An empty selection is not a legal state — also opts out of the default ✕. */
  disallowEmptySelection?: boolean;
  /** HeroUI compat — boolean shorthand for `selectionMode='multiple'`. */
  multiple?: boolean;
  /** Passed through to the DOM. */
  dir?: 'rtl' | 'ltr';
  /** Allow style passthrough on the wrapper. */
  style?: React.CSSProperties;
  /** HeroUI compat — kept for parity. */
  spinnerRef?: React.Ref<HTMLDivElement>;
  /** HeroUI compat — kept for parity. */
  hideEmptyContent?: boolean;
  /** HeroUI compat — semantic value (mirrors Select's selectedKeys). */
  value?: string | string[] | Set<string>;
  /** HeroUI compat — semantic default value. */
  defaultValue?: string | string[];
}

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

export function Select(props: SelectProps) {
  const {
    label,
    placeholder = 'Select',
    description,
    errorMessage,
    isInvalid,
    isDisabled,
    isRequired,
    isLoading,
    isClearable,
    onClear,
    size = 'md',
    radius = 'md',
    color = 'default',
    variant = 'bordered',
    multiple,
    selectionMode: selectionModeProp,
    selectedKeys: selectedKeysProp,
    defaultSelectedKeys,
    onSelectionChange,
    onChange,
    onValueChange,
    startContent,
    endContent,
    closeOnSelect: closeOnSelectProp,
    className,
    classNames,
    rotate: _rotate,
    fullWidth = true,
    labelPlacement: _labelPlacement,
    renderValue,
    items,
    children,
    name,
    id,
    validate,
    'aria-label': ariaLabel,
    isOpen: openProp,
    defaultOpen,
    onOpenChange,
    disabledKeys,
    disallowEmptySelection,
    scrollRef,
    popoverProps: _pp,
    listboxProps: _lp,
    dir,
    style,
    spinnerRef: _spinnerRef,
    hideEmptyContent,
    value: valueProp,
    defaultValue,
  } = props;

  const selectionMode: 'single' | 'multiple' = selectionModeProp ?? (multiple ? 'multiple' : 'single');
  const closeOnSelect = closeOnSelectProp ?? selectionMode === 'single';

  // `value` / `defaultValue` are HeroUI compat — convert to a SelectKeysInput.
  const valueAsKeys: SelectKeysInput | undefined = (() => {
    if (valueProp === undefined) return undefined;
    if (typeof valueProp === 'string') return valueProp ? [valueProp] : [];

    return valueProp as SelectKeysInput;
  })();
  const defaultValueAsKeys: SelectKeysInput | undefined = (() => {
    if (defaultValue === undefined) return undefined;
    if (typeof defaultValue === 'string') return defaultValue ? [defaultValue] : [];

    return defaultValue;
  })();


  const reactId = React.useId();
  const triggerId = id ?? reactId;
  const listboxId = `${triggerId}-list`;

  /* ---------- selection state ---------- */
  const isSelectedControlled = selectedKeysProp !== undefined || valueAsKeys !== undefined;
  const [internalSelected, setInternalSelected] = React.useState<Set<string>>(() =>
    toKeySet(defaultSelectedKeys ?? defaultValueAsKeys),
  );

  // Controlled callers commonly pass a fresh array/Set every render
  // (e.g. `selectedKeys={[id]}`); serialize content so the resolved Set is
  // referentially stable across renders, which keeps ctxValue stable and
  // prevents SelectItem from re-registering on every parent render.
  const controlledKeysInput = selectedKeysProp ?? valueAsKeys;
  const controlledKeysSerial = React.useMemo(() => {
    if (!isSelectedControlled) return null;
    if (!controlledKeysInput || controlledKeysInput === 'all') return String(controlledKeysInput);
    try {
      return Array.from(controlledKeysInput as Iterable<string>)
        .map(String)
        .sort()
        .join(' ');
    } catch {
      return '';
    }
  }, [isSelectedControlled, controlledKeysInput]);
  const selectedKeys = React.useMemo<Set<string>>(
    () => (isSelectedControlled ? toKeySet(controlledKeysInput) : internalSelected),
    // controlledKeysSerial captures content changes; controlledKeysInput intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isSelectedControlled, internalSelected, controlledKeysSerial],
  );

  const disabledKeysSerial = React.useMemo(() => {
    if (!disabledKeys) return '';
    try {
      return Array.from(disabledKeys as Iterable<string>)
        .map(String)
        .sort()
        .join(' ');
    } catch {
      return '';
    }
  }, [disabledKeys]);
  const disabledKeySet = React.useMemo(
    () => toKeySet(disabledKeys),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabledKeysSerial],
  );

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

  /* ---------- registered items (for keyboard nav + renderValue) ---------- */
  const [items_, setItems] = React.useState<Map<string, SelectItemDescriptor>>(new Map());
  const orderRef = React.useRef<string[]>([]);
  // Persistent descriptor cache. SelectItems only mount while the dropdown is OPEN, so
  // they unregister from items_ on close — which would make the trigger lose the selected
  // item's label and revert to the placeholder. This cache survives unmount so the trigger
  // can still resolve the label of a selected key after the dropdown closes.
  const labelCacheRef = React.useRef<Map<string, SelectItemDescriptor>>(new Map());
  const registerItem = React.useCallback((d: SelectItemDescriptor) => {
    labelCacheRef.current.set(d.key, d);
    setItems((prev) => {
      const next = new Map(prev);
      next.set(d.key, d);

      return next;
    });
    if (!orderRef.current.includes(d.key)) orderRef.current.push(d.key);
  }, []);
  const unregisterItem = React.useCallback((k: string) => {
    setItems((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Map(prev);
      next.delete(k);

      return next;
    });
    orderRef.current = orderRef.current.filter((x) => x !== k);
  }, []);

  /* ---------- active key for keyboard nav ---------- */
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open && activeKey === null) {
      const first = Array.from(selectedKeys)[0] ?? orderRef.current[0] ?? null;
      setActiveKey(first);
    }
    if (!open) setActiveKey(null);
  }, [open, activeKey, selectedKeys]);

  /* ---------- toggle ---------- */
  // Keep current selection accessible inside toggle without depending on it,
  // so toggle's identity stays stable across renders (prevents ctxValue churn).
  const selectedKeysRef = React.useRef(selectedKeys);
  selectedKeysRef.current = selectedKeys;
  const toggle = React.useCallback(
    (key: string) => {
      if (disabledKeySet.has(key)) return;
      const current = selectedKeysRef.current;
      let next: Set<string>;
      if (selectionMode === 'multiple') {
        next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
      } else {
        next = new Set([key]);
      }
      if (!isSelectedControlled) setInternalSelected(next);
      onSelectionChange?.(next);
      // Native-like onChange for consumers that read e.target.value:
      const first = Array.from(next)[0] ?? '';
      onChange?.({ target: { value: first, name } });
      onValueChange?.(selectionMode === 'multiple' ? Array.from(next) : first);
      if (closeOnSelect) setOpen(false);
    },
    [
      disabledKeySet,
      selectionMode,
      isSelectedControlled,
      onSelectionChange,
      onChange,
      onValueChange,
      name,
      closeOnSelect,
      setOpen,
    ],
  );

  /* ---------- clearing ---------- */
  // Every route a selection normally announces itself through fires on clear
  // too — a consumer whose handler only listens to one of them stays in sync.
  const clearSelection = React.useCallback(() => {
    if (!isSelectedControlled) setInternalSelected(new Set());
    onSelectionChange?.(new Set());
    onValueChange?.(selectionMode === 'multiple' ? [] : '');
    onChange?.({ target: { value: '', name } });
    onClear?.();
  }, [isSelectedControlled, onSelectionChange, onValueChange, onChange, name, selectionMode, onClear]);

  /*
   * Clearable by default; an explicit `isClearable` beats the `isRequired`
   * heuristic in both directions. `disallowEmptySelection` means an empty
   * selection is not a legal state, so it never defaults to clearable.
   */
  const clearable = isClearable ?? (!isRequired && !disallowEmptySelection);
  /*
   * `''` does not count as a selection here: many filters declare an "All"
   * option with `key=''` as their neutral state, and the trigger already
   * renders the placeholder for it (descriptors skip empty keys) — showing a
   * ✕ next to a placeholder, clearing '' to '', would be a permanent dead
   * button on every such filter.
   */
  const hasRealSelection = Array.from(selectedKeys).some((key) => key !== '');
  const showClear = clearable && !isDisabled && !isLoading && hasRealSelection;

  /* ---------- click-outside + escape ---------- */
  const rootRef = React.useRef<HTMLDivElement>(null);
  const listboxRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      // The listbox is portaled to <body>, so it's outside rootRef — ignore clicks in it too.
      if (rootRef.current?.contains(t) || listboxRef.current?.contains(t)) return;
      setOpen(false);
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

  /* ---------- portal positioning ---------- */
  // The listbox is portaled to <body> (below) so it escapes ancestors that clip it — a
  // sheet's overflow-y-auto / transform previously cut the options off-screen. Anchor it
  // to the trigger as `position: fixed`, flip up when there's no room below, and follow
  // the trigger on scroll/resize.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const [pos, setPos] = React.useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
    dropUp: boolean;
  } | null>(null);
  const updatePosition = React.useCallback(() => {
    // Use the id, not querySelector('button'), so we never measure a nested clear/remove button.
    const trigger = (document.getElementById(triggerId) ??
      rootRef.current?.querySelector('button')) as HTMLElement | null;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const GAP = 8;
    const EDGE = 8; // keep off the viewport edges
    const spaceBelow = window.innerHeight - r.bottom - GAP - EDGE;
    const spaceAbove = r.top - GAP - EDGE;
    // Flip up only when there's genuinely more room above.
    const dropUp = spaceAbove > spaceBelow && spaceBelow < 280;
    // Size the list to the room actually available on the chosen side, so it can never
    // overflow the viewport (it scrolls internally instead) — robust to where the trigger lands.
    const maxHeight = Math.max(120, Math.min(320, dropUp ? spaceAbove : spaceBelow));

    setPos({
      left: r.left,
      width: r.width,
      top: dropUp ? undefined : r.bottom + GAP,
      bottom: dropUp ? window.innerHeight - r.top + GAP : undefined,
      maxHeight,
      dropUp,
    });
  }, [triggerId]);
  React.useLayoutEffect(() => {
    if (!open) {
      setPos(null);

      return;
    }
    updatePosition();
    const onScrollResize = () => updatePosition();

    // capture:true so scrolls inside any container (e.g. a modal body) reposition the listbox.
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);

    // The trigger can keep moving AFTER open via a CSS transform (a modal/bottom-sheet
    // entrance animation) or a dvh/URL-bar shift — neither fires scroll or resize, so the
    // one-shot capture would pin the listbox to a stale position (only the tape peeks).
    // Re-measure every frame across the settle window, and observe the trigger's box.
    let raf = 0;
    const start = performance.now();
    const tick = () => {
      updatePosition();
      if (performance.now() - start < 400) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const triggerEl = document.getElementById(triggerId);
    const ro = triggerEl && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => updatePosition()) : null;
    ro?.observe(triggerEl as Element);

    return () => {
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize);
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [open, updatePosition, triggerId]);

  /* ---------- keyboard nav on trigger ---------- */
  const handleTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);

        return;
      }
      const order = orderRef.current.filter((k) => !disabledKeySet.has(k) && !items_.get(k)?.isDisabled);
      if (!order.length) return;
      const idx = activeKey ? order.indexOf(activeKey) : -1;
      const nextIdx = e.key === 'ArrowDown' ? (idx + 1) % order.length : (idx - 1 + order.length) % order.length;
      setActiveKey(order[nextIdx] ?? null);
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (!open) {
        e.preventDefault();
        setOpen(true);

        return;
      }
      if (activeKey !== null) {
        e.preventDefault();
        toggle(activeKey);
      }
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && showClear) {
      // Keyboard route for clearing: the ✕ itself is deliberately not
      // focusable (see below), so the trigger owns the interaction.
      e.preventDefault();
      clearSelection();
    } else if (e.key === 'Home') {
      e.preventDefault();
      const first = orderRef.current.find((k) => !disabledKeySet.has(k));
      if (first) setActiveKey(first);
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = [...orderRef.current].reverse().find((k) => !disabledKeySet.has(k));
      if (last) setActiveKey(last);
    }
  };

  /* ---------- rendering items[] prop variant ---------- */
  const renderedChildren = React.useMemo(() => {
    if (items && typeof children === 'function') {
      const arr: React.ReactNode[] = [];
      const iter = items as Iterable<{ key?: string; id?: string; value?: string; [k: string]: unknown }>;
      const itemsArr = Array.isArray(items)
        ? (items as Array<{ key?: string; id?: string; value?: string; [k: string]: unknown }>)
        : Array.from(iter);
      itemsArr.forEach((item, idx) => {
        const node = (children as (it: typeof item) => React.ReactNode)(item);
        if (React.isValidElement(node)) {
          // Prefer the React `key` the consumer set on the returned element
          // (e.g. `<SelectItem key={item.value}>`). Fall back to common id fields, then index.
          const elementKey = node.key != null ? String(node.key) : '';
          const k = elementKey || String(item.key ?? item.id ?? item.value ?? idx);
          arr.push(
            React.cloneElement(node as React.ReactElement, { key: k, __itemKey: k } as Partial<SelectItemProps>),
          );
        } else {
          arr.push(node);
        }
      });

      return arr;
    }

    // Walk children to inject __itemKey from React `key` (since SelectItem can't read its own key prop).
    if (Array.isArray(children) || React.isValidElement(children)) {
      return React.Children.map(children, (child) => {
        if (React.isValidElement(child)) {
          const k = String((child.key ?? '') as string).replace(/^\.\$/, '');

          return React.cloneElement(child as React.ReactElement, { __itemKey: k } as Partial<SelectItemProps>);
        }

        return child;
      });
    }

    return children;
  }, [items, children]);

  /* ---------- declared descriptors (resolve selected label WITHOUT opening the dropdown) ---------- */
  // ROOT FIX: the interactive <SelectItem>s only mount while the dropdown is OPEN, so they register
  // their descriptors lazily — a controlled/pre-selected value set before the user ever opens the
  // dropdown would have no descriptor and the trigger would fall back to the placeholder (the
  // "selected value not showing" bug). Derive descriptors statically from the declared children/items
  // every render (no mount required) so the selected label always resolves immediately.
  const declaredDescriptors = React.useMemo(() => {
    const map = new Map<string, SelectItemDescriptor>();
    const visit = (node: React.ReactNode) => {
      if (!React.isValidElement(node)) return;
      const p = node.props as SelectItemProps;
      const rawKey = p.value ?? p.__itemKey ?? (node.key != null ? String(node.key).replace(/^\.\$/, '') : undefined);
      const key = rawKey != null ? String(rawKey) : '';
      if (!key) return;
      map.set(key, {
        key,
        textValue: p.textValue ?? (typeof p.children === 'string' ? p.children : key),
        label: p.children,
        startContent: p.startContent,
        endContent: p.endContent,
        description: p.description,
        isDisabled: p.isDisabled,
      });
    };

    React.Children.forEach(renderedChildren as React.ReactNode, visit);

    return map;
  }, [renderedChildren]);

  /* ---------- trigger label (renderValue or selected labels) ---------- */
  // Resolve order: live-registered (open) → declared options (current, even while closed) →
  // label cache (survives an option leaving the list after it was seen).
  const selectedDescriptors = Array.from(selectedKeys)
    .map((k) => items_.get(k) ?? declaredDescriptors.get(k) ?? labelCacheRef.current.get(k))
    .filter(Boolean) as SelectItemDescriptor[];
  const triggerLabel = (() => {
    if (renderValue) {
      return renderValue(selectedDescriptors.map((d) => ({ key: d.key, textValue: d.textValue })));
    }
    if (selectedDescriptors.length === 0) {
      // Placeholder uses the body face (no `font-hand`), same as `Input.tsx`.
      return <span className='text-[color:var(--clay-muted)] font-semibold'>{placeholder}</span>;
    }
    if (selectionMode === 'multiple' && selectedDescriptors.length > 1) {
      return (
        <span className='flex flex-wrap items-center gap-1'>
          {selectedDescriptors.map((d) => (
            <span
              key={d.key}
              className='inline-flex items-center gap-1 rounded-[8px] border-[2px] border-[color:var(--clay-edge)] px-1.5 text-[12px] font-extrabold'
              style={{ background: CLAY_FILL.primary, color: CLAY_LABEL.primary }}
            >
              <span>{d.label}</span>
              {/* span, not <button> — this chip renders INSIDE the trigger
                  button, and nested buttons are invalid DOM (hydration error). */}
              <span
                aria-label='Remove'
                className='inline-flex h-3.5 w-3.5 cursor-pointer items-center justify-center opacity-70 hover:opacity-100'
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(d.key);
                }}
                role='button'
              >
                <svg
                  fill='none'
                  height='10'
                  stroke='currentColor'
                  strokeLinecap='round'
                  strokeWidth={2.6}
                  viewBox='0 0 24 24'
                  width='10'
                >
                  <path d='M18 6 6 18M6 6l12 12' />
                </svg>
              </span>
            </span>
          ))}
        </span>
      );
    }

    // Compact trigger: a string label renders as-is; for a rich/JSX option label we
    // prefer its `textValue` (a clean string the consumer supplied, e.g. a username) so
    // the trigger doesn't render the full option card. Fall back to the JSX label only
    // when there's no meaningful textValue (textValue defaults to the key/id otherwise).
    const d0 = selectedDescriptors[0];
    const compact =
      typeof d0?.label === 'string' ? d0.label : d0?.textValue && d0.textValue !== d0.key ? d0.textValue : d0?.label;

    return <span className='truncate'>{compact}</span>;
  })();

  /* ---------- styling tokens: Input.tsx's field, matched exactly ---------- */
  const isUnderlined = variant === 'underlined';
  const face = FACE[variant];
  /*
   * The focus/invalid border takes the brand as a MARK, not as a FILL.
   * `CLAY_FILL.primary` is a fixed dark purple in both themes, so on a dark
   * field it measures ~1.9-2.9:1 against the fill — a focus indicator you
   * cannot see. The `*-text` tokens are the same brand corrected to read
   * AGAINST the theme, and are the only place in the system that answers this.
   */
  /*
   * `validate` was destructured as `_validate` — renamed purely to silence the
   * unused warning, which is the most explicit form this bug took anywhere. See
   * `useValidation`.
   *
   * The value handed to the rule matches what `onValueChange` emits: an array in
   * `multiple`, the first key (or null) in `single`. A rule written against what
   * the change handler gives you must receive the same shape, or every call site
   * has to branch on `selectionMode` itself.
   *
   * There IS a hidden native field below for form posts, but it is rendered only
   * when `name` is set, so validity is not attached to it — the message and the
   * invalid paint are the whole mechanism here.
   */
  const validationValue = React.useMemo(
    () => (selectionMode === 'multiple' ? Array.from(selectedKeys) : (Array.from(selectedKeys)[0] ?? '')),
    [selectionMode, selectedKeys],
  );
  const validation = useValidation<string | string[]>(validate, validationValue);
  const effectiveInvalid = isInvalid || validation.isInvalid;
  const effectiveError = errorMessage ?? validation.shown;

  const focusEdge = effectiveInvalid ? HEROUI_COLOR_TEXT.danger : HEROUI_COLOR_TEXT.primary;

  const triggerStyle = {
    background: face,
    // `shapeFrom` colours the border from the brand without staining the face;
    // `clayVars` never touches `background`.
    ...clayVars(isUnderlined ? SURFACE : face, {
      shapeFrom: effectiveInvalid ? CLAY_FILL.danger : color === 'default' ? undefined : CLAY_FILL[color],
      // The profile follows the SHAPE's luminance, not the face's and not the
      // `color` prop — `clayKindFor` selects by colour NAME and cannot be asked
      // this. Off a near-white face the shape IS that face, so it needs
      // `control`; a saturated `shapeFrom` would be over-darkened by it.
      kind: effectiveInvalid || color !== 'default' ? 'brand' : 'control',
      // Shallower than a button's 6. A field is a static raised surface, not a
      // press, and it sits in a row of controls it must not out-shout.
      depth: 4,
    }),
    '--clay-edge-hover': HOVER_EDGE,
    '--clay-focus': focusEdge,
    '--clay-muted': MUTED,
  } as React.CSSProperties;

  // Memoize so SelectItem's registration effect doesn't re-run every parent
  // render. Without this, every render unregisters + re-registers each item,
  // briefly emptying items_ and clobbering the trigger label after selection.
  const close = React.useCallback(() => setOpen(false), [setOpen]);
  const ctxValue = React.useMemo<SelectContextValue>(
    () => ({
      selectedKeys,
      toggle,
      selectionMode,
      closeOnSelect,
      close,
      registerItem,
      unregisterItem,
      activeKey,
      setActiveKey,
    }),
    [selectedKeys, toggle, selectionMode, closeOnSelect, close, registerItem, unregisterItem, activeKey],
  );

  return (
    <SelectContext.Provider value={ctxValue}>
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
          <button
            aria-controls={listboxId}
            aria-expanded={open}
            aria-haspopup='listbox'
            aria-invalid={effectiveInvalid || undefined}
            aria-label={ariaLabel}
            className={cn(
              'relative flex w-full items-center gap-2 px-5 py-2 text-start',
              // Only the border colour animates. Nothing translates and nothing
              // lifts: a flat field, with the border doing all the work.
              'transition-[border-color,outline-color] duration-150 motion-reduce:transition-none',
              // `.clay-panel` is what actually PAINTS `--clay-rest`. Without it the
              // trigger set every clay var and drew no shadow at all — a 2px grey
              // outline on a flat rectangle, which is the bug the Input port fixed and
              // this trigger still had. Same class, same depth, so a Select and an
              // Input standing next to each other are the same object.
              !isUnderlined && 'clay-panel border-[2px] border-[color:var(--clay-edge)]',
              isUnderlined && 'border-x-0 border-t-0 border-b-[2px] border-[color:var(--clay-edge)] rounded-none',
              // The neutral darkens when you point at it.
              !isDisabled && 'hover:border-[color:var(--clay-edge-hover)]',
              isDisabled && 'cursor-not-allowed opacity-50',
              !isDisabled && 'cursor-pointer',
              /*
               * Focus: the border takes the brand colour AND thickens, via a 1px
               * `outline` at offset 0 sitting flush outside the 2px border — one
               * 3px edge, no layout shift, and `box-shadow` not involved at all.
               *
               * Two separate properties, so neither can silently replace the
               * other. That is the whole reason this replaced the old
               * `!important` box-shadow composition: Tailwind's ring compiles to
               * a box-shadow, could not beat the `!` on the base rule, and left
               * the trigger with NO focus indicator at all (WCAG 2.4.7, level A).
               * On `border-color` + `outline` the collision cannot happen.
               */
              'focus-visible:outline focus-visible:outline-[1px] focus-visible:outline-offset-0',
              'focus-visible:outline-[color:var(--clay-focus)]',
              'focus-visible:border-[color:var(--clay-focus)]',
              SIZE[size],
              isUnderlined ? 'rounded-none' : RADIUS[radius],
              classNames?.trigger,
              classNames?.innerWrapper,
            )}
            disabled={isDisabled}
            id={triggerId}
            onClick={() => !isDisabled && setOpen(!open)}
            onKeyDown={handleTriggerKey}
            style={triggerStyle as React.CSSProperties}
            type='button'
          >
            {startContent ? <span className='shrink-0'>{startContent}</span> : null}
            <span className={cn('text-ink flex min-w-0 flex-1 items-center font-bold', classNames?.value)}>
              {triggerLabel}
            </span>
            {isLoading ? (
              <svg
                aria-hidden
                className='shrink-0 animate-spin'
                fill='none'
                height='16'
                stroke='currentColor'
                strokeLinecap='round'
                strokeWidth={2.6}
                viewBox='0 0 24 24'
                width='16'
              >
                <path d='M12 3 a9 9 0 0 1 9 9' />
              </svg>
            ) : null}
            {showClear ? (
              /*
               * NOT a <button>: the trigger already is one, and a button
               * inside a button is invalid DOM that React rejects at
               * hydration (the packages-list filter broke exactly this way).
               * A span with role='button' is legal markup; it stays out of
               * the tab order on purpose — keyboard users clear with
               * Backspace/Delete on the trigger itself.
               */
              <span
                aria-label='Clear selection'
                className='text-ink/60 hover:text-ink inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full'
                onClick={(e) => {
                  e.stopPropagation();
                  clearSelection();
                }}
                role='button'
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
              </span>
            ) : null}
            {endContent ? <span className='shrink-0'>{endContent}</span> : null}
            <span aria-hidden className={cn('text-ink/70 inline-flex shrink-0', classNames?.selectorIcon)}>
              <ChevronIcon open={open} />
            </span>
          </button>

          {mounted
            ? createPortal(
                <AnimatePresence>
                  {open && pos ? (
                    <motion.div
                      ref={listboxRef}
                      animate={{ opacity: 1, y: 0, rotate: -0.3 }}
                      className={cn('fixed z-[200]', classNames?.popoverContent, classNames?.listboxWrapper)}
                      dir={dir}
                      exit={{ opacity: 0, y: pos.dropUp ? 4 : -4, rotate: 0 }}
                      initial={{ opacity: 0, y: pos.dropUp ? 6 : -6, rotate: 0 }}
                      style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
                      transition={{ duration: 0.16, ease: [0.3, 0.6, 0.2, 1.2] }}
                    >
                      <ul
                        ref={scrollRef}
                        aria-multiselectable={selectionMode === 'multiple' || undefined}
                        style={{
                          maxHeight: pos.maxHeight,
                          background: 'var(--card-bg)',
                          ...clayVars('var(--card-bg)', { kind: 'surface', depth: 8 }),
                        }}
                        className={cn(
                          'relative w-full overflow-auto',
                          // ONE arbitrary declaration, not `border-sk border-line`. `cn` is
                          // tailwind-merge and cannot tell the WIDTH token from the COLOR token
                          // (both read as `border-{value}`), so it kept only `border-line` and
                          // the panel shipped with `border-width: 0px` — no border at all.
                          // `.clay-panel` — raised, no hover rule: a floating
                          // listbox answering the cursor is an affordance lie.
                          // `.clay-panel` reads `--clay-rest`, and the three
                          // clay vars must be set ON THIS ELEMENT: the panel is
                          // rendered outside the trigger, so nothing it needs is
                          // inherited. Setting only the class shipped a panel
                          // with `box-shadow: none` — and an undefined
                          // `var(--clay-edge)` inside the `border` SHORTHAND
                          // invalidates the whole declaration, which is how the
                          // border came out `0px`. Both measured, both from the
                          // same missing style object.
                          'clay-panel [border:3px_solid_var(--clay-edge)]',
                          'rounded-[18px] p-1',
                          classNames?.listbox,
                        )}
                        id={listboxId}
                        role='listbox'
                      >
                        {renderedChildren}
                        {!hideEmptyContent && React.Children.count(renderedChildren as React.ReactNode) === 0 ? (
                          <li className='text-ink-muted px-4 py-3 text-[14px] font-semibold'>No options</li>
                        ) : null}
                      </ul>
                    </motion.div>
                  ) : null}
                </AnimatePresence>,
                document.body,
              )
            : null}
        </div>
        {description || effectiveError ? (
          <div className={cn('flex flex-col gap-0.5', classNames?.helperWrapper)}>
            {effectiveError ? (
              <span className={cn('text-sk-red text-[13px] font-bold', classNames?.errorMessage)}>
                {effectiveError}
              </span>
            ) : description ? (
              <span className={cn('text-ink-muted text-[13px] font-medium', classNames?.description)}>
                {description}
              </span>
            ) : null}
          </div>
        ) : null}
        {/* Hidden native field for native form posts. */}
        {name ? (
          <select
            aria-hidden
            className='hidden'
            multiple={selectionMode === 'multiple'}
            name={name}
            onChange={() => {
              /* controlled by toggle() */
            }}
            value={selectionMode === 'multiple' ? Array.from(selectedKeys) : (Array.from(selectedKeys)[0] ?? '')}
          >
            {Array.from(
              // The hidden <select> must expose an <option> for the CURRENT value even when the
              // dropdown is CLOSED — otherwise native form submission loses the value. Interactive
              // <SelectItem>s only register into `items_` while open, so union the statically
              // declared descriptors (always available) with any live items and the selected keys.
              (() => {
                const opts = new Map(declaredDescriptors);
                items_.forEach((d, k) => opts.set(k, d));
                selectedKeys.forEach((k) => {
                  if (!opts.has(k)) opts.set(k, labelCacheRef.current.get(k) ?? { key: k, textValue: k, label: k });
                });

                return opts.values();
              })(),
            ).map((d) => (
              <option key={d.key} value={d.key}>
                {d.textValue}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </SelectContext.Provider>
  );
}

Select.displayName = 'Select';
