import { useEffect, useState } from 'react';
import { useReadLocalStorage } from 'usehooks-ts';
import { getCookie } from 'cookies-next';

import type { AuthConfig, AuthCookieReturn, BaseUser, UserDataReturn } from './types';

export function createGetUserData<TUser extends BaseUser>(
  config: AuthConfig<TUser>,
  useAuthCookie: () => AuthCookieReturn,
): () => UserDataReturn<TUser> {
  const useGetUserData = (): UserDataReturn<TUser> => {
    const user = useReadLocalStorage<TUser>(config.userStorageKey);

    const [userData, setUserData] = useState<TUser>(config.defaultUserData);

    useEffect(() => {
      if (user && Object.keys(user).length > 0) {
        setUserData(user);
      }
    }, [user]);

    return { userData, token: getCookie(config.cookieKey) };
  };

  return useGetUserData;
}
