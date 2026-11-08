import React from 'react';

import { cn } from '../../cn';
import { clayVars } from '../clay';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';

/**
 * da-v2 Breadcrumbs / BreadcrumbItem — drop-in for HeroUI's Breadcrumbs.
 *
 *   <Breadcrumbs separator='/' size='sm' maxItems={4}>
 *     <BreadcrumbItem href='/'>Home</BreadcrumbItem>
 *     <BreadcrumbItem href='/products'>Products</BreadcrumbItem>
 *     <BreadcrumbItem isCurrent>Detail</BreadcrumbItem>
 *   </Breadcrumbs>
 *
 * Visual: horizontal flex row, gap 8px, font-medium text-sm. Items joined by a
 * separator (default chevron-end SVG, text-ink/55).
 *
 * Collapse:
 *  - `maxItems` collapses the middle items into a single ellipsis token. The
 *    first and last (last `itemsAfterCollapse`) are always shown.
 */

export type BreadcrumbsVariant = 'solid' | 'bordered' | 'light';

export interface BreadcrumbsClassNames {
  base?: string;
  list?: string;
  separator?: string;
  ellipsis?: string;
}

export interface BreadcrumbItemClassNames {
  base?: string;
  item?: string;
  separator?: string;
}

const SIZE_CLS: Record<HeroUISize, string> = {
  sm: 'text-[12px] gap-1.5',
  md: 'text-[13px] gap-2',
  lg: 'text-[15px] gap-2.5',
};

/** The container variants' clay vars. See the note at the `<ol>` for `control` and depth 4. */
const CRUMB_CLAY: React.CSSProperties = clayVars('var(--card-bg)', { kind: 'control', depth: 4 });

const RADIUS_CLS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
};

/**
 * `secondary` is the SEMANTIC secondary (`sk-secondary` -> `--s-text`), not the
 * literal blue. `text-sk-blue` resolves to `--b-text`, which is the `sk-blue`
 * DECORATION token and is deliberately left blue by every alternate palette —
 * so a `color='secondary'` crumb stayed #006fee under an alternate palette while
 * the rest of the trail went amber. `--s-text` IS `var(--b-text)` in light and
 * dark, so this moves nothing in the shipped themes.
 */
const COLOR_CLS: Record<HeroUIColor, string> = {
  default: 'text-ink',
  primary: 'text-sk-primary',
  secondary: 'text-sk-secondary',
  success: 'text-sk-green',
  warning: 'text-sk-amber',
  danger: 'text-sk-red',
};

interface BreadcrumbsContextValue {
  size: HeroUISize;
  color: HeroUIColor;
  radius: HeroUIRadius;
  variant: BreadcrumbsVariant;
  separator: React.ReactNode;
  hideSeparator: boolean;
  itemClasses?: BreadcrumbItemClassNames;
  isDisabled: boolean;
  underline: 'none' | 'hover' | 'always' | 'active' | 'focus';
}

const BreadcrumbsContext = React.createContext<BreadcrumbsContextValue | null>(null);

/* ============================================================
   <Breadcrumbs>
   ============================================================ */

export interface BreadcrumbsProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
  separator?: React.ReactNode;
  size?: HeroUISize;
  color?: HeroUIColor;
  radius?: HeroUIRadius;
  variant?: BreadcrumbsVariant;
  isDisabled?: boolean;
  hideSeparator?: boolean;
  underline?: 'none' | 'hover' | 'always' | 'active' | 'focus';
  /** Collapse middle items when total > maxItems. */
  maxItems?: number;
  /** Number of items kept visible before the ellipsis. */
  itemsBeforeCollapse?: number;
  /** Number of items kept visible after the ellipsis. */
  itemsAfterCollapse?: number;
  renderEllipsis?: (info: {
    items: React.ReactNode[];
    ellipsisIcon: React.ReactNode;
    separator: React.ReactNode;
  }) => React.ReactNode;
  className?: string;
  classNames?: BreadcrumbsClassNames;
  itemClasses?: BreadcrumbItemClassNames;
  /** Pass-through `dir`. */
  dir?: 'rtl' | 'ltr';
}

function DefaultSeparator({ size }: { size: HeroUISize }) {
  // Chevron pointing right (forward).
  const px = size === 'sm' ? 10 : size === 'lg' ? 14 : 12;

  return (
    <svg
      aria-hidden
      className='text-ink/55 shrink-0'
      fill='none'
      height={px}
      stroke='currentColor'
      strokeLinecap='round'
      strokeLinejoin='round'
      strokeWidth='2'
      viewBox='0 0 24 24'
      width={px}
    >
      <path d='m9 18 6-6-6-6' />
    </svg>
  );
}

export function Breadcrumbs(props: BreadcrumbsProps) {
  const {
    children,
    separator,
    size = 'md',
    color = 'default',
    radius = 'md',
    variant = 'light',
    isDisabled,
    hideSeparator,
    underline = 'hover',
    maxItems,
    itemsBeforeCollapse = 1,
    itemsAfterCollapse = 2,
    renderEllipsis,
    className,
    classNames,
    itemClasses,
    dir,
    ...rest
  } = props;

  const sep = separator ?? <DefaultSeparator size={size} />;

  const ctxValue: BreadcrumbsContextValue = {
    size,
    color,
    radius,
    variant,
    separator: sep,
    hideSeparator: Boolean(hideSeparator),
    itemClasses,
    isDisabled: Boolean(isDisabled),
    underline,
  };

  // Walk children, recognize BreadcrumbItem; mark last one as current automatically
  // (HeroUI behavior). Then handle maxItems collapse.
  const childArray = React.Children.toArray(children).filter((c): c is React.ReactElement => React.isValidElement(c));

  const lastIdx = childArray.length - 1;
  const augmented = childArray.map((child, idx) => {
    const isLast = idx === lastIdx;
    const childProps = child.props as { isCurrent?: boolean };
    if (isLast && childProps.isCurrent === undefined) {
      return React.cloneElement(child, { isCurrent: true } as Partial<BreadcrumbItemProps>);
    }

    return child;
  });

  let visibleItems: React.ReactNode[] = augmented;
  let ellipsisInserted = false;

  if (maxItems && augmented.length > maxItems) {
    const before = augmented.slice(0, itemsBeforeCollapse);
    const after = augmented.slice(augmented.length - itemsAfterCollapse);
    const collapsed = augmented.slice(itemsBeforeCollapse, augmented.length - itemsAfterCollapse);

    const ellipsisIcon = (
      <span aria-hidden className={cn('font-hand text-ink/55 text-[18px] leading-none', classNames?.ellipsis)}>
        …
      </span>
    );

    let ellipsisNode: React.ReactNode;
    if (renderEllipsis) {
      ellipsisNode = renderEllipsis({ items: collapsed, ellipsisIcon, separator: sep });
    } else {
      ellipsisNode = (
        // a11y: this used to carry `role='presentation'` AND `aria-label='more'`.
        // The presentation role strips the element's semantics, which discards
        // the label — and its only visible child is aria-hidden. Net effect: a
        // screen-reader user got NO signal that any crumbs had been collapsed.
        // Dropping the role restores it to a real list item, and the collapsed
        // count goes in visually-hidden text rather than an aria-label, which is
        // unreliably announced on <li>.
        // The `text-ink/55` on the <li> was also dead — its only child sets its
        // own colour — so it is gone.
        <li key='__ellipsis__' className='inline-flex cursor-default select-none items-center px-1.5'>
          <span className='sr-only'>{`${collapsed.length} hidden item${collapsed.length === 1 ? '' : 's'}`}</span>
          {ellipsisIcon}
        </li>
      );
    }
    visibleItems = [...before, ellipsisNode, ...after];
    ellipsisInserted = true;
  }

  const renderedWithSeparators: React.ReactNode[] = [];
  visibleItems.forEach((node, idx) => {
    renderedWithSeparators.push(node);
    if (idx < visibleItems.length - 1 && !hideSeparator) {
      renderedWithSeparators.push(
        <li
          key={`__sep__${idx}`}
          aria-hidden
          className={cn('inline-flex select-none items-center', classNames?.separator, itemClasses?.separator)}
          role='presentation'
        >
          {sep}
        </li>,
      );
    }
  });

  return (
    <BreadcrumbsContext.Provider value={ctxValue}>
      <nav
        aria-label='breadcrumb'
        className={cn(SIZE_CLS[size], COLOR_CLS[color], className, classNames?.base)}
        dir={dir}
        {...rest}
      >
        <ol
          className={cn(
            'flex flex-row flex-wrap items-center',
            SIZE_CLS[size],
            // Tier 2, small: `.clay-panel` — a crumb trail is not pressable, and
            // `control` because the fill is near-white and the rim is what
            // bounds it. Depth 4 rather than a panel's 8: this is a text-height
            // strip, and a lip half the height of the thing casting it reads as
            // a second bar (the same finding as the Navbar).
            variant === 'bordered' &&
              'clay-panel rounded-lg border-[3px] border-[color:var(--clay-edge)] [background-color:var(--card-bg)] px-2.5 py-1.5',
            variant === 'solid' && 'clay-panel rounded-lg [background-color:var(--card-bg)] px-2.5 py-1.5',
            classNames?.list,
          )}
          style={variant === 'bordered' || variant === 'solid' ? CRUMB_CLAY : undefined}
        >
          {renderedWithSeparators}
        </ol>
        {/* Reference radius and ellipsisInserted to satisfy TS/eslint when unused. */}
        <span hidden data-collapsed={ellipsisInserted || undefined} data-radius={RADIUS_CLS[radius]} />
      </nav>
    </BreadcrumbsContext.Provider>
  );
}

Breadcrumbs.displayName = 'Breadcrumbs';

/* ============================================================
   <BreadcrumbItem>
   ============================================================ */

export interface BreadcrumbItemProps extends Omit<React.HTMLAttributes<HTMLLIElement>, 'onClick'> {
  href?: string;
  isCurrent?: boolean;
  isDisabled?: boolean;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  onPress?: (e: React.MouseEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
  className?: string;
  classNames?: BreadcrumbItemClassNames;
  /** HeroUI compat — kept for parity. */
  underline?: 'none' | 'hover' | 'always' | 'active' | 'focus';
  /** HeroUI compat — kept for parity. */
  size?: HeroUISize;
  /** HeroUI compat — kept for parity. */
  color?: HeroUIColor;
  target?: string;
  rel?: string;
}

export function BreadcrumbItem(props: BreadcrumbItemProps) {
  const {
    href,
    isCurrent,
    isDisabled,
    startContent,
    endContent,
    onPress,
    onClick,
    children,
    className,
    classNames,
    underline,
    size: _s,
    color: _c,
    target,
    rel,
    ...rest
  } = props;

  const ctx = React.useContext(BreadcrumbsContext);
  const effectiveUnderline = underline ?? ctx?.underline ?? 'hover';
  const disabled = isDisabled || ctx?.isDisabled;

  const inner = (
    <span className={cn('inline-flex items-center gap-1.5', classNames?.item, ctx?.itemClasses?.item)}>
      {startContent ? <span className='shrink-0'>{startContent}</span> : null}
      <span>{children}</span>
      {endContent ? <span className='shrink-0'>{endContent}</span> : null}
    </span>
  );

  const handleClick = (e: React.MouseEvent) => {
    if (disabled) {
      e.preventDefault();

      return;
    }
    onClick?.(e);
    onPress?.(e);
  };

  // Current item — bold + ink, not a link.
  if (isCurrent) {
    return (
      <li
        aria-current='page'
        className={cn(
          'text-ink inline-flex select-none items-center font-extrabold',
          disabled && 'cursor-not-allowed opacity-50',
          className,
          classNames?.base,
        )}
        {...rest}
      >
        {inner}
      </li>
    );
  }

  const linkCls = cn(
    'relative inline-flex items-center text-ink/70 font-bold cursor-pointer',
    'transition-colors duration-[80ms]',
    'hover:text-ink',
    effectiveUnderline === 'always' && 'underline decoration-[2px] underline-offset-[3px]',
    effectiveUnderline === 'hover' &&
      'hover:underline hover:decoration-[2px] hover:underline-offset-[3px]',
    effectiveUnderline === 'focus' &&
      'focus-visible:underline focus-visible:decoration-[2px]',
    // The underline is the link's NON-COLOUR cue (WCAG 1.4.1), so it is a mark
    // and must be visible on its own. Citrine measured 1.29:1 on paper — an
    // affordance you cannot see in light, fine in dark, which is why it lasted.
    // Dropping `decoration-*` leaves it at `currentColor`: it can never fail,
    // because it is exactly the text colour that was already contrast-checked.
    // No `ring-*` either — Tailwind rings are a `box-shadow` and would compose
    // wrongly with clay; an `outline` is its own property. See the report.
    'rounded-sm',
    disabled && 'opacity-50 cursor-not-allowed pointer-events-none',
  );

  if (href) {
    return (
      <li className={cn('inline-flex items-center', className, classNames?.base)} {...rest}>
        <a
          aria-disabled={disabled || undefined}
          className={linkCls}
          href={disabled ? undefined : href}
          onClick={handleClick}
          rel={rel}
          target={target}
        >
          {inner}
        </a>
      </li>
    );
  }

  return (
    <li className={cn('inline-flex items-center', className, classNames?.base)} {...rest}>
      <button aria-disabled={disabled || undefined} className={linkCls} onClick={handleClick} type='button'>
        {inner}
      </button>
    </li>
  );
}

BreadcrumbItem.displayName = 'BreadcrumbItem';
