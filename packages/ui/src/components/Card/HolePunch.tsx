import React from 'react';

export type HolePunchSide = 'left' | 'right' | 'top' | 'bottom';

export interface HolePunchProps {
  /** Which edge to render holes along. Default 'left'. */
  side?: HolePunchSide;
  /** Number of holes. Default 6. */
  count?: number;
  /** Hole diameter in px. Default 10. */
  size?: number;
  /** Inset from the edge in px (how far the hole sits inside the card). Default 12. */
  inset?: number;
  /** Override hole color. Default uses currentColor at low opacity (reads as ink). */
  color?: string;
}

/**
 * Spiral-notebook punch holes — decorative pseudo-element rendered at the
 * specified edge of the parent. Pure-CSS, no JS, no images. Each hole is a
 * small dark circle with a faint inner highlight to suggest a real punched
 * page. Holes are evenly distributed along the edge using flexbox.
 *
 * Use as a child of a card / wrapper:
 *
 *   <Card withHoles>...</Card>
 *   <Card withHoles={{ side: 'top', count: 8 }}>...</Card>
 */
export const HolePunch = React.memo(function HolePunch({
  side = 'left',
  count = 6,
  size = 10,
  inset = 12,
  color,
}: HolePunchProps) {
  const isVertical = side === 'left' || side === 'right';

  const holeStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    background: color ?? 'rgba(24, 32, 74, 0.65)',
    boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.18), inset 0 -1px 1px rgba(0,0,0,0.25)',
  };

  const wrapStyle: React.CSSProperties = {
    position: 'absolute',
    pointerEvents: 'none',
    display: 'flex',
    flexDirection: isVertical ? 'column' : 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    [isVertical ? 'top' : 'left']: 0,
    [isVertical ? 'bottom' : 'right']: 0,
    [side]: inset,
    [isVertical ? 'width' : 'height']: size,
  };

  return (
    <div aria-hidden style={wrapStyle}>
      {Array.from({ length: count }).map((_, i) => (
        <span key={i} style={holeStyle} />
      ))}
    </div>
  );
});
