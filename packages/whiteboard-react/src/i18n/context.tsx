import React, { createContext, useContext, useMemo } from 'react';

import { wbDir, wbIntlLocale, wbT, type WbLocale, type WbStringKey, type WbVars } from './strings';

const WbLocaleContext = createContext<WbLocale>('en');

export const WbLocaleProvider: React.FC<{ locale: WbLocale; children: React.ReactNode }> = ({ locale, children }) => (
  <WbLocaleContext.Provider value={locale}>{children}</WbLocaleContext.Provider>
);

export interface WbStrings {
  locale: WbLocale;
  t: (key: WbStringKey, vars?: WbVars) => string;
  dir: 'rtl' | 'ltr';
  /** `Intl` locale for numbers and dates. */
  intlLocale: string;
}

export function useWbLocale(): WbLocale {
  return useContext(WbLocaleContext);
}

export function useWbStrings(): WbStrings {
  const locale = useContext(WbLocaleContext);

  return useMemo(
    () => ({
      locale,
      t: (key: WbStringKey, vars?: WbVars) => wbT(locale, key, vars),
      dir: wbDir(locale),
      intlLocale: wbIntlLocale(locale),
    }),
    [locale],
  );
}
