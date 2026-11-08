import React from 'react';

import { cn } from '../../cn';
import { Checkbox } from '../Checkbox';
import { Spinner } from '../Spinner';
import { CLAY_RIM, clayKindFor, clayVars } from '../clay';
import type { HeroUIColor, HeroUIRadius } from '../tokens';

/**
 * da-v2 Table — drop-in replacement for HeroUI's Table compound component.
 *
 *   <Table aria-label selectionMode sortDescriptor onSortChange isStriped ...>
 *     <TableHeader columns?>{...}</TableHeader>
 *     <TableBody items? emptyContent loadingContent loadingState>{...}</TableBody>
 *   </Table>
 *
 * Both `TableHeader` and `TableBody` accept render-prop OR static children:
 *
 *   // Render-prop:
 *   <TableHeader columns={cols}>{(c) => <TableColumn key={c.key}>{c.label}</TableColumn>}</TableHeader>
 *   <TableBody items={rows}>{(item) => <TableRow key={item.id}>{(k) => <TableCell>{item[k]}</TableCell>}</TableRow>}</TableBody>
 *
 *   // Static:
 *   <TableHeader>
 *     <TableColumn key='name' allowsSorting>Name</TableColumn>
 *   </TableHeader>
 *   <TableBody>
 *     <TableRow key={id}><TableCell>{...}</TableCell></TableRow>
 *   </TableBody>
 *
 * Visual contract — CLAY, tier 4. A table is not a slab you push: it gets no lip
 * and no press ladder. What survives the scrapbook is the part doing STRUCTURAL
 * work, re-tokened:
 *
 *   - the outer frame becomes `CLAY_RIM`, the shared tier-4 framing rim;
 *   - the rules resolve into two weights, STRUCTURE and SEPARATION. The frame
 *     and the header/body split are structure and share `CLAY_RIM`; the row
 *     hairlines are separation and take the quieter surface edge. The old
 *     `--line` made all three track the theme instead of their job: 18.65:1 in
 *     light against 2.29:1 in dark, with row rules at 1.14:1 (invisible);
 *   - the surface moves off `--paper` onto `--card-bg`. `--paper` IS the page
 *     rung in light (`--surface-0`, the same literal `#fbfaf6`), so the table
 *     was painting the page colour and relying on an ink border to be seen.
 *
 * Row hover and selection stay CITRINE deliberately. It is brand-CONSTANT, which
 * is what a wash under a label needs, and it measures 15.86:1 light / 5.88:1 dark
 * for the selected label. Swapping it for `CLAY_FILL[color]` is the exact move
 * that shipped a 2.49:1 indicator in the Accordion port.
 */

/* ============================================================
   Shared types
   ============================================================ */

export type TableSelectionMode = 'none' | 'single' | 'multiple';
export type TableSelectionBehavior = 'toggle' | 'replace';
export type TableSelection = 'all' | Set<React.Key>;
export type TableSortDirection = 'ascending' | 'descending';

export interface TableSortDescriptor {
  column?: React.Key;
  direction?: TableSortDirection;
}

export type TableLoadingState = 'idle' | 'loading' | 'sorting' | 'loadingMore' | 'error' | 'filtering';

export interface TableClassNames {
  base?: string;
  table?: string;
  thead?: string;
  tbody?: string;
  tr?: string;
  th?: string;
  td?: string;
  tfoot?: string;
  sortIcon?: string;
  emptyWrapper?: string;
  loadingWrapper?: string;
  wrapper?: string;
}

/* ============================================================
   Context
   ============================================================ */

interface TableContextValue {
  selectionMode: TableSelectionMode;
  selectionBehavior: TableSelectionBehavior;
  selectedKeys: TableSelection;
  disabledKeys: Set<React.Key>;
  toggleRow: (key: React.Key) => void;
  toggleAll: () => void;
  totalRowKeys: React.Key[];
  showSelectionCheckboxes: boolean;
  color: HeroUIColor;
  isCompact: boolean;
  isStriped: boolean;
  isHeaderSticky: boolean;
  hideHeader: boolean;
  layout: 'auto' | 'fixed';
  sortDescriptor?: TableSortDescriptor;
  setSortDescriptor: (column: React.Key) => void;
  classNames?: TableClassNames;
  loadingState?: TableLoadingState;
  isLoading: boolean;
  /** Keys (in declared order) for the current TableHeader. Used to pre-compute
   *  column order so TableRow's render-prop can iterate. */
  columnKeys: React.Key[];
  /** Internal — populated by TableHeader to hand off to TableBody/TableRow. */
  registerColumns: (keys: React.Key[]) => void;
}

const TableContext = React.createContext<TableContextValue | null>(null);

function useTableContext(name: string): TableContextValue {
  const ctx = React.useContext(TableContext);
  if (!ctx) {
    throw new Error(`<${name}> must be used inside <Table>`);
  }

  return ctx;
}

/* ============================================================
   <Table> — the orchestrator
   ============================================================ */

export interface TableProps {
  children?: React.ReactNode;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
  classNames?: TableClassNames;
  id?: string;
  role?: string;
  dir?: 'rtl' | 'ltr' | 'auto';
  style?: React.CSSProperties;

  selectionMode?: TableSelectionMode;
  selectionBehavior?: TableSelectionBehavior;
  selectedKeys?: TableSelection | Iterable<React.Key>;
  defaultSelectedKeys?: TableSelection | Iterable<React.Key>;
  disabledKeys?: Iterable<React.Key>;
  onSelectionChange?: (keys: TableSelection) => void;
  showSelectionCheckboxes?: boolean;

  sortDescriptor?: TableSortDescriptor;
  defaultSortDescriptor?: TableSortDescriptor;
  onSortChange?: (descriptor: TableSortDescriptor) => void;

  /**
   * No-op in clay. It only ever tinted the hard offset shadow, which tier 4
   * does not have. Still read by context for API parity; nothing paints it.
   * (HeroUI uses `color` for the SELECTED ROW — deliberately not adopted here:
   * selection is citrine, which is brand-CONSTANT and therefore survives both
   * themes under a label. See the class comment on the selected row.)
   */
  color?: HeroUIColor;
  layout?: 'auto' | 'fixed';
  isCompact?: boolean;
  isStriped?: boolean;
  isHeaderSticky?: boolean;
  hideHeader?: boolean;
  removeWrapper?: boolean;
  fullWidth?: boolean;
  /**
   * No-op in clay. A table is tier 4: it is a bounded region of data, not an
   * object standing off the page, so it has no lip for this to size. Kept
   * accepted — it is passed once in the repo (`shadow='sm'`).
   */
  shadow?: 'none' | 'sm' | 'md' | 'lg';
  /** Corner radius. Clay's ladder, one step below Card's 24px. */
  radius?: 'none' | HeroUIRadius;

  topContent?: React.ReactNode;
  bottomContent?: React.ReactNode;
  topContentPlacement?: 'inside' | 'outside';
  bottomContentPlacement?: 'inside' | 'outside';

  isLoading?: boolean;
  /** HeroUI compat — accepted but stubbed (no virtualization). */
  isVirtualized?: boolean;
  maxTableHeight?: number;
  rowHeight?: number;

  /** HeroUI compat — forwarded to selection checkbox cells. */
  checkboxesProps?: Record<string, unknown>;
}

/**
 * The table's own surface. `--card-bg`, not `--paper`: in the light theme
 * `--paper` and `--surface-0` are the same literal value, so a table painted
 * `bg-paper` was the page colour and only read because of an ink border clay
 * deletes. This is the token Popover, Accordion, Input, Select and Card all use.
 */
const TABLE_FILL = 'var(--card-bg)';

/**
 * Two rule weights, and they are deliberately different — the old `--line` gave
 * the outer frame and the header/body split an identical 18.65:1 in light.
 *
 *   FRAME + header split -> `CLAY_RIM`. A table frames content, which is the
 *     same job Avatar's rim does, and `clay.ts` says every tier-4 component that
 *     frames content wants this one. Measured there: 3.88:1 light / 5.27:1 dark.
 *   row hairlines -> the `surface` profile's edge. A row rule should be quiet;
 *     what it must not be is theme-dependent, and `--line`/20 was 1.56:1 in
 *     light and 1.14:1 in dark. Deriving it from the surface makes it the same
 *     relationship in both.
 */
const ROW_RULE = (clayVars(TABLE_FILL, { kind: clayKindFor('default') }) as Record<string, string>)['--clay-edge'];

// Clay's radius ladder, written out literally — Tailwind's JIT cannot see
// through a template literal. A table is dense and rectilinear, so it sits a
// step below Card's 24px.
const RADIUS_MAP: Record<NonNullable<TableProps['radius']>, string> = {
  none: 'rounded-none',
  sm: 'rounded-[10px]',
  md: 'rounded-[14px]',
  lg: 'rounded-[18px]',
  full: 'rounded-[18px]',
};

export function Table(props: TableProps) {
  const {
    children,
    className,
    classNames,
    selectionMode = 'none',
    selectionBehavior = 'toggle',
    selectedKeys: controlledKeys,
    defaultSelectedKeys,
    disabledKeys,
    onSelectionChange,
    showSelectionCheckboxes = true,
    sortDescriptor: controlledSort,
    defaultSortDescriptor,
    onSortChange,
    color = 'primary',
    layout = 'auto',
    isCompact = false,
    isStriped = false,
    isHeaderSticky = false,
    hideHeader = false,
    removeWrapper = false,
    fullWidth = true,
    shadow = 'md',
    radius = 'md',
    topContent,
    bottomContent,
    topContentPlacement = 'inside',
    bottomContentPlacement = 'inside',
    isLoading = false,
    maxTableHeight,
    rowHeight,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    id,
    role,
    dir,
    style,
  } = props;

  /* ---------- selection state ---------- */
  const isSelectionControlled = controlledKeys !== undefined;
  const normalizeSel = React.useCallback((v: TableSelection | Iterable<React.Key> | undefined): TableSelection => {
    if (v === undefined) return new Set<React.Key>();
    if (v === 'all') return 'all';
    if (v instanceof Set) return v;

    return new Set(Array.from(v));
  }, []);

  const [internalSel, setInternalSel] = React.useState<TableSelection>(() => normalizeSel(defaultSelectedKeys));

  const selectedKeys: TableSelection = isSelectionControlled ? normalizeSel(controlledKeys) : internalSel;

  const disabledKeySet = React.useMemo<Set<React.Key>>(
    () => (disabledKeys ? new Set(Array.from(disabledKeys)) : new Set()),
    [disabledKeys],
  );

  /* ---------- column registration (header → context → rows) ---------- */
  const [columnKeys, setColumnKeys] = React.useState<React.Key[]>([]);
  const registerColumns = React.useCallback((keys: React.Key[]) => {
    setColumnKeys((prev) => {
      if (prev.length === keys.length && prev.every((k, i) => k === keys[i])) return prev;

      return keys;
    });
  }, []);

  /* ---------- row key collection (for select-all) ---------- */
  // We collect row keys lazily — TableBody calls back with its keys once it
  // resolves them (static children OR items render-prop).
  const [rowKeysList, setRowKeysList] = React.useState<React.Key[]>([]);
  const totalRowKeysRef = React.useRef<React.Key[]>([]);
  React.useEffect(() => {
    totalRowKeysRef.current = rowKeysList;
  }, [rowKeysList]);

  /* ---------- selection actions ---------- */
  const updateSelection = React.useCallback(
    (next: TableSelection) => {
      if (!isSelectionControlled) setInternalSel(next);
      onSelectionChange?.(next);
    },
    [isSelectionControlled, onSelectionChange],
  );

  const toggleRow = React.useCallback(
    (key: React.Key) => {
      if (selectionMode === 'none') return;
      if (disabledKeySet.has(key)) return;

      if (selectionMode === 'single') {
        const isAlreadySelected = selectedKeys === 'all' || (selectedKeys instanceof Set && selectedKeys.has(key));
        if (isAlreadySelected) {
          if (selectionBehavior === 'replace') return;
          updateSelection(new Set<React.Key>());
        } else {
          updateSelection(new Set<React.Key>([key]));
        }

        return;
      }

      // multiple
      const current = selectedKeys === 'all' ? new Set<React.Key>(totalRowKeysRef.current) : new Set(selectedKeys);
      if (current.has(key)) current.delete(key);
      else current.add(key);
      updateSelection(current);
    },
    [disabledKeySet, selectedKeys, selectionBehavior, selectionMode, updateSelection],
  );

  const toggleAll = React.useCallback(() => {
    if (selectionMode !== 'multiple') return;
    const allKeys = totalRowKeysRef.current.filter((k) => !disabledKeySet.has(k));
    const isAll =
      selectedKeys === 'all' ||
      (selectedKeys instanceof Set &&
        allKeys.length > 0 &&
        allKeys.every((k) => (selectedKeys as Set<React.Key>).has(k)));
    if (isAll) {
      updateSelection(new Set<React.Key>());
    } else {
      updateSelection(new Set<React.Key>(allKeys));
    }
  }, [disabledKeySet, selectedKeys, selectionMode, updateSelection]);

  /* ---------- sort state ---------- */
  const isSortControlled = controlledSort !== undefined;
  const [internalSort, setInternalSort] = React.useState<TableSortDescriptor | undefined>(defaultSortDescriptor);
  const sortDescriptor = isSortControlled ? controlledSort : internalSort;

  const setSortDescriptor = React.useCallback(
    (column: React.Key) => {
      const current = sortDescriptor;
      let nextDir: TableSortDirection = 'ascending';
      if (current?.column === column && current.direction === 'ascending') {
        nextDir = 'descending';
      }
      const next: TableSortDescriptor = { column, direction: nextDir };
      if (!isSortControlled) setInternalSort(next);
      onSortChange?.(next);
    },
    [isSortControlled, onSortChange, sortDescriptor],
  );

  /* ---------- row key collector handle exposed via cloneElement on TableBody ---------- */
  const handleBodyKeys = React.useCallback((keys: React.Key[]) => {
    setRowKeysList((prev) => {
      if (prev.length === keys.length && prev.every((k, i) => k === keys[i])) return prev;

      return keys;
    });
  }, []);

  /* ---------- compose context ---------- */
  const ctxValue = React.useMemo<TableContextValue>(
    () => ({
      selectionMode,
      selectionBehavior,
      selectedKeys,
      disabledKeys: disabledKeySet,
      toggleRow,
      toggleAll,
      totalRowKeys: rowKeysList,
      showSelectionCheckboxes,
      color,
      isCompact,
      isStriped,
      isHeaderSticky,
      hideHeader,
      layout,
      sortDescriptor,
      setSortDescriptor,
      classNames,
      loadingState: isLoading ? 'loading' : 'idle',
      isLoading,
      columnKeys,
      registerColumns,
    }),
    [
      selectionMode,
      selectionBehavior,
      selectedKeys,
      disabledKeySet,
      toggleRow,
      toggleAll,
      rowKeysList,
      showSelectionCheckboxes,
      color,
      isCompact,
      isStriped,
      isHeaderSticky,
      hideHeader,
      layout,
      sortDescriptor,
      setSortDescriptor,
      classNames,
      isLoading,
      columnKeys,
      registerColumns,
    ],
  );

  /* ---------- mount: inject row-key collector into TableBody ---------- */
  const decoratedChildren = React.useMemo(() => {
    return React.Children.map(children, (child) => {
      if (!React.isValidElement(child)) return child;
      const ctype = (child.type as { displayName?: string } | undefined)?.displayName;
      if (ctype === 'TableBody') {
        return React.cloneElement(
          child as React.ReactElement,
          {
            __reportKeys: handleBodyKeys,
          } as Partial<TableBodyProps>,
        );
      }

      return child;
    });
  }, [children, handleBodyKeys]);

  /* ---------- wrapper visuals ----------
   * The hard diagonal `4px 4px 0` offset shadow is gone with the scrapbook, and
   * tier 4 does not replace it with a lip: a table is a bounded region of data,
   * not an object that stands off the page. `shadow` and `color` are therefore
   * documented no-ops — see their prop docs. Between them they are passed once
   * in the whole repo (`shadow='sm'`).
   */

  const tableEl = (
    <div
      className={cn(
        'relative',
        // Wide tables must always scroll horizontally — HeroUI's wrapper did this by
        // default. Without it the table is clipped (the base below is overflow-hidden)
        // and unreachable on narrow screens. Sticky header / max-height add vertical scroll.
        isHeaderSticky ? 'overflow-auto' : 'overflow-x-auto',
        classNames?.wrapper,
      )}
      style={maxTableHeight !== undefined ? { maxHeight: maxTableHeight, overflow: 'auto' } : undefined}
    >
      <table
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn(
          'text-ink w-full border-collapse text-[14px]',
          layout === 'fixed' ? 'table-fixed' : 'table-auto',
          fullWidth && 'w-full',
          classNames?.table,
        )}
        style={rowHeight !== undefined ? { ['--sk-row-h' as string]: `${rowHeight}px` } : undefined}
      >
        {decoratedChildren}
      </table>
    </div>
  );

  const wrapped = removeWrapper ? (
    tableEl
  ) : (
    <div
      className={cn(
        // One `!`-important shorthand. It was `!border-sk !border-line !border-solid`,
        // which twMerge collapsed to `!border-line` (it files a custom width and a custom
        // colour in the same group) — importance does not change which class survives.
        'relative overflow-hidden border-[3px]',
        RADIUS_MAP[radius],
        className,
        classNames?.base,
      )}
      style={{ background: TABLE_FILL, borderColor: CLAY_RIM }}
    >
      {topContent && topContentPlacement === 'inside' ? (
        <div className='border-b-[1.5px] px-4 py-3' style={{ borderBottomColor: ROW_RULE }}>
          {topContent}
        </div>
      ) : null}
      {tableEl}
      {bottomContent && bottomContentPlacement === 'inside' ? (
        <div className='border-t-[1.5px] px-4 py-3' style={{ borderTopColor: ROW_RULE }}>
          {bottomContent}
        </div>
      ) : null}
    </div>
  );

  return (
    <TableContext.Provider value={ctxValue}>
      <div
        className={cn('flex flex-col gap-3', !removeWrapper && fullWidth && 'w-full')}
        dir={dir}
        id={id}
        role={role}
        style={style}
      >
        {topContent && topContentPlacement === 'outside' ? <div>{topContent}</div> : null}
        {wrapped}
        {bottomContent && bottomContentPlacement === 'outside' ? <div>{bottomContent}</div> : null}
      </div>
    </TableContext.Provider>
  );
}

Table.displayName = 'Table';

/* ============================================================
   <TableHeader>
   ============================================================ */

interface ColumnDescriptor {
  key: React.Key;
  label?: React.ReactNode;
  sortable?: boolean;
  [k: string]: unknown;
}

export interface TableHeaderProps<T extends ColumnDescriptor = ColumnDescriptor> {
  children: React.ReactNode | ((column: T) => React.ReactNode);
  columns?: Iterable<T>;
  className?: string;
}

export function TableHeader<T extends ColumnDescriptor = ColumnDescriptor>(props: TableHeaderProps<T>) {
  const ctx = useTableContext('TableHeader');
  const { children, columns, className } = props;

  /* ---------- resolve column children ---------- */
  const resolved: React.ReactElement[] = [];

  if (columns && typeof children === 'function') {
    const list = Array.isArray(columns) ? columns : Array.from(columns);
    list.forEach((col) => {
      const node = (children as (c: T) => React.ReactNode)(col);
      if (React.isValidElement(node)) {
        const k = (node.key ?? col.key) as React.Key;
        resolved.push(
          React.cloneElement(node as React.ReactElement, { key: k, __columnKey: k } as Partial<TableColumnProps>),
        );
      }
    });
  } else {
    React.Children.forEach(children as React.ReactNode, (child) => {
      if (!React.isValidElement(child)) return;
      const k = (child.key ?? '') as React.Key;
      resolved.push(React.cloneElement(child as React.ReactElement, { __columnKey: k } as Partial<TableColumnProps>));
    });
  }

  /* ---------- register column keys with the orchestrator ---------- */
  const keysSig = resolved.map((el) => String(el.key ?? ''));
  const keysSigJoined = keysSig.join('|');
  React.useEffect(() => {
    ctx.registerColumns(resolved.map((el) => (el.key ?? '') as React.Key));
    // We intentionally watch the joined signature, not the array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSigJoined]);

  if (ctx.hideHeader) return null;

  /* ---------- selection-all checkbox in the leading column ---------- */
  const showCheckbox = ctx.selectionMode !== 'none' && ctx.showSelectionCheckboxes;
  const allKeys = ctx.totalRowKeys.filter((k) => !ctx.disabledKeys.has(k));
  const allSelected =
    ctx.selectedKeys === 'all' ||
    (ctx.selectedKeys instanceof Set &&
      allKeys.length > 0 &&
      allKeys.every((k) => (ctx.selectedKeys as Set<React.Key>).has(k)));
  const someSelected = ctx.selectedKeys instanceof Set && ctx.selectedKeys.size > 0 && !allSelected;

  return (
    <thead
      className={cn(
        'bg-[var(--card-bg)] text-ink',
        ctx.isHeaderSticky && 'sticky top-0 z-[1]',
        className,
        ctx.classNames?.thead,
      )}
    >
      <tr className={cn(ctx.classNames?.tr)}>
        {showCheckbox ? (
          <th
            className={cn(
              'bg-[var(--card-bg)] w-[40px] border-b-[2px] px-2 py-3 text-start',
              ctx.isHeaderSticky && 'sticky right-auto top-0 z-[2]',
            )}
            style={{ borderBottomColor: CLAY_RIM }}
          >
            {ctx.selectionMode === 'multiple' ? (
              <Checkbox
                aria-label='Select all rows'
                isIndeterminate={someSelected && !allSelected}
                isSelected={allSelected}
                onValueChange={() => ctx.toggleAll()}
                size='sm'
              />
            ) : null}
          </th>
        ) : null}
        {resolved}
      </tr>
    </thead>
  );
}

TableHeader.displayName = 'TableHeader';

/* ============================================================
   <TableColumn>
   ============================================================ */

export interface TableColumnProps {
  children?: React.ReactNode;
  className?: string;
  align?: 'start' | 'center' | 'end';
  width?: number | string;
  minWidth?: number | string;
  maxWidth?: number | string;
  allowsSorting?: boolean;
  hideHeader?: boolean;
  textValue?: string;
  /** Internal — set by TableHeader. */
  __columnKey?: React.Key;
}

const ALIGN_CLASS: Record<NonNullable<TableColumnProps['align']>, string> = {
  start: 'text-start',
  center: 'text-center',
  end: 'text-end',
};

export function TableColumn(props: TableColumnProps) {
  const ctx = useTableContext('TableColumn');
  const { children, className, align = 'start', width, minWidth, maxWidth, allowsSorting, __columnKey } = props;

  const colKey = __columnKey;
  const isSorted = ctx.sortDescriptor?.column === colKey && colKey !== undefined;
  const direction = isSorted ? ctx.sortDescriptor?.direction : undefined;

  const handleSort = () => {
    if (!allowsSorting || colKey === undefined) return;
    ctx.setSortDescriptor(colKey);
  };

  const innerStyle: React.CSSProperties = {
    width: typeof width === 'number' ? `${width}px` : width,
    minWidth: typeof minWidth === 'number' ? `${minWidth}px` : minWidth,
    maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth,
    // The header/body split is structure, so it takes the framing rim rather
    // than the quiet row weight.
    //
    // The SURFACE is deliberately not set here. A sticky header does need its
    // own opaque fill (rows scroll under it), but an inline `background`
    // outranks every `hover:` class — setting it here silently killed the
    // sortable-header hover. It goes on as a class instead, where the `hover:`
    // variant's extra specificity can still win.
    borderBottomColor: CLAY_RIM,
  };

  return (
    <th
      aria-sort={isSorted ? (direction === 'ascending' ? 'ascending' : 'descending') : undefined}
      className={cn(
        'bg-[var(--card-bg)] border-b-[2px] px-3 py-3 font-extrabold tracking-[-0.005em]',
        ALIGN_CLASS[align],
        /*
         * /35, matching the row hover — it was /45.
         *
         * A heavier citrine wash lightens the ground toward the cream `--ink`
         * in dark, and at /45 the header label landed at 4.34:1, under the 4.5
         * a 14px bold label owes. /35 measures 5.88:1 there and 17:1 in light.
         * There was never a reason for the header and the rows to hover at two
         * different strengths; one "hover" wash is also easier to keep honest.
         */
        allowsSorting && 'hover:bg-citrine/35 cursor-pointer transition-colors duration-[80ms]',
        className,
        ctx.classNames?.th,
      )}
      onClick={allowsSorting ? handleSort : undefined}
      onKeyDown={
        allowsSorting
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleSort();
              }
            }
          : undefined
      }
      role={allowsSorting ? 'button' : undefined}
      style={innerStyle}
      tabIndex={allowsSorting ? 0 : undefined}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1.5',
          align === 'center' && 'justify-center',
          align === 'end' && 'justify-end',
        )}
      >
        <span>{children}</span>
        {allowsSorting ? (
          <SortGlyph
            className={cn(
              // /60, not /50: an unsorted glyph is still a UI graphic and owes 3:1,
              // not 4.5:1. Sugar's warm ink is a lighter ink, so /50 lands at
              // 2.86:1 on --surface-3; /60 gives 3.71 with margin. (Went via /55
              // at 3.25 — passing, but thin enough to be worth the extra step.)
              'text-ink/60 shrink-0 transition-colors',
              isSorted && 'text-ink',
              ctx.classNames?.sortIcon,
            )}
            direction={direction}
          />
        ) : null}
      </span>
    </th>
  );
}

TableColumn.displayName = 'TableColumn';

function SortGlyph({ direction, className }: { direction?: TableSortDirection; className?: string }) {
  return (
    <svg className={className} fill='currentColor' height='10' stroke='none' viewBox='0 0 12 12' width='10'>
      {direction === 'descending' ? (
        <path d='M2 4h8L6 10z' />
      ) : direction === 'ascending' ? (
        <path d='M6 2 10 8H2z' />
      ) : (
        <>
          <path d='M6 1 9 5H3z' opacity={0.55} />
          <path d='M6 11 9 7H3z' opacity={0.55} />
        </>
      )}
    </svg>
  );
}

/* ============================================================
   <TableBody>
   ============================================================ */

export interface TableBodyProps<T = unknown> {
  children?: React.ReactNode | ((item: T) => React.ReactNode);
  items?: Iterable<T>;
  emptyContent?: React.ReactNode;
  loadingContent?: React.ReactNode;
  loadingState?: TableLoadingState;
  isLoading?: boolean;
  className?: string;
  /** Internal — provided by <Table> to collect row keys for select-all. */
  __reportKeys?: (keys: React.Key[]) => void;
}

function getItemKey(item: unknown, fallback: number): React.Key {
  if (item && typeof item === 'object') {
    const o = item as { key?: React.Key; id?: React.Key; _id?: React.Key };
    if (o.key !== undefined) return o.key;
    if (o.id !== undefined) return o.id;
    if (o._id !== undefined) return o._id;
  }

  return fallback;
}

export function TableBody<T = unknown>(props: TableBodyProps<T>) {
  const ctx = useTableContext('TableBody');
  const {
    children,
    items,
    emptyContent,
    loadingContent,
    loadingState,
    isLoading: bodyLoading,
    className,
    __reportKeys,
  } = props;

  /* Resolve rows */
  const rowsAndKeys = React.useMemo(() => {
    const out: Array<{ key: React.Key; node: React.ReactElement }> = [];

    if (items && typeof children === 'function') {
      const list = Array.isArray(items) ? items : Array.from(items);
      list.forEach((item, idx) => {
        const node = (children as (it: T) => React.ReactNode)(item);
        if (!React.isValidElement(node)) return;
        const k = (node.key as React.Key | null) ?? getItemKey(item, idx);
        const cloned = React.cloneElement(
          node as React.ReactElement,
          {
            key: k,
            __rowKey: k,
            __columnKeys: ctx.columnKeys,
            __item: item,
          } as Partial<TableRowProps>,
        );
        out.push({ key: k, node: cloned });
      });
    } else {
      React.Children.forEach(children as React.ReactNode, (child, idx) => {
        if (!React.isValidElement(child)) return;
        const k = (child.key as React.Key | null) ?? idx;
        const cloned = React.cloneElement(
          child as React.ReactElement,
          {
            __rowKey: k,
            __columnKeys: ctx.columnKeys,
          } as Partial<TableRowProps>,
        );
        out.push({ key: k, node: cloned });
      });
    }

    return out;
  }, [items, children, ctx.columnKeys]);

  /* Report row keys upward — debounced via the orchestrator's equality check. */
  const keysSig = rowsAndKeys.map((r) => String(r.key)).join('|');
  React.useEffect(() => {
    __reportKeys?.(rowsAndKeys.map((r) => r.key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSig]);

  const showCheckboxCol = ctx.selectionMode !== 'none' && ctx.showSelectionCheckboxes;
  const colSpan = ctx.columnKeys.length + (showCheckboxCol ? 1 : 0) || 1;

  const effectiveLoading = bodyLoading || ctx.isLoading || loadingState === 'loading' || loadingState === 'sorting';
  const isEmpty = rowsAndKeys.length === 0;

  return (
    <tbody className={cn(className, ctx.classNames?.tbody)}>
      {effectiveLoading && isEmpty ? (
        <tr>
          <td className='p-0' colSpan={colSpan}>
            <div className={cn('flex items-center justify-center gap-3 py-12', ctx.classNames?.loadingWrapper)}>
              {loadingContent ?? <Spinner size='md' />}
            </div>
          </td>
        </tr>
      ) : isEmpty ? (
        <tr>
          <td className='p-0' colSpan={colSpan}>
            <div
              className={cn(
                'mx-4 my-6 flex items-center justify-center px-6 py-10',
                'rounded-[14px] border-2 border-dashed',
                // /70, not /60: a warm palette's lighter ink is a lighter ink, so the same
                // alpha reads 3.90:1 there against 4.98:1 in the default palette.
                'text-ink/70 text-[14px] font-bold',
                ctx.classNames?.emptyWrapper,
              )}
              style={{ borderColor: ROW_RULE }}
            >
              {emptyContent ?? 'No data'}
            </div>
          </td>
        </tr>
      ) : (
        rowsAndKeys.map((r) => r.node)
      )}
    </tbody>
  );
}

TableBody.displayName = 'TableBody';

/* ============================================================
   <TableRow>
   ============================================================ */

export interface TableRowProps extends Omit<React.HTMLAttributes<HTMLTableRowElement>, 'children' | 'onClick'> {
  children?: React.ReactNode | ((columnKey: React.Key) => React.ReactNode);
  className?: string;
  /** Click handler — called in addition to the built-in selection toggle. */
  onClick?: (e: React.MouseEvent<HTMLTableRowElement>) => void;
  /** Internal — provided by <TableBody>. */
  __rowKey?: React.Key;
  __columnKeys?: React.Key[];
  __item?: unknown;
}

export function TableRow(props: TableRowProps) {
  const ctx = useTableContext('TableRow');
  const { children, className, onClick, style, __rowKey, __columnKeys = [], __item: _item, ...rest } = props;
  void _item;
  const rowKey = __rowKey;

  const isSelected =
    ctx.selectedKeys === 'all' ||
    (ctx.selectedKeys instanceof Set && rowKey !== undefined && ctx.selectedKeys.has(rowKey));
  const isDisabled = rowKey !== undefined && ctx.disabledKeys.has(rowKey);

  const handleRowClick = (e: React.MouseEvent<HTMLTableRowElement>) => {
    onClick?.(e);
    if (rowKey === undefined) return;
    if (ctx.selectionMode === 'none' || isDisabled) return;
    ctx.toggleRow(rowKey);
  };

  /* Render-prop columns */
  const cells: React.ReactNode = (() => {
    if (typeof children === 'function') {
      return __columnKeys.map((k) => (
        <React.Fragment key={String(k)}>{(children as (k: React.Key) => React.ReactNode)(k)}</React.Fragment>
      ));
    }

    return children;
  })();

  const showCheckboxCol = ctx.selectionMode !== 'none' && ctx.showSelectionCheckboxes;

  const padY = ctx.isCompact ? 'py-2' : 'py-[14px]';

  // Striped: cream tint on even rows, via tailwind's even/odd selectors — the
  // rows are siblings in one tbody, so nth-child is all this needs.
  return (
    <tr
      aria-disabled={isDisabled || undefined}
      aria-selected={ctx.selectionMode !== 'none' && rowKey !== undefined ? isSelected : undefined}
      /*
       * Caller `style` still wins — it is spread last — but it can no longer
       * silently drop the row rule, which it did while `style` sat inside
       * `...rest` and the spread re-applied it after this prop.
       */
      style={{ borderBottomColor: ROW_RULE, ...(style as React.CSSProperties) }}
      className={cn(
        'group transition-[background-color,box-shadow] duration-[80ms] ease-out',
        'border-b-[1.5px]',
        isDisabled && 'opacity-50',
        // Striped: alternating tint. This has to be `paper-2`, not `paper` — the
        // table's own base is already `bg-paper`, so painting even rows the same
        // token made `isStriped` draw literally nothing (measured 1.00:1 in every
        // theme). Skipped on a selected row, whose fill is unprefixed and would
        // otherwise lose the specificity contest against this `even:` variant.
        ctx.isStriped && !isSelected && 'even:bg-paper-2',
        // clickable cursor
        ((ctx.selectionMode !== 'none' && !isDisabled) || onClick) && 'cursor-pointer',
        // hover
        !isSelected && !isDisabled && 'hover:bg-citrine/35',
        /*
         * Selected — a 60% citrine wash plus a left strip.
         *
         * The strip was `var(--line)`, which FLIPS with the theme while the
         * citrine under it does not. So the mark tracked one thing and its
         * ground tracked another: 15.7:1 in light and 2.37:1 in dark, against a
         * 3:1 floor for a mark. `--ink-const` is the token that does not flip,
         * which is why the LABEL beside it was already using it.
         */
        isSelected && 'bg-citrine/60 text-ink-const',
        /* ...and the strip sits on the row's start (left) edge. */
        isSelected && 'shadow-[inset_3px_0_0_var(--ink-const)]',
        className,
        ctx.classNames?.tr,
      )}
      onClick={ctx.selectionMode !== 'none' || onClick ? handleRowClick : undefined}
      {...rest}
    >
      {showCheckboxCol ? (
        <td
          className={cn('w-[40px] px-2', padY, ctx.isHeaderSticky && 'sticky right-auto z-[1] bg-inherit')}
          onClick={(e) => e.stopPropagation()}
        >
          {ctx.selectionMode !== 'none' && rowKey !== undefined ? (
            <Checkbox
              aria-label={`Select row ${String(rowKey)}`}
              isDisabled={isDisabled}
              isSelected={isSelected}
              onValueChange={() => ctx.toggleRow(rowKey)}
              size='sm'
            />
          ) : null}
        </td>
      ) : null}
      {cells}
    </tr>
  );
}

TableRow.displayName = 'TableRow';

/* ============================================================
   <TableCell>
   ============================================================ */

export interface TableCellProps extends Omit<React.TdHTMLAttributes<HTMLTableCellElement>, 'children' | 'align'> {
  children?: React.ReactNode;
  className?: string;
  align?: 'start' | 'center' | 'end';
  textValue?: string;
  colSpan?: number;
  rowSpan?: number;
}

export function TableCell(props: TableCellProps) {
  const ctx = React.useContext(TableContext);
  const { children, className, align = 'start', colSpan, rowSpan, textValue: _textValue, ...rest } = props;
  void _textValue;

  const padY = ctx?.isCompact ? 'py-2' : 'py-[14px]';

  return (
    <td
      className={cn('px-3 align-middle', padY, ALIGN_CLASS[align], className, ctx?.classNames?.td)}
      colSpan={colSpan}
      rowSpan={rowSpan}
      {...rest}
    >
      {children}
    </td>
  );
}

TableCell.displayName = 'TableCell';
