// Client-safe KYC errors. Fixed messages only: never a PAN, Aadhaar, contact, token or partner detail.

export type KycErrorCode =
  | 'bad_request'
  | 'missing_idempotency_key'
  | 'idempotency_mismatch'
  | 'in_progress'
  | 'not_found'
  | 'already_started'
  | 'decided'
  | 'wrong_step'
  | 'upload_missing'
  | 'conflict'
  | 'limit_reached'
  | 'partner_unavailable';

export const KYC_ERROR_MESSAGES: Record<KycErrorCode, string> = {
  bad_request: 'Check the details and try again.',
  missing_idempotency_key: 'This request needs an Idempotency-Key header.',
  idempotency_mismatch: 'This Idempotency-Key was already used for a different request.',
  in_progress: 'This request is still being processed. Try again shortly.',
  not_found: 'Start your KYC first.',
  already_started: 'Your KYC has already started.',
  decided: 'Your KYC has already been decided.',
  wrong_step: 'That step is not open right now. Check your KYC status.',
  upload_missing: 'We could not find that upload. Upload the file again.',
  conflict: 'Your KYC changed meanwhile. Check your status and try again.',
  limit_reached: 'You have reached today\u2019s limit for KYC checks. Try again tomorrow.',
  partner_unavailable: 'The KYC service is not answering right now. Try again shortly.',
};

export const KYC_ERROR_STATUS: Record<KycErrorCode, number> = {
  bad_request: 400,
  missing_idempotency_key: 400,
  idempotency_mismatch: 422,
  in_progress: 409,
  not_found: 404,
  already_started: 409,
  decided: 409,
  wrong_step: 409,
  upload_missing: 400,
  conflict: 409,
  limit_reached: 429,
  partner_unavailable: 503,
};

export class KycError extends Error {
  constructor(readonly code: KycErrorCode) {
    super(KYC_ERROR_MESSAGES[code]);
    this.name = 'KycError';
  }
}

export function isKycError(e: unknown): e is KycError {
  return e instanceof KycError;
}
