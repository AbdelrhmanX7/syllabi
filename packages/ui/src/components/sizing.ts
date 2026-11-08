import type { HeroUISize } from './tokens';

/**
 * The one sizing ladder for form controls (see the `ui-rules` skill, section 2).
 * Written out as literal classes because the Tailwind JIT cannot read template literals.
 *
 * control height 36 / 44 / 52 · control text 13 / 14 / 15 · typed field text 16 (iOS zooms under 16).
 */
export const CONTROL_HEIGHT: Record<HeroUISize, string> = {
  sm: 'h-9',
  md: 'h-11',
  lg: 'h-[52px]',
};

export const CONTROL_TEXT: Record<HeroUISize, string> = {
  sm: 'text-[13px]',
  md: 'text-[14px]',
  lg: 'text-[15px]',
};

/** Text a person types into a field. */
export const FIELD_TEXT = 'text-[16px]';

/** Inputs, selects and other fields sit on the middle rung of the radius ladder. */
export const FIELD_RADIUS = 'rounded-md';
