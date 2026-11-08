/**
 * Every user-visible string of the board engine. The product is English only; the lookup API
 * (`wbT`, `useWbStrings`) is kept so call sites stay keyed and placeholder-aware.
 *
 * Placeholders are `{name}` and are filled by `wbT`. AI prompt text sent to the backend is NOT here —
 * only what a person reads on screen.
 */
import { AI_STRINGS } from './dict/ai';
import { CONCEPT_MAP_STRINGS } from './dict/conceptMap';
import { EDITOR_STRINGS } from './dict/editor';
import { LIBRARY_STRINGS } from './dict/library';
import { PDF_STRINGS } from './dict/pdf';
import { SELECTION_STRINGS } from './dict/selection';
import { TOOLBAR_STRINGS } from './dict/toolbar';

/** The board is English only; the `locale` prop is kept so hosts can keep passing it. */
export type WbLocale = 'en';

export const WB_STRINGS = {
  ...EDITOR_STRINGS,
  ...TOOLBAR_STRINGS,
  ...PDF_STRINGS,
  ...LIBRARY_STRINGS,
  ...AI_STRINGS,
  ...SELECTION_STRINGS,
  ...CONCEPT_MAP_STRINGS,
} satisfies Record<string, string>;

export type WbStringKey = keyof typeof WB_STRINGS;

export type WbVars = Record<string, string | number>;

export function wbT(_locale: WbLocale, key: WbStringKey, vars?: WbVars): string {
  const text: string = WB_STRINGS[key];

  if (!vars) return text;

  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

const USER_FACING = Symbol.for('wb.userFacingError');

/**
 * An error whose message was written for the user. Raw library errors are English too, so the
 * user-facing ones carry this tag.
 */
export function userFacingError(message: string): Error {
  return Object.assign(new Error(message), { [USER_FACING]: true });
}

export function isUserFacingError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as Record<symbol, unknown>)[USER_FACING]);
}

/** The `Intl` locale for numbers and dates. */
export function wbIntlLocale(_locale?: WbLocale): string {
  return 'en-US';
}

export function wbDir(_locale?: WbLocale): 'rtl' | 'ltr' {
  return 'ltr';
}
