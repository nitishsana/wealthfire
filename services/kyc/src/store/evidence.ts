// decide() over stored case evidence. Shared by the KYC routes and the webhook so both read the
// same evidence the same way (including the webhook's "Aadhaar eKYC failed" flag).
import type { KycConfig } from '../config';
import { decide, type Decision, type DecideInput } from '../decide';
import type { KycStatus, ReasonCode } from '../types';
import type { CaseEvidence } from './types';

/** The decide() input for stored evidence (bookkeeping fields dropped). */
export function decideInput(ev: CaseEvidence, current: KycStatus, currentReason: ReasonCode | null): DecideInput {
  const { faceTs: _f, kraUpload: _k, eventTs: _e, aadhaarFailed: _a, ...rest } = ev;
  return { ...rest, current, currentReason };
}

/**
 * decide() for a stored case. decide() has no "eKYC failed" input: a failed Aadhaar eKYC is a real
 * doubt (not a timeout), so unless a clear fail already rejects, a person must look at it.
 */
export function decideFromEvidence(
  ev: CaseEvidence, current: KycStatus, currentReason: ReasonCode | null, config: KycConfig,
): Decision {
  const d = decide(decideInput(ev, current, currentReason), config);
  if (ev.aadhaarFailed && d.status !== 'rejected') {
    // a case already waiting for staff keeps its reason (e.g. pan-in-use)
    const keep = current === 'under-review' && currentReason && currentReason !== 'partner-timeout' ? currentReason : null;
    return {
      ...d, status: 'under-review', path: d.path ?? 'full-kyc', reason: keep ?? 'check-unclear', next: 'wait',
      checks: { ...d.checks, aadhaar: 'unclear' },
    };
  }
  return d;
}
