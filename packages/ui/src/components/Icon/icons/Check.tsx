import { motion, useReducedMotion } from 'motion/react';
import React from 'react';

/**
 * Hand-drawn check — split into two segments with a deliberate pen-lift gap.
 *
 * Craft:
 *   - Path NOT a straight diagonal — has a slight curve mid-stroke (pen
 *     pressure varies as it draws). The inflection at point (9.5, 16.6) is
 *     intentional.
 *   - Two `<motion.path>` segments with a 90ms gap between them so it reads
 *     like the writer briefly lifted their pen — gives life to a glyph that
 *     would otherwise look mechanical.
 *
 * Animation (60fps, stroke-dashoffset only — GPU-accelerated for SVG):
 *   - Each segment animates `pathLength` from 0 → 1 (framer-motion converts to
 *     stroke-dashoffset under the hood). Compositor-only on modern engines.
 *   - First segment: 220ms ease-out. Pause 90ms (the "pen lift"). Second
 *     segment: 280ms ease-out for the longer diagonal.
 *   - Reverse on un-active: both retract simultaneously (160ms) — like an
 *     eraser pulled back.
 *   - `prefers-reduced-motion`: instant draw.
 */
export const CheckIcon = React.memo(function CheckIcon({ active = true }: { active?: boolean }) {
  const reduced = useReducedMotion() ?? false;

  if (reduced) {
    return (
      <path
        d='M5 12.7 C6.7 14.4 8.0 15.55 9.5 16.6 C12.65 13.85 15.5 10.55 19.05 6.95'
        style={{ opacity: active ? 1 : 0 }}
      />
    );
  }

  // Two segments — pen lift gap mid-stroke.
  const seg1 = 'M5 12.7 C6.7 14.4 8.0 15.55 9.5 16.6';
  const seg2 = 'M9.5 16.6 C12.65 13.85 15.5 10.55 19.05 6.95';

  return (
    <>
      <motion.path
        animate={{ pathLength: active ? 1 : 0 }}
        d={seg1}
        initial={{ pathLength: active ? 1 : 0 }}
        style={{ willChange: 'stroke-dashoffset' }}
        transition={
          active
            ? { pathLength: { duration: 0.22, ease: [0.32, 0.72, 0.35, 1] } }
            : { pathLength: { duration: 0.16, ease: 'easeIn' } }
        }
      />
      <motion.path
        animate={{ pathLength: active ? 1 : 0 }}
        d={seg2}
        initial={{ pathLength: active ? 1 : 0 }}
        style={{ willChange: 'stroke-dashoffset' }}
        transition={
          active
            ? { pathLength: { duration: 0.28, delay: 0.31, ease: [0.32, 0.72, 0.35, 1] } }
            : { pathLength: { duration: 0.16, ease: 'easeIn' } }
        }
      />
    </>
  );
});
