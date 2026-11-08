import { wbT } from '../../../i18n/strings';

import type { WbLocale } from '../../../i18n/strings';
import type { InkClass } from './types';

/** Dictionary key of a class name (the board's class menu, a host's settings). */
export const inkClassKey = (cls: InkClass) => `inkClass.${cls}` as const;

/** A class's name in `locale`. */
export function inkClassLabel(cls: InkClass, locale: WbLocale): string {
  return wbT(locale, inkClassKey(cls));
}
