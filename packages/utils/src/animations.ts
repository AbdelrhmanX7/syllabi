import type { Variants, Transition } from 'motion/react';

export const easing = {
  easeInOut: [0.42, 0, 0.58, 1] as [number, number, number, number],
  easeOut: [0, 0, 0.58, 1] as [number, number, number, number],
  easeIn: [0.42, 0, 1, 1] as [number, number, number, number],
  spring: [0.25, 0.1, 0.25, 1] as [number, number, number, number],
};

export const successBounce: Variants = {
  initial: { scale: 0.8, opacity: 0 },
  animate: {
    scale: [0.8, 1.2, 1],
    opacity: 1,
    transition: { duration: 0.6, ease: easing.easeOut },
  },
  exit: {
    scale: 0.8,
    opacity: 0,
    transition: { duration: 0.3, ease: easing.easeIn },
  },
};

export const errorShake: Variants = {
  initial: { x: 0 },
  animate: {
    x: [-10, 10, -10, 10, -5, 5, 0],
    transition: { duration: 0.5, ease: easing.easeInOut },
  },
};

export const fadeSlideUp: Variants = {
  initial: { y: 20, opacity: 0 },
  animate: {
    y: 0,
    opacity: 1,
    transition: { duration: 0.4, ease: easing.easeOut },
  },
  exit: {
    y: -20,
    opacity: 0,
    transition: { duration: 0.3, ease: easing.easeIn },
  },
};

export const staggerContainer: Variants = {
  initial: {},
  animate: {
    transition: { staggerChildren: 0.1 },
  },
};

export const scalePop: Variants = {
  initial: { scale: 0 },
  animate: {
    scale: 1,
    transition: { type: 'spring', stiffness: 260, damping: 20 },
  },
  exit: {
    scale: 0,
    transition: { duration: 0.2, ease: easing.easeIn },
  },
};

export const tapFeedback = {
  whileTap: {
    scale: 0.95,
    transition: { duration: 0.1, ease: easing.easeInOut },
  },
};

export const hoverFeedback = {
  whileHover: {
    scale: 1.05,
    transition: { duration: 0.2, ease: easing.easeOut },
  },
};

export const springTransition: Transition = {
  type: 'spring',
  stiffness: 260,
  damping: 20,
};

export const fastTransition: Transition = {
  duration: 0.2,
  ease: easing.easeOut,
};

export const smoothTransition: Transition = {
  duration: 0.4,
  ease: easing.easeInOut,
};
