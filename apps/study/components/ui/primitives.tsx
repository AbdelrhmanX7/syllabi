import type { KeyboardEvent, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@repo/ui";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import Link from "next/link";

import { EMAIL_NOT_VERIFIED_MESSAGE, isAiNotEnabled, isAiQuotaError } from "@/lib/api/errors";

/* ------------------------------------------------------------------ surfaces */

export function Surface({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag
      className={cn(
        "rounded-st-lg border-st-clay-edge bg-st-surface shadow-clay border-2",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function SectionTitle({
  children,
  count,
  action,
}: {
  children: ReactNode;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-st-fg font-display flex items-baseline gap-2 text-lg font-bold">
        {children}
        {typeof count === "number" && (
          <span className="text-st-muted text-sm font-medium">{count}</span>
        )}
      </h2>
      {action}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-st-lg border-st-clay-edge bg-st-surface flex flex-col items-center justify-center gap-2 border-2 border-dashed px-6 py-8 text-center">
      {Icon && <Icon className="text-st-muted h-7 w-7" strokeWidth={1.5} />}
      <p className="text-st-fg font-display text-base font-bold">{title}</p>
      {hint && <p className="text-st-muted max-w-sm text-sm">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function LoadingRows({
  rows = 4,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div aria-busy="true" className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="rounded-st bg-st-raised h-12 animate-pulse"
        />
      ))}
    </div>
  );
}

export function ErrorNote({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  // An empty AI account is not fixed by retrying — the notice stays, without the button.
  // Unverified email: retrying can't help either; the way out is Settings → Account (resend the link).
  const unverified = message === EMAIL_NOT_VERIFIED_MESSAGE;
  // AI not on for this account: only the server owner can change that, so no retry either.
  const retry = isAiQuotaError(message) || unverified || isAiNotEnabled(message) ? undefined : onRetry;

  return (
    <div className="rounded-st border-st-danger/40 bg-st-danger/10 text-st-danger flex items-center justify-between gap-3 border-2 px-4 py-3 text-sm font-medium">
      {/* Wraps, never truncates: an error line is the one text nobody can read elsewhere. */}
      <span className="min-w-0 break-words">{message}</span>
      {unverified && (
        <Link
          className="shrink-0 font-medium underline underline-offset-2"
          href="/settings/"
        >
          Settings
        </Link>
      )}
      {retry && (
        <button
          className="shrink-0 font-medium underline underline-offset-2"
          type="button"
          onClick={retry}
        >
          Retry
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ badges */

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger";

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "bg-st-raised text-st-fg border-st-line",
  accent: "bg-st-accent-soft text-st-accent border-st-accent/30",
  ok: "bg-st-ok/10 text-st-ok border-st-ok/20",
  warn: "bg-st-warn/10 text-st-warn border-st-warn/20",
  danger: "bg-st-danger/10 text-st-danger border-st-danger/20",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-semibold leading-5",
        BADGE_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "bg-st-accent inline-block h-2 w-2 rounded-full",
        className,
      )}
    />
  );
}

/* ------------------------------------------------------------------ grades */

export function TrendIcon({
  trend,
  className,
}: {
  trend: -1 | 0 | 1;
  className?: string;
}) {
  const Icon = trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Minus;
  const tone =
    trend > 0 ? "text-st-ok" : trend < 0 ? "text-st-danger" : "text-st-muted";

  return (
    <Icon
      aria-label={
        trend > 0 ? "Trending up" : trend < 0 ? "Trending down" : "Steady"
      }
      className={cn("h-4 w-4", tone, className)}
    />
  );
}

export function GradeChip({
  score,
  letter,
  trend,
  size = "md",
}: {
  score: number | null;
  letter: string | null;
  trend: -1 | 0 | 1;
  size?: "md" | "lg";
}) {
  const label =
    score === null
      ? (letter ?? "—")
      : `${score.toFixed(score >= 99.95 ? 0 : 1)}%`;
  const tone =
    score === null
      ? "text-st-muted"
      : score >= 90
        ? "text-st-ok"
        : score >= 75
          ? "text-st-fg"
          : "text-st-warn";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-semibold tabular-nums",
        tone,
        size === "lg" ? "text-3xl" : "text-base",
      )}
    >
      {label}
      {letter && score !== null && (
        <span className="text-st-muted text-sm font-medium">{letter}</span>
      )}
      <TrendIcon
        className={size === "lg" ? "h-5 w-5" : undefined}
        trend={trend}
      />
    </span>
  );
}

/* ------------------------------------------------------------------ buttons */

// The board's floating top-bar chips: one 36px round size, clay edge + lip; labels hide (icon + tooltip).
export const BOARD_CHIP =
  "pointer-events-auto relative inline-flex h-9 min-h-9 min-w-9 items-center justify-center gap-1 rounded-st border-2 border-st-clay-edge bg-st-surface px-2 text-xs font-semibold text-st-fg shadow-clay transition-[transform,box-shadow] duration-100 hover:bg-st-accent-soft active:translate-y-[3px] active:shadow-none disabled:opacity-60";
/** ActionButton overrides that turn it into a BOARD_CHIP (tailwind-merge drops the base size). */
export const BOARD_CHIP_OVERRIDE = "pointer-events-auto h-9 min-h-9 min-w-9 gap-1 rounded-st px-2 text-xs";

// Clay button (the @repo/ui look): tinted fill, a same-hue edge, and a solid lip straight DOWN that the press sinks into.
const BUTTON_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border-2 px-4 text-sm font-semibold transition-[transform,box-shadow,background-color] duration-100 active:translate-y-[3px] active:shadow-none disabled:pointer-events-none disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-st-accent";

export const BUTTON_VARIANT = {
  primary:
    "border-st-accent-lip bg-st-accent text-st-accent-fg shadow-clay-accent hover:brightness-110",
  secondary:
    "border-st-clay-edge bg-st-surface text-st-fg shadow-clay hover:bg-st-accent-soft",
  soft:
    "border-st-accent bg-st-accent-soft text-st-fg shadow-clay-accent hover:brightness-[1.03]",
  accent:
    "border-st-star-lip bg-st-star text-st-star-fg shadow-clay-star hover:brightness-105",
  ghost:
    "border-transparent text-st-fg hover:bg-st-raised active:translate-y-0",
  danger:
    "border-st-danger-lip bg-st-danger text-st-danger-fg shadow-clay-danger hover:brightness-110",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANT;

export function ActionButton({
  children,
  variant = "secondary",
  className,
  loading,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      className={cn(BUTTON_BASE, BUTTON_VARIANT[variant], className)}
      disabled={props.disabled || loading}
      type={props.type ?? "button"}
    >
      {loading && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  children,
  variant = "secondary",
  className,
  "aria-label": ariaLabel,
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Link
      aria-label={ariaLabel}
      className={cn(BUTTON_BASE, BUTTON_VARIANT[variant], className)}
      href={href}
    >
      {children}
    </Link>
  );
}

/* ------------------------------------------------------------------ filter chips */

export function FilterChip({
  active,
  children,
  onClick,
  count,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        // Clay chip: 32px, same-hue edge + short straight lip; selected = soft accent (several rows of
        // solid-blue «All» chips shouted over the content).
        "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm border-2 px-3 text-[13px] font-semibold transition-[transform,box-shadow,border-color] duration-100 active:translate-y-[2px] active:shadow-none",
        active
          ? "border-st-accent bg-st-accent-soft text-st-fg shadow-[0_3px_0_rgb(var(--st-accent))]"
          : "border-st-control-edge bg-st-surface text-st-fg shadow-[0_3px_0_rgb(var(--st-clay-edge))] hover:border-st-accent",
      )}
      type="button"
      onClick={onClick}
    >
      {children}
      {typeof count === "number" && (
        <span
          className="text-st-muted text-xs tabular-nums"
        >
          {count}
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ divider tabs */

export interface DividerTab<K extends string> {
  key: K;
  label: ReactNode;
  icon?: ReactNode;
  count?: number;
}

/**
 * Notebook-divider tabs: index tabs standing on a rail, the active one on page paper so it opens
 * into the content below. The rail is drawn inside the scroller and the active tab sits above it,
 * so a horizontal scroll on a narrow tablet never clips the tab edges.
 */
export function DividerTabs<K extends string>({
  tabs,
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
}: {
  tabs: DividerTab<K>[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
  "aria-label": string;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const idx = tabs.findIndex((tab) => tab.key === value);
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

    if (!step || idx < 0) return;
    event.preventDefault();
    const next = tabs[(idx + step + tabs.length) % tabs.length];

    onChange(next.key);
    document.getElementById(`divider-tab-${next.key}`)?.focus();
  };

  return (
    <div className={cn("relative -mx-1 overflow-x-auto px-1 pt-1", className)}>
      <div
        aria-label={ariaLabel}
        className="relative flex min-w-max items-end gap-1 ps-2"
        role="tablist"
      >
        <span
          aria-hidden
          className="bg-st-clay-edge absolute inset-x-0 bottom-0 h-0.5"
        />
        {tabs.map((tab) => {
          const active = tab.key === value;

          return (
            <button
              key={tab.key}
              aria-selected={active}
              className={cn(
                "relative inline-flex items-center gap-1.5 rounded-t-xl border-2 border-b-0 px-3 text-sm font-semibold transition-colors",
                "focus-visible:outline-st-accent focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2",
                active
                  ? "border-st-clay-edge bg-st-bg text-st-fg z-10 min-h-11"
                  : "border-st-line bg-st-raised text-st-muted hover:text-st-fg mb-0.5 min-h-10",
              )}
              id={`divider-tab-${tab.key}`}
              role="tab"
              tabIndex={active ? 0 : -1}
              type="button"
              onClick={() => onChange(tab.key)}
              onKeyDown={onKeyDown}
            >
              {tab.icon && (
                <span
                  // Icons only where there's room: on a tablet the labels alone keep every tab in view.
                  className={cn("hidden lg:inline-flex", active ? "text-st-accent" : "")}
                >
                  {tab.icon}
                </span>
              )}
              {tab.label}
              {typeof tab.count === "number" && (
                <span
                  className={cn(
                    "rounded-sm px-1.5 text-xs",
                    active
                      ? "bg-st-star text-st-star-fg"
                      : "bg-st-line text-st-muted",
                  )}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ fields */

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-st-fg text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="text-st-muted text-xs">{hint}</span>}
    </label>
  );
}

export const INPUT_CLASS =
  "min-h-11 w-full rounded-st border-2 border-st-control-edge bg-st-surface px-3 text-sm text-st-fg placeholder:text-st-muted focus:border-st-accent focus:outline-none focus:ring-2 focus:ring-st-accent/25";
