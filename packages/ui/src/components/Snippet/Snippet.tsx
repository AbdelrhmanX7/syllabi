import React from 'react';

import { cn } from '../../cn';
import { clayVars } from '../clay';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';
import { HEROUI_COLOR_SOFT_FILL } from '../tokens';
import { Tooltip } from '../Tooltip/Tooltip';

/**
 * da-v2 Snippet — drop-in for HeroUI Snippet. A scrapbook card containing a
 * code line (or array of lines) plus a copy button on the inline-end. Uses
 * `navigator.clipboard.writeText()` with a `document.execCommand('copy')`
 * fallback for environments without secure-context clipboard access.
 *
 * Visual: paper-2 fill, ink border, hard offset shadow. Symbol prefix at
 * inline-start (default `$`). Copy button at inline-end with check-icon swap
 * on success (resets after `timeout` ms, default 2000). Tooltip ("Copy" /
 * "Copied!") wraps the button unless `disableTooltip`.
 *
 * The copy button sits at the end; the symbol at the start.
 */

export type SnippetVariant = 'flat' | 'solid' | 'shadow' | 'bordered';
export type SnippetColor = HeroUIColor;
export type SnippetSize = HeroUISize;
export type SnippetRadius = HeroUIRadius;

const SIZE: Record<SnippetSize, string> = {
  sm: 'text-[12px] px-2 py-1.5',
  md: 'text-[13px] px-3 py-2',
  lg: 'text-[14px] px-3.5 py-2.5',
};

const RADIUS: Record<SnippetRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-md',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
};

/**
 * A snippet is a raised surface holding code — never pressed, so `.clay-panel`
 * on the variants that are elevated at all. `control` rather than `surface`:
 * the fill is near-white and the rim is what bounds it, and `surface`'s 1.23:1
 * rim would leave a `bordered` snippet with no visible border in light.
 *
 * `solid` and `flat`+tinted deliberately keep NO lip: those two sit INSIDE
 * other surfaces as an inline tint, and a lip on an inline element pushes a
 * shadow across the text below it.
 */
function variantClasses(variant: SnippetVariant, color: SnippetColor): string {
  const tinted = color !== 'default';
  const rim = 'border-[3px] border-[color:var(--clay-edge)]';

  if (variant === 'bordered') {
    return cn('[background-color:var(--card-bg)]', rim);
  }
  if (variant === 'solid') {
    return cn(rim);
  }
  if (variant === 'shadow') {
    return cn('clay-panel [background-color:var(--card-bg)]', rim);
  }

  // flat (default)
  return cn(tinted ? 'border-[2px] border-[color:var(--clay-edge)]' : cn('clay-panel [background-color:var(--card-bg)]', rim));
}

/** The snippet surface's clay vars, and the copy button's at small-control scale. */
const SNIPPET_CLAY: React.CSSProperties = clayVars('var(--card-bg)', { kind: 'control', depth: 6 });
const COPY_CLAY: React.CSSProperties = clayVars('var(--card-bg)', { kind: 'control', depth: 4 });

const CopyIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    aria-hidden
    className={className}
    fill='none'
    height='16'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2}
    viewBox='0 0 24 24'
    width='16'
  >
    <rect height='13' rx='2' width='13' x='9' y='9' />
    <path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' />
  </svg>
);

const CheckIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    aria-hidden
    className={className}
    fill='none'
    height='16'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2.4}
    viewBox='0 0 24 24'
    width='16'
  >
    <path d='m5 12 5 5L20 7' />
  </svg>
);

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);

      return true;
    }
  } catch {
    // fall through to legacy path
  }
  if (typeof document === 'undefined') return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);

    return ok;
  } catch {
    return false;
  }
}

export interface SnippetProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'onCopy'> {
  children?: React.ReactNode | string[];
  symbol?: React.ReactNode;
  variant?: SnippetVariant;
  color?: SnippetColor;
  size?: SnippetSize;
  radius?: SnippetRadius;
  timeout?: number;
  hideCopyButton?: boolean;
  hideSymbol?: boolean;
  disableCopy?: boolean;
  disableTooltip?: boolean;
  copyIcon?: React.ReactElement;
  checkIcon?: React.ReactElement;
  /** Override the string that gets copied (defaults to children joined by \n). */
  codeString?: string;
  onCopy?: (value: string | string[]) => void;
  tooltipProps?: Partial<React.ComponentProps<typeof Tooltip>>;
  classNames?: {
    base?: string;
    pre?: string;
    content?: string;
    symbol?: string;
    copyButton?: string;
    copyIcon?: string;
    checkIcon?: string;
  };
}

export const Snippet = React.forwardRef<HTMLDivElement, SnippetProps>(function Snippet(
  {
    children,
    symbol = '$',
    variant = 'flat',
    color = 'default',
    size = 'md',
    radius = 'md',
    timeout = 2000,
    hideCopyButton,
    hideSymbol,
    disableCopy,
    disableTooltip,
    copyIcon,
    checkIcon,
    codeString,
    onCopy,
    tooltipProps,
    className,
    classNames,
    style,
    ...rest
  },
  ref,
) {
  const [copied, setCopied] = React.useState(false);
  const lines: string[] = React.useMemo(() => {
    if (Array.isArray(children)) return children.filter((c): c is string => typeof c === 'string');
    if (typeof children === 'string') return [children];

    return [];
  }, [children]);
  const isMultiLine = lines.length > 1;

  const copyValue = codeString ?? lines.join('\n');

  const handleCopy = async () => {
    if (disableCopy) return;
    const ok = await writeClipboard(copyValue);
    if (ok) {
      setCopied(true);
      onCopy?.(Array.isArray(children) ? lines : copyValue);
      window.setTimeout(() => setCopied(false), Math.max(0, timeout));
    }
  };

  const tinted = color !== 'default';
  const bgFromColor = tinted ? HEROUI_COLOR_SOFT_FILL[color] : undefined;

  const symbolNode = hideSymbol ? null : (
    <span aria-hidden className={cn('text-ink/70 me-2 shrink-0 select-none font-mono', classNames?.symbol)}>
      {symbol}
    </span>
  );

  const renderedContent =
    lines.length === 0 ? (
      typeof children === 'string' || Array.isArray(children) ? null : (
        // ReactNode passthrough for non-string children (rare, mainly for flexibility)
        <span className={cn('font-mono', classNames?.content)} dir='ltr'>
          {children as React.ReactNode}
        </span>
      )
    ) : isMultiLine ? (
      <span className={cn('flex flex-col gap-0.5', classNames?.content)} dir='ltr'>
        {lines.map((line, i) => (
          <span className='flex items-center font-mono' key={i}>
            {symbolNode}
            <span>{line}</span>
          </span>
        ))}
      </span>
    ) : (
      <span className={cn('flex min-w-0 items-center font-mono', classNames?.content)} dir='ltr'>
        <span className='truncate'>{lines[0]}</span>
      </span>
    );

  const button = !hideCopyButton ? (
    <button
      aria-label={copied ? 'Copied' : 'Copy'}
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
        // Tier 1 inside a tier-2 surface: this is the one genuinely pressable
        // thing in a Snippet. Travel equals `depth - lip`, so its bottom edge
        // does not move: rest 0/4, hover 2/2, active 3/1.
        'clay-btn text-ink border-[3px] border-[color:var(--clay-edge)] [background-color:var(--card-bg)]',
        'transition-[transform,box-shadow,opacity] duration-150',
        'hover:translate-y-[2px] active:translate-y-[3px]',
        'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        // The two-layer ring this used to carry is REMOVED, not ported. Its own
        // comment explained why it was safe: "the ring utilities keep
        // `var(--tw-shadow)` as their last layer, so `shadow-sk-sm` survives".
        // That holds for a Tailwind `shadow-*` utility, which sets `--tw-shadow`
        // and is part of the ring's composed chain. `.clay-btn` sets `box-shadow`
        // DIRECTLY, so it is not in that chain and the ring replaces it outright
        // — measured elsewhere as the lip going 4px -> 0 on focus. The pattern
        // does not survive the migration; an `outline` is its own property and
        // cannot collide.
        'ms-2',
        disableCopy && 'pointer-events-none opacity-50',
        classNames?.copyButton,
      )}
      disabled={disableCopy}
      style={COPY_CLAY}
      onClick={handleCopy}
      type='button'
    >
      {copied
        ? (checkIcon ?? <CheckIcon className={classNames?.checkIcon} />)
        : (copyIcon ?? <CopyIcon className={classNames?.copyIcon} />)}
    </button>
  ) : null;

  const wrappedButton =
    button && !disableTooltip ? (
      <Tooltip content={copied ? 'Copied!' : 'Copy'} placement='top' {...tooltipProps}>
        {button}
      </Tooltip>
    ) : (
      button
    );

  return (
    <div
      ref={ref}
      className={cn(
        'inline-flex max-w-full items-start',
        variantClasses(variant, color),
        SIZE[size],
        RADIUS[radius],
        className,
        classNames?.base,
      )}
      // Clay vars first so a caller-supplied `style` still wins, and
      // `bgFromColor` still overrides the fill for the tinted colours.
      style={{ ...SNIPPET_CLAY, background: bgFromColor, ...(style as React.CSSProperties) }}
      {...rest}
    >
      <pre
        className={cn(
          'm-0 flex min-w-0 flex-1 items-start whitespace-pre-wrap break-all p-0 font-mono',
          classNames?.pre,
        )}
      >
        {!isMultiLine && symbolNode}
        {renderedContent}
      </pre>
      {wrappedButton}
    </div>
  );
});

Snippet.displayName = 'Snippet';
