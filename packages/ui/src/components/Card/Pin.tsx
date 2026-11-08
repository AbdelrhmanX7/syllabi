import React from 'react';

import { cn } from '../../cn';

export interface PinProps {
  /** px from top of parent. Default -8. */
  top?: number;
  /** px from inline-start. */
  start?: number;
  /** px from inline-end. Default -8. */
  end?: number;
  size?: number;
  color?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function Pin({ top = -8, start, end = -8, size = 18, color, className, style }: PinProps) {
  const positional: React.CSSProperties = { width: size, height: size, top };
  if (typeof start === 'number') positional.insetInlineStart = start;
  if (typeof end === 'number') positional.insetInlineEnd = end;
  if (color) positional.background = color;

  return <span aria-hidden className={cn('sk-pin', className)} style={{ ...positional, ...style }} />;
}
