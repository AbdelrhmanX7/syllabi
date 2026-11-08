import React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';

import { cn } from '../../cn';
import { clayVars } from '../clay';
import { lockBodyScroll } from '../../body-scroll-lock';

/**
 * da-v2 Navbar family — drop-in for HeroUI's Navbar primitives.
 *
 *   <Navbar isBordered isBlurred position='sticky' shouldHideOnScroll
 *           isMenuOpen onMenuOpenChange maxWidth='xl' height='4rem'>
 *     <NavbarBrand>logo</NavbarBrand>
 *     <NavbarContent justify='center'>
 *       <NavbarItem isActive>Home</NavbarItem>
 *       <NavbarItem>Products</NavbarItem>
 *     </NavbarContent>
 *     <NavbarContent justify='end'>
 *       <NavbarMenuToggle aria-label='toggle' />
 *     </NavbarContent>
 *     <NavbarMenu>
 *       <NavbarMenuItem>Home</NavbarMenuItem>
 *     </NavbarMenu>
 *   </Navbar>
 *
 * Implementation:
 *  - Top-level <header> with NavbarContext that holds open state shared between
 *    NavbarMenuToggle and NavbarMenu.
 *  - shouldHideOnScroll tracks window scroll-y in a ref; hides via translateY
 *    when scrolling down beyond a threshold; reveals when scrolling up.
 *  - isBordered: bottom hairline.
 *  - isBlurred: backdrop-blur + bg-paper/85.
 *  - position='sticky' = sticky top-0 z-40.
 *
 * Mobile menu (NavbarMenu):
 *  - Slides in from the right edge.
 *  - Portaled to document.body to escape header stacking context.
 *  - Closed when isMenuOpen === false; framer-motion handles exit.
 */

export type NavbarMaxWidth = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
/**
 * The bar's clay vars. `.clay-panel`, not `.clay-surface` — a navbar is not
 * pressable, and lifting it because the cursor crossed it is movement with no
 * meaning behind it.
 *
 * `from: 'bottom'` (the default) is the one anchor that needs no argument: the
 * bar is stuck to the TOP, so its only free edge is the bottom and its lip falls
 * inward, down into the page. Every other edge is flush with the viewport.
 *
 * `control`, not `surface`: measured, the bar was **1.00:1 against the page in
 * light** — `--paper` IS `--surface-0` there, so the fill separated it by
 * nothing at all — and `shadow-sk-sm` computed to no shadow. Its entire boundary
 * was the optional 1.5px hairline. `surface`'s 1.23:1 rim would not have
 * replaced that.
 *
 * Depth 5, not tier 2's 8 — picked from screenshots at 8/5/4. A bar is the one
 * tier-2 surface whose lip spans the FULL page width, so the same depth that
 * reads as a card's edge reads here as a second stripe under the first. 5 keeps
 * a panel-scale lip without the band. There is no press ladder to preserve, so
 * the depth-3 collapse that constrains pressable components does not apply.
 */
const BAR_CLAY: React.CSSProperties = clayVars('var(--card-bg)', { kind: 'control', depth: 5 });

/** The mobile menu is edge-anchored like a Drawer, so its lip falls inward. */
const MENU_CLAY: React.CSSProperties = clayVars('var(--card-bg)', { kind: 'control', depth: 8, from: 'left' });

export type NavbarPosition = 'static' | 'sticky';

const MAX_WIDTH: Record<NavbarMaxWidth, string> = {
  sm: 'max-w-screen-sm',
  md: 'max-w-screen-md',
  lg: 'max-w-screen-lg',
  xl: 'max-w-screen-xl',
  '2xl': 'max-w-screen-2xl',
  full: 'max-w-full',
};

export interface NavbarClassNames {
  base?: string;
  wrapper?: string;
  brand?: string;
  content?: string;
  item?: string;
  toggle?: string;
  menu?: string;
  menuItem?: string;
}

interface NavbarContextValue {
  isMenuOpen: boolean;
  setMenuOpen: (next: boolean) => void;
  classNames?: NavbarClassNames;
  dir: 'rtl' | 'ltr' | undefined;
  height: string;
  isHidden: boolean;
}

const NavbarContext = React.createContext<NavbarContextValue | null>(null);

/* ============================================================
   <Navbar>
   ============================================================ */

export interface NavbarProps extends Omit<React.HTMLAttributes<HTMLElement>, 'onChange'> {
  children?: React.ReactNode;
  isMenuOpen?: boolean;
  isMenuDefaultOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  shouldHideOnScroll?: boolean;
  position?: NavbarPosition;
  /**
   * @deprecated No-op. Clay's rim is not optional: measured, a bar without one
   * was 1.00:1 against the page in light. Kept accepted for call-site parity.
   */
  isBordered?: boolean;
  isBlurred?: boolean;
  maxWidth?: NavbarMaxWidth;
  /** CSS height — string. Default '4rem'. */
  height?: string | number;
  className?: string;
  classNames?: NavbarClassNames;
  /** Pass-through for `dir`. */
  dir?: 'rtl' | 'ltr';
  /** HeroUI compat — disable internal animations. */
  disableAnimation?: boolean;
}

export function Navbar(props: NavbarProps) {
  const {
    children,
    isMenuOpen: controlledOpen,
    isMenuDefaultOpen,
    onMenuOpenChange,
    shouldHideOnScroll,
    position = 'sticky',
    isBordered: _isBordered,
    isBlurred = true,
    maxWidth = 'xl',
    height = '4rem',
    className,
    classNames,
    dir,
    disableAnimation: _da,
    ...rest
  } = props;

  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(Boolean(isMenuDefaultOpen));
  const isControlled = controlledOpen !== undefined;
  const isMenuOpen = isControlled ? Boolean(controlledOpen) : uncontrolledOpen;

  const setMenuOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onMenuOpenChange?.(next);
    },
    [isControlled, onMenuOpenChange],
  );

  const heightStr = typeof height === 'number' ? `${height}px` : height;

  // Hide-on-scroll
  const [isHidden, setIsHidden] = React.useState(false);
  const lastYRef = React.useRef(0);
  React.useEffect(() => {
    if (!shouldHideOnScroll) {
      setIsHidden(false);

      return;
    }
    const onScroll = () => {
      const y = window.scrollY;
      const last = lastYRef.current;
      // Threshold so we don't hide right at the top.
      if (y < 8) {
        setIsHidden(false);
      } else if (y > last + 4) {
        setIsHidden(true);
      } else if (y < last - 4) {
        setIsHidden(false);
      }
      lastYRef.current = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => window.removeEventListener('scroll', onScroll);
  }, [shouldHideOnScroll]);

  const ctxValue: NavbarContextValue = {
    isMenuOpen,
    setMenuOpen,
    classNames,
    dir,
    height: heightStr,
    isHidden,
  };

  return (
    <NavbarContext.Provider value={ctxValue}>
      <header
        className={cn(
          'text-ink w-full',
          position === 'sticky' && 'sticky top-0 z-40',
          // Translucency is the POINT of the blurred bar — you are meant to see
          // content move under it — so that branch keeps `paper` rather than
          // moving rung. It costs nothing: `--paper` and `--card-bg` differ by
          // 1.02:1 in light and are the SAME value in dark, and the difference
          // is invisible under 85% alpha anyway. The opaque branch takes the
          // right rung. (`bg-card/85` is not available: the preset builds alpha
          // utilities from an `--x-rgb` triplet and there is no `--card-bg-rgb`.)
          isBlurred
            ? 'bg-paper/85 supports-[backdrop-filter]:bg-paper/75 backdrop-blur'
            : '[background-color:var(--card-bg)]',
          // The rim is NOT conditional on `isBordered`. Measured, an unbordered
          // bar was 1.00:1 against the page in light with no shadow either — an
          // invisible navbar. Clay's boundary is the bar's only separation, so
          // it is always drawn. Bottom only: the other three edges are flush
          // with the viewport.
          'clay-panel border-b-[3px] border-[color:var(--clay-edge)]',
          'transition-transform duration-200 ease-out',
          isHidden && '-translate-y-full',
          className,
          classNames?.base,
        )}
        dir={dir}
        style={{ ...BAR_CLAY, ['--navbar-height' as string]: heightStr } as React.CSSProperties}
        {...rest}
      >
        <div
          className={cn(
            'mx-auto flex w-full items-center gap-3 px-4 sm:px-6',
            MAX_WIDTH[maxWidth],
            classNames?.wrapper,
          )}
          style={{ height: heightStr }}
        >
          {children}
        </div>
      </header>
    </NavbarContext.Provider>
  );
}

Navbar.displayName = 'Navbar';

/* ============================================================
   <NavbarBrand>
   ============================================================ */

export interface NavbarBrandProps extends React.HTMLAttributes<HTMLElement> {
  as?: React.ElementType;
  children?: React.ReactNode;
  className?: string;
}

export function NavbarBrand(props: NavbarBrandProps) {
  const { as: Component = 'div', className, children, ...rest } = props;
  const ctx = React.useContext(NavbarContext);

  return (
    <Component
      className={cn('text-ink flex shrink-0 items-center gap-2 font-extrabold', ctx?.classNames?.brand, className)}
      {...rest}
    >
      {children}
    </Component>
  );
}

NavbarBrand.displayName = 'NavbarBrand';

/* ============================================================
   <NavbarContent>
   ============================================================ */

export interface NavbarContentProps extends React.HTMLAttributes<HTMLUListElement> {
  children?: React.ReactNode;
  justify?: 'start' | 'center' | 'end';
  className?: string;
}

export function NavbarContent(props: NavbarContentProps) {
  const { children, justify = 'start', className, ...rest } = props;
  const ctx = React.useContext(NavbarContext);

  return (
    <ul
      className={cn(
        'flex items-center gap-3',
        justify === 'start' && 'me-auto justify-start',
        justify === 'center' && 'flex-1 justify-center',
        justify === 'end' && 'ms-auto justify-end',
        ctx?.classNames?.content,
        className,
      )}
      {...rest}
    >
      {children}
    </ul>
  );
}

NavbarContent.displayName = 'NavbarContent';

/* ============================================================
   <NavbarItem>
   ============================================================ */

export interface NavbarItemProps extends React.LiHTMLAttributes<HTMLLIElement> {
  isActive?: boolean;
  children?: React.ReactNode;
  className?: string;
}

export function NavbarItem(props: NavbarItemProps) {
  const { isActive, children, className, ...rest } = props;
  const ctx = React.useContext(NavbarContext);

  return (
    <li
      className={cn(
        'text-ink relative inline-flex items-center text-[14px] font-bold',
        'transition-colors duration-[80ms]',
        isActive && 'text-ink',
        !isActive && 'text-ink/70 hover:text-ink',
        ctx?.classNames?.item,
        className,
      )}
      data-active={isActive || undefined}
      {...rest}
    >
      {/* underline accent for the active item — a themed brand mark */}
      {isActive ? (
        <span
          aria-hidden
          // A MARK, not a fill: it is the only thing saying which nav item is
          // active, so WCAG 1.4.11's 3:1 applies to it. Citrine measured
          // **1.32:1 against the bar in light** — a state indicator you cannot
          // see — while passing at 13.49:1 in dark, which is exactly why it
          // survived review. `--p-text` is the brand-as-MARK token and measures
          // 7.15:1 light / 7.54:1 dark. Citrine stays where it is a FILL under a
          // label (the mobile active item below), which is the reviewed pair.
          className='pointer-events-none absolute inset-x-0 -bottom-1 h-[3px] bg-[color:var(--p-text)] [mask-image:radial-gradient(circle_at_top,black_55%,transparent_60%)]'
        />
      ) : null}
      {children}
    </li>
  );
}

NavbarItem.displayName = 'NavbarItem';

/* ============================================================
   <NavbarMenuToggle>
   Hamburger button that toggles the mobile menu.
   ============================================================ */

export interface NavbarMenuToggleProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Override the icon. */
  icon?: React.ReactNode | ((isOpen: boolean) => React.ReactNode);
  className?: string;
}

export function NavbarMenuToggle(props: NavbarMenuToggleProps) {
  const { icon, className, 'aria-label': ariaLabel, onClick, ...rest } = props;
  const ctx = React.useContext(NavbarContext);
  if (!ctx) return null;

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    ctx.setMenuOpen(!ctx.isMenuOpen);
  };

  const iconNode =
    typeof icon === 'function'
      ? icon(ctx.isMenuOpen)
      : (icon ?? (
          <svg
            aria-hidden
            className={cn('transition-transform duration-150 ease-out', ctx.isMenuOpen && 'rotate-90')}
            fill='none'
            height='18'
            stroke='currentColor'
            strokeLinecap='round'
            strokeLinejoin='round'
            strokeWidth='2.5'
            viewBox='0 0 24 24'
            width='18'
          >
            {ctx.isMenuOpen ? (
              <>
                <path d='M18 6 6 18' />
                <path d='M6 6l12 12' />
              </>
            ) : (
              <>
                <path d='M3 7h18' />
                <path d='M3 12h18' />
                <path d='M3 17h18' />
              </>
            )}
          </svg>
        ));

  return (
    <button
      aria-controls='navbar-menu'
      aria-expanded={ctx.isMenuOpen}
      aria-label={ariaLabel ?? (ctx.isMenuOpen ? 'Close menu' : 'Open menu')}
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-md',
        // The one pressable thing on the bar, so the only thing here with a
        // press ladder. Travel equals `depth - lip`, so its bottom edge does
        // not move: rest 0/4, hover 2/2, active 3/1.
        'clay-btn text-ink border-[3px] border-[color:var(--clay-edge)] [background-color:var(--card-bg)]',
        'transition-[transform,box-shadow] duration-150',
        'hover:translate-y-[2px] active:translate-y-[3px]',
        'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        // NO `focus-visible:ring-*` here, and no `outline-none`. Tailwind's ring
        // utilities are implemented as a `box-shadow`, and box-shadow REPLACES
        // rather than composes — the surviving citrine ring was wiping
        // `.clay-btn`'s lip to 0 on focus, so the button's bottom edge jumped up
        // 4px the moment a keyboard reached it. Same failure `.sk-input`
        // documents in scrapbook.css, third instance.
        // Under clay the focus indicator is an `outline`, which is its own
        // property and cannot collide with the lip, so the UA outline is left
        // to stand. A single citrine ring was never a valid indicator anyway:
        // measured 1.29:1 on paper.
        'lg:hidden',
        ctx.classNames?.toggle,
        className,
      )}
      onClick={handleClick}
      style={clayVars('var(--card-bg)', { kind: 'control', depth: 4 })}
      type='button'
      {...rest}
    >
      {iconNode}
    </button>
  );
}

NavbarMenuToggle.displayName = 'NavbarMenuToggle';

/* ============================================================
   <NavbarMenu>
   Slide-in mobile menu portaled to document.body.
   ============================================================ */

export interface NavbarMenuProps extends React.HTMLAttributes<HTMLUListElement> {
  children?: React.ReactNode;
  className?: string;
  /** HeroUI compat — kept for parity. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  motionProps?: any;
  /** HeroUI compat — kept for parity. */
  portalContainer?: Element | HTMLElement | null;
}

export function NavbarMenu(props: NavbarMenuProps) {
  const { children, className, motionProps: _mp, portalContainer, id: idProp, role: _role, ...passthrough } = props;
  // We deliberately don't spread `passthrough` onto motion.ul — its types collide
  // with framer-motion's onDrag/onAnimationStart signatures. Consumers needing
  // arbitrary HTML attrs should pass `className` / `style`.
  void passthrough;
  const ctx = React.useContext(NavbarContext);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Body scroll lock while open — counted, so a menu that overlaps any other lock
  // cannot strand the page as unscrollable. See `body-scroll-lock.ts`.
  React.useEffect(() => {
    if (!ctx?.isMenuOpen) return;

    return lockBodyScroll();
  }, [ctx?.isMenuOpen]);

  if (!ctx) return null;

  // The menu slides in from the right edge.

  const portalTarget =
    mounted && typeof document !== 'undefined' ? ((portalContainer as HTMLElement | null) ?? document.body) : null;

  if (!portalTarget) return null;

  const node = (
    <AnimatePresence>
      {ctx.isMenuOpen ? (
        <motion.div
          animate={{ opacity: 1 }}
          aria-hidden
          className='fixed inset-0 z-[60] bg-black/40 lg:hidden'
          dir={ctx.dir}
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          onClick={() => ctx.setMenuOpen(false)}
          transition={{ duration: 0.18 }}
        >
          <motion.ul
            animate={{ x: 0 }}
            className={cn(
              'absolute top-0 h-full w-[78%] max-w-[320px] overflow-y-auto',
              'clay-panel [background-color:var(--card-bg)] p-4',
              // Edge-anchored, exactly like a Drawer: only the inward edge is
              // ever seen, so only it gets a rim and a radius.
              'border-l-[3px] border-[color:var(--clay-edge)] rounded-l-lg',
              'flex flex-col gap-1',
              'end-0',
              ctx.classNames?.menu,
              className,
            )}
            // Slide IN from the right edge.
            exit={{ x: '100%' }}
            id={idProp ?? 'navbar-menu'}
            initial={{ x: '100%' }}
            onClick={(e) => e.stopPropagation()}
            role='menu'
            style={MENU_CLAY}
            transition={{ duration: 0.24, ease: [0.3, 0.6, 0.2, 1.2] }}
          >
            {children}
          </motion.ul>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  return createPortal(node, portalTarget);
}

NavbarMenu.displayName = 'NavbarMenu';

/* ============================================================
   <NavbarMenuItem>
   ============================================================ */

export interface NavbarMenuItemProps extends React.LiHTMLAttributes<HTMLLIElement> {
  isActive?: boolean;
  children?: React.ReactNode;
  className?: string;
}

export function NavbarMenuItem(props: NavbarMenuItemProps) {
  const { isActive, children, className, ...rest } = props;
  const ctx = React.useContext(NavbarContext);

  return (
    <li
      className={cn(
        'rounded-sk-sm relative flex items-center px-3 py-2.5 text-[15px] font-bold',
        'cursor-pointer transition-colors duration-[80ms]',
        // Don't wash the active item on hover: the translucent citrine would sit
        // under the non-flipping ink-const label and collapse its contrast in dark.
        !isActive && 'hover:bg-citrine/40',
        isActive ? 'bg-citrine text-ink-const [box-shadow:inset_3px_0_0_var(--ink-const)]' : 'text-ink',
        ctx?.classNames?.menuItem,
        className,
      )}
      data-active={isActive || undefined}
      {...rest}
    >
      {children}
    </li>
  );
}

NavbarMenuItem.displayName = 'NavbarMenuItem';
