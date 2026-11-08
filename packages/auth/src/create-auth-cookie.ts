import { setCookie, getCookie, deleteCookie } from 'cookies-next';
import { useCallback } from 'react';
import { useLocalStorage } from 'usehooks-ts';

import type { AuthConfig, AuthCookieReturn } from './types';

export function createAuthCookie(config: AuthConfig): () => AuthCookieReturn {
  const useAuthCookie = (): AuthCookieReturn => {
    const [, setLocalStorageToken] = useLocalStorage<string>(config.tokenStorageKey, '');
    const [, setUser] = useLocalStorage<any>(config.userStorageKey, {});

    const setAuthToken = useCallback((token: string) => {
      const expiresIn = 60 * 60 * 24 * 30; // 30 days in seconds
      const expirationDate = new Date();

      expirationDate.setTime(expirationDate.getTime() + expiresIn * 1000);

      setCookie(config.cookieKey, token, { expires: expirationDate });
      setLocalStorageToken(token);
    }, []);

    const getAuthToken = useCallback(() => {
      return getCookie(config.cookieKey) || '';
    }, []);

    const removeAuthToken = useCallback(async () => {
      setLocalStorageToken('');
      setUser({});
      deleteCookie(config.cookieKey);
    }, []);

    return {
      setAuthToken,
      getAuthToken,
      removeAuthToken,
    };
  };

  return useAuthCookie;
}
