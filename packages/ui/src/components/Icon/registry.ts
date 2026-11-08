/**
 * Icon registry — maps short string names to hand-drawn icon components.
 * Each registered icon is a React component that renders one or more SVG
 * children (paths, circles, etc.) inside a parent <svg> wrapper provided by
 * <Icon />. Each can accept its own state props (`active`, `open`, etc.).
 *
 * Adding a new icon: drop a file in ./icons/Foo.tsx, import + register here.
 */
import type React from 'react';

import { CheckIcon } from './icons/Check';
import { HeartIcon } from './icons/Heart';
import { LockIcon } from './icons/Lock';

export interface IconStateProps {
  /** State prop — meaning depends on the icon (locked, favourited, checked, etc.). */
  active?: boolean;
}

export const ICON_REGISTRY: Record<string, React.ComponentType<IconStateProps>> = {
  lock: LockIcon,
  heart: HeartIcon,
  check: CheckIcon,
};

export type RegisteredIconName = keyof typeof ICON_REGISTRY;
