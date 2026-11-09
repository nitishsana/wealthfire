// Pure: applies one parsed partner event to a stored case (design §5). Merges the result into the
// case evidence, runs decide() for KYC results and e-sign, and returns the new case. No I/O.
//
// Ordering: each check keeps the partner event time (`occurredAt`) of the result it holds; an
// older result arriving later is ignored. Face attempts are kept in event-time order.
import { canSystemTransition, decide, type DecideInput } from '../decide';
import type { KycConfig } from '../config';
import type { KycCase } from '../types';
import type { PartnerEvent } from './events';
import type { CaseEvidence, CaseSnapshot, EvidenceKey, FaceAttempt, WebhookAction, WebhookOutcome } from './ports';

export type ApplyResult =
  | { kind: 'applied'; after: KycCase; evidence: CaseEvidence; check?: string }
  | { kind: 'ignored'; outcome: Exclude<WebhookOutcome, 'applied' | 'ignored-unknown-case'>; check?: string };

const TERMINAL = new Set(['verified', 'rejected']);

export function actionFor(e: PartnerEvent): WebhookAction {
  return e.type === 'kyc.result' ? 'webhook.kyc-result' : e.type === 'esign.completed' ? 'webhook.esign' : 'webhook.kra-upload';
}

export function snapshot(c: KycCase): CaseSnapshot {
  return { status: c.status, path: c.path, reason: c.reason, version: c.version };
}

type RefKey = keyof KycCase['partnerRefs'];

function refKeyFor(e: PartnerEvent): RefKey | undefined {
  if (e.type === 'esign.completed') return 'esign';
  if (e.type === 'kra.upload') return 'kraUpload';
  if (e.data.check === 'kra') return 'kra';
  if (e.data.check === 'aadhaar') return 'aadhaar';
  return undefined;
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

  // KRA upload only follows a verified case; everything else stops at a terminal case.
  if (e.type === 'kra.upload') {
    if (before.status !== 'verified') return { kind: 'ignored', outcome: 'ignored-not-verified' };
  } else if (TERMINAL.has(before.status)) {
    return { kind: 'ignored', outcome: 'ignored-terminal', ...withCheck };
  }

  // A result for a different partner session (e.g. an abandoned e-sign) is not this case's.
  const refKey = refKeyFor(e);
  const storedRef = refKey ? before.partnerRefs[refKey] : undefined;
  if (refKey && e.ref !== undefined && storedRef !== undefined && storedRef !== e.ref) {
    return { kind: 'ignored', outcome: 'ignored-ref-mismatch', ...withCheck };
  }

  const evKey = evidenceKeyFor(e);
  const seenAt = evKey ? evidenceIn.eventTs?.[evKey] : undefined;
  if (evKey && seenAt !== undefined && e.occurredAt < seenAt) {
    return { kind: 'ignored', outcome: 'ignored-stale', ...withCheck };
  }

  const evidence: CaseEvidence = structuredClone(evidenceIn);
  if (evKey) evidence.eventTs = { ...(evidence.eventTs ?? {}), [evKey]: e.occurredAt };
  const partnerRefs = { ...before.partnerRefs, ...(refKey && e.ref !== undefined ? { [refKey]: e.ref } : {}) };
  const base: KycCase = { ...before, partnerRefs, updatedAt: new Date(now).toISOString(), version: before.version + 1 };

  if (e.type === 'kra.upload') {
    evidence.kraUpload = { status: e.data.status };
    return { kind: 'applied', after: base, evidence };
  }

  if (e.type === 'esign.completed') {
    evidence.esign = e.data.status === 'done' ? 'done' : e.data.status === 'timeout' ? 'timeout' : 'pending';
  } else {
    mergeKycResult(evidence, e);
  }

  const { faceTs: _f, kraUpload: _k, eventTs: _e, aadhaarFailed, ...rest } = evidence;
  const input: DecideInput = { ...rest, current: before.status, currentReason: before.reason };
  let d = decide(input, config);
  // decide() has no "eKYC failed" input: a failed Aadhaar eKYC is a real doubt (not a timeout), so
  // unless a clear fail already rejects, a person must look at it.
  if (aadhaarFailed && d.status !== 'rejected') {
    d = {
      ...d, status: 'under-review', path: d.path ?? 'full-kyc', reason: 'check-unclear', next: 'wait',
      checks: { ...d.checks, aadhaar: 'unclear' },
    };
  }
  const status = canSystemTransition(before.status, d.status, before.reason) ? d.status : before.status;
  const after: KycCase = {
    ...base,
    status,
    path: d.path ?? before.path,
    reason: status === d.status ? d.reason : before.reason,
    checks: d.checks,
  };
  return { kind: 'applied', after, evidence, ...withCheck };
}
