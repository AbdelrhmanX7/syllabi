import React from 'react';

import { cn } from '../../cn';

/**
 * da-v2 Form / FormProvider — drop-in for HeroUI's <Form>.
 *
 * Form is a thin <form> wrapper that participates in HeroUI's validation
 * pipeline. The visual presentation is delegated to the inputs inside; this
 * component handles the layout and the validation context plumbing.
 *
 * HeroUI shape mirrored:
 *   <Form
 *     action onSubmit onReset onInvalid
 *     validationBehavior='aria' | 'native'
 *     validationErrors={{ fieldName: 'msg' | ['msg1','msg2'] }}
 *     classNames={{ base?: string }}>
 *     {children}
 *   </Form>
 *
 * `validationBehavior='aria'` (HeroUI default): the form sets `noValidate` on
 * the underlying <form>, surfacing errors through aria attributes only. With
 * `'native'`, native browser validation runs.
 *
 * `validationErrors` is exposed via FormContext so descendant inputs can
 * read field-level errors keyed on their `name` prop. Inputs that don't yet
 * read the context simply ignore it — the prop remains harmless.
 *
 * <FormProvider> is a context-only variant — useful when you want to share
 * validation context across a sub-tree without rendering a <form> element.
 */

export type FormValidationBehavior = 'aria' | 'native';

export type FormValidationErrors = Record<string, string | string[] | undefined>;

export interface FormContextValue {
  validationErrors?: FormValidationErrors;
  validationBehavior: FormValidationBehavior;
}

const FormContext = React.createContext<FormContextValue | null>(null);

export function useFormContext(): FormContextValue | null {
  return React.useContext(FormContext);
}

/** Normalize a single field's error to a string, joining arrays with ` / `. */
export function getFieldError(errors: FormValidationErrors | undefined, name: string | undefined): string | undefined {
  if (!errors || !name) return undefined;
  const v = errors[name];
  if (!v) return undefined;
  if (Array.isArray(v)) return v.join(' / ');

  return v;
}

export interface FormProviderProps {
  validationErrors?: FormValidationErrors;
  validationBehavior?: FormValidationBehavior;
  children?: React.ReactNode;
}

/** Context-only provider — does NOT render a <form> element. */
export function FormProvider({ validationErrors, validationBehavior = 'aria', children }: FormProviderProps) {
  const value = React.useMemo<FormContextValue>(
    () => ({ validationErrors, validationBehavior }),
    [validationErrors, validationBehavior],
  );

  return <FormContext.Provider value={value}>{children}</FormContext.Provider>;
}

FormProvider.displayName = 'FormProvider';

export interface FormProps extends Omit<React.FormHTMLAttributes<HTMLFormElement>, 'onInvalid'> {
  validationBehavior?: FormValidationBehavior;
  validationErrors?: FormValidationErrors;
  /** HeroUI uses both `onInvalid` and the native form-invalid event. We forward both. */
  onInvalid?: React.FormEventHandler<HTMLFormElement>;
  classNames?: { base?: string };
  children?: React.ReactNode;
}

export const Form = React.forwardRef<HTMLFormElement, FormProps>(function Form(
  { validationBehavior = 'aria', validationErrors, classNames, className, children, onInvalid, ...rest },
  ref,
) {
  const value = React.useMemo<FormContextValue>(
    () => ({ validationErrors, validationBehavior }),
    [validationErrors, validationBehavior],
  );

  // When validationBehavior is 'aria' (HeroUI default), suppress native browser
  // validation tooltips so the rendered helper / error text is the only source.
  const noValidate = validationBehavior === 'aria';

  return (
    <FormContext.Provider value={value}>
      <form
        ref={ref}
        className={cn(classNames?.base, className)}
        noValidate={noValidate}
        onInvalid={onInvalid}
        {...rest}
      >
        {children}
      </form>
    </FormContext.Provider>
  );
});

Form.displayName = 'Form';
