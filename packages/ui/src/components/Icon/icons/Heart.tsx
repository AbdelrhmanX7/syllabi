import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import React, { useEffect, useRef, useState } from 'react';

/**
 * Hand-drawn heart with celebratory toggle.
 *
 * Craft:
 *   - Asymmetric humps (left lobe slightly higher than right) so it reads as
 *     drawn, not stamped.
 *   - Two stacked paths: outline (always visible) + filled (cross-fades in
 *     when active). Animating opacity of a separate path is GPU-cheap; toggling
 *     the `fill` attribute on a single path is not.
 *
 * Animation (60fps, transform + opacity only):
 *   - Heart scale: keyframe array 1 → 1.28 → 0.96 → 1 with custom ease curve
 *     (overshoots, settles past 1, then back). Spring physics in keyframe form.
 *   - Confetti burst: 5 small dots fly out radially on each false→true toggle.
 *     Each is a motion.circle animating its `transform` (translate + opacity),
 *     which is compositor-only. Mount/unmount via AnimatePresence so they
 *     fully clean up between bursts.
 *   - `prefers-reduced-motion`: instant fill, no scale, no confetti.
 */

interface ConfettiBurstProps {
  reduced: boolean;
}

function ConfettiBurst({ reduced }: ConfettiBurstProps) {
  if (reduced) return null;
  const dots = [
    { angle: -90, distance: 9 }, // up
    { angle: -36, distance: 10 }, // upper-right
    { angle: 36, distance: 10 }, // lower-right
    { angle: -144, distance: 10 }, // upper-left
    { angle: 144, distance: 10 }, // lower-left
  ];

  return (
    <g>
      {dots.map((d, i) => {
        const rad = (d.angle * Math.PI) / 180;
        const dx = Math.cos(rad) * d.distance;
        const dy = Math.sin(rad) * d.distance;

        return (
          <motion.circle
            key={i}
            animate={{ x: dx, y: dy - 2, opacity: 0, scale: 0.4 }}
            cx='12'
            cy='12'
            exit={{ opacity: 0 }}
            fill='currentColor'
            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
            r='0.85'
            stroke='none'
            style={{ willChange: 'transform, opacity' }}
            transition={{ duration: 0.55, ease: [0.22, 0.7, 0.3, 1], delay: i * 0.018 }}
          />
        );
      })}
    </g>
  );
}

export const HeartIcon = React.memo(function HeartIcon({ active = false }: { active?: boolean }) {
  const reduced = useReducedMotion() ?? false;
  const [burstId, setBurstId] = useState(0);
  const prev = useRef(active);

  useEffect(() => {
    if (active && !prev.current) setBurstId((b) => b + 1);
    prev.current = active;
  }, [active]);

  const heartPath =
    'M12 20.6 C9.05 18.1 4.05 14.05 4.05 9.55 C4.05 7.05 6.0 4.95 8.45 4.95 C10.05 4.95 11.3 5.85 12 7.0 C12.7 5.85 14.05 5.0 15.6 5.0 C18 5.0 20 7.05 20 9.55 C20 14.05 15 18.1 12 20.6 Z';

  return (
    <>
      {/* Outline — always visible, scales as a unit on toggle. */}
      <motion.g
        animate={{ scale: !reduced && active ? [1, 1.28, 0.96, 1] : 1 }}
        style={{ transformOrigin: '12px 12px', willChange: 'transform' }}
        transition={reduced ? { duration: 0 } : { duration: 0.46, times: [0, 0.4, 0.7, 1], ease: [0.3, 0.6, 0.2, 1.2] }}
      >
        {/* Outline */}
        <path d={heartPath} />
        {/* Filled overlay — cross-fades in via opacity when active. */}
        <motion.path
          animate={{ opacity: active ? 1 : 0 }}
          d={heartPath}
          fill='currentColor'
          initial={false}
          stroke='none'
          style={{ willChange: 'opacity' }}
          transition={{ duration: reduced ? 0 : 0.18, ease: 'easeOut' }}
        />
      </motion.g>

      {/* Confetti burst — remounts on each false→true toggle. */}
      <AnimatePresence>
        {burstId > 0 && (
          <motion.g key={burstId} animate={{ opacity: 1 }} exit={{ opacity: 0 }} initial={{ opacity: 1 }}>
            <ConfettiBurst reduced={reduced} />
          </motion.g>
        )}
      </AnimatePresence>
    </>
  );
});
