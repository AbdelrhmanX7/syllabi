import { aiEnabledFrom } from '@/lib/ai/access';
import { useAccount } from '@/features/auth/api';
import { useBackendSettings } from '@/hooks/useBackendSettings';
import { useSession } from '@/hooks/useSession';
import { useGetUserData } from '@/lib/auth';

/**
 * Whether this account gets the AI parts of the app (tutor, explain, make questions/cards/maps…).
 * True in demo mode, for the server owner and for accounts the owner turned AI on for; false only
 * when the server says the account has no AI. See lib/ai/access.ts.
 */
export function useAiEnabled(): boolean {
  const { mockMode } = useBackendSettings();
  const session = useSession();
  const signedIn = session.state === 'signed-in';
  const demo = mockMode === 'mock';
  const account = useAccount(signedIn && !demo);
  const { userData } = useGetUserData();

  return aiEnabledFrom({ demo, signedIn, account: account.data, stored: userData });
}
