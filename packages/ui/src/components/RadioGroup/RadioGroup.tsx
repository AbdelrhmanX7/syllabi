import React from 'react';

import { cn } from '../../cn';
import { useValidation } from '../useValidation';
import type { ClayColor } from '../clay';
import { CLAY_FILL, CLAY_LABEL, clayKindFor, clayVars } from '../clay';
import type { HeroUIColor, HeroUISize } from '../tokens';

/**
 * da-v2 RadioGroup / Radio — drop-in for HeroUI's RadioGroup + Radio.
 *
 * HeroUI API mirrored:
 *   <RadioGroup label value defaultValue onValueChange orientation
 *               isDisabled isRequired size color isInvalid errorMessage description>
 *     <Radio value description isDisabled>{label}</Radio>
 *   </RadioGroup>
 *
 * Visual: clay. Unselected is a recessed hole; selected is a slab that has
 * popped up, carrying the dot. The state change is physical, so it survives
 * greyscale and colour-blindness instead of resting on hue alone.
 *
 * Sibling contract: this IS `<Checkbox>` in a circle. Box size, 3px edge, lip
 * depth, press ladder, focus ring and mark colour are read from the same
 * places and must stay identical — a radio and a checkbox on one form are the
 * same object in two shapes. Change one, change the other.
 */

// Written out, not interpolated — Tailwind's JIT cannot see through a template
// literal. Circles match Checkbox's boxes step for step (20/24/28): a 3px clay
// edge on the scrapbook's 16px circle left 10px of interior for the dot.
const SIZE: Record<HeroUISize, { circle: string; dot: string; label: string }> = {
  sm: { circle: 'h-5 w-5', dot: 'h-2 w-2', label: 'text-[13px]' },
  md: { circle: 'h-6 w-6', dot: 'h-2.5 w-2.5', label: 'text-[14px]' },
  lg: { circle: 'h-7 w-7', dot: 'h-3 w-3', label: 'text-[15px]' },
};

/** Lip depth — one value for every size. See the note in `Checkbox.tsx`. */
const LIP = 4;

/** Hole depth. Deeper than the lip; see `Checkbox.tsx` for why. */
const HOLE = 6;

/** Reserves the lip so the row does not shift 4px between the two states. */
const LIP_RESERVE = 'mb-[4px]';

interface RadioGroupContextValue {
  name: string;
  value: string;
  setValue: (v: string) => void;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  isRequired?: boolean;
  isInvalid?: boolean;
  size?: HeroUISize;
  color?: HeroUIColor;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null);

/* ============================================================
   <Radio>
   ============================================================ */

export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'onChange' | 'color'> {
  value: string;
  description?: React.ReactNode;
  isDisabled?: boolean;
  size?: HeroUISize;
  color?: HeroUIColor;
  /**
   * Scrapbook-era seeded tilt. Accepted and ignored: clay has no rotation, and
   * the transform slot now carries the press. Kept so call sites need no edit.
   */
  rotate?: number;
  classNames?: { base?: string; wrapper?: string; label?: string; description?: string; control?: string };
  children?: React.ReactNode;
}

export const Radio = React.forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { value, description, isDisabled, size, color, rotate: _rotate, children, classNames, className, ...rest },
  ref,
) {
  const ctx = React.useContext(RadioGroupContext);

  const groupSize = ctx?.size ?? size ?? 'md';
  const groupColor = ctx?.color ?? color ?? 'primary';
  const sizeCfg = SIZE[groupSize];

  const isChecked = ctx ? ctx.value === value : false;
  const groupDisabled = ctx?.isDisabled || isDisabled;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (groupDisabled || ctx?.isReadOnly) return;
    if (e.target.checked) ctx?.setValue(value);
  };

  // Invalid OVERRIDES the colour once the circle is filled — the same finding as
  // `Checkbox.tsx`: a danger rim on a brand fill measured 1.10:1, so a SELECTED
  // invalid radio was indistinguishable from an ordinary selected one. The rim
  // carries the state only while the circle is still a hole.
  const clayColor = (ctx?.isInvalid ? 'danger' : groupColor) as ClayColor;
  const fillColor = isChecked ? CLAY_FILL[clayColor] : CLAY_FILL.default;
  // `small` — the rim is the boundary on a control this size. See `Checkbox.tsx`.
  const kind = clayKindFor(isChecked ? clayColor : 'default', true);

  // The dot sits ON the fill, so it is read out of the fill's own paired
  // foreground. `const dotColor = … : '#ffffff'` is what left a 2.03:1 dot on a
  // light brand fill; CLAY_LABEL is the map that already answers this per theme.
  const dotColor = CLAY_LABEL[clayColor];

  // The UNSELECTED invalid circle keeps its hole and only takes a danger rim.
  const dangerEdge = clayVars(CLAY_FILL.danger, { kind: 'brand' }) as Record<string, string>;

  const controlStyle = {
    background: fillColor,
    // Ring in the control's OWN colour: an unselected default circle edges in
    // grey, and a grey ring on a grey rim indicates nothing.
    '--clay-ring': CLAY_FILL[clayColor],
    ...clayVars(fillColor, { kind, depth: isChecked ? LIP : HOLE, inset: !isChecked }),
    ...(ctx?.isInvalid ? { '--clay-edge': dangerEdge['--clay-edge'] } : null),
  } as React.CSSProperties;

  const interactive = !groupDisabled && !ctx?.isReadOnly;

  return (
    <label
      className={cn(
        // A single-line radio centres against its label exactly as a Checkbox
        // does — they are siblings. Only a two-line option (description) needs
        // top alignment, and then the circle is nudged onto the first line's
        // optical centre.
        'group inline-flex gap-2.5',
        description ? 'items-start' : 'items-center',
        // 44px minimum touch target on mobile — see the note in `Checkbox.tsx`.
        'max-sm:min-h-[44px]',
        !children && !description && 'max-sm:min-w-[44px]',
        groupDisabled && 'cursor-not-allowed opacity-50',
        !groupDisabled && 'cursor-pointer',
        className,
        classNames?.base,
      )}
    >
      <input
        ref={ref}
        checked={isChecked}
        className='sr-only'
        disabled={groupDisabled}
        name={ctx?.name}
        onChange={handleChange}
        readOnly={ctx?.isReadOnly}
        type='radio'
        value={value}
        {...rest}
      />
      <span
        aria-hidden
        className={cn(
          'relative inline-flex shrink-0 items-center justify-center rounded-full',
          description && 'mt-[1px]',
          'border-[3px] border-[color:var(--clay-edge)]',
          LIP_RESERVE,
          // Only transform and box-shadow animate — never the fill, or the
          // selection reads as a cross-dissolve instead of a movement.
          'transition-[transform,box-shadow] duration-200 motion-reduce:transition-none',
          isChecked ? 'clay-btn' : 'clay-field',
          // The label is what gets hovered and pressed, not the circle — see the
          // long note in `Checkbox.tsx`. Travel and lip have to move together.
          interactive && 'group-hover:[box-shadow:var(--clay-hover)] group-active:[box-shadow:var(--clay-active)]',
          interactive && isChecked && 'group-hover:translate-y-[2px] group-active:translate-y-[3px] group-active:scale-[0.97]',
          interactive && isChecked && 'motion-reduce:group-hover:translate-y-0',
          // The focusable element is the sr-only input, so the ring is
          // forwarded here. There was none before — a keyboard user could not
          // see which option they were on.
          'group-has-[:focus-visible]:outline group-has-[:focus-visible]:outline-2',
          'group-has-[:focus-visible]:outline-offset-2 group-has-[:focus-visible]:outline-[color:var(--clay-ring)]',
          sizeCfg.circle,
          classNames?.control,
          classNames?.wrapper,
        )}
        style={controlStyle}
      >
        {isChecked ? (
          <span aria-hidden className={cn('rounded-full', sizeCfg.dot)} style={{ background: dotColor }} />
        ) : null}
      </span>
      {children || description ? (
        <span className='flex flex-col'>
          {children ? (
            <span className={cn('text-ink font-bold', sizeCfg.label, classNames?.label)}>{children}</span>
          ) : null}
          {description ? (
            <span className={cn('font-hand text-ink/70 text-[14px] font-semibold', classNames?.description)}>
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
});

Radio.displayName = 'Radio';

/* ============================================================
   <RadioGroup>
   ============================================================ */

export interface RadioGroupProps {
  label?: React.ReactNode;
  description?: React.ReactNode;
  errorMessage?: React.ReactNode;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  orientation?: 'vertical' | 'horizontal';
  isDisabled?: boolean;
  isReadOnly?: boolean;
  isRequired?: boolean;
  isInvalid?: boolean;
  size?: HeroUISize;
  color?: HeroUIColor;
  name?: string;
  className?: string;
  classNames?: {
    base?: string;
    label?: string;
    wrapper?: string;
    helperWrapper?: string;
    description?: string;
    errorMessage?: string;
  };
  children?: React.ReactNode;
  /** HeroUI compat — kept for parity. */
  validate?: (value: string) => string | null | undefined | true;
  /** Passed through to the DOM. */
  dir?: 'rtl' | 'ltr';
  /** Allow style passthrough on the wrapper. */
  style?: React.CSSProperties;
}

export function RadioGroup(props: RadioGroupProps) {
  const {
    label,
    description,
    errorMessage,
    value: valueProp,
    defaultValue,
    onValueChange,
    onChange,
    orientation = 'vertical',
    isDisabled,
    isReadOnly,
    isRequired,
    isInvalid,
    validate,
    size = 'md',
    color = 'primary',
    name,
    className,
    classNames,
    children,
    dir,
    style,
  } = props;

  const reactId = React.useId();
  const groupName = name ?? `radiogroup-${reactId}`;

  const isControlled = valueProp !== undefined;
  const [internal, setInternal] = React.useState<string>(defaultValue ?? '');
  const value = isControlled ? String(valueProp ?? '') : internal;

  const setValue = React.useCallback(
    (v: string) => {
      if (!isControlled) setInternal(v);
      onValueChange?.(v);
      // Synthesize a change-like event for native onChange consumers.
      onChange?.({ target: { value: v, name: groupName } } as unknown as React.ChangeEvent<HTMLInputElement>);
    },
    [isControlled, onValueChange, onChange, groupName],
  );

  /*
   * `validate` was declared in the props and never even destructured — see
   * `useValidation`. No `setCustomValidity`: a radio GROUP is not a single form
   * control, so there is no node to hang native validity on. Message + invalid
   * paint only; blocking a native submit is deliberately not faked.
   */
  const validation = useValidation<string>(validate, value ?? '');
  const effectiveInvalid = isInvalid || validation.isInvalid;
  const effectiveError = errorMessage ?? validation.shown;

  return (
    <RadioGroupContext.Provider
      value={{
        name: groupName,
        value,
        setValue,
        isDisabled,
        isReadOnly,
        isRequired,
        isInvalid: effectiveInvalid,
        size,
        color,
      }}
    >
      <div
        aria-required={isRequired || undefined}
        className={cn('flex flex-col gap-1.5', className, classNames?.base)}
        dir={dir}
        role='radiogroup'
        style={style}
      >
        {label ? (
          <span
            className={cn(
              'text-ink text-[13px] font-bold',
              isRequired && "after:text-sk-red after:ms-1 after:content-['*']",
              classNames?.label,
            )}
          >
            {label}
          </span>
        ) : null}
        <div
          className={cn(
            'flex',
            orientation === 'horizontal' ? 'flex-row flex-wrap gap-4' : 'flex-col gap-3',
            classNames?.wrapper,
          )}
        >
          {children}
        </div>
        {description || effectiveError ? (
          <div className={cn('flex flex-col gap-0.5', classNames?.helperWrapper)}>
            {effectiveError ? (
              <span className={cn('font-hand text-sk-red text-[15px] font-semibold', classNames?.errorMessage)}>
                {effectiveError}
              </span>
            ) : description ? (
              <span className={cn('font-hand text-ink/70 text-[15px] font-semibold', classNames?.description)}>
                {description}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </RadioGroupContext.Provider>
  );
}

RadioGroup.displayName = 'RadioGroup';
