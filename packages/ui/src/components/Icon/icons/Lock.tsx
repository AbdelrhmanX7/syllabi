import { motion, useReducedMotion } from 'motion/react';
import React from 'react';

/**
 * Hand-drawn padlock — scrapbook rebuild.
 *
 * Craft:
 *   - Body bezier coordinates carry intentional micro-wobble (e.g. 6.05 instead
 *     of 6.0) so it reads as drawn, not generated.
 *   - Body has a sketchy double-stroke: a second path 0.4px offset at 40% opacity
 *     for that "pen passed twice" feel.
 *   - Keyhole is a hand-shaped teardrop, not a perfect circle.
 *
 * Animation (60fps, transform-only):
 *   - Shackle is a `motion.path`. On unlock, springs through rotation + lift
 *     with intentional underdamping so the shackle bounces a little after
 *     popping open. Spring runs on rAF, GPU-accelerated transforms only.
 *   - `transform-origin` is the right hinge so the shackle pivots like a real
 *     padlock, not the SVG centre.
 *   - `will-change: transform` set ONLY while animating (framer's onAnimationStart
 *     could toggle this, but the static value is fine here — it's a tiny SVG).
 *   - Respects `prefers-reduced-motion`.
 */
export const LockIcon = React.memo(function LockIcon({ active = true }: { active?: boolean }) {
  const reduced = useReducedMotion();
  const transition = reduced ? { duration: 0 } : { type: 'spring' as const, stiffness: 380, damping: 16, mass: 0.7 };

  return (
    <>
      {/* Shackle — pivots open when unlocked. Slight wobble in the U-shape. */}
      <motion.path
        animate={{
          rotate: active ? 0 : -28,
          y: active ? 0 : -1.6,
          x: active ? 0 : -0.6,
        }}
        d='M8.42 11 V7.85 C8.42 5.65 10.05 3.95 12 3.95 C13.92 3.95 15.6 5.7 15.6 7.85 V11'
        initial={false}
        style={{
          transformOrigin: '15.6px 8.2px',
          transformBox: 'fill-box',
          willChange: 'transform',
        }}
        transition={transition}
      />

      {/* Sketchy double-stroke on the body — second pass at 40% opacity. */}
      <path
        d='M5.95 11.25 C5.95 10.62 6.5 10.18 7.05 10.2 H17 C17.55 10.2 18.05 10.6 18.05 11.22 V19.55 C18.05 20.15 17.5 20.55 16.95 20.55 H7.05 C6.5 20.55 5.95 20.1 5.95 19.5 Z'
        opacity='0.45'
        strokeWidth='1.4'
      />
      {/* Body — primary path */}
      <path d='M6 11.2 C6 10.6 6.5 10.18 7 10.2 H17 C17.5 10.18 18 10.62 18 11.2 V19.5 C18 20.1 17.5 20.5 17 20.5 H7 C6.5 20.5 6 20.1 6 19.5 Z' />

      {/* Keyhole — teardrop (hand-drawn, not a perfect circle). */}
      <path
        d='M11.95 13.55 C12.55 13.5 13.05 13.95 13.05 14.55 C13.05 14.95 12.85 15.3 12.55 15.5 L12.55 17.4 C12.55 17.65 12.3 17.85 12 17.85 C11.7 17.85 11.45 17.65 11.45 17.4 L11.45 15.5 C11.15 15.3 10.95 14.95 10.95 14.55 C10.95 13.95 11.42 13.5 11.95 13.55 Z'
        fill='currentColor'
        stroke='none'
      />
    </>
  );
});
