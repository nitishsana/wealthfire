// Pure: applies one parsed partner event to a stored case (design §5). Merges the result into the
// case evidence, runs decide() for KYC results and e-sign, and returns the new case. No I/O.
//
// Ordering: each check keeps the partner event time (`occurredAt`) of the result it holds; an
// older result arriving later is ignored. Face attempts are kept in event-time order.
import { canSystemTransition } from '../decide';
import type { KycConfig } from '../config';
import { decideFromEvidence } from '../store/evidence';
import { snapshotOf } from '../store/types';
import type { CheckName, KycCase, NextStep } from '../types';
import type { PartnerEvent } from './events';
import type { CaseEvidence, CaseSnapshot, EvidenceKey, FaceAttempt, WebhookAction, WebhookOutcome } from './ports';

export type ApplyResult =
  | { kind: 'applied'; after: KycCase; evidence: CaseEvidence; next?: NextStep; unclear?: CheckName[]; check?: string }
  | { kind: 'ignored'; outcome: Exclude<WebhookOutcome, 'applied' | 'ignored-unknown-case'>; check?: string };

const TERMINAL = new Set(['verified', 'rejected']);

export function actionFor(e: PartnerEvent): WebhookAction {
  return e.type === 'kyc.result' ? 'webhook.kyc-result' : e.type === 'esign.completed' ? 'webhook.esign' : 'webhook.kra-upload';
}

export function snapshot(c: KycCase): CaseSnapshot {
  return snapshotOf(c);
}

type RefKey = keyof KycCase['partnerRefs'];

function refKeyFor(e: PartnerEvent): RefKey | undefined {
  if (e.type === 'esign.completed') return 'esign';
  if (e.type === 'kra.upload') return 'kraUpload';
  if (e.data.check === 'kra') return 'kra';
  if (e.data.check === 'aadhaar') return 'aadhaar';
  return undefined;
}

/** S17: the event's ref must equal the ref this case stored for the step (both present). */
export function refMatches(stored: string | undefined, given: string | undefined): boolean {
  return typeof stored === 'string' && stored !== '' && typeof given === 'string' && stored === given;
}

/** E-sign result on a staff-approved (verified) case: record it; 'done' makes the KRA upload due. */
function applyEsignAfterApprove(
  before: KycCase,
  evidenceIn: CaseEvidence,
  e: Extract<PartnerEvent, { type: 'esign.completed' }>,
  now: number,
): ApplyResult {
  const seenAt = evidenceIn.eventTs?.esign;
  if (seenAt !== undefined && e.occurredAt < seenAt) return { kind: 'ignored', outcome: 'ignored-stale' };
  const evidence: CaseEvidence = structuredClone(evidenceIn);
  evidence.eventTs = { ...(evidence.eventTs ?? {}), esign: e.occurredAt };
  const done = e.data.status === 'done';
  evidence.esign = done ? 'done' : e.data.status === 'timeout' ? 'timeout' : 'pending';
  const after: KycCase = {
    ...before,
    checks: done ? { ...before.checks, esign: 'pass' } : before.checks,
    updatedAt: new Date(now).toISOString(),
    version: before.version + 1,
  };
  // 'kra-upload' is run by GET /kyc/status (KycService.advance); until then the user redoes e-sign.
  return { kind: 'applied', after, evidence, next: done ? 'kra-upload' : 'esign' };
}

function evidenceKeyFor(e: PartnerEvent): EvidenceKey | undefined {
  if (e.type === 'esign.completed') return 'esign';
  if (e.type === 'kra.upload') return 'kra-upload';
  return e.data.check === 'face' ? undefined : e.data.check;
}

/** Inserts a face attempt in event-time order (stable for equal times). */
function insertFace(ev: CaseEvidence, at: number, attempt: FaceAttempt): void {
  const face = [...(ev.face ?? [])];
  const ts = face.map((_, i) => ev.faceTs?.[i] ?? 0);
  let i = ts.length;
  while (i > 0 && (ts[i - 1] ?? 0) > at) i--;
  face.splice(i, 0, attempt);
  ts.splice(i, 0, at);
  ev.face = face;
  ev.faceTs = ts;
}

function mergeKycResult(ev: CaseEvidence, e: Extract<PartnerEvent, { type: 'kyc.result' }>): void {
  const d = e.data;
  switch (d.check) {
    case 'kra':
      ev.kra = d.timeout ? 'timeout' : { status: d.status, ...(d.name !== undefined ? { name: d.name } : {}), ...(d.dob !== undefined ? { dob: d.dob } : {}) };
      return;
    case 'aadhaar':
      // A failed eKYC is not a clear reject in design §5 (only a last-4 mismatch is): it is held as
      // `aadhaarFailed` and sends the case to a person (see applyEvent).
      if (d.timeout) {
        ev.aadhaar = 'timeout';
        delete ev.aadhaarFailed;
      } else if (!d.verified) {
        delete ev.aadhaar;
        ev.aadhaarFailed = true;
      } else {
        ev.aadhaar = { verified: true, last4: d.last4 ?? '' };
        delete ev.aadhaarFailed;
      }
      return;
    case 'pan':
      ev.pan = d.timeout ? 'timeout' : { valid: d.valid, nameMatch: d.nameMatch, aadhaarLinked: d.aadhaarLinked };
      return;
    case 'face':
      insertFace(ev, e.occurredAt, d.timeout ? 'timeout' : { match: d.match, live: d.live });
      return;
  }
}

export function applyEvent(
  before: KycCase,
  evidenceIn: CaseEvidence,
  e: PartnerEvent,
  config: KycConfig,
  now: number,
): ApplyResult {
  const check = e.type === 'kyc.result' ? e.data.check : undefined;
  const withCheck = check !== undefined ? { check } : {};

  // KRA upload only follows a verified case; e-sign may follow a staff Approve (R1); everything
  // else stops at a terminal case.
  if (e.type === 'kra.upload') {
    if (before.status !== 'verified') return { kind: 'ignored', outcome: 'ignored-not-verified' };
  } else if (e.type === 'esign.completed' && before.status === 'verified') {
    if (evidenceIn.esign === 'done' || before.partnerRefs.kraUpload) {
      return { kind: 'ignored', outcome: 'ignored-terminal' };
    }
  } else if (TERMINAL.has(before.status)) {
    return { kind: 'ignored', outcome: 'ignored-terminal', ...withCheck };
  }

  // S17: an event for a ref-bound step (KRA lookup, Aadhaar, e-sign, KRA upload) must carry the
  // partner ref this case stored when it started that step. A missing ref, a case with no stored
  // ref (e.g. a late KRA result after the lookup timed out) or a different session's ref is
  // refused: audited + logged as 'ignored-ref-mismatch', and the case stays as it is (an
  // under-review case stays with staff). PAN and face results have no ref of their own.
  const refKey = refKeyFor(e);
  const storedRef = refKey ? before.partnerRefs[refKey] : undefined;
  if (refKey && !refMatches(storedRef, e.ref)) {
    return { kind: 'ignored', outcome: 'ignored-ref-mismatch', ...withCheck };
  }

  // R1: a staff-approved case that was never e-signed waits as verified with next 'esign'. Its
  // e-sign result only records the signature and moves the case on to its KRA upload; it is
  // never re-decided (staff already decided it).
  if (e.type === 'esign.completed' && before.status === 'verified') {
    return applyEsignAfterApprove(before, evidenceIn, e, now);
  }

  const evKey = evidenceKeyFor(e);
  const seenAt = evKey ? evidenceIn.eventTs?.[evKey] : undefined;
  if (evKey && seenAt !== undefined && e.occurredAt < seenAt) {
    return { kind: 'ignored', outcome: 'ignored-stale', ...withCheck };
  }

  const evidence: CaseEvidence = structuredClone(evidenceIn);
  if (evKey) evidence.eventTs = { ...(evidence.eventTs ?? {}), [evKey]: e.occurredAt };
  // refs are set by the KYC routes when a step starts; the webhook only checks them (S17)
  const base: KycCase = { ...before, partnerRefs: { ...before.partnerRefs }, updatedAt: new Date(now).toISOString(), version: before.version + 1 };

  if (e.type === 'kra.upload') {
    evidence.kraUpload = { status: e.data.status };
    return { kind: 'applied', after: base, evidence };
  }

  if (e.type === 'esign.completed') {
    evidence.esign = e.data.status === 'done' ? 'done' : e.data.status === 'timeout' ? 'timeout' : 'pending';
  } else {
    mergeKycResult(evidence, e);
  }

  // Same decision the KYC routes make (incl. the "Aadhaar eKYC failed" → person rule).
  const d = decideFromEvidence(evidence, before.status, before.reason, config);
  const status = canSystemTransition(before.status, d.status, before.reason) ? d.status : before.status;
  const after: KycCase = {
    ...base,
    status,
    path: d.path ?? before.path,
    reason: status === d.status ? d.reason : before.reason,
    checks: d.checks,
  };
  // `next` is stored so a case verified here still gets its KRA upload ('kra-upload').
  const decided = status === d.status;
  return {
    kind: 'applied', after, evidence,
    ...(decided ? { next: d.next, unclear: d.unclear ?? [] } : {}),
    ...withCheck,
  };
}
