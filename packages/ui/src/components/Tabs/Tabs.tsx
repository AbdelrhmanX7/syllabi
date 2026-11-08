import React from 'react';
import { AnimatePresence, motion } from 'motion/react';

import { cn } from '../../cn';
import { CLAY_FILL, CLAY_LABEL, clayKindFor, clayVars } from '../clay';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';
import { HEROUI_COLOR_TEXT } from '../tokens';

/**
 * da-v2 Tabs / Tab — drop-in for HeroUI's Tabs.
 *
 * HeroUI API surface mirrored:
 *   <Tabs aria-label items selectedKey defaultSelectedKey onSelectionChange
 *         variant='solid'|'bordered'|'light'|'underlined' color size radius
 *         placement isVertical destroyInactiveTabPanel disableAnimation
 *         isDisabled disabledKeys classNames fullWidth>
 *     <Tab key title>{children}</Tab>
 *   </Tabs>
 *
 * Visual language: CLAY. A tab strip is a row of physical keys and the selected one is
 * LATCHED DOWN — it sits pressed into the page with its lip closed while its siblings
 * stay raised on a 4-6px lip. That is the whole point of moving Tabs to clay: selection
 * is the one piece of state this component carries, and clay can express it as a
 * POSITION rather than only as a colour. Colour still moves too (the pressed key takes
 * the brand fill), so the state survives for anyone who cannot read the 5px of travel.
 *
 * Per variant, and why:
 *   solid      raised neutral keys; the selected one is pressed in AND takes the brand
 *              fill. The loudest, and the default.
 *   bordered   the same key strip with the colour in the RIM and the LIP instead of the
 *              face — `clayVars` is fed the brand fill while the background stays the
 *              neutral surface, so the edge, the lip and the ambient glow all go brand
 *              and the body does not.
 *   light      no slab. The selected tab is a shallow WELL — clay tier 3, an inset
 *              rather than a lip — holding a wash of the colour. Quietest, and the only
 *              variant where the selected tab is recessed instead of the siblings raised.
 *   underlined NO clay slab at all, by definition: the variant is defined by not having
 *              one. Clay contributes the 3px rounded bar (clay's edge weight, clay's
 *              radius) that replaces the old hairline border, and nothing else. There is
 *              no lip to close, so there is no press — travelling with no shadow to
 *              answer it reads as a glitch, not as a key going down.
 *
 * Unselected tabs are always muted, so the selected one wins by contrast in every
 * variant. Tab panels animate via opacity/translate.
 */

export type TabsVariant = 'solid' | 'bordered' | 'light' | 'underlined';
export type TabsPlacement = 'top' | 'bottom' | 'start' | 'end';

// Clay is chunkier than the scrapbook was: a key you press needs somewhere to press.
const TAB_SIZE: Record<HeroUISize, string> = {
  sm: 'h-9 px-4 text-xs',
  md: 'h-10 px-5 text-sm',
  lg: 'h-12 px-6 text-base',
};

// Clay's radius ladder (CLAY_RADIUS = 14/18/20/24), written out rather than
// interpolated: Tailwind's JIT scans source TEXT and cannot see through a template
// literal, so an interpolated arbitrary `rounded-` value generates no class at all. These must
// stay in step with clay.ts by hand.
const RADIUS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-[14px]',
  md: 'rounded-[18px]',
  lg: 'rounded-[20px]',
  full: 'rounded-full',
};

/**
 * Lip depth per size. A 6px lip under a 36px `sm` tab is a plinth, not a key, so the
 * depth tracks the tab's height. Everything else derives from it:
 *   hover   `clayVars` sets the lip to depth-2, so the key travels 2px — one number for
 *           every size, which is why there is no per-size hover class.
 *   pressed the lip closes to 1px, so the key travels depth-1 and its BOTTOM edge stays
 *           exactly where it was. Animating the travel without the lip makes it slide.
 */
const DEPTH: Record<HeroUISize, number> = { sm: 4, md: 5, lg: 6 };

// Literal classes for the same reason as RADIUS above. `PRESS` is the transient press
// under the pointer; `LATCHED` is the same offset held permanently by the selected tab.
const PRESS: Record<HeroUISize, string> = {
  sm: 'active:translate-y-[3px]',
  md: 'active:translate-y-[4px]',
  lg: 'active:translate-y-[5px]',
};
const LATCHED: Record<HeroUISize, string> = {
  sm: 'translate-y-[3px]',
  md: 'translate-y-[4px]',
  lg: 'translate-y-[5px]',
};

/**
 * Clay speaks in two HeroUI tokens and mixes everything else out of them, which is what
 * makes it impossible to invert in dark mode. These are the two.
 */
const FG = 'hsl(var(--heroui-foreground))';
const SURFACE = CLAY_FILL.default;

/**
 * An unselected label. Mixed toward the slab it sits on rather than faded with opacity,
 * so it stays in the surface's own family in both themes and never lands on a
 * transparent hole. 62% is the point where it reads as secondary and still clears AA
 * against the surface.
 */
const MUTED = `color-mix(in srgb, ${FG} 62%, ${SURFACE})`;

interface TabDescriptor {
  key: string;
  title: React.ReactNode;
  isDisabled?: boolean;
  panel: React.ReactNode;
}

interface TabsContextValue {
  selectedKey: string;
  setSelectedKey: (k: string) => void;
  registerTab: (d: TabDescriptor) => void;
  unregisterTab: (k: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

/* ============================================================
   <Tab> — registers itself with the parent Tabs.
   The Tab itself is "data-only"; rendering happens in <Tabs>.
   ============================================================ */

export interface TabProps {
  /** Provide via React `key`. Mirrored at runtime via __itemKey. */
  title?: React.ReactNode;
  isDisabled?: boolean;
  children?: React.ReactNode;
  /** Internal — supplied by <Tabs>. */
  __itemKey?: string;
  /** HeroUI compat — kept for parity. */
  className?: string;
  /** HeroUI compat — kept for parity. */
  href?: string;
}

export function Tab(props: TabProps) {
  const { title, isDisabled, children, __itemKey } = props;
  const ctx = React.useContext(TabsContext);
  const key = String(__itemKey ?? '');

  const register = ctx?.registerTab;
  const unregister = ctx?.unregisterTab;

  React.useEffect(() => {
    if (!register || !unregister || !key) return;
    register({ key, title, isDisabled, panel: children });

    return () => unregister(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, unregister, key, isDisabled, title, children]);

  return null;
}

Tab.displayName = 'Tab';

/* ============================================================
   <Tabs>
   ============================================================ */

export interface TabsProps {
  'aria-label'?: string;
  items?: Iterable<{ key?: string; id?: string; title?: React.ReactNode; [k: string]: unknown }>;
  children?: React.ReactNode | ((item: any) => React.ReactNode); // eslint-disable-line @typescript-eslint/no-explicit-any
  selectedKey?: string;
  defaultSelectedKey?: string;
  onSelectionChange?: (key: string) => void;
  variant?: TabsVariant;
  color?: HeroUIColor;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  placement?: TabsPlacement;
  isVertical?: boolean;
  destroyInactiveTabPanel?: boolean;
  disableAnimation?: boolean;
  isDisabled?: boolean;
  disabledKeys?: Iterable<string>;
  fullWidth?: boolean;
  className?: string;
  classNames?: {
    base?: string;
    tabList?: string;
    tab?: string;
    tabContent?: string;
    cursor?: string;
    panel?: string;
    panelContainer?: string;
  };
  /** HeroUI compat — keyboard activation mode. */
  keyboardActivation?: 'automatic' | 'manual';
  /** HeroUI compat — kept for parity. */
  motionProps?: Record<string, unknown>;
}

export function Tabs(props: TabsProps) {
  const {
    children,
    items,
    selectedKey: selectedKeyProp,
    defaultSelectedKey,
    onSelectionChange,
    variant = 'solid',
    color = 'default',
    size = 'md',
    radius = 'md',
    placement = 'top',
    isVertical,
    destroyInactiveTabPanel = true,
    disableAnimation,
    isDisabled,
    disabledKeys,
    fullWidth,
    className,
    classNames,
    'aria-label': ariaLabel,
  } = props;

  const orderRef = React.useRef<string[]>([]);
  const [tabs, setTabs] = React.useState<Map<string, TabDescriptor>>(new Map());
  const disabledKeySet = React.useMemo(
    () => new Set(disabledKeys ? Array.from(disabledKeys, String) : []),
    [disabledKeys],
  );

  const isControlled = selectedKeyProp !== undefined;
  const [internalKey, setInternalKey] = React.useState<string>(defaultSelectedKey ?? '');
  const activeKey = isControlled ? String(selectedKeyProp) : internalKey;

  const setSelectedKey = React.useCallback(
    (k: string) => {
      if (!isControlled) setInternalKey(k);
      onSelectionChange?.(k);
    },
    [isControlled, onSelectionChange],
  );

  const registerTab = React.useCallback((d: TabDescriptor) => {
    setTabs((prev) => {
      const next = new Map(prev);
      next.set(d.key, d);

      return next;
    });
    if (!orderRef.current.includes(d.key)) orderRef.current.push(d.key);
  }, []);

  const unregisterTab = React.useCallback((k: string) => {
    setTabs((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Map(prev);
      next.delete(k);

      return next;
    });
    orderRef.current = orderRef.current.filter((x) => x !== k);
  }, []);

  // Default to first registered tab once known.
  React.useEffect(() => {
    if (!activeKey && orderRef.current.length > 0) {
      setInternalKey(orderRef.current[0]);
    }
  }, [activeKey, tabs.size]);

  /* ---------- inject __itemKey via React `key` so <Tab> can register itself ---------- */
  const renderedTabs: React.ReactNode = React.useMemo(() => {
    if (items && typeof children === 'function') {
      const arr: React.ReactNode[] = [];
      const itemsArr = Array.isArray(items)
        ? (items as Array<{ key?: string; id?: string }>)
        : Array.from(items as Iterable<{ key?: string; id?: string }>);
      itemsArr.forEach((item) => {
        const k = String(item.key ?? item.id ?? '');
        const node = (children as (it: typeof item) => React.ReactNode)(item);
        if (React.isValidElement(node)) {
          arr.push(React.cloneElement(node as React.ReactElement, { key: k, __itemKey: k } as Partial<TabProps>));
        } else {
          arr.push(node);
        }
      });

      return arr;
    }

    return React.Children.map(children as React.ReactNode, (child) => {
      if (React.isValidElement(child)) {
        const k = String((child.key ?? '') as string).replace(/^\.\$/, '');

        return React.cloneElement(child as React.ReactElement, { __itemKey: k } as Partial<TabProps>);
      }

      return child;
    });
  }, [items, children]);

  /* ---------- styling ---------- */
  const isVerticalLayout = isVertical || placement === 'start' || placement === 'end';

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const order = orderRef.current.filter((k) => !disabledKeySet.has(k) && !tabs.get(k)?.isDisabled);
    if (!order.length) return;
    const idx = order.indexOf(activeKey);
    if (e.key === (isVerticalLayout ? 'ArrowDown' : 'ArrowRight')) {
      e.preventDefault();
      setSelectedKey(order[(idx + 1) % order.length]);
    } else if (e.key === (isVerticalLayout ? 'ArrowUp' : 'ArrowLeft')) {
      e.preventDefault();
      setSelectedKey(order[(idx - 1 + order.length) % order.length]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setSelectedKey(order[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      setSelectedKey(order[order.length - 1]);
    }
  };

  /* ---------- what the variant is made of ---------- */

  const isUnderlined = variant === 'underlined';
  const isWell = variant === 'light';
  /*
   * `bordered` only has something to put in the rim when a brand colour was asked for.
   * With `default` there is no hue, so it falls back to the `solid` key — not to a
   * neutral rim on a neutral face, which is a raised slab with no selected state at all.
   */
  const isRimmed = variant === 'bordered' && color !== 'default';
  /** The two variants that build a raised key. `light` is recessed; `underlined` is flat. */
  const hasSlab = !isUnderlined && !isWell;

  const depth = DEPTH[size];

  /*
   * The brand as a MARK — a rule or a label on a neutral ground — is not the same colour
   * as the brand as a FILL. The raw hues fail contrast as text, which is what the
   * `*-text` tokens exist to fix, and they are the only place in the system that answer
   * this question. `default` is the one entry clay overrules: `HEROUI_COLOR_TEXT.default`
   * is the scrapbook's INK, and clay marks in the theme foreground instead.
   */
  const mark = color === 'default' ? FG : HEROUI_COLOR_TEXT[color];

  /*
   * The selected face, per variant.
   *   solid    the brand fill — a coloured key.
   *   bordered the neutral surface; the colour is in the rim and the lip, not here.
   *   light    the brand mixed 18% into the surface. Derived rather than taken from a
   *            soft-fill map so it is guaranteed to be a tint OF THIS SURFACE in both
   *            themes — 18% purple into white is a pale lavender, 18% purple into the
   *            dark surface is a tinted navy, and neither can invert.
   *            `default` has no hue to mix, so it steps one rung down the surface ladder
   *            instead; mixing content1 into content1 would have been a no-op and left
   *            the selected tab invisible on a white page.
   *   underlined nothing. The bar below the label is the whole state.
   */
  const selectedFace = isUnderlined
    ? 'transparent'
    : isWell
      ? color === 'default'
        ? 'hsl(var(--heroui-content2))'
        : `color-mix(in srgb, ${CLAY_FILL[color]} 18%, ${SURFACE})`
      : isRimmed
        ? SURFACE
        : CLAY_FILL[color];

  /*
   * Which fill the LIP, the RIM and the ambient glow are derived from. This is the one
   * place `bordered` and `solid` part company: both paint `clayVars` from the brand, but
   * `bordered` paints its BACKGROUND from the surface, so the colour survives only in
   * the edge. `clayVars` never touches `background`, which is what makes that possible.
   */
  const selectedShape = isRimmed ? CLAY_FILL[color] : selectedFace;

  /* ---------- the three clay recipes ----------
     None of these depend on WHICH tab is being drawn, only on the variant and the colour,
     so they are built once per render rather than once per tab. */

  /**
   * An unlatched key: raised on its lip, neutral, identical in every slab variant.
   *
   * `control`, not `surface`. An unselected tab is ALWAYS a near-white slab on a near-white
   * card, and its 3px rim is the only thing that says a key is there — there is no fill and
   * no full-strength label doing that job. `surface` mixes the edge at 90%, which measures
   * 1.23:1 and is invisible at this size; `control` mixes at 50% and clears the 3:1 floor
   * WCAG 1.4.11 puts on a graphic that carries meaning.
   *
   * Written through `clayKindFor('default', true)` rather than the literal `'control'` so
   * this call site answers a grep for `clayKindFor` — as a hardcoded `kind: 'surface'` it
   * did not, which is exactly how it survived a sweep that caught the other two.
   */
  const raised = clayVars(SURFACE, { kind: clayKindFor('default', true), depth }) as Record<string, string>;

  /*
   * A latched key. `clay-btn` styles `:hover` and `:focus-visible` unconditionally, and a
   * key that is already down must not rise when the pointer crosses it — so `--clay-rest`
   * and `--clay-hover` are both overwritten with the pressed shadow the helper has already
   * computed. Reading `--clay-active` back off the helper's own output is deliberate: the
   * alternative is re-deriving the closed lip here, which is exactly the per-component
   * drift `clay.ts` exists to prevent.
   */
  const pressed = clayVars(selectedShape, { kind: clayKindFor(color, true), depth }) as Record<string, string>;
  const latched = { ...pressed, '--clay-rest': pressed['--clay-active'], '--clay-hover': pressed['--clay-active'] };

  /*
   * A well (`light`). No lip and no hover lift — a hole does not rise — so all three of
   * its states are the one inset `clayVars({ inset: true })` returns.
   *
   * Twice the depth, and the BRAND mix profile rather than the surface one, because an
   * inset has half the reach of a lip: `clayVars` offsets it by depth/2 where a lip gets
   * the full depth, and it is drawn on top of the wash instead of underneath the slab. At
   * the surface profile and the slab's own depth it measured as a 2px grey hairline — a
   * wash with a smudge on it, not a hole.
   */
  const well = clayVars(selectedFace, { kind: clayKindFor(color, true), depth: depth * 2, inset: true }) as Record<
    string,
    string
  >;

  /* ---------- per-tab visuals ---------- */
  const renderTabButton = (d: TabDescriptor) => {
    const isActive = d.key === activeKey;
    const isLocallyDisabled = isDisabled || d.isDisabled || disabledKeySet.has(d.key);

    const face = isActive ? selectedFace : hasSlab ? SURFACE : 'transparent';

    /*
     * Label colour:
     *   solid active     `CLAY_LABEL[color]` — the theme's own answer for a label on that
     *                    fill. Never `#ffffff`: white is right on the default purple and
     *                    wrong on a light amber brand.
     *   bordered active  the mark, since the face underneath it is the neutral surface.
     *   light active     the full-strength foreground. The wash is a tint of the surface,
     *                    so the surface's own text colour is by construction correct on it.
     *   underlined active the mark, which is what makes the label read as selected
     *                    alongside the bar.
     *   inactive         muted, in every variant.
     */
    const activeFg = isUnderlined || isRimmed ? mark : isWell ? FG : CLAY_LABEL[color];
    const fg = isActive ? activeFg : MUTED;

    const clay = hasSlab ? (isActive ? latched : raised) : isWell && isActive ? well : undefined;

    return (
      <button
        key={d.key}
        aria-controls={`${d.key}-panel`}
        aria-selected={isActive}
        className={cn(
          'relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-bold',
          // 44px minimum touch target (PRODUCT.md) without inflating the drawn key: `sm`
          // and `md` paint at 36px and 40px, which are the right visual weights and the
          // wrong hit areas. A transparent 44px band centred on the button only ever ADDS
          // to the hit area, so `lg` (48px) is unaffected and the visual metrics of all
          // three are untouched. It sits below the label, which is already `z-[1]`.
          "before:absolute before:inset-x-0 before:top-1/2 before:h-[44px] before:-translate-y-1/2 before:content-['']",
          // Only transform and box-shadow animate. The fill snaps, because the fill is
          // reporting a selection that has already happened while the travel is the
          // movement that reports it — cross-fading both makes the press read as a
          // colour wash instead of a key going down.
          'transition-[transform,box-shadow] duration-200',
          TAB_SIZE[size],
          isUnderlined ? 'rounded-none' : RADIUS[radius],
          fullWidth && 'flex-1',
          // Clay's 3px edge, in a mid-tone OF THE FILL. `light` deliberately has none:
          // a rim would make the well read as a second kind of slab, and the whole job
          // of the variant is to be the one that is not a slab.
          hasSlab && 'border-[3px] border-[color:var(--clay-edge)]',
          /*
           * Elevation, but only while the tab can actually be pressed.
           *
           * A lip says "push me", so a disabled tab must not have one — it would be an
           * affordance that lies. Disabled therefore flattens (no `clay-btn`, no
           * `clay-field`, so no `box-shadow` at all) while KEEPING its latch offset and
           * its 3px edge: position carries the state, elevation carries the affordance,
           * and only the second one is untrue when the control is inert. Dropping the
           * offset too would erase the selected state outright at `color='default'`,
           * where the selected fill and the surface are the same token.
           *
           * The shadow states are real CSS in styles/scrapbook.css — a Tailwind
           * `shadow-[var(--clay-rest)]` computes to `none` here.
           */
          hasSlab && !isLocallyDisabled && 'clay-btn',
          isWell && isActive && !isLocallyDisabled && 'clay-field',
          // Latched: held at the pressed offset for as long as it is the selected tab.
          hasSlab && isActive && LATCHED[size],
          isLocallyDisabled && 'cursor-not-allowed opacity-50',
          // Only an UNLATCHED key moves. Everything about the selected one is already
          // down, including under `focus-visible`, which `.clay-btn` also styles.
          !isLocallyDisabled &&
            !isActive &&
            hasSlab &&
            cn(
              'cursor-pointer hover:translate-y-[2px]',
              PRESS[size],
              'active:scale-[0.99]',
            ),
          !isLocallyDisabled && !hasSlab && 'cursor-pointer',
          // A focus ring in the theme foreground rather than a brand accent: it has to
          // clear 3:1 on a white key, a purple key and a dark-mode navy page alike, and
          // it must stay distinguishable from selection, which already owns the brand.
          'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-[2px]',
          'focus-visible:outline-[color:var(--clay-focus)]',
          'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
          classNames?.tab,
        )}
        disabled={isLocallyDisabled}
        id={`${d.key}-tab`}
        onClick={() => !isLocallyDisabled && setSelectedKey(d.key)}
        onKeyDown={handleKeyDown}
        role='tab'
        style={
          {
            background: face,
            color: fg,
            ['--clay-focus' as string]: FG,
            ...clay,
          } as React.CSSProperties
        }
        tabIndex={isActive ? 0 : -1}
        type='button'
      >
        <span className={cn('relative z-[1] inline-flex items-center justify-center gap-2', classNames?.tabContent)}>
          {d.title}
        </span>
        {/*
         * `underlined`'s entire selected state. A positioned bar rather than a
         * `border-bottom` for two reasons: a border cannot carry a radius, so it can only
         * ever be a hairline and never a small clay bar; and the border colour would have
         * to be set inline next to `background`, where it beat every utility class — the
         * documented reason this variant went a long time without drawing any underline
         * at all. Nothing can shadow an element that owns its own colour.
         */}
        {isUnderlined ? (
          <span
            aria-hidden='true'
            className='pointer-events-none absolute inset-x-2 bottom-0 h-[3px] rounded-full transition-colors duration-200'
            style={{ background: isActive ? mark : 'transparent' }}
          />
        ) : null}
      </button>
    );
  };

  const ordered: TabDescriptor[] = orderRef.current.map((k) => tabs.get(k)).filter(Boolean) as TabDescriptor[];

  const activeTab = tabs.get(activeKey);

  /* ---------- panel ---------- */
  const renderPanels = () => {
    if (destroyInactiveTabPanel) {
      return (
        <AnimatePresence mode='wait'>
          {activeTab ? (
            <motion.div
              key={activeTab.key}
              animate={disableAnimation ? undefined : { opacity: 1, y: 0 }}
              aria-labelledby={`${activeTab.key}-tab`}
              className={cn('outline-none', classNames?.panel)}
              exit={disableAnimation ? undefined : { opacity: 0, y: 4 }}
              id={`${activeTab.key}-panel`}
              initial={disableAnimation ? undefined : { opacity: 0, y: -4 }}
              role='tabpanel'
              tabIndex={0}
              transition={{ duration: 0.18, ease: [0.3, 0.6, 0.2, 1.2] }}
            >
              {activeTab.panel}
            </motion.div>
          ) : null}
        </AnimatePresence>
      );
    }

    return ordered.map((d) => (
      <div
        key={d.key}
        aria-labelledby={`${d.key}-tab`}
        className={cn('outline-none', classNames?.panel, d.key !== activeKey && 'hidden')}
        id={`${d.key}-panel`}
        role='tabpanel'
        tabIndex={0}
      >
        {d.panel}
      </div>
    ));
  };

  return (
    <TabsContext.Provider value={{ selectedKey: activeKey, setSelectedKey, registerTab, unregisterTab }}>
      {/* Mount Tab children so they can register, but render their panel via active selection. */}
      {renderedTabs}
      <div
        aria-label={ariaLabel}
        className={cn(
          'flex',
          isVerticalLayout ? 'flex-row gap-4' : 'flex-col gap-3',
          (placement === 'bottom' || placement === 'end') && 'flex-col-reverse',
          className,
          classNames?.base,
        )}
      >
        <div
          aria-orientation={isVerticalLayout ? 'vertical' : 'horizontal'}
          className={cn(
            'flex',
            isVerticalLayout ? 'flex-col gap-2' : 'flex-row flex-wrap gap-2',
            // Room for the lip. Every raised key carries up to 6px of solid shadow below
            // it, and the strip's own box has to reserve that or the lip of a wrapped
            // row lands on the labels of the row beneath it.
            hasSlab && 'pb-[6px]',
            fullWidth && !isVerticalLayout && 'w-full',
            classNames?.tabList,
          )}
          role='tablist'
        >
          {ordered.map(renderTabButton)}
        </div>
        <div className={cn('relative flex-1', classNames?.panelContainer)}>{renderPanels()}</div>
      </div>
    </TabsContext.Provider>
  );
}

Tabs.displayName = 'Tabs';
