import React from 'react';

import { cn } from '../../cn';
import { useValidation } from '../useValidation';
import type { HeroUIColor, HeroUISize } from '../tokens';

/**
 * da-v2 CheckboxGroup — drop-in for HeroUI's <CheckboxGroup>.
 *
 * Mirrored API:
 *   <CheckboxGroup label value defaultValue onValueChange onChange
 *                  orientation isDisabled isReadOnly isRequired isInvalid
 *                  size color errorMessage description name classNames>
 *     <Checkbox value="x">A</Checkbox>
 *     <Checkbox value="y">B</Checkbox>
 *   </CheckboxGroup>
 *
 * The group manages a `Set<string>` of selected values via context. Each
 * <Checkbox> child opts in by inspecting `CheckboxGroupContext` and (when a
 * group is present) reads/writes its checked state from/to the group rather
 * than its own local state.
 *
 * Layout:
 *   - vertical (default): column, gap-3 (12px)
 *   - horizontal: row, flex-wrap, gap-4 (16px)
 */

export interface CheckboxGroupContextValue {
  value: Set<string>;
  toggle: (v: string) => void;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  isRequired?: boolean;
  isInvalid?: boolean;
  size?: HeroUISize;
  color?: HeroUIColor;
  name?: string;
}

export const CheckboxGroupContext = React.createContext<CheckboxGroupContextValue | null>(null);

export function useCheckboxGroup(): CheckboxGroupContextValue | null {
  return React.useContext(CheckboxGroupContext);
}

export interface CheckboxGroupProps {
  label?: React.ReactNode;
  description?: React.ReactNode;
  errorMessage?: React.ReactNode;
  /** Selected values. */
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
  /** HeroUI compat — fires after `onValueChange`, with the same array. */
  onChange?: (value: string[]) => void;
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
  validate?: (value: string[]) => string | null | undefined | true;
  dir?: 'rtl' | 'ltr';
  style?: React.CSSProperties;
}

export function CheckboxGroup(props: CheckboxGroupProps) {
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

  const isControlled = valueProp !== undefined;
  const [internal, setInternal] = React.useState<Set<string>>(() => new Set(defaultValue ?? []));
  const valueSet = React.useMemo(
    () => (isControlled ? new Set(valueProp ?? []) : internal),
    [isControlled, valueProp, internal],
  );

  const toggle = React.useCallback(
    (v: string) => {
      if (isDisabled || isReadOnly) return;
      const next = new Set(valueSet);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      if (!isControlled) setInternal(next);
      const arr = Array.from(next);
      onValueChange?.(arr);
      onChange?.(arr);
    },
    [valueSet, isDisabled, isReadOnly, isControlled, onValueChange, onChange],
  );

  /*
   * `validate` was declared in the props and never even destructured — see
   * `useValidation`. No `setCustomValidity` here: a checkbox GROUP is not a
   * single form control, so there is no node to attach native validity to. This
   * shows the message and paints the invalid state; blocking a native submit
   * would need a hidden input and is deliberately not faked.
   */
  const selected = React.useMemo(() => Array.from(valueSet), [valueSet]);
  const validation = useValidation<string[]>(validate, selected);
  const effectiveInvalid = isInvalid || validation.isInvalid;
  const effectiveError = errorMessage ?? validation.shown;

  const ctxValue = React.useMemo<CheckboxGroupContextValue>(
    () => ({
      value: valueSet,
      toggle,
      isDisabled,
      isReadOnly,
      isRequired,
      isInvalid: effectiveInvalid,
      size,
      color,
      name,
    }),
    [valueSet, toggle, isDisabled, isReadOnly, isRequired, effectiveInvalid, size, color, name],
  );

  return (
    <CheckboxGroupContext.Provider value={ctxValue}>
      <div
        aria-required={isRequired || undefined}
        className={cn('flex flex-col gap-1.5', className, classNames?.base)}
        dir={dir}
        role='group'
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
    </CheckboxGroupContext.Provider>
  );
}

CheckboxGroup.displayName = 'CheckboxGroup';
