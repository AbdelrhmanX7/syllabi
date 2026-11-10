import type { DropTokenCreated } from './types';

import { useEffect, useSyncExternalStore } from 'react';

import { useDropTokenMutations, useDropTokens } from './api';
import {
  dropLinkRevoked,
  forgetDropLink,
  getDropLinkSnapshot,
  rememberDropLink,
  subscribeDropLink,
  usableDropLink,
} from './lib/dropLink';
import { dropUrl } from './lib/links';

import { useBackendSettings } from '@/hooks/useBackendSettings';
import { useSampleRoute, useStudyQueriesEnabled } from '@/lib/api/hooks';
import { useGetUserData } from '@/lib/auth';

/**
 * The phone drop link shared by Settings → Phone inbox and the board's «From phone» sheet: one
 * remembered token per device and server, so opening the sheet again shows the same QR. A code is
 * made only on request (`make`); a token revoked anywhere stops showing once the list comes back.
 */
export function usePhoneDropLink() {
  const { backendUrl } = useBackendSettings();
  const isSample = useSampleRoute('/inbox/tokens');
  const enabled = useStudyQueriesEnabled();
  const tokens = useDropTokens();
  const { create, revoke } = useDropTokenMutations();
  const { userData } = useGetUserData();
  // Server + account: another account signing in on this tablet never sees the first one's code.
  const scope = isSample ? 'mock' : `${backendUrl.trim().replace(/\/+$/, '')}#${userData?._id ?? userData?.email ?? ''}`;
  const saved = useSyncExternalStore(subscribeDropLink, getDropLinkSnapshot, () => null);
  const listedIds = tokens.data ? tokens.data.map((token) => token.id) : null;
  // Only a list fetched after the code was made can say it was revoked (the refetch lags the create).
  const listedAt = tokens.dataUpdatedAt;
  const link = usableDropLink(saved, scope, listedIds, listedAt);
  const revoked = !!saved && saved.scope === scope && dropLinkRevoked(saved, listedIds, listedAt);

  // Revoked elsewhere (another device, Settings): drop the remembered secret for good.
  useEffect(() => {
    if (revoked && saved) forgetDropLink(saved.id);
  }, [revoked, saved]);

  const make = (label: string, onMade?: (token: DropTokenCreated) => void) =>
    create.mutate(label, {
      onSuccess: (token) => {
        rememberDropLink(scope, token);
        onMade?.(token);
      },
    });

  return {
    /** False when signed out against a live server: nothing to make a code with. */
    enabled,
    isSample,
    link,
    url: link ? dropUrl(backendUrl, link.token) : null,
    make,
    create,
    revoke,
    tokens,
  };
}
