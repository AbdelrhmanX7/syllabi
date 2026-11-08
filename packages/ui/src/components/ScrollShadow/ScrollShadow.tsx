import React from 'react';

import { cn } from '../../cn';

/**
 * da-v2 ScrollShadow — drop-in replacement for HeroUI's ScrollShadow.
 *
 *   <ScrollShadow className='h-64' size={40} hideScrollBar>
 *     {longContent}
 *   </ScrollShadow>
 *
 * Wraps a scrollable container and overlays paper-cream → transparent gradients
 * at the start/end edges. Edges are toggled based on scroll position so the
 * shadow disappears at the boundaries.
 */

export type ScrollShadowOrientation = 'horizontal' | 'vertical';
export type ScrollShadowVisibility = 'auto' | 'top' | 'bottom' | 'left' | 'right' | 'both' | 'none';

export interface ScrollShadowClassNames {
  base?: string;
}

export interface ScrollShadowProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: number;
  hideScrollBar?: boolean;
  visibility?: ScrollShadowVisibility;
  orientation?: ScrollShadowOrientation;
  offset?: number;
  isEnabled?: boolean;
  className?: string;
  classNames?: ScrollShadowClassNames;
  children: React.ReactNode;
}

export const ScrollShadow = React.forwardRef<HTMLDivElement, ScrollShadowProps>(function ScrollShadow(
  {
    size = 40,
    hideScrollBar = false,
    visibility = 'auto',
    orientation = 'vertical',
    offset = 0,
    isEnabled = true,
    className,
    classNames,
    children,
    style,
    ...rest
  },
  forwardedRef,
) {
  const innerRef = React.useRef<HTMLDivElement | null>(null);
  // Merge forwarded ref + internal ref.
  React.useImperativeHandle(forwardedRef, () => innerRef.current as HTMLDivElement);

  const [showStart, setShowStart] = React.useState(false);
  const [showEnd, setShowEnd] = React.useState(false);

  const update = React.useCallback(() => {
    const el = innerRef.current;
    if (!el || !isEnabled) return;
    if (orientation === 'vertical') {
      const { scrollTop, scrollHeight, clientHeight } = el;
      setShowStart(scrollTop > offset);
      setShowEnd(scrollTop + clientHeight < scrollHeight - offset);
    } else {
      const { scrollWidth, clientWidth } = el;
      const fromStart = el.scrollLeft;
      const fromEnd = scrollWidth - clientWidth - fromStart;
      setShowStart(fromStart > offset);
      setShowEnd(fromEnd > offset);
    }
  }, [orientation, offset, isEnabled]);

  React.useEffect(() => {
    const el = innerRef.current;
    if (!el || !isEnabled) {
      setShowStart(false);
      setShowEnd(false);

      return;
    }
    update();
    const onScroll = () => update();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => update()) : null;
    ro?.observe(el);
    window.addEventListener('resize', onScroll, { passive: true });

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      window.removeEventListener('resize', onScroll);
    };
  }, [update, isEnabled]);

  // Honor explicit `visibility` prop overrides — translate logical strings.
  const startVisible =
    visibility === 'auto'
      ? showStart
      : orientation === 'vertical'
        ? visibility === 'top' || visibility === 'both'
        : visibility === 'left' || visibility === 'both';
  const endVisible =
    visibility === 'auto'
      ? showEnd
      : orientation === 'vertical'
        ? visibility === 'bottom' || visibility === 'both'
        : visibility === 'right' || visibility === 'both';

  // Gradients use the theme paper token so they blend into scrapbook surfaces
  // in BOTH light (#fbfaf6) and dark (#18204a) — the var flips automatically.
  // TRANSPARENT fades the SAME paper color to 0 alpha (via the rgb triplet) so
  // we never interpolate through a gray/black midpoint at the edge.
  const PAPER = 'var(--paper)';
  const TRANSPARENT = 'rgb(var(--paper-rgb) / 0)';

  const verticalStartGrad = `linear-gradient(180deg, ${PAPER} 0%, ${TRANSPARENT} 100%)`;
  const verticalEndGrad = `linear-gradient(0deg, ${PAPER} 0%, ${TRANSPARENT} 100%)`;
  const horizontalStartGrad = `linear-gradient(90deg, ${PAPER} 0%, ${TRANSPARENT} 100%)`;
  const horizontalEndGrad = `linear-gradient(270deg, ${PAPER} 0%, ${TRANSPARENT} 100%)`;

  return (
    <div
      ref={innerRef}
      className={cn(
        'relative',
        orientation === 'vertical' ? 'overflow-y-auto overflow-x-hidden' : 'overflow-x-auto overflow-y-hidden',
        hideScrollBar && '[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
        classNames?.base,
      )}
      data-orientation={orientation}
      data-show-start={startVisible || undefined}
      data-show-end={endVisible || undefined}
      style={style}
      {...rest}
    >
      {children}
      {isEnabled && startVisible ? (
        <span
          aria-hidden
          className='pointer-events-none sticky z-10 block'
          style={
            orientation === 'vertical'
              ? {
                  top: 0,
                  left: 0,
                  right: 0,
                  height: size,
                  marginBottom: -size,
                  background: verticalStartGrad,
                  position: 'sticky',
                }
              : {
                  // For horizontal, sticky doesn't help — use absolute on the start edge.
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  insetInlineStart: 0,
                  width: size,
                  background: horizontalStartGrad,
                }
          }
        />
      ) : null}
      {isEnabled && endVisible ? (
        <span
          aria-hidden
          className='pointer-events-none block'
          style={
            orientation === 'vertical'
              ? {
                  position: 'sticky',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: size,
                  marginTop: -size,
                  background: verticalEndGrad,
                }
              : {
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  insetInlineEnd: 0,
                  width: size,
                  background: horizontalEndGrad,
                }
          }
        />
      ) : null}
    </div>
  );
});

ScrollShadow.displayName = 'ScrollShadow';
