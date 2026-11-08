import React from 'react';

import { cn } from '../../cn';
import { ICON_REGISTRY, type RegisteredIconName } from './registry';

/**
 * Scrapbook icon wrapper. Three modes:
 *
 *   1. Registered hand-drawn icon (state-aware):
 *        <Icon name="lock" active={isLocked} />
 *        <Icon name="heart" active={isFav} />
 *
 *   2. Wrapped lucide (or any) component — applies scrapbook stroke + animation:
 *        <Icon as={Search} hover="wiggle" />
 *
 *   3. Custom inline children — for one-off icons:
 *        <Icon><path d="..." /></Icon>
 *
 * Animation is CSS-only: pass `hover`/`active`/`focus` to declare which
 * keyframe runs on which state. The `trigger` prop lets the icon respond to
 * its parent's hover/focus instead of its own (e.g. icon inside a Button):
 *
 *        <button className="group">
 *          <Icon name="heart" hover="pop" trigger="group-hover" />
 *        </button>
 *
 * Animation names (defined in scrapbook.css):
 *   wiggle | pop | bounce | shake | spin | draw-in
 *
 * Stroke + fill follow `currentColor` so parent text-color tokens drive both.
 */

export type IconHoverAnimation = 'wiggle' | 'pop' | 'bounce' | 'shake' | 'spin' | 'none';

export type IconTrigger = 'self' | 'group-hover' | 'group-focus' | 'always';

export interface IconProps {
  /** Registered hand-drawn icon name. Mutually exclusive with `as` and children. */
  name?: RegisteredIconName;
  /** Wrap any external icon component (e.g. lucide). Mutually exclusive with `name` and children. */
  as?: React.ComponentType<{ size?: number | string; className?: string; strokeWidth?: number }>;
  /** Animation that plays when the trigger fires. */
  hover?: IconHoverAnimation;
  /** What event triggers the hover animation. Default `self`. */
  trigger?: IconTrigger;
  /** State for registry icons that have a stateful pair (lock/unlock, heart, etc.). */
  active?: boolean;
  /** Pixel size for both width and height. Default 20. */
  size?: number;
  /** Stroke thickness. Default 1.8 — slightly heavier than lucide's 2 for hand-drawn weight. */
  strokeWidth?: number;
  /** Tailwind classes — most commonly for color (`text-ink`, `text-sk-primary`, etc.). */
  className?: string;
  /** Inline children: raw <path>, <circle>, etc. (mode 3). */
  children?: React.ReactNode;
  /** Accessible label. */
  'aria-label'?: string;
}

const HOVER_CLASS: Record<IconHoverAnimation, string> = {
  wiggle: 'sk-icon-wiggle',
  pop: 'sk-icon-pop',
  bounce: 'sk-icon-bounce',
  shake: 'sk-icon-shake',
  spin: 'sk-icon-spin',
  none: '',
};

function triggerClass(animation: IconHoverAnimation, trigger: IconTrigger): string {
  if (animation === 'none') return '';
  const cls = HOVER_CLASS[animation];

  switch (trigger) {
    case 'self':
      return `hover:${cls}`;
    case 'group-hover':
      return `group-hover:${cls}`;
    case 'group-focus':
      return `group-focus-visible:${cls}`;
    case 'always':
      return cls;
    default:
      return '';
  }
}

export const Icon = React.forwardRef<SVGSVGElement, IconProps>(function Icon(
  {
    name,
    as: As,
    hover = 'none',
    trigger = 'self',
    active,
    size = 20,
    strokeWidth = 1.8,
    className,
    children,
    'aria-label': ariaLabel,
  },
  ref,
) {
  const trigCls = triggerClass(hover, trigger);

  // Mode 2 — wrap external component (lucide, etc.).
  if (As) {
    return (
      <As
        // forwardRef-passthrough is best-effort — most icon libs accept any HTMLAttributes.
        className={cn(trigCls, className)}
        size={size}
        strokeWidth={strokeWidth}
      />
    );
  }

  // Mode 1 (registry) or Mode 3 (inline children).
  const Glyph = name ? ICON_REGISTRY[name] : null;
  const hidden = !ariaLabel ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': ariaLabel };

  return (
    <svg
      ref={ref}
      className={cn(
        // Hand-drawn base — round caps, ink stroke colour from parent.
        'inline-block fill-none stroke-current',
        trigCls,
        className,
      )}
      fill='none'
      height={size}
      stroke='currentColor'
      strokeLinecap='round'
      strokeLinejoin='round'
      strokeWidth={strokeWidth}
      viewBox='0 0 24 24'
      width={size}
      xmlns='http://www.w3.org/2000/svg'
      {...hidden}
    >
      {Glyph ? <Glyph active={active} /> : children}
    </svg>
  );
});

export default Icon;
