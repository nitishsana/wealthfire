// Pure final-KYC decision (design §5). No I/O: callers pass everything known about a case and
// store the result. Precedence: clear fail → rejected; device hand check → under-review;
// KRA fast path → verified; any unclear check → under-review; all full-KYC checks pass → verified;
// otherwise still in progress (status unchanged, `next` says what is missing).
import type { KycConfig } from './config';
import { dobMatches, nameMatches } from './match';
import type { CheckName, CheckResult, KraStatus, KycPath, KycStatus, NextStep, ReasonCode } from './types';

/** A partner call that still failed after its retries. */
export type Timeout = 'timeout';

export interface DecideInput {
  /** the case's current status (first call: the device result) */
  current: KycStatus;
  /**
   * the case's stored reason. An under-review case may be moved to verified by the system only
   * when this is 'partner-timeout'; any other under-review case waits for staff.
   */
  currentReason?: ReasonCode | null;
  /** device onboarding sent the documents for a hand check */
  deviceHandCheck: boolean;
  /** typed at onboarding */
  typed: { firstName: string; lastName: string; dob: string };
  /** typed PAN is an individual PAN (match.isIndividualPan) */
  panIndividual: boolean;
  /** Aadhaar last 4 verified by the device Aadhaar OTP */
  otpAadhaarLast4: string;
  /** KycPartner.lookupKyc; undefined = not done yet */
  kra?: { status: KraStatus; name?: string; dob?: string } | Timeout;
  /** DigiLocker / Aadhaar OTP eKYC result; undefined = not done yet */
  aadhaar?: { verified: true; last4: string } | Timeout;
  /** KycPartner.verifyPan; undefined = not done yet */
  pan?: { valid: boolean; nameMatch: boolean; aadhaarLinked: boolean } | Timeout;
  /** KycPartner.faceMatch attempts, oldest first */
  face?: readonly ({ match: number; live: boolean } | Timeout)[];
  /** partner e-sign */
  esign?: 'done' | 'pending' | Timeout;
}

export interface Decision {
  status: KycStatus;
  /** null only while the KRA lookup has not finished */
  path: KycPath | null;
  reason: ReasonCode;
  next: NextStep;
  checks: Partial<Record<CheckName, CheckResult>>;
  /** checks that came back unclear (reason 'check-unclear') */
  unclear?: CheckName[];
  note?: string;
}

export class KycTransitionError extends Error {
  constructor(readonly from: KycStatus, readonly to: KycStatus | 'staff-action', message: string) {
    super(message);
    this.name = 'KycTransitionError';
  }
}

const TERMINAL: ReadonlySet<KycStatus> = new Set(['verified', 'rejected']);

/**
 * System (non-staff) moves: terminal cases never change; a case never goes back to pre-verified;
 * an under-review case reaches verified without staff only when its reason is 'partner-timeout'.
 */
export function canSystemTransition(from: KycStatus, to: KycStatus, fromReason?: ReasonCode | null): boolean {
  if (TERMINAL.has(from)) return false;
  if (from === 'under-review' && to === 'pre-verified') return false;
  if (from === 'under-review' && to === 'verified') return fromReason === 'partner-timeout';
  return true;
}

/** Staff moves: only an under-review case, only to verified or rejected. */
export function canStaffTransition(from: KycStatus, to: KycStatus): boolean {
  return from === 'under-review' && (to === 'verified' || to === 'rejected');
}

const isTimeout = (v: unknown): v is Timeout => v === 'timeout';

/**
 * Evaluate all known evidence for a case (design §5 rows 1–4). Throws KycTransitionError on a terminal case.
 *
 * Under-review cases: a clear fail still rejects. When `currentReason` is 'partner-timeout' the
 * evidence decides as usual (a retry that now passes verifies; while steps are missing the case
 * stays under-review with reason 'partner-timeout'). Any other under-review case stays
 * under-review with its reason and next 'wait' until staff decide.
 */
export function decide(input: DecideInput, config: KycConfig): Decision {
  const { current } = input;
  if (TERMINAL.has(current)) {
    throw new KycTransitionError(current, current, `case is ${current}; only a new case can change it`);
  }
  const d = evaluate(input, config);
  if (current !== 'under-review' || d.status === 'rejected') return d;
  if (input.currentReason === 'partner-timeout') {
    return d.reason === 'in-progress' ? { ...d, status: 'under-review', reason: 'partner-timeout' } : d;
  }
  // Waits for staff: never verified by the system, never relabelled as a timeout.
  const keep: ReasonCode =
    input.currentReason ??
    (d.status === 'under-review' && d.reason !== 'partner-timeout' && d.reason !== 'in-progress' ? d.reason : 'check-unclear');
  return {
    status: 'under-review', path: d.path, reason: keep, next: 'wait', checks: d.checks,
    ...(d.unclear ? { unclear: d.unclear } : {}),
  };
}

function evaluate(input: DecideInput, config: KycConfig): Decision {
  const { current } = input;
  const checks: Partial<Record<CheckName, CheckResult>> = {};
  const reject = (reason: ReasonCode): Decision => ({ status: 'rejected', path: 'full-kyc', reason, next: 'none', checks });

  // Row 4: clear fails → rejected with reason.
  if (!input.panIndividual) {
    checks.pan = 'fail';
    return reject('pan-not-individual');
  }
  if (input.pan !== undefined && !isTimeout(input.pan) && !input.pan.valid) {
    checks.pan = 'fail';
    return reject('pan-invalid');
  }
  if (input.aadhaar !== undefined && !isTimeout(input.aadhaar) && input.aadhaar.last4 !== input.otpAadhaarLast4) {
    checks.aadhaar = 'fail';
    return reject('aadhaar-mismatch');
  }
  const faces = input.face ?? [];
  const livenessFails = config.livenessRequired
    ? faces.filter((f) => !isTimeout(f) && !f.live).length
    : 0;
  if (livenessFails >= config.livenessFailsToReject) {
    checks.liveness = 'fail';
    return reject('liveness-failed');
  }

  // Row 3 (device part): a device hand check always goes to a person.
  if (input.deviceHandCheck) {
    return { status: 'under-review', path: 'hand-check', reason: 'device-hand-check', next: 'wait', checks };
  }

  // Row 1: KRA fast path.
  const kra = input.kra;
  if (kra === undefined) {
    return { status: current, path: null, reason: 'in-progress', next: 'kra-lookup', checks };
  }
  if (isTimeout(kra)) {
    return {
      status: 'under-review', path: null, reason: 'partner-timeout', next: 'wait', checks, unclear: ['kra'],
    };
  }
  if (kra.status === 'validated') {
    checks['kra-name'] = kra.name === undefined ? 'fail' : nameMatches(input.typed.firstName, input.typed.lastName, kra.name);
    checks['kra-dob'] = dobMatches(input.typed.dob, kra.dob) ? 'pass' : 'fail';
    if (checks['kra-name'] === 'pass' && checks['kra-dob'] === 'pass') {
      return { status: 'verified', path: 'kra-validated', reason: 'kra-validated', next: 'none', checks };
    }
    // not a clean match: the full KYC decides (registered / on-hold / not-found also land here)
  }

  // Row 2 / row 3: full KYC.
  const steps: { step: NextStep; results: [CheckName, CheckResult | null][] }[] = [];
  const a = input.aadhaar;
  steps.push({ step: 'aadhaar', results: [['aadhaar', a === undefined ? null : isTimeout(a) ? 'unclear' : 'pass']] });
  const p = input.pan;
  steps.push({
    step: 'pan-check',
    results:
      p === undefined
        ? [['pan', null]]
        : isTimeout(p)
          ? [['pan', 'unclear']]
          : [
              ['pan', 'pass'],
              ['pan-name', p.nameMatch ? 'pass' : 'unclear'],
              ['pan-aadhaar-link', p.aadhaarLinked ? 'pass' : 'unclear'],
            ],
  });
  steps.push({ step: 'selfie', results: faceResults(faces, config) });
  const e = input.esign;
  steps.push({ step: 'esign', results: [['esign', e === 'done' ? 'pass' : isTimeout(e) ? 'unclear' : null]] });

  // Unclear only because a partner call timed out (not a real doubt about the person).
  const timedOut = new Set<CheckName>();
  if (isTimeout(a)) timedOut.add('aadhaar');
  if (isTimeout(p)) timedOut.add('pan');
  if (isTimeout(faces[faces.length - 1])) timedOut.add('face-match');
  if (isTimeout(e)) timedOut.add('esign');

  const unclear: CheckName[] = [];
  let next: NextStep | null = null;
  for (const s of steps) {
    for (const [name, r] of s.results) {
      if (r === null) next ??= s.step;
      else {
        checks[name] = r;
        if (r === 'unclear') unclear.push(name);
      }
    }
  }
  if (unclear.length > 0) {
    const reason: ReasonCode = unclear.every((n) => timedOut.has(n)) ? 'partner-timeout' : 'check-unclear';
    return { status: 'under-review', path: 'full-kyc', reason, next: 'wait', checks, unclear };
  }
  if (next !== null) {
    return { status: current, path: 'full-kyc', reason: 'in-progress', next, checks };
  }
  return { status: 'verified', path: 'full-kyc', reason: 'full-kyc-passed', next: 'kra-upload', checks };
}

/** Face match + liveness from the latest attempt; null = not done / retry allowed. */
function faceResults(
  faces: readonly ({ match: number; live: boolean } | Timeout)[],
  config: KycConfig,
): [CheckName, CheckResult | null][] {
  const last = faces[faces.length - 1];
  if (last === undefined) return [['face-match', null]];
  if (isTimeout(last)) return [['face-match', 'unclear']];
  if (config.livenessRequired && !last.live) return [['liveness', null]]; // one fail: retake the selfie
  const live: [CheckName, CheckResult | null][] = config.livenessRequired ? [['liveness', 'pass']] : [];
  return [...live, ['face-match', last.match >= config.faceMatchMin ? 'pass' : 'unclear']];
}

export type StaffAction =
  | { kind: 'approve'; staffId: string; note?: string }
  | { kind: 'reject'; staffId: string; reason: string };

/** Design §5 row 5: staff Approve → verified, Reject (reason required) → rejected. Caller writes the audit row. */
export function staffDecide(current: { status: KycStatus; path: KycPath | null }, action: StaffAction): Decision {
  const to: KycStatus = action.kind === 'approve' ? 'verified' : 'rejected';
  if (!canStaffTransition(current.status, to)) {
    throw new KycTransitionError(current.status, 'staff-action', `staff can only decide an under-review case (is ${current.status})`);
  }
  if (action.staffId.trim() === '') throw new KycTransitionError(current.status, to, 'staff id is required');
  const path = current.path ?? 'hand-check';
  if (action.kind === 'reject') {
    const reason = action.reason.trim();
    if (reason === '') throw new KycTransitionError(current.status, to, 'a reject needs a reason');
    return { status: 'rejected', path, reason: 'staff-rejected', next: 'none', checks: {}, note: reason };
  }
  const note = action.note?.trim();
  return {
    status: 'verified', path, reason: 'staff-approved', next: 'kra-upload', checks: {},
    ...(note ? { note } : {}),
  };
}
