import React from 'react';

import { cn } from '../../cn';
import { CLAY_FILL, CLAY_LABEL, clayKindFor, clayVars } from '../clay';
import type { HeroUIColor, HeroUISize } from '../tokens';

/**
 * Clay Switch — the one component in the library that is genuinely TWO physical
 * parts, so it gets two clay treatments rather than one:
 *
 *   - the TRACK is a recessed channel. `clayVars(fill, { inset: true })` +
 *     `.clay-field`. It is a hole cut into the page, not a raised lip — a knob
 *     cannot slide along something that is standing proud of the surface.
 *   - the THUMB is a raised slab that slides inside that channel. That is the
 *     lip: `clayVars(fill)` + `.clay-btn`, so pressing it collapses the lip
 *     6 -> 1px and the knob visibly sinks into the channel.
 *
 * COLOURS COME FROM `../clay.ts`, NEVER FROM LITERALS. Thumb-vs-track is the
 * only thing that says "on", so it owes the 3:1 non-text floor. A previous
 * revision hardcoded the thumb `bg-white` while the track took the brand
 * colour: white measured 2.54:1 on the brand green and 2.15:1 on amber. The
 * thumb now takes `CLAY_LABEL[color]` — HeroUI's own paired answer to "what
 * goes on this fill", the twin of the `CLAY_FILL[color]` the track is painted
 * with. Measured table in `.clay/switch.md`; `success` is the one entry below
 * 3:1 and it is a recorded owner decision in `theme.ts`, not a local choice.
 */

// Radii and travel distances are written out rather than interpolated: Tailwind's
// JIT scans source text and cannot see through a template literal, so
// an interpolated arbitrary `rounded-` value generates no class at all.
//
// `travel` is the knob's slide distance and is arithmetic, not taste:
//   inner width (track width - 2 x 3px edge) - thumb width - 2 x 2px inset.
// Get it wrong and the knob either stops short of the end or punches through
// the channel wall.
const SIZE: Record<HeroUISize, { track: string; thumb: string; travel: number }> = {
  // 48x28 track, 42x22 channel, 16px knob
  sm: { track: 'h-7 w-12 rounded-[12px]', thumb: 'h-4 w-4 rounded-[7px]', travel: 22 },
  // 56x32 track, 50x26 channel, 20px knob
  md: { track: 'h-8 w-14 rounded-[14px]', thumb: 'h-5 w-5 rounded-[8px]', travel: 26 },
  // 64x36 track, 58x30 channel, 24px knob
  lg: { track: 'h-9 w-16 rounded-[16px]', thumb: 'h-6 w-6 rounded-[10px]', travel: 30 },
};

/**
 * The OFF channel. `CLAY_FILL` has no "empty recessed channel" entry — its
 * `default` is `content1`, the raised CARD surface, which is the wrong thing to
 * paint a hole with (in light mode it is pure white, so the channel disappears
 * into the page). `default-200` is the surface rung that does NOT invert
 * between themes (50-300 are documented surfaces and stay dark in dark), so it
 * reads as a channel in both. If clay grows a canonical recessed-neutral token
 * this should move to it.
 */
const OFF_TRACK = 'hsl(var(--heroui-default-200))';

/**
 * The OFF knob. Deliberately the ramp rung that DOES invert (dark grey in
 * light, pale lavender in dark) because the channel above does not — that is
 * what keeps knob-vs-channel above 3:1 in both themes. It is a grey knob rather
 * than flat ink so `clayVars` has something to derive a visible edge and lip
 * from; ink mixed toward the foreground is still ink, and the knob would go
 * flat.
 */
const OFF_THUMB = 'hsl(var(--heroui-default-700))';

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'onChange'> {
  isSelected?: boolean;
  defaultSelected?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onValueChange?: (selected: boolean) => void;
  color?: HeroUIColor;
  size?: HeroUISize;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  thumbIcon?: React.ReactNode | ((props: { isSelected: boolean }) => React.ReactNode);
  classNames?: { base?: string; wrapper?: string; thumb?: string; label?: string };
  children?: React.ReactNode;
}

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  {
    isSelected,
    defaultSelected,
    onChange,
    onValueChange,
    color = 'primary',
    size = 'md',
    isDisabled,
    isReadOnly,
    startContent,
    endContent,
    children,
    classNames,
    className,
    thumbIcon,
    ...rest
  },
  ref,
) {
  const isControlled = isSelected !== undefined;
  const [internal, setInternal] = React.useState(Boolean(defaultSelected));
  const checked = isControlled ? Boolean(isSelected) : internal;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isReadOnly || isDisabled) return;
    if (!isControlled) setInternal(e.target.checked);
    onChange?.(e);
    onValueChange?.(e.target.checked);
  };

  const { track, thumb, travel } = SIZE[size];

  // On: the channel takes the brand fill and the knob takes that fill's paired
  // label. Off: a neutral channel and a neutral knob, both from the same ramp.
  const trackFill = checked ? CLAY_FILL[color] : OFF_TRACK;
  // `small: true` on BOTH branches, and the colour resolved to `default` on the
  // one whose fill is neutral. A switch track is one of the controls the
  // `control` profile was added for: there is no label inside it doing the
  // identifying the way a button has one, so its RIM is what says "this is a
  // control", and WCAG 1.4.11 puts a 3:1 floor on it — `surface` measures 1.23:1
  // on a white card. Half-applying it (off only) leaves a `default`-coloured ON
  // switch as a white slab on a white card. Brand fills are unaffected:
  // `clayKindFor` still returns `brand` for them, because a saturated fill
  // separates itself from the card without help from its rim.
  const trackKind = clayKindFor(checked ? color : 'default', true);
  const thumbFill = checked ? CLAY_LABEL[color] : OFF_THUMB;

  return (
    <label
      className={cn(
        'inline-flex items-center gap-2',
        // 44px minimum touch target (PRODUCT.md). The tallest track is 36px, so
        // the padding buys the difference and the equal negative margin gives
        // the space straight back to the layout — the hit area grows, nothing
        // moves. sm (28px) is the case that needs all 8: 28 + 16 = 44.
        'py-2 -my-2',
        isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
        classNames?.base,
      )}
    >
      <span
        className={cn(
          // The recessed channel. `.clay-field` reads --clay-rest / --clay-active
          // out of the inline vars below; it cannot be a Tailwind
          // `shadow-[var(--clay-rest)]`, which computes to `box-shadow: none`.
          // `overflow-hidden` keeps the knob's lip and ambient glow INSIDE the
          // channel. Without it the glow blooms out past the track wall and the
          // switch grows a halo. The knob is sized to fit its own lip, so
          // nothing that should be visible is clipped; an element's own outline
          // is not clipped by its own overflow, so focus survives.
          'clay-field relative inline-flex shrink-0 items-center overflow-hidden',
          'border-[3px] border-[color:var(--clay-edge)]',
          // Only the fill crossfades. The knob's movement is a transform, so the
          // two do not fight over the same property.
          'transition-[background-color] duration-200 motion-reduce:transition-none',
          // Keyboard focus rings the whole control, not the knob — the channel
          // is the thing that has a boundary to ring.
          // `has-[:focus-visible]`, not `focus-within` — the input takes focus on
          // every mouse click too, so `focus-within` rings the control on every
          // toggle. Only a keyboard user needs the ring.
          'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[3px]',
          'has-[:focus-visible]:[outline-color:hsl(var(--heroui-focus))]',
          track,
          classNames?.wrapper,
        )}
        style={{
          background: trackFill,
          ...clayVars(trackFill, { inset: true, kind: trackKind, depth: 6 }),
        }}
      >
        <input
          ref={ref}
          checked={checked}
          className='sr-only'
          disabled={isDisabled}
          onChange={handleChange}
          readOnly={isReadOnly}
          role='switch'
          type='checkbox'
          {...rest}
        />
        {startContent ? (
          <span
            aria-hidden
            className='pointer-events-none absolute inset-y-0 start-[6px] flex items-center text-[10px]'
            style={{ color: CLAY_LABEL[checked ? color : 'default'] }}
          >
            {startContent}
          </span>
        ) : null}
        {endContent ? (
          <span
            aria-hidden
            className='pointer-events-none absolute inset-y-0 end-[6px] flex items-center text-[10px]'
            style={{ color: CLAY_LABEL[checked ? color : 'default'] }}
          >
            {endContent}
          </span>
        ) : null}
        <span
          aria-hidden
          className={cn(
            // The raised knob. `.clay-btn` gives it the three lip states, so
            // pressing the knob collapses the lip and it sinks into the channel
            // — the press is a depth change, never a colour change.
            'clay-btn absolute start-[2px] top-[2px] inline-flex items-center justify-center',
            // Sign of the knob's travel (LTR: slides right into the channel).
            '[--sw-dir:1]',
            'border-[3px] border-[color:var(--clay-edge)]',
            'transition-[transform,box-shadow,background-color] duration-200 ease-out',
            // The knob travels down by EXACTLY the distance its lip shrinks, so
            // the lip's bottom edge never moves and the knob reads as pressed
            // rather than slid. `.clay-btn` takes the lip 4 -> 2 -> 1px, so the
            // travel is 0 -> 2 -> 3. Checked at 2x, not by eye at 1x.
            'hover:[--sw-press:2px] active:[--sw-press:3px]',
            'motion-reduce:transition-none motion-reduce:hover:[--sw-press:0px]',
            thumb,
            classNames?.thumb,
          )}
          style={{
            background: thumbFill,
            // The knob's own icon sits on the knob, so it is coloured by what the
            // knob is painted with — the inverse pairing of the track.
            color: checked ? CLAY_FILL[color] : CLAY_FILL.default,
            transform: `translateX(calc(var(--sw-dir) * ${checked ? travel : 0}px)) translateY(var(--sw-press, 0px))`,
            // `surface`, NOT the `control` profile the track uses. `control`
            // mixes 50% toward the theme foreground, which assumes a fill that
            // FOLLOWS the theme. The knob's on-fill is `CLAY_LABEL`, constant
            // white for four of six colours, so in light it would rim a white
            // knob in mid-grey (#808080 — 1.10:1 on the danger track, worse than
            // the 2.94:1 `surface` gives) and in dark it would mix white toward
            // cream and produce no rim at all. Measured both before choosing.
            //
            // 4, not the button's 6: a 6px lip under a 20px slab is a plinth.
            // It cannot go lower than 4 either — `clayVars` derives hover as
            // `depth - 2` and pins active at 1px, so depth 3 makes hover and
            // press the SAME 1px lip and the press stops reading. 4 also lands
            // the lip exactly on the channel floor at all three sizes.
            ...clayVars(thumbFill, { kind: 'surface', depth: 4 }),
          }}
        >
          {typeof thumbIcon === 'function' ? thumbIcon({ isSelected: checked }) : thumbIcon}
        </span>
      </span>
      {children ? <span className={cn('text-ink text-[14px] font-bold', classNames?.label)}>{children}</span> : null}
    </label>
  );
});

Switch.displayName = 'Switch';
