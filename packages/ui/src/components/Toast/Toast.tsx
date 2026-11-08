import React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';

import { cn } from '../../cn';
import { CLAY_FILL, CLAY_LABEL, clayKindFor, clayVars } from '../clay';
import { Spinner } from '../Spinner';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';

/**
 * da-v2 Toast — drop-in replacement for @heroui/react's Toast / addToast /
 * ToastProvider. Mirrors the HeroUI imperative API:
 *
 *   addToast({ title, description, color, variant, ... }) -> id
 *   closeToast(id)
 *   closeAll()
 *   <ToastProvider placement maxVisibleToasts toastOffset toastProps regionProps />
 *
 * Implementation:
 *  - Module-scoped pub/sub store (Map<id, ToastInternal> + Set<listener>).
 *  - <ToastProvider> subscribes via useSyncExternalStore and renders the
 *    queue inside a portal anchored to document.body.
 *  - Each toast owns its timeout + AnimatePresence exit. Hover pauses the
 *    timer (and the CSS keyframe-driven progress bar via animation-play-state).
 *  - SSR-safe: portal rendering is gated by a `mounted` flag.
 */

export type ToastVariant = 'flat' | 'solid' | 'bordered';
export type ToastPlacement = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface ToastClassNames {
  base?: string;
  title?: string;
  description?: string;
  icon?: string;
  content?: string;
  closeButton?: string;
  progressTrack?: string;
  progressIndicator?: string;
}

export interface ToastProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  color?: HeroUIColor;
  variant?: ToastVariant;
  radius?: HeroUIRadius;
  size?: HeroUISize;
  icon?: React.ReactNode;
  hideIcon?: boolean;
  hideCloseButton?: boolean;
  closeIcon?: React.ReactNode;
  endContent?: React.ReactNode;
  /** HeroUI compat — changes the icon without changing the color. */
  severity?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
  /** Auto-dismiss timeout in ms. 0 = sticky. Default 5000. */
  timeout?: number;
  /** Show the bottom progress track. Default false. */
  shouldShowTimeoutProgress?: boolean;
  /** Promise-driven toast: shows loading → success / danger on settlement. */
  promise?: Promise<unknown>;
  classNames?: ToastClassNames;
  onClose?: () => void;
  className?: string;
}

interface ToastInternal extends ToastProps {
  id: string;
  /** Index for staggered rotation. Set by provider on render. */
  __index?: number;
  /** Internal: snapshot of `color` while a promise is pending. */
  __pending?: boolean;
}

type Listener = () => void;

let _store: ReadonlyMap<string, ToastInternal> = new Map();
const _listeners: Set<Listener> = new Set();
let _id = 0;

function _setStore(next: ReadonlyMap<string, ToastInternal>) {
  _store = next;
  _listeners.forEach((l) => l());
}

function _subscribe(l: Listener) {
  _listeners.add(l);

  return () => {
    _listeners.delete(l);
  };
}

function _snapshot(): ReadonlyMap<string, ToastInternal> {
  return _store;
}

const _serverSnapshot: ReadonlyMap<string, ToastInternal> = new Map();
function _getServerSnapshot(): ReadonlyMap<string, ToastInternal> {
  return _serverSnapshot;
}

/* ----------------------- Imperative API ----------------------- */

export function addToast(props: ToastProps): string {
  const id = `t-${++_id}`;
  const t: ToastInternal = { ...props, id };

  if (props.promise) {
    // Loading state: forces sticky + spinner icon
    t.__pending = true;
    t.timeout = 0;
    t.color = props.color ?? 'default';
    const next = new Map(_store);
    next.set(id, t);
    _setStore(next);

    props.promise
      .then(() => {
        const cur = _store.get(id);
        if (!cur) return;
        const resolved: ToastInternal = {
          ...cur,
          __pending: false,
          color: 'success',
          timeout: cur.timeout && cur.timeout > 0 ? cur.timeout : 5000,
        };
        const m = new Map(_store);
        m.set(id, resolved);
        _setStore(m);
      })
      .catch(() => {
        const cur = _store.get(id);
        if (!cur) return;
        const rejected: ToastInternal = { ...cur, __pending: false, color: 'danger', timeout: 0 };
        const m = new Map(_store);
        m.set(id, rejected);
        _setStore(m);
      });
  } else {
    const next = new Map(_store);
    next.set(id, t);
    _setStore(next);
  }

  return id;
}

export function closeToast(id: string): void {
  if (!_store.has(id)) return;
  const next = new Map(_store);
  next.delete(id);
  _setStore(next);
}

export function closeAll(): void {
  if (_store.size === 0) return;
  _setStore(new Map());
}

/* ----------------------- Visual tokens ----------------------- */

const SIZE_PADDING: Record<HeroUISize, string> = {
  sm: 'p-3.5 text-[13px] gap-2.5 min-w-[260px]',
  md: 'p-4 text-[14px] gap-3 min-w-[300px]',
  lg: 'p-5 text-[15px] gap-3.5 min-w-[340px]',
};

/** A toast is a panel, not a control: same lip depth as Alert. */
const TOAST_DEPTH = 8;

const FG = 'hsl(var(--heroui-foreground))';
const SURFACE = CLAY_FILL.default;

/**
 * The chip's rim runs on the `control` mix whatever colour fills it — a 32px
 * chip is a small object whose rim is its boundary regardless of hue. See the
 * matching note in `Alert.tsx`; measured 2.90:1 / 2.77:1 at the brand mix.
 */
const CHIP_KIND = clayKindFor('default', true);

// Clay's radius ladder, written out — the JIT cannot see through a template literal.
const RADIUS_CLASS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-[14px]',
  md: 'rounded-[18px]',
  lg: 'rounded-[20px]',
  full: 'rounded-[24px]',
};

interface SurfaceTokens {
  /** The face. */
  bg: string;
  /** The label on that face. */
  fg: string;
  /** The severity chip behind the glyph. */
  chipBg: string;
  chipFg: string;
}

/**
 * The toast surface, per variant — the clay twin of `Alert`'s, deliberately, so
 * the same message at two urgencies is built out of the same parts.
 *
 * The face is whatever the variant paints; the rim and lip always derive from
 * the brand at full strength, via `clayVars`'s `shapeFrom`. A rim derived from a
 * 16% wash is a paler wash — measured 1.69-2.42:1 against the page, i.e. no
 * boundary — and `clayVars` never touches `background`, so the pale face is
 * unaffected by drawing its shape from a saturated colour.
 */
function surfaceFor(variant: ToastVariant, color: HeroUIColor): SurfaceTokens {
  const fill = CLAY_FILL[color];
  const isSolid = variant === 'solid';

  const bg = isSolid
    ? fill
    : variant === 'bordered'
      ? SURFACE
      : // flat — a tint OF THIS SURFACE. `default` has no hue to mix, so it
        // steps down the surface ladder rather than mixing itself into itself.
        color === 'default'
        ? 'hsl(var(--heroui-content2))'
        : `color-mix(in srgb, ${fill} 16%, ${SURFACE})`;

  return {
    bg,
    fg: isSolid ? CLAY_LABEL[color] : FG,
    // Severity at full strength behind the glyph — see the header. On `solid`
    // the face is already the brand, so the chip inverts instead of vanishing.
    chipBg: isSolid ? CLAY_LABEL[color] : fill,
    chipFg: isSolid ? fill : CLAY_LABEL[color],
  };
}

/* ----------------------- Default icons ----------------------- */

const CHECK_ICON = (
  <svg
    fill='none'
    height={16}
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2.6}
    viewBox='0 0 24 24'
    width={16}
  >
    <path d='M20 6 9 17l-5-5' />
  </svg>
);

const CROSS_ICON = (
  <svg
    fill='none'
    height={16}
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2.6}
    viewBox='0 0 24 24'
    width={16}
  >
    <path d='M18 6 6 18' />
    <path d='m6 6 12 12' />
  </svg>
);

const WARN_ICON = (
  <svg
    fill='none'
    height={16}
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2.4}
    viewBox='0 0 24 24'
    width={16}
  >
    <path d='M12 9v4' />
    <path d='M12 17h.01' />
    <path d='M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z' />
  </svg>
);

const INFO_ICON = (
  <svg
    fill='none'
    height={16}
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2.4}
    viewBox='0 0 24 24'
    width={16}
  >
    <circle cx='12' cy='12' r='9' />
    <path d='M12 8h.01' />
    <path d='M11 12h1v4h1' />
  </svg>
);

function defaultIconFor(color: HeroUIColor, pending?: boolean): React.ReactNode {
  if (pending) return <Spinner color='current' size='sm' />;
  if (color === 'success') return CHECK_ICON;
  if (color === 'danger') return CROSS_ICON;
  if (color === 'warning') return WARN_ICON;

  return INFO_ICON;
}

/*
 * The washi tape is GONE, and so is the map that coloured it.
 *
 * It is worth recording what it was for, because the job does not disappear with
 * the decoration. `TAPE_FOR_SEVERITY` mapped severity -> tape colour after an
 * earlier fix caught a fixed `yellow` on every toast. It was already documented
 * as "a weak channel — a 40px strip at the top edge", and it was weaker than
 * that in practice: the toast sets `overflow-hidden` and the strip sat at
 * `top: -12`, so most of it was clipped and what rendered was a pale sliver.
 *
 * Severity now lives in the icon chip instead — full-strength fill, beside the
 * title, inside the padding rather than bleeding past the edge. Same information,
 * in the reader's fovea, and it cannot be clipped by its own container.
 */

const SMALL_CLOSE = (
  <svg
    fill='none'
    height={12}
    stroke='currentColor'
    strokeLinecap='round'
    strokeWidth={2.6}
    viewBox='0 0 24 24'
    width={12}
  >
    <path d='M18 6 6 18' />
    <path d='m6 6 12 12' />
  </svg>
);

/* ----------------------- Single Toast view ----------------------- */

interface ToastViewProps {
  toast: ToastInternal;
  index: number;
  defaults?: Partial<ToastProps>;
}

function ToastView({ toast, index: _index, defaults }: ToastViewProps) {
  const merged: ToastInternal = { ...defaults, ...toast };
  const {
    id,
    title,
    description,
    color = 'default',
    variant = 'flat',
    radius = 'md',
    size = 'md',
    icon,
    hideIcon,
    severity,
    hideCloseButton,
    closeIcon,
    endContent,
    timeout: rawTimeout,
    shouldShowTimeoutProgress,
    classNames,
    onClose,
    className,
    __pending,
  } = merged;

  const timeout = typeof rawTimeout === 'number' ? rawTimeout : 5000;
  const tokens = surfaceFor(variant, color);
  // The alternating lean off the stack index is gone with the scrapbook — a clay
  // object is square to the page. `index` is still passed by the provider (it is
  // part of the internal contract and orders the stack) but nothing in the view
  // consumes it any more, hence the underscore.

  const [paused, setPaused] = React.useState(false);
  const remaining = React.useRef<number>(timeout);
  const startedAt = React.useRef<number>(Date.now());
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = React.useCallback(() => {
    closeToast(id);
    onClose?.();
  }, [id, onClose]);

  // Auto-dismiss timer (skipped while pending or sticky or paused)
  React.useEffect(() => {
    if (timeout <= 0 || __pending) {
      return;
    }
    if (paused) {
      // pause: capture remaining time
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));

      return;
    }

    startedAt.current = Date.now();
    timer.current = setTimeout(dismiss, remaining.current);

    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [paused, timeout, __pending, dismiss]);

  // Reset remaining when timeout/__pending changes (e.g. promise resolves)
  React.useEffect(() => {
    if (timeout > 0 && !__pending) {
      remaining.current = timeout;
      startedAt.current = Date.now();
    }
  }, [timeout, __pending]);

  const isStringTitle = typeof title === 'string';
  const showProgress = shouldShowTimeoutProgress && timeout > 0 && !__pending;

  return (
    <motion.div
      animate={{ opacity: 1, x: 0, scale: 1 }}
      className={cn(
        'pointer-events-auto relative inline-flex flex-col',
        // Clay's 3px edge, in a mid-tone OF THE FILL.
        'border-[3px] border-[color:var(--clay-edge)]',
        // Tier 2: raised, no press.
        'clay-surface',
        SIZE_PADDING[size],
        RADIUS_CLASS[radius],
        classNames?.base,
        className,
      )}
      exit={{ opacity: 0, x: 24, scale: 0.96 }}
      initial={{ opacity: 0, x: 24, scale: 0.96 }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role='status'
      style={
        {
          background: tokens.bg,
          color: tokens.fg,
          ...clayVars(tokens.bg, {
            shapeFrom: CLAY_FILL[color],
            kind: clayKindFor(color, true),
            depth: TOAST_DEPTH,
          }),
          // Hovering a toast PAUSES its timer, which is real behaviour — but it
          // is not a press, and `.clay-surface`'s hover lift would claim it was.
          // The lip holds still; the pause is communicated by the progress bar
          // stopping, which is the honest channel for it.
          '--clay-hover': 'var(--clay-rest)',
        } as React.CSSProperties
      }
      transition={{ duration: 0.18, ease: [0.3, 0.6, 0.2, 1.2] }}
    >
      <div className={cn('flex items-start gap-3', classNames?.content)}>
        {!hideIcon ? (
          <span
            aria-hidden
            className={cn(
              // A rim, but NO lip: the chip is inert, and a lip says "push me".
              'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]',
              'border-[2px] border-[color:var(--clay-edge)]',
              classNames?.icon,
            )}
            style={
              {
                background: tokens.chipBg,
                color: tokens.chipFg,
                // Scoped `--clay-edge`: the rim should be a mid-tone of the CHIP,
                // not of the face behind it. The lip vars come along unused,
                // because no `.clay-*` class is applied here.
                ...clayVars(tokens.chipBg, { kind: CHIP_KIND }),
              } as React.CSSProperties
            }
          >
            {icon ?? defaultIconFor(severity ?? color, __pending)}
          </span>
        ) : null}

        <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
          {title ? (
            <div
              className={cn(
                // `font-hand` on short titles is gone. It was the scrapbook's
                // handwritten voice, and clay is a physical object rather than a
                // note someone wrote.
                'font-extrabold leading-tight',
                isStringTitle && (title as string).length <= 18 ? 'text-[16px]' : 'text-[14px]',
                classNames?.title,
              )}
            >
              {title}
            </div>
          ) : null}
          {description ? (
            <div className={cn('text-[13px] leading-snug opacity-90', classNames?.description)}>{description}</div>
          ) : null}
        </div>

        {endContent}

        {!hideCloseButton ? (
          <button
            aria-label='Close'
            className={cn(
              // The only pressable thing on a toast, so the only thing that gets
              // tier 1. Depth 4, travel 3 — bottom edge fixed, lip closes.
              'clay-btn relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px]',
              'border-[2px] border-[color:var(--clay-edge)]',
              'transition-[transform,box-shadow] duration-200',
              'cursor-pointer hover:translate-y-[2px] active:translate-y-[3px]',
              'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-[2px]',
              'focus-visible:outline-[color:var(--clay-focus)]',
              'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
              // 44px touch target without inflating the drawn key (PRODUCT.md).
              "before:absolute before:inset-x-0 before:top-1/2 before:h-[44px] before:-translate-y-1/2 before:content-['']",
              classNames?.closeButton,
            )}
            onClick={dismiss}
            style={
              {
                background: SURFACE,
                color: FG,
                '--clay-focus': FG,
                ...clayVars(SURFACE, { kind: clayKindFor('default', true), depth: 4 }),
              } as React.CSSProperties
            }
            type='button'
          >
            {closeIcon ?? SMALL_CLOSE}
          </button>
        ) : null}
      </div>

      {showProgress ? (
        <div
          className={cn(
            // Was a dashed rule with a citrine bar — a torn-paper edge and the
            // scrapbook accent. Clay makes it a small recessed TRACK with a
            // solid bar in the severity colour: a groove with something moving
            // in it, which is the same object metaphor as the rest of the
            // language and also finally ties the progress bar to the severity.
            'clay-field mt-3 h-[6px] w-full overflow-hidden rounded-[14px]',
            classNames?.progressTrack,
          )}
          style={
            {
              background: `color-mix(in srgb, ${tokens.bg} 88%, var(--shadow-c))`,
              ...clayVars(tokens.bg, { kind: clayKindFor(color, true), depth: 6, inset: true }),
            } as React.CSSProperties
          }
        >
          <div
            className={cn('h-full rounded-[14px]', classNames?.progressIndicator)}
            style={{
              background: variant === 'solid' ? CLAY_LABEL[color] : CLAY_FILL[color],
              animation: `sk-toast-progress ${timeout}ms linear forwards`,
              animationPlayState: paused ? 'paused' : 'running',
            }}
          />
        </div>
      ) : null}
    </motion.div>
  );
}

/* ----------------------- Provider ----------------------- */

export interface ToastProviderProps {
  placement?: ToastPlacement;
  maxVisibleToasts?: number;
  toastOffset?: number;
  toastProps?: Partial<ToastProps>;
  regionProps?: React.HTMLAttributes<HTMLDivElement>;
  /** HeroUI compat — kept for parity. */
  disableAnimation?: boolean;
}

const PLACEMENT_CLASS: Record<ToastPlacement, string> = {
  'top-left': 'top-0 left-0 items-start',
  'top-center': 'top-0 left-1/2 -translate-x-1/2 items-center',
  'top-right': 'top-0 right-0 items-end',
  'bottom-left': 'bottom-0 left-0 items-start',
  'bottom-center': 'bottom-0 left-1/2 -translate-x-1/2 items-center',
  'bottom-right': 'bottom-0 right-0 items-end',
};

export function ToastProvider({
  placement = 'bottom-right',
  maxVisibleToasts = 3,
  toastOffset = 16,
  toastProps,
  regionProps,
}: ToastProviderProps) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const map = React.useSyncExternalStore(_subscribe, _snapshot, _getServerSnapshot);
  const list = React.useMemo(() => Array.from(map.values()), [map]);

  // Render newest toasts at the visible edge (the side closest to viewport edge).
  // For bottom placements, newer toasts appear at the bottom of the stack.
  const visibleList = React.useMemo(() => {
    const isBottom = placement.startsWith('bottom');
    const ordered = isBottom ? list : [...list].reverse();
    // Cap to maxVisibleToasts (still allows the older ones to remain in the
    // store so they can finish their exit animation if dismissed).
    return ordered.slice(-Math.max(1, maxVisibleToasts));
  }, [list, maxVisibleToasts, placement]);

  if (!mounted || typeof document === 'undefined') return null;

  const isBottom = placement.startsWith('bottom');

  return createPortal(
    <div
      aria-label='Notifications'
      className={cn('pointer-events-none fixed z-[1000] flex flex-col gap-3 p-4', PLACEMENT_CLASS[placement])}
      role='region'
      style={{
        // Apply the offset
        ...(placement.includes('top') ? { paddingTop: toastOffset } : { paddingBottom: toastOffset }),
        ...(placement.includes('left') ? { paddingLeft: toastOffset } : {}),
        ...(placement.includes('right') ? { paddingRight: toastOffset } : {}),
      }}
      {...regionProps}
    >
      <AnimatePresence initial={false} mode='popLayout'>
        {(isBottom ? visibleList : visibleList).map((t, i) => (
          <ToastView defaults={toastProps} index={i} key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

ToastProvider.displayName = 'ToastProvider';

/* ----------------------- Static Toast component (HeroUI compat) ----------------------- */

/**
 * Standalone <Toast> — rarely used directly; most consumers call addToast().
 * Provided for HeroUI parity (some apps render <Toast> inside their own list).
 */
export function Toast(props: ToastProps) {
  // Render a non-store-backed visual; consumers using this directly are
  // responsible for managing visibility.
  const fakeInternal: ToastInternal = { ...props, id: '__static__' };

  return <ToastView index={0} toast={fakeInternal} />;
}

Toast.displayName = 'Toast';
