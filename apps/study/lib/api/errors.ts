/**
 * The AI provider is out of balance. The backend sends `code: 'AI_QUOTA'` on every study JSON error and
 * SSE `error` frame when that happens (the board's `/whiteboard/ai/*` may answer 402 instead). Nothing
 * the student does fixes it, so it is a persistent notice: no auto-retry, no Retry button.
 */
export const AI_QUOTA_CODE = 'AI_QUOTA';
export const AI_QUOTA_MESSAGE = 'AI credits ran out — top up the AI account, then try again.';

/** The server's monthly AI allowance for everyone is used up. Nothing to retry until next month. */
export const AI_BUDGET_CODE = 'AI_BUDGET';
export const AI_BUDGET_MESSAGE = 'The AI is resting until next month.';

/** One account used the AI a lot today. Back tomorrow. */
export const AI_DAILY_LIMIT_CODE = 'AI_DAILY_LIMIT';
export const AI_DAILY_LIMIT_MESSAGE = "You've used a lot of AI today — try again tomorrow.";

/** The AI's resting, for the month or for today: no auto-retry. */
export function isAiResting(error: unknown): boolean {
  const code = !!error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;

  return code === AI_BUDGET_CODE || code === AI_DAILY_LIMIT_CODE;
}

/** 403 from AI endpoints (tutor, extraction, `/study/ai/*`) until the account's email is confirmed. */
export const EMAIL_NOT_VERIFIED_CODE = 'EMAIL_NOT_VERIFIED';
export const EMAIL_NOT_VERIFIED_MESSAGE =
  'Confirm your email to use AI — open the link we sent, or resend it from Settings → Account.';

/** 403 from every AI endpoint when the owner hasn't turned AI on for this account. */
export const AI_NOT_ENABLED_CODE = 'AI_NOT_ENABLED';
export const AI_NOT_ENABLED_MESSAGE = "AI features aren't on for your account.";

export function isAiNotEnabled(error: unknown): boolean {
  if (typeof error === 'string') return error === AI_NOT_ENABLED_MESSAGE;

  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === AI_NOT_ENABLED_CODE;
}

export function isEmailNotVerified(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === EMAIL_NOT_VERIFIED_CODE;
}

/** `{ message, code }` from the contract, plus the HTTP status. Thrown by both transports. */
export class StudyApiError extends Error {
  status: number;
  code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    // Every reader of `.message` (tutor, grading, flashcards, digests…) gets the English line.
    super(
      code === AI_QUOTA_CODE || status === 402
        ? AI_QUOTA_MESSAGE
        : code === EMAIL_NOT_VERIFIED_CODE
          ? EMAIL_NOT_VERIFIED_MESSAGE
          : code === AI_NOT_ENABLED_CODE
            ? AI_NOT_ENABLED_MESSAGE
            : code === AI_BUDGET_CODE
              ? AI_BUDGET_MESSAGE
              : code === AI_DAILY_LIMIT_CODE
                ? AI_DAILY_LIMIT_MESSAGE
                : message,
    );
    this.name = 'StudyApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The error plus the body's extra fields (409 `currentVersion`, extract `failedPages`…). The body's
 * `message` never overwrites the error's: that is where the AI_QUOTA line was put.
 */
export function studyApiError(
  status: number,
  message: string,
  code: string | undefined,
  extra: Record<string, unknown> = {},
): StudyApiError {
  const rest = { ...extra };

  delete rest.message;

  return Object.assign(new StudyApiError(status, message, code), rest);
}

export function isStudyApiError(error: unknown, status?: number): error is StudyApiError {
  return error instanceof StudyApiError && (status === undefined || error.status === status);
}

/** Any thrown value that means «the AI account is empty»: the code, a 402, or the message itself. */
export function isAiQuotaError(error: unknown): boolean {
  if (typeof error === 'string') return error === AI_QUOTA_MESSAGE;
  if (!error || typeof error !== 'object') return false;
  const { code, status, message } = error as { code?: unknown; status?: unknown; message?: unknown };

  return code === AI_QUOTA_CODE || status === 402 || message === AI_QUOTA_MESSAGE;
}

/** React Query `retry`: once for a flaky network, never for an empty AI account. */
export const retryUnlessAiQuota = (failureCount: number, error: unknown): boolean =>
  failureCount < 1 && !isAiQuotaError(error) && !isEmailNotVerified(error) && !isAiNotEnabled(error) && !isAiResting(error);

export const NETWORK_MESSAGE = 'Lost connection to the server — check your internet and try again.';

/**
 * The browser's own «the connection broke» errors — a fetch that never reached the server, or a
 * response body (an SSE stream) cut mid-way: Chromium `TypeError: network error` / `Failed to
 * fetch`, Safari `Load failed`, Firefox `NetworkError when attempting to fetch resource.`. Never a
 * server answer (those are StudyApiError).
 */
export function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || error instanceof StudyApiError) return false;
  const message = (error as { message?: unknown }).message;

  if (typeof message !== 'string') return false;

  return /^(network ?error\b|failed to fetch|load failed|the network connection was lost|network request failed|net::err_)/i.test(
    message.trim(),
  );
}

/**
 * A deploy outlasted the backend's drain: the stream's last frame is `error {code:'SERVER_RESTARTING'}`
 * (study SSE: a named `error` event; `/whiteboard/ai/*`: `data:{type:'error', data:{code, message}}`).
 * Same family as a dropped connection — retry, don't alarm.
 */
export const SERVER_RESTARTING_CODE = 'SERVER_RESTARTING';
export const SERVER_RESTARTING_MESSAGE = 'Server restarted — try again';

export function isServerRestarting(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === SERVER_RESTARTING_CODE;
}

/** A stream that died for a reason a rerun fixes: the connection broke, or the server restarted. */
export const isRetryableStreamError = (error: unknown): boolean => isNetworkError(error) || isServerRestarting(error);

/** 400 from grade / reference / practice when the map has no concept list (was `NO_TERMS`). */
export const NO_PROMPT_TERMS_CODE = 'NO_PROMPT_TERMS';
export const NO_PROMPT_TERMS_MESSAGE = "Enter this map's concept list first";

/** `network` replaces the generic lost-connection line where the caller can say what was lost. */
export function describeError(error: unknown, fallback = 'Something went wrong', network = NETWORK_MESSAGE): string {
  if (isAiQuotaError(error)) return AI_QUOTA_MESSAGE;
  if (isServerRestarting(error)) return SERVER_RESTARTING_MESSAGE;
  if ((error as { code?: unknown } | null)?.code === AI_BUDGET_CODE) return AI_BUDGET_MESSAGE;
  if ((error as { code?: unknown } | null)?.code === AI_DAILY_LIMIT_CODE) return AI_DAILY_LIMIT_MESSAGE;
  if ((error as { code?: unknown } | null)?.code === NO_PROMPT_TERMS_CODE) return NO_PROMPT_TERMS_MESSAGE;
  if (isEmailNotVerified(error)) return EMAIL_NOT_VERIFIED_MESSAGE;
  if (isAiNotEnabled(error)) return AI_NOT_ENABLED_MESSAGE;
  if (isNetworkError(error)) return network;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;

  return fallback;
}
