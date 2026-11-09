// Partner webhook envelope (design §3 "signed callbacks: KYC result, e-sign done, KRA upload
// status"). The partner's real wire format is only known after sandbox access, so the
// FintechPrimitivesPartner adapter (wave 5) maps its payloads to this normalised envelope:
//
//   { id, type, timestamp, occurredAt?, userId, ref?, data }
//
//   id          partner event id, unique per event (replay / duplicate key)
//   timestamp   when this delivery was sent (epoch ms or ISO); must be within 5 minutes of now
//   occurredAt  when the result happened (ordering of out-of-order events); default `timestamp`
//   userId      our user id, passed to the partner when the check was started
//   ref         partner reference of the session the result belongs to (optional)
//
// Parsing is strict: anything unexpected is malformed (400). Values are never logged.
import type { KraStatus } from '../types';
import type { KraUploadStatus } from './ports';

export type KycCheck = 'kra' | 'aadhaar' | 'pan' | 'face';

export type KycResultData =
  | { check: 'kra'; timeout: true }
  | { check: 'kra'; timeout?: false; status: KraStatus; name?: string; dob?: string }
  | { check: 'aadhaar'; timeout: true }
  | { check: 'aadhaar'; timeout?: false; verified: boolean; last4?: string }
  | { check: 'pan'; timeout: true }
  | { check: 'pan'; timeout?: false; valid: boolean; nameMatch: boolean; aadhaarLinked: boolean }
  | { check: 'face'; timeout: true }
  | { check: 'face'; timeout?: false; match: number; live: boolean };

export type EsignStatus = 'done' | 'failed' | 'expired' | 'timeout';

interface EventBase {
  id: string;
  /** epoch ms */
  timestamp: number;
  /** epoch ms */
  occurredAt: number;
  userId: string;
  ref?: string;
}

export type PartnerEvent =
  | (EventBase & { type: 'kyc.result'; data: KycResultData })
  | (EventBase & { type: 'esign.completed'; data: { status: EsignStatus } })
  | (EventBase & { type: 'kra.upload'; data: { status: KraUploadStatus } });

export type PartnerEventType = PartnerEvent['type'];

export class MalformedEventError extends Error {
  constructor(readonly field: string) {
    super(`malformed webhook event: ${field}`);
    this.name = 'MalformedEventError';
  }
}

/** Largest body accepted (bytes of the UTF-8 string). Partner callbacks are small. */
export const MAX_BODY_BYTES = 64 * 1024;

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const KRA_STATUSES: readonly KraStatus[] = ['validated', 'registered', 'on-hold', 'not-found'];
const ESIGN_STATUSES: readonly EsignStatus[] = ['done', 'failed', 'expired', 'timeout'];
const UPLOAD_STATUSES: readonly KraUploadStatus[] = ['pending', 'uploaded', 'rejected'];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(field: string): never {
  throw new MalformedEventError(field);
}

function id(v: unknown, field: string): string {
  return typeof v === 'string' && ID_RE.test(v) ? v : fail(field);
}

function time(v: unknown, field: string): number {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && v.length <= 40) {
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return fail(field);
}

function bool(v: unknown, field: string): boolean {
  return typeof v === 'boolean' ? v : fail(field);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fail(field);
}

function optText(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' && v.length <= max ? v : fail(field);
}

function kycResult(d: Obj): KycResultData {
  const check = oneOf<KycCheck>(d.check, ['kra', 'aadhaar', 'pan', 'face'], 'data.check');
  if (d.timeout !== undefined && d.timeout !== false) {
    if (d.timeout !== true) fail('data.timeout');
    return { check, timeout: true };
  }
  switch (check) {
    case 'kra': {
      const name = optText(d.name, 'data.name', 200);
      const dob = optText(d.dob, 'data.dob', 40);
      return {
        check,
        status: oneOf(d.status, KRA_STATUSES, 'data.status'),
        ...(name !== undefined ? { name } : {}),
        ...(dob !== undefined ? { dob } : {}),
      };
    }
    case 'aadhaar': {
      const verified = bool(d.verified, 'data.verified');
      if (!verified) return { check, verified };
      const last4 = typeof d.last4 === 'string' && /^\d{4}$/.test(d.last4) ? d.last4 : fail('data.last4');
      return { check, verified, last4 };
    }
    case 'pan':
      return {
        check,
        valid: bool(d.valid, 'data.valid'),
        nameMatch: bool(d.nameMatch, 'data.nameMatch'),
        aadhaarLinked: bool(d.aadhaarLinked, 'data.aadhaarLinked'),
      };
    case 'face': {
      const match = typeof d.match === 'number' && d.match >= 0 && d.match <= 1 ? d.match : fail('data.match');
      return { check, match, live: bool(d.live, 'data.live') };
    }
  }
}

/** Parses the raw (already signature-checked) body. Throws MalformedEventError. */
export function parseEvent(body: string): PartnerEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return fail('json');
  }
  if (!isObj(raw)) return fail('body');
  if (!isObj(raw.data)) return fail('data');
  const timestamp = time(raw.timestamp, 'timestamp');
  const ref = raw.ref === undefined || raw.ref === null ? undefined : id(raw.ref, 'ref');
  const base: EventBase = {
    id: id(raw.id, 'id'),
    timestamp,
    occurredAt: raw.occurredAt === undefined || raw.occurredAt === null ? timestamp : time(raw.occurredAt, 'occurredAt'),
    userId: id(raw.userId, 'userId'),
    ...(ref !== undefined ? { ref } : {}),
  };
  const type = oneOf<PartnerEventType>(raw.type, ['kyc.result', 'esign.completed', 'kra.upload'], 'type');
  const d = raw.data;
  switch (type) {
    case 'kyc.result':
      return { ...base, type, data: kycResult(d) };
    case 'esign.completed':
      return { ...base, type, data: { status: oneOf(d.status, ESIGN_STATUSES, 'data.status') } };
    case 'kra.upload':
      return { ...base, type, data: { status: oneOf(d.status, UPLOAD_STATUSES, 'data.status') } };
  }
}
