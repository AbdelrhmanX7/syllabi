import { useEffect, useState } from 'react';
import { useReadLocalStorage } from 'usehooks-ts';
import axios from 'axios';
import { deleteCookie } from 'cookies-next';

import type { AuthConfig, AuthInitReturn, CreateAuthInitDeps } from './types';

/**
 * Returns true when a JWT string is missing, malformed, or past its expiry.
 */
function isTokenExpired(token: string | undefined | null): boolean {
  if (!token) return true;

  try {
    const parts = token.split('.');

    if (parts.length !== 3) return true;

    const payload = JSON.parse(atob(parts[1]));

    return typeof payload.exp === 'number' && payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

export function createAuthInit(config: AuthConfig, deps: CreateAuthInitDeps): () => AuthInitReturn {
  const useAuthInit = (): AuthInitReturn => {
    const [isLoading, setIsLoading] = useState(true);

    const { token } = deps.useGetUserData();
    const { setAuthToken, removeAuthToken } = deps.useAuthCookie();
    const localStorageToken = useReadLocalStorage<string>(config.tokenStorageKey) || '';

    useEffect(() => {
      const tokenInfo = (token as string) || localStorageToken;

      // If the token is expired/malformed, clean up and stop — don't propagate it.
      if (tokenInfo && isTokenExpired(tokenInfo)) {
        removeAuthToken();
        deleteCookie(config.cookieKey);
        setIsLoading(false);

        return;
      }

      if (tokenInfo) {
        axios.defaults.headers.common['Authorization'] = `Bearer ${tokenInfo}`;

        if (deps.apiClient) {
          deps.apiClient.defaults.headers.common['Authorization'] = `Bearer ${tokenInfo}`;
        }

        setAuthToken(tokenInfo);

        if (deps.socketUtils) {
          try {
            deps.socketUtils.initSocket(tokenInfo);
          } catch {
            // ignore
          }
        }
      }

      setIsLoading(false);
    }, [token, localStorageToken]);

    return { isLoading };
  };

  return useAuthInit;
}
