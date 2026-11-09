// Auth failure counters (S3). Each event carries only a fixed reason and the contact kind: never
// a contact, its hash, an IP, a code or a challenge id. The default writes CloudWatch Embedded
// Metric Format lines, so the `Wealthfire/Kyc OtpFailures` metric (dimension Reason) needs no SDK.

export type OtpFailureReason =
  /** a wrong code was entered */
  | 'wrong-code'
  /** the challenge was unknown, expired or out of tries */
  | 'dead-challenge'
  /** send or verify refused because the target is locked out */
  | 'locked'
  /** send refused by the per-target or per-IP send limits */
  | 'send-limited'
  /** verify refused by the per-IP verify limit */
  | 'verify-limited'
  /** a target hit the failed-challenge threshold and was locked */
  | 'lockout-started'
  /** the SMS / email provider failed */
  | 'send-failed';

export interface OtpFailureEvent {
  reason: OtpFailureReason;
  kind?: 'email' | 'mobile';
}

export interface AuthMetrics {
  otpFailure(e: OtpFailureEvent): void;
}

export const METRIC_NAMESPACE = 'Wealthfire/Kyc';
export const OTP_FAILURE_METRIC = 'OtpFailures';

/** One EMF JSON object for an OTP failure. */
export function otpFailureEmf(e: OtpFailureEvent, timestamp: number): Record<string, unknown> {
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [{ Namespace: METRIC_NAMESPACE, Dimensions: [['Reason']], Metrics: [{ Name: OTP_FAILURE_METRIC, Unit: 'Count' }] }],
    },
    level: 'info',
    event: 'otp_failure',
    Reason: e.reason,
    ...(e.kind ? { kind: e.kind } : {}),
    [OTP_FAILURE_METRIC]: 1,
  };
}

/** Production default: EMF lines on stdout (CloudWatch Logs turns them into metrics). */
export const emfAuthMetrics: AuthMetrics = {
  otpFailure(e) {
    console.log(JSON.stringify(otpFailureEmf(e, Date.now())));
  },
};

/** Test metrics: keeps the events in memory. */
export class MemoryAuthMetrics implements AuthMetrics {
  readonly events: OtpFailureEvent[] = [];
  otpFailure(e: OtpFailureEvent): void {
    this.events.push({ ...e });
  }
  count(reason: OtpFailureReason): number {
    return this.events.filter((e) => e.reason === reason).length;
  }
}
