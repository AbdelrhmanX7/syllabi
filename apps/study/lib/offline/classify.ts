import type { SendResult } from './outbox';

import { isNetworkError, isStudyApiError } from '@/lib/api/errors';

/** What to do with a job whose send threw: retry what the network broke, drop what the server refused. */
export function classifySendError(error: unknown): SendResult {
  if (isNetworkError(error)) return 'retry';
  if (isStudyApiError(error)) {
    const { status } = error;

    // 401: the session ran out — keep it for when the same account signs in again.
    if (status === 0 || status === 401 || status === 408 || status === 429 || status >= 500) return 'retry';

    return 'drop';
  }

  return 'retry';
}
