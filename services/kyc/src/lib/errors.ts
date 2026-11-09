// Client-safe auth errors. Messages are fixed strings: they never contain codes, tokens,
// contacts or whether a contact has an account. Anything else thrown is reported as 'internal'.

export type AuthErrorCode =
  | 'bad_request'
  | 'forbidden'
  | 'invalid_code'
  | 'invalid_token'
  | 'rate_limited'
  | 'send_failed'
  | 'unauthorized';

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  bad_request: 'Check the details and try again.',
  forbidden: 'You do not have access to this.',
  invalid_code: 'That code is wrong or has expired.',
  invalid_token: 'Your session has ended. Sign in again.',
  rate_limited: 'Too many tries. Wait a little and try again.',
  send_failed: 'We could not send the code. Try again shortly.',
  unauthorized: 'Sign in to continue.',
};

export const AUTH_ERROR_STATUS: Record<AuthErrorCode, number> = {
  bad_request: 400,
  forbidden: 403,
  invalid_code: 401,
  invalid_token: 401,
  rate_limited: 429,
  send_failed: 503,
  unauthorized: 401,
};

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  /** Only for rate_limited: how long to wait. */
  readonly retryAfterMs?: number;
  /** Only for invalid_code: tries left on this challenge. */
  readonly triesLeft?: number;

  constructor(code: AuthErrorCode, extra: { retryAfterMs?: number; triesLeft?: number } = {}) {
    super(AUTH_ERROR_MESSAGES[code]);
    this.name = 'AuthError';
    this.code = code;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = Math.max(0, Math.ceil(extra.retryAfterMs));
    if (extra.triesLeft !== undefined) this.triesLeft = Math.max(0, extra.triesLeft);
  }
}

export function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError;
}
