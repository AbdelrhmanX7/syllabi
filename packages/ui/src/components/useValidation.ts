import React from 'react';

/**
 * The `validate` prop, actually wired up.
 *
 * `Input`, `Textarea`, `Select`, `CheckboxGroup` and `RadioGroup` have all
 * DECLARED a `validate` callback in their prop types for as long as they have
 * existed. None of them ever called it. `Input` and `Textarea` destructured it
 * and dropped it on the floor; `Select` renamed it `_validate` to silence the
 * unused warning; `CheckboxGroup` and `RadioGroup` did not even destructure it.
 *
 * It typechecks perfectly either way, which is why nobody noticed: 26 call
 * sites across 6 apps pass rules that have never run once. Measured on
 * `apps/web`'s login form — submitted `password='abc'` against a rule requiring
 * 8 characters, and got `aria-invalid: null`, an empty `validationMessage`, and
 * zero message nodes. The student was sent to the server and shown a
 * credentials error instead of "your password is too short".
 *
 * One hook rather than five copies, so the five controls cannot drift.
 *
 * WHEN IT RUNS vs WHEN IT SHOWS — these are deliberately different:
 *
 * - It RUNS on mount and on every change, and pushes the result straight into
 *   `setCustomValidity`. That means a native form submit is blocked from the
 *   first render, before the user has touched anything, which is the behaviour
 *   the call sites have been assuming all along.
 * - It SHOWS only after the field has been blurred once. Validating on mount
 *   and rendering it immediately would put a red error under every empty
 *   required field the moment a form opens, which is how you teach someone to
 *   ignore error text.
 *
 * A string return is the message. `true`, `null` and `undefined` all mean
 * valid — `true` because that is what the declared type offers as the explicit
 * "this is fine" value, and an empty string because a caller returning `''`
 * means "no message", not "an error with no text".
 */
export interface ValidationState {
  /** The message to render, or null while the field is untouched or valid. */
  shown: string | null;
  /** Whether the control should paint its invalid state. */
  isInvalid: boolean;
  /** Re-run the rule against a value. Safe to call when no `validate` was given. */
  run: (value: unknown) => void;
  /** Mark the field blurred, so a failing rule becomes visible. */
  markTouched: () => void;
}

export function useValidation<T>(
  validate: ((value: T) => string | null | undefined | true) | undefined,
  currentValue: T,
  /**
   * The DOM node to push `setCustomValidity` into, when there is one. Native
   * form submission is the half of validation that a React-only error message
   * cannot provide: without it a failing field still submits.
   */
  nodeRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>,
): ValidationState {
  const [message, setMessage] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);

  // `validate` is nearly always an inline arrow at the call site, so it is a new
  // identity every render. Reading it through a ref keeps `run` stable and stops
  // the mount effect below from re-firing on every parent render.
  const validateRef = React.useRef(validate);

  validateRef.current = validate;

  const run = React.useCallback(
    (value: unknown) => {
      const fn = validateRef.current;

      if (!fn) return;

      const result = fn(value as T);
      const msg = typeof result === 'string' && result.length > 0 ? result : null;

      setMessage(msg);
      nodeRef?.current?.setCustomValidity?.(msg ?? '');
    },
    [nodeRef],
  );

  const markTouched = React.useCallback(() => setTouched(true), []);

  // Mount + whenever the value changes from outside (a controlled parent, a
  // reset, a prefill). Covers the uncontrolled case too, because `run` is also
  // called from the control's own change handler.
  React.useEffect(() => {
    run(currentValue);
  }, [run, currentValue]);

  return {
    shown: touched ? message : null,
    isInvalid: touched && message !== null,
    run,
    markTouched,
  };
}
