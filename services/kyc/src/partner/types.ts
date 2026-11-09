// KycPartner adapter (design §4). The rest of the service talks to the KYC / KRA partner only
// through this interface, so the partner's wire format stays in one implementation
// (FakePartner now; FintechPrimitivesPartner once sandbox docs are available).

export interface KycPartner {
  lookupKyc(pan: string): Promise<{ status: 'validated' | 'registered' | 'on-hold' | 'not-found'; name?: string; dob?: string; ref: string }>;
  startAadhaar(userId: string, mode: 'digilocker' | 'otp', returnUrl: string): Promise<{ redirectUrl?: string; challengeRef?: string }>;
  verifyPan(pan: string, name: string): Promise<{ valid: boolean; nameMatch: boolean; aadhaarLinked: boolean }>;
  faceMatch(selfieKey: string, aadhaarRef: string): Promise<{ match: number; live: boolean }>;
  startEsign(userId: string, returnUrl: string): Promise<{ redirectUrl: string; ref: string }>;
  uploadToKra(userId: string): Promise<{ ref: string }>;
  verifyWebhook(headers: Record<string, string>, body: string): boolean;
}

/**
 * Thrown by an adapter when the partner did not answer in time. The KYC service retries a few
 * times, then records the check as 'timeout' (decide() → under-review, reason 'partner-timeout').
 */
export class PartnerTimeoutError extends Error {
  constructor(readonly operation: keyof KycPartner) {
    super(`partner ${operation} timed out`);
    this.name = 'PartnerTimeoutError';
  }
}

export function isPartnerTimeout(e: unknown): e is PartnerTimeoutError {
  return e instanceof PartnerTimeoutError;
}

/** The partner calls that cost money (R7); each one is capped per user per day and logged in `costs`. */
export type PaidCheck = 'kra-lookup' | 'aadhaar' | 'pan-verify' | 'face-match' | 'esign' | 'kra-upload';
