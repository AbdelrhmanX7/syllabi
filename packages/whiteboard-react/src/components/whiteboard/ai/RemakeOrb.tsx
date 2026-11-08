import React from 'react';

import { ThinkingOrb } from '../../../vendor/thinking-orbs';

import { REMAKE_ORB_COLORS } from './generatingState';

import type { RemakeOrbState } from './generatingState';

/**
 * The «Similar copy» thinking orb: `thinking-orbs` (MIT, vendored — see src/vendor/thinking-orbs),
 * inked in the brand hue of the current stage. Plain 2D canvas dots, no filters; the library pauses
 * itself offscreen / in a hidden tab and draws a static frame under reduced motion.
 */
export function RemakeOrb({ state, size, paused, className, style }: { state: RemakeOrbState; size: 64 | 32 | 20; paused?: boolean; className?: string; style?: React.CSSProperties }) {
  return (
    <ThinkingOrb
      aria-hidden
      className={className}
      color={REMAKE_ORB_COLORS[state]}
      data-remake-orb={state}
      // A touch bolder than the stock mark: it sits on warm paper, not white.
      dotSize={1.2}
      paused={paused}
      size={size}
      state={state}
      style={style}
      // The orb always sits on paper: dark ink, whatever the host's colour scheme.
      theme='light'
    />
  );
}
