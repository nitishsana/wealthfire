// Decision thresholds (design §5). Read from env; anything missing or invalid falls back to the
// safe default (strict face match, liveness on, a low daily cap on paid checks).

export interface KycConfig {
  /** minimum partner face-match score, 0 < x <= 1 */
  faceMatchMin: number;
  /** when true, a selfie must pass liveness */
  livenessRequired: boolean;
  /** failed liveness attempts that reject the case (design §5: "failed twice") */
  livenessFailsToReject: number;
  /** paid partner calls per user per day, every call counted (R7) */
  maxPaidChecksPerDay: number;
}

export const DEFAULT_CONFIG: Readonly<KycConfig> = Object.freeze({
  faceMatchMin: 0.8,
  livenessRequired: true,
  livenessFailsToReject: 2,
  // every paid partner call counts (user steps, system follow-ups and retries); a clean full KYC
  // is 6 calls, so 10 leaves room for one retake and a couple of retries
  maxPaidChecksPerDay: 10,
});

type Env = Record<string, string | undefined>;

function num(v: string | undefined, ok: (n: number) => boolean, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && ok(n) ? n : fallback;
}

/**
 * KYC_FACE_MATCH_MIN (0–1], KYC_LIVENESS_REQUIRED ('false' is the only value that turns it off),
 * KYC_MAX_PAID_CHECKS_PER_DAY (whole number >= 1).
 */
export function loadConfig(env: Env = process.env): KycConfig {
  return {
    faceMatchMin: num(env.KYC_FACE_MATCH_MIN, (n) => n > 0 && n <= 1, DEFAULT_CONFIG.faceMatchMin),
    livenessRequired: env.KYC_LIVENESS_REQUIRED?.trim().toLowerCase() !== 'false',
    livenessFailsToReject: DEFAULT_CONFIG.livenessFailsToReject,
    maxPaidChecksPerDay: num(
      env.KYC_MAX_PAID_CHECKS_PER_DAY,
      (n) => Number.isInteger(n) && n >= 1,
      DEFAULT_CONFIG.maxPaidChecksPerDay,
    ),
  };
}

/** Paid checks left today for a user who has used `usedToday`. */
export function paidChecksLeft(usedToday: number, config: KycConfig): number {
  return Math.max(0, config.maxPaidChecksPerDay - usedToday);
}
