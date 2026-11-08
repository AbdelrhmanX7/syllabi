import React from 'react';

import { cn } from '../../cn';

export type TapeColor = 'yellow' | 'pink' | 'blue' | 'green';

export interface TapeProps {
  color?: TapeColor;
  width?: number;
  height?: number;
  rotate?: number;
  /** px from top of parent (relative). Default -10. */
  top?: number;
  start?: number;
  end?: number;
  className?: string;
  style?: React.CSSProperties;
}

const COLOR: Record<TapeColor, string> = {
  yellow: 'sk-tape-yellow',
  pink: 'sk-tape-pink',
  blue: 'sk-tape-blue',
  green: 'sk-tape-green',
};

export function Tape({
  color = 'yellow',
  width = 80,
  height = 22,
  rotate = -4,
  top = -10,
  start,
  end,
  className,
  style,
}: TapeProps) {
  const positional: React.CSSProperties = {
    width,
    height,
    top,
    transform: `rotate(${rotate}deg)`,
  };
  if (typeof start === 'number') positional.insetInlineStart = start;
  if (typeof end === 'number') positional.insetInlineEnd = end;
  if (start === undefined && end === undefined) {
    positional.insetInlineStart = `calc(50% - ${width / 2}px)`;
  }

  return <span aria-hidden className={cn('sk-tape', COLOR[color], className)} style={{ ...positional, ...style }} />;
}
