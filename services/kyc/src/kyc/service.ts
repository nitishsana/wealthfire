// Final KYC flow (design §3–5, R2, R3, R6, R7). Every status change goes through decide();
// paid partner calls are capped per user per day and logged in `costs`; requests that trigger a
// paid call need an Idempotency-Key and replay the stored result on a retry.
//
// Steps: start (KRA lookup) → aadhaar (DigiLocker / OTP; result arrives by webhook →
// recordAadhaar) → pan-check (automatic) → selfie (upload + face match) → esign (result by webhook →
// recordEsign) → verified → KRA upload (automatic).
//
// Wave 4:
//   R1  hand-check and pan-in-use cases still run the KRA lookup and PAN check (for the reviewer);
//       the KRA upload runs only after e-sign, so a staff Approve without e-sign sets next 'esign'.
//   R3  POST /kyc/retry re-runs a timed-out partner step (or says which user step to redo);
//       GET /kyc/status re-runs a timed-out system step at most once per 10 minutes.
//   R7  18+ on the date of birth (same rule as packages/core validateDob).
//   R9  a start that fails after claiming the PAN releases the claim.
//   S2  consent records: every paid partner call needs a prior consent for its purpose; withdraw
//       stops the case ('consent-withdrawn'); a new consent afterwards starts a NEW case;
//       DELETE /kyc/data deletes what the retention rule does not keep.
//   S11 /kyc/documents signings capped at 9 a day; uploads start tagged `pending` and are tagged
//       `linked` once a case references them.
//   S14 an upload's magic bytes must match its declared type before it is used.
//   S18 idempotency rows expire after 24 h.
//
// Never stored: the full Aadhaar number. The PAN is stored only encrypted plus an HMAC lookup key.
import { randomUUID } from 'node:crypto';
import { DOB_MESSAGES, normalizePan, validateDob } from '@wealthfire/core';
import type { KycConfig } from '../config';
import type { Clock } from '../lib/clock';
import { allowedReturnUrl, DEFAULT_RETURN_URL_PREFIXES as LIB_RETURN_URL_PREFIXES } from '../lib/returnUrl';
import { decideFromEvidence } from '../store/evidence';
import { hmacLookup, sha256, type Encryptor, type MacSigner } from '../lib/crypto';
import { isIndividualPan, parseDob } from '../match';
import { isPartnerTimeout, type KycPartner, type PaidCheck } from '../partner/types';
import type { CheckName, CheckResult, KycPath, KycStatus, NextStep, ReasonCode } from '../types';
import { KycError } from './errors';
import {
  CONSENT_PURPOSES, IDEMPOTENCY_TTL_SEC, consentSk, parseConsentSk,
  type CaseSnapshot, type ConsentAction, type ConsentPurpose, type DocumentKind, type KycAuditRow, type KycCaseRecord, type KycEvidence,
  type KycRepos,
} from './repo';
import { checkUploadContent, type UploadSigner } from './uploads';

/** Placeholder ₹ per paid check until partner pricing is known (design §8). */
export const DEFAULT_CHECK_COSTS: Readonly<Record<PaidCheck, number>> = Object.freeze({
  'kra-lookup': 2,
  aadhaar: 5,
  'pan-verify': 1,
  'face-match': 3,
  esign: 10,
  'kra-upload': 5,
});

/** Tries per partner call before it counts as a timeout (placeholder: the first call + one retry). */
export const DEFAULT_PARTNER_ATTEMPTS = 2;

/** Return-URL allow-list default (src/lib/returnUrl.ts; no loopback, R10). */
export const DEFAULT_RETURN_URL_PREFIXES: readonly string[] = LIB_RETURN_URL_PREFIXES;

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_URL_TTL_SEC = 300;
export const DEFAULT_DOCS_PREFIX = 'kyc/';
/** S11: presigned document uploads per user per day (3 full sets). */
export const MAX_SIGNINGS_PER_DAY = 9;
/** R3: GET /kyc/status re-runs a timed-out system step at most this often. */
export const AUTO_RETRY_MS = 10 * 60_000;
/** F9: GET /kyc/status auto-retries at most this many times per India day, one partner attempt each. */
export const MAX_AUTO_RETRIES_PER_DAY = 3;
/**
 * S2: the consent each paid partner call needs. The KRA lookup has no purpose of its own in the
 * contract; it uses the PAN, so it needs 'pan-check' (see QUESTIONS in the wave-4 report).
 * The Aadhaar step needs 'digilocker' or 'aadhaar-otp' by mode.
 */
export const CHECK_CONSENT: Readonly<Record<Exclude<PaidCheck, 'aadhaar'>, ConsentPurpose>> = Object.freeze({
  'kra-lookup': 'pan-check',
  'pan-verify': 'pan-check',
  'face-match': 'face-match',
  esign: 'esign',
  'kra-upload': 'kra-upload',
});
const SAVE_RETRIES = 3;
const IST_OFFSET_MS = 330 * 60_000;
const IP_HASH_CACHE_MAX = 256;

const DOC_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
const DOC_KINDS = ['selfie', 'aadhaar', 'pan'] as const satisfies readonly DocumentKind[];
const PAN_SHAPE = /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/;
const UPLOAD_ID = /^(selfie|aadhaar|pan)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf)$/;
const SELFIE_ID = /^selfie-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/;
const IDEM_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const TERMINAL: ReadonlySet<KycStatus> = new Set(['verified', 'rejected']);
/** Under-review reasons that wait for staff but still get the KRA lookup + PAN check run (R1). */
const STAFF_PRECHECK: ReadonlySet<ReasonCode> = new Set(['device-hand-check', 'pan-in-use']);

export interface KycServiceDeps {
  repos: KycRepos;
  partner: KycPartner;
  uploads: UploadSigner;
  encryptor: Encryptor;
  mac: MacSigner;
  clock: Clock;
  config: KycConfig;
  /** allowed prefixes for DigiLocker / e-sign return URLs (default DEFAULT_RETURN_URL_PREFIXES) */
  returnUrlPrefixes?: readonly string[];
  costs?: Partial<Record<PaidCheck, number>>;
  /** tries per partner call before it counts as a timeout (default DEFAULT_PARTNER_ATTEMPTS) */
  partnerAttempts?: number;
  /** S3 key prefix (default 'kyc/', the prefix the api Lambda may write) */
  docsPrefix?: string;
  newId?: () => string;
}

export interface StartInput {
  firstName: string;
  lastName: string;
  dob: string;
  pan: string;
  aadhaarLast4: string;
  deviceResult: 'pre-verified' | 'under-review';
}

/** What the app sees. Masks only. */
export interface StatusView {
  status: KycStatus | null;
  path: KycPath | null;
  reason: ReasonCode | null;
  next: NextStep | 'start';
  eligibleToInvest: boolean;
  masks?: { pan: string; aadhaar: string };
  checks?: Partial<Record<CheckName, CheckResult>>;
  unclear?: CheckName[];
  /** S11: document kinds the case already holds (uploaded, content checked, tagged linked) */
  documents?: DocumentKind[];
  /** S14: kinds whose latest upload was refused (content did not match its type): upload again */
  rejectedDocuments?: DocumentKind[];
  updatedAt?: string;
}

/** POST /kyc/retry: the status, plus the user step to redo when the timed-out step is the user's. */
export type RetryView = StatusView & { redo?: 'aadhaar' | 'selfie' | 'esign' };

export type AadhaarResult = { verified: true; last4: string } | 'timeout';
export type EsignResult = 'done' | 'timeout';

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

// ---------- input helpers ----------

function str(v: unknown, max: number): string {
  if (typeof v !== 'string') throw new KycError('bad_request');
  const t = v.trim();
  if (t.length === 0 || t.length > max) throw new KycError('bad_request');
  return t;
}

function name(v: unknown): string {
  const t = str(v, 100);
  if (!/[A-Za-z]/.test(t)) throw new KycError('bad_request');
  return t;
}

export function parseStartInput(b: Record<string, unknown>): StartInput {
  const dob = str(b.dob, 10);
  if (parseDob(dob) === null) throw new KycError('bad_request');
  const pan = normalizePan(str(b.pan, 10));
  if (!PAN_SHAPE.test(pan)) throw new KycError('bad_request');
  const aadhaarLast4 = str(b.aadhaarLast4, 4);
  if (!/^\d{4}$/.test(aadhaarLast4)) throw new KycError('bad_request');
  const deviceResult = b.deviceResult;
  if (deviceResult !== 'pre-verified' && deviceResult !== 'under-review') throw new KycError('bad_request');
  return { firstName: name(b.firstName), lastName: name(b.lastName), dob, pan, aadhaarLast4, deviceResult };
}

/** Today's calendar date in India as a local Date (what packages/core validateDob reads). */
export function istToday(nowMs: number): Date {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  return new Date(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
}

/** R7: the same date-of-birth rule as the apps (packages/core validateDob, MIN_INVEST_AGE), on India's date. */
export function assertAdult(dob: string, nowMs: number): void {
  const err = validateDob(dob, istToday(nowMs));
  if (err === DOB_MESSAGES.minor) throw new KycError('under_age');
  if (err !== null) throw new KycError('bad_request');
}

export function parsePurpose(v: unknown): ConsentPurpose {
  if (typeof v !== 'string' || !(CONSENT_PURPOSES as readonly string[]).includes(v)) throw new KycError('bad_request');
  return v as ConsentPurpose;
}

/**
 * S2 (Nitish, final): after a withdrawal, a new consent (POST /kyc/consent) or a new POST
 * /kyc/start starts a NEW case; the old case stays 'consent-withdrawn' (archived), and status
 * shows next 'start'. Kept in this one function so the rule is easy to change.
 */
export function newConsentStartsNewCase(rec: KycCaseRecord): boolean {
  return rec.status === 'rejected' && rec.reason === 'consent-withdrawn';
}

/**
 * DELETE /kyc/data retention rule (placeholder until the compliance adviser sets it): a verified
 * case is a KYC record the regulator expects kept, so its outcome, masks, refs and documents stay;
 * anything else is deleted.
 */
export function retainsKycRecord(rec: KycCaseRecord): boolean {
  return rec.status === 'verified';
}

/**
 * Clears what a case holds beyond its outcome: the encrypted PAN, the typed name / date of birth,
 * the partner name / DOB results and the Aadhaar last 4 the user typed; drops pending signings.
 * Kept: masks, refs, checks, the device / PAN-type flags and the e-sign state.
 */
function minimise(w: KycCaseRecord): void {
  w.panEnc = '';
  w.evidence = {
    typed: { firstName: '', lastName: '', dob: '' },
    deviceHandCheck: w.evidence.deviceHandCheck,
    panIndividual: w.evidence.panIndividual,
    otpAadhaarLast4: '',
    ...(w.evidence.esign !== undefined ? { esign: w.evidence.esign } : {}),
  };
  delete w.pendingUploads;
}

/** True when minimise() (plus dropping the document links) would change nothing. */
function isMinimised(r: KycCaseRecord): boolean {
  return r.panEnc === '' && r.evidence.typed.firstName === '' && r.evidence.typed.dob === '' && r.evidence.otpAadhaarLast4 === ''
    && r.evidence.kra === undefined && r.evidence.pan === undefined && r.evidence.aadhaar === undefined && r.evidence.face === undefined
    && !r.pendingUploads?.length && !r.documents;
}

const panMask = (last4: string): string => `XXXXXX${last4}`;
const aadhaarMask = (last4: string): string => `XXXX XXXX ${last4}`;

/** The step a verified case still waits for (R1: e-sign before the KRA upload), else null. */
function verifiedFollowUp(rec: KycCaseRecord): 'esign' | 'kra-upload' | null {
  if (rec.status !== 'verified' || rec.partnerRefs.kraUpload) return null;
  return rec.next === 'esign' || rec.next === 'kra-upload' ? rec.next : null;
}

export function statusView(rec: KycCaseRecord | null): StatusView {
  if (!rec) return { status: null, path: null, reason: null, next: 'start', eligibleToInvest: false };
  const held = DOC_KINDS.filter((k) => rec.documents?.[k]?.state === 'linked');
  const refused = DOC_KINDS.filter((k) => rec.documents?.[k]?.state === 'rejected');
  const followUp = verifiedFollowUp(rec);
  return {
    status: rec.status,
    path: rec.path,
    reason: rec.reason,
    // a decided case has nothing left for the user, except an e-sign / KRA upload after a verify;
    // after a consent withdrawal the user may start a NEW case
    next: newConsentStartsNewCase(rec) ? 'start' : TERMINAL.has(rec.status) ? followUp ?? 'none' : rec.next,
    // a staff-approved case is not ready to invest until the KYC form is e-signed (R1)
    eligibleToInvest: rec.status === 'verified' && followUp !== 'esign',
    masks: { pan: rec.masks.pan, aadhaar: rec.masks.aadhaar },
    checks: { ...rec.checks },
    ...(rec.unclear && rec.unclear.length > 0 ? { unclear: [...rec.unclear] } : {}),
    documents: held,
    ...(refused.length > 0 ? { rejectedDocuments: refused } : {}),
    updatedAt: rec.updatedAt,
  };
}

function snapshot(c: KycCaseRecord | null): CaseSnapshot | null {
  return c ? { status: c.status, path: c.path, reason: c.reason, version: c.version } : null;
}

const isTimeout = (v: unknown): v is 'timeout' => v === 'timeout';
const kindOf = (uploadId: string): DocumentKind => uploadId.slice(0, uploadId.indexOf('-')) as DocumentKind;

/** Audit action of a KYC-route system write. */
type KycAction = `kyc.${string}`;

interface PaidOptions {
  /** the case the consent must belong to (default: the live case; start passes its new case's id) */
  caseId?: string;
  /** partner tries (default and maximum: the service's partnerAttempts; F9 auto-retries use 1) */
  attempts?: number;
}

// ---------- service ----------

export class KycService {
  private readonly attempts: number;
  private readonly prefix: string;
  private readonly newId: () => string;
  private readonly ipHashes = new Map<string, string>();

  constructor(private readonly deps: KycServiceDeps) {
    this.attempts = Math.max(1, deps.partnerAttempts ?? DEFAULT_PARTNER_ATTEMPTS);
    this.prefix = deps.docsPrefix ?? DEFAULT_DOCS_PREFIX;
    this.newId = deps.newId ?? randomUUID;
  }

  private now(): number {
    return this.deps.clock.now();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // ----- idempotency -----

  /**
   * Runs `fn` once per (user, route, Idempotency-Key). A retry with the same key and body gets the
   * stored result; the same key with another body is refused; a request still running is 409.
   * Records expire after 24 h (S18).
   */
  async idempotent(
    userId: string, route: string, key: string | undefined, body: unknown, fn: () => Promise<ApiResult>,
  ): Promise<ApiResult & { replayed?: boolean }> {
    if (typeof key !== 'string' || key.trim() === '') throw new KycError('missing_idempotency_key');
    if (!IDEM_KEY.test(key)) throw new KycError('bad_request');
    const { idempotency } = this.deps.repos;
    const id = sha256(`${userId}\u0000${route}\u0000${key}`);
    // Keyed hash: the body can hold a PAN.
    const requestHash = await hmacLookup(this.deps.mac, 'idem-body', typeof body === 'string' ? body : JSON.stringify(body ?? null));
    const now = this.now();
    const nowSec = Math.floor(now / 1000);
    const existing = await idempotency.get(id, nowSec);
    if (existing) return this.replay(existing, requestHash);
    const rec = { id, requestHash, state: 'pending' as const, createdAt: now, expiresAt: nowSec + IDEMPOTENCY_TTL_SEC };
    if (!(await idempotency.claim(rec, nowSec))) {
      const again = await idempotency.get(id, nowSec);
      if (again) return this.replay(again, requestHash);
      throw new KycError('in_progress');
    }
    try {
      const res = await fn();
      await idempotency.complete(id, res);
      return res;
    } catch (e) {
      await idempotency.release(id);
      throw e;
    }
  }

  private replay(
    rec: { requestHash: string; state: string; response?: ApiResult }, requestHash: string,
  ): ApiResult & { replayed: true } {
    if (rec.requestHash !== requestHash) throw new KycError('idempotency_mismatch');
    if (rec.state !== 'done' || !rec.response) throw new KycError('in_progress');
    return { ...rec.response, replayed: true };
  }

  // ----- consent (S2) -----

  // ----- IP (S#14) -----

  /** hmacLookup('ip', ip): consent and audit rows never hold the raw IP. Cached per container. */
  private async ipHash(ip?: string): Promise<string | undefined> {
    if (typeof ip !== 'string' || ip === '') return undefined;
    const hit = this.ipHashes.get(ip);
    if (hit !== undefined) return hit;
    const h = await hmacLookup(this.deps.mac, 'ip', ip);
    if (this.ipHashes.size >= IP_HASH_CACHE_MAX) this.ipHashes.clear();
    this.ipHashes.set(ip, h);
    return h;
  }

  /** A system audit row (ts = ISO time + nonce; the caller's IP only as its keyed hash). */
  private async auditRow(
    userId: string, action: KycAction, before: CaseSnapshot | null, after: CaseSnapshot | null, ip?: string,
  ): Promise<KycAuditRow> {
    const ipHash = await this.ipHash(ip);
    return { userId, ts: `${this.iso()}#${this.newId()}`, actor: 'system', action, before, after, ...(ipHash ? { ipHash } : {}) };
  }

  // ----- consent (S2, S#11) -----

  /**
   * True when the newest consent row for this purpose is 'given' and belongs to this case: a row
   * bound to another case (S#11) never counts. `caseId` defaults to the user's live case.
   */
  async hasConsent(userId: string, purpose: ConsentPurpose, caseId?: string): Promise<boolean> {
    const row = await this.deps.repos.consents.latest(userId, purpose);
    if (row?.action !== 'given') return false;
    const live = caseId ?? (await this.deps.repos.cases.get(userId))?.caseId;
    return row.caseId === undefined || live === undefined || row.caseId === live;
  }

  /**
   * Appends one consent row. S#11: the sort key `<purpose>#<iso>#<seq>` is monotonic per (user,
   * purpose): same millisecond (or a clock behind the newest row) -> the newest row's time with the
   * next seq; a taken key (a parallel write) is retried.
   */
  private async recordConsent(
    userId: string, purpose: ConsentPurpose, action: ConsentAction, ip?: string, caseId?: string,
  ): Promise<string> {
    const { consents } = this.deps.repos;
    const ipHash = await this.ipHash(ip);
    for (let i = 0; i < SAVE_RETRIES + 2; i++) {
      const prev = await consents.latest(userId, purpose);
      let at = this.iso();
      let seq = 0;
      if (prev) {
        const p = parseConsentSk(prev.sk);
        if (at < p.at) at = p.at;
        if (at === p.at) seq = p.seq + 1;
      }
      const ok = await consents.record({
        userId, sk: consentSk(purpose, at, seq), purpose, action, at, ...(caseId ? { caseId } : {}), ...(ipHash ? { ipHash } : {}),
      });
      if (ok) return at;
    }
    throw new KycError('conflict');
  }

  /**
   * S#11: a case was archived or deleted: every purpose still 'given' gets a 'case-closed' row, so
   * a NEW case needs fresh consent rows.
   */
  private async closeConsents(userId: string, caseId: string | undefined, ip?: string): Promise<void> {
    for (const purpose of CONSENT_PURPOSES) {
      if ((await this.deps.repos.consents.latest(userId, purpose))?.action === 'given') {
        await this.recordConsent(userId, purpose, 'case-closed', ip, caseId);
      }
    }
  }

  /**
   * POST /kyc/consent: records a consent (bound to the live case, S#11). After a withdrawal the old
   * case is archived FIRST, so this consent is the first one of the new case.
   */
  async giveConsent(userId: string, b: Record<string, unknown>, ip?: string): Promise<Record<string, unknown>> {
    const purpose = parsePurpose(b.purpose);
    let rec = await this.deps.repos.cases.get(userId);
    if (rec && newConsentStartsNewCase(rec)) {
      await this.archiveCase(rec, ip);
      rec = null;
    }
    const at = await this.recordConsent(userId, purpose, 'given', ip, rec?.caseId);
    return { purpose, consent: 'given', at, kyc: statusView(await this.read(userId)) };
  }

  /**
   * POST /kyc/consent/withdraw: records the withdrawal.
   * - A case the retention rule does not keep (anything but verified) is stopped if still open
   *   ('consent-withdrawn'), its documents under `kyc/<userId>/` are deleted and its encrypted PAN
   *   and typed details blanked (S#5). Withdrawing again repeats the delete (safe).
   * - A verified case keeps its KYC (F3): the withdrawal is recorded, and a follow-up it still
   *   waits for (e-sign / KRA upload) needs that consent, so it waits.
   */
  async withdrawConsent(userId: string, b: Record<string, unknown>, ip?: string): Promise<Record<string, unknown>> {
    const purpose = parsePurpose(b.purpose);
    let rec = await this.deps.repos.cases.get(userId);
    const at = await this.recordConsent(userId, purpose, 'withdrawn', ip, rec?.caseId);
    if (rec && !retainsKycRecord(rec)) {
      if (!TERMINAL.has(rec.status) || !isMinimised(rec)) {
        rec = await this.commit(userId, 'kyc.consent-withdrawn', (w) => {
          if (retainsKycRecord(w)) throw new KycError('conflict'); // verified meanwhile: keep it
          if (!TERMINAL.has(w.status)) {
            w.status = 'rejected';
            w.reason = 'consent-withdrawn';
            w.next = 'none';
            delete w.unclear;
          }
          minimise(w);
          delete w.documents;
        }, { ip, redecide: false });
      }
      await this.deps.uploads.deletePrefix(`${this.prefix}${userId}/`);
    }
    return { purpose, consent: 'withdrawn', at, kyc: statusView(rec) };
  }

  /** Moves a stopped case aside so the user can start a new one; frees its PAN claim; closes its consents (S#11). */
  private async archiveCase(rec: KycCaseRecord, ip?: string): Promise<void> {
    const at = this.iso();
    const audit = await this.auditRow(rec.userId, 'kyc.case-archived', snapshot(rec), null, ip);
    if (!(await this.deps.repos.cases.archive(rec.userId, rec.version, at, audit))) throw new KycError('conflict');
    await this.deps.repos.cases.releasePan(rec.panHash, rec.userId);
    await this.closeConsents(rec.userId, rec.caseId, ip);
  }

  /**
   * DELETE /kyc/data: deletes the user's documents (S3 `kyc/<userId>/`), case data and archived
   * cases (`arch#<userId>#*`), except what the retention rule keeps (retainsKycRecord), and says
   * why each kept item is kept. A verified case keeps only the documents it references (S#5).
   * Consent rows are never deleted (append-only proof). Audited.
   */
  async deleteData(userId: string, ip?: string): Promise<Record<string, unknown>> {
    let rec = await this.deps.repos.cases.get(userId);
    const kept: { what: string; reason: string }[] = [
      { what: 'consent-records', reason: 'Proof of the consents you gave and withdrew.' },
      { what: 'audit-log', reason: 'Record of every change to your KYC (no ID numbers or documents).' },
      { what: 'paid-check-costs', reason: 'Billing record of partner checks (no ID numbers).' },
    ];
    const prefix = `${this.prefix}${userId}/`;
    let documents = 0;
    let caseResult: 'deleted' | 'minimised' | 'none' = 'none';
    if (rec && retainsKycRecord(rec)) {
      kept.push({
        what: 'kyc-record',
        reason: 'Your verified KYC result, masked numbers and documents are kept for the regulatory retention period.',
      });
      // F1: uploads of this verified case that were never linked are its KYC documents too
      if (rec.pendingUploads?.length) await this.linkPendingUploads(userId);
      rec = await this.commit(userId, 'kyc.data-minimised', (w) => minimise(w), { ip, redecide: false });
      const keep = new Set<string>();
      for (const k of DOC_KINDS) {
        const d = rec.documents?.[k];
        if (d?.state === 'linked') keep.add(this.docKey(userId, d.uploadId));
      }
      documents = await this.deps.uploads.deletePrefix(prefix, keep);
      caseResult = 'minimised';
    } else {
      documents = await this.deps.uploads.deletePrefix(prefix);
      if (rec) {
        const audit = await this.auditRow(userId, 'kyc.data-deleted', snapshot(rec), null, ip);
        if (!(await this.deps.repos.cases.remove(userId, rec.version, audit))) throw new KycError('conflict');
        await this.deps.repos.cases.releasePan(rec.panHash, userId);
        caseResult = 'deleted';
      } else {
        await this.deps.repos.audit.write(await this.auditRow(userId, 'kyc.data-deleted', null, null, ip));
      }
      await this.closeConsents(userId, rec?.caseId, ip);
    }
    const archived = await this.deps.repos.cases.removeArchived(userId);
    return { deleted: { documents, case: caseResult, archived }, kept };
  }

  // ----- paid calls -----

  private day(): { day: string; month: string; at: string } {
    const now = this.now();
    const ist = new Date(now + IST_OFFSET_MS).toISOString();
    return { day: ist.slice(0, 10), month: ist.slice(0, 7), at: new Date(now).toISOString() };
  }

  /**
   * Calls the partner with retries. Needs a prior consent for `purpose` (S2), else
   * 'consent-required'. EVERY paid partner call counts against the user's daily cap (R7): user
   * steps, system follow-ups (PAN check, KRA upload) and each retry. No call is made past the cap:
   * before the first try that is `limit_reached`; before a retry the call ends as 'timeout' (a
   * later retry continues it). Every attempt is logged in `costs`.
   */
  private async paid<T>(
    userId: string, check: PaidCheck, purpose: ConsentPurpose, fn: () => Promise<T>, opts: PaidOptions = {},
  ): Promise<T | 'timeout'> {
    if (!(await this.hasConsent(userId, purpose, opts.caseId))) throw new KycError('consent-required');
    const { costs } = this.deps.repos;
    const { day, month, at } = this.day();
    const costInr = this.deps.costs?.[check] ?? DEFAULT_CHECK_COSTS[check];
    const attempts = Math.max(1, Math.min(opts.attempts ?? this.attempts, this.attempts));
    for (let i = 0; i < attempts; i++) {
      if (!(await costs.reserve(userId, day, this.deps.config.maxPaidChecksPerDay))) {
        if (i === 0) throw new KycError('limit_reached');
        return 'timeout';
      }
      await costs.record({ month, checkId: this.newId(), check, costInr, userId, at });
      try {
        return await fn();
      } catch (e) {
        if (!isPartnerTimeout(e)) throw new KycError('partner_unavailable');
      }
    }
    return 'timeout';
  }

  // ----- case writes -----

  private async load(userId: string): Promise<KycCaseRecord> {
    const rec = await this.read(userId);
    if (!rec) throw new KycError('not_found');
    return rec;
  }

  /**
   * Reads a case and re-derives `next` / `unclear` from its evidence (status and reason are kept
   * as stored). The webhook updates evidence and status but not `next`.
   */
  private async read(userId: string): Promise<KycCaseRecord | null> {
    const rec = await this.deps.repos.cases.get(userId);
    if (!rec || TERMINAL.has(rec.status)) return rec;
    const d = this.decided(rec, rec);
    rec.next = d.next;
    if (d.unclear) rec.unclear = d.unclear;
    return rec;
  }

  /** Re-decides `rec` (status, path, reason, next, checks) from its evidence. */
  private decided(before: KycCaseRecord | null, rec: KycCaseRecord): KycCaseRecord {
    // Same evidence reading as the webhook (src/store/evidence.ts).
    const d = decideFromEvidence(rec.evidence, rec.status, before ? before.reason : null, this.deps.config);
    const out: KycCaseRecord = {
      ...rec,
      status: d.status,
      path: d.path ?? rec.path,
      reason: d.reason,
      next: d.next,
      checks: d.checks,
    };
    if (d.unclear && d.unclear.length > 0) out.unclear = d.unclear;
    else delete out.unclear;
    return out;
  }

  private audit(before: KycCaseRecord | null, after: KycCaseRecord, action: KycAction, ip?: string): Promise<KycAuditRow> {
    return this.auditRow(after.userId, action, snapshot(before), snapshot(after), ip);
  }

  /**
   * Optimistic update: reload, apply `mutate` (which may throw if the step is no longer open),
   * re-decide unless `redecide` is false, save with version + 1 and an audit row. Retries on a
   * concurrent change.
   */
  private async commit(
    userId: string, action: KycAction, mutate: (rec: KycCaseRecord) => void, opts: { ip?: string; redecide?: boolean } = {},
  ): Promise<KycCaseRecord> {
    for (let i = 0; i < SAVE_RETRIES; i++) {
      const before = await this.load(userId);
      if (TERMINAL.has(before.status) && opts.redecide !== false) throw new KycError('decided');
      const work = structuredClone(before);
      mutate(work);
      const after = opts.redecide === false ? work : this.decided(before, work);
      after.version = before.version + 1;
      after.updatedAt = this.iso();
      if (await this.deps.repos.cases.save(after, before.version, await this.audit(before, after, action, opts.ip))) return after;
    }
    throw new KycError('conflict');
  }

  /** A user step is open: it is `next`, or it is being retried after its own partner timeout. */
  private stepOpen(rec: KycCaseRecord, step: NextStep, timedOut: boolean): boolean {
    if (TERMINAL.has(rec.status)) return false;
    return rec.next === step || (rec.reason === 'partner-timeout' && timedOut);
  }

  private assertReturnUrl(v: unknown): string {
    const url = allowedReturnUrl(v, this.deps.returnUrlPrefixes ?? DEFAULT_RETURN_URL_PREFIXES);
    if (url === null) throw new KycError('bad_request');
    return url;
  }

  private async pan(rec: KycCaseRecord): Promise<string> {
    return this.deps.encryptor.decrypt(rec.panEnc, { purpose: 'pan', userId: rec.userId });
  }

  /**
   * A system follow-up's paid call. Past the daily cap or without its consent it is deferred
   * (null): the step stays as `next` and GET /kyc/status runs it later, so the user's own step
   * still succeeds.
   */
  private async systemPaid<T>(
    userId: string, check: PaidCheck, purpose: ConsentPurpose, fn: () => Promise<T>, opts: PaidOptions = {},
  ): Promise<T | 'timeout' | null> {
    try {
      return await this.paid(userId, check, purpose, fn, opts);
    } catch (e) {
      if (e instanceof KycError && (e.code === 'limit_reached' || e.code === 'consent-required')) return null;
      throw e;
    }
  }

  /** True when the case waits for its KRA upload: verified, e-signed (R1), not uploaded yet. */
  private kraUploadDue(rec: KycCaseRecord): boolean {
    return rec.status === 'verified' && rec.next === 'kra-upload' && !rec.partnerRefs.kraUpload && rec.evidence.esign === 'done';
  }

  /**
   * System follow-ups after a change: PAN check when it is next; e-sign gate; KRA upload once
   * verified. Any case that is not rejected (open, under review OR verified, F1) gets its uploaded
   * documents linked (tagged `state=linked`) first, so the 1-day `pending` lifecycle never deletes
   * documents staff or the retention rule need.
   */
  private async advance(userId: string): Promise<KycCaseRecord> {
    const first = await this.load(userId);
    if (first.status !== 'rejected' && first.pendingUploads?.length) await this.linkPendingUploads(userId);
    let rec = await this.load(userId);
    if (rec.next === 'pan-check' && !TERMINAL.has(rec.status)) {
      const pan = await this.pan(rec);
      const r = await this.systemPaid(userId, 'pan-verify', CHECK_CONSENT['pan-verify'], () =>
        this.deps.partner.verifyPan(pan, `${rec.evidence.typed.firstName} ${rec.evidence.typed.lastName}`));
      if (r === null) return rec;
      rec = await this.commit(userId, 'kyc.pan-check', (w) => {
        if (w.next !== 'pan-check') throw new KycError('conflict');
        w.evidence.pan = r;
      });
    }
    // R1: a verified case uploads to the KRA only after e-sign; without it the next step is 'esign'.
    const followUp = verifiedFollowUp(rec);
    if (followUp !== null) {
      const want = rec.evidence.esign === 'done' ? 'kra-upload' : 'esign';
      if (want !== followUp) {
        try {
          rec = await this.commit(userId, 'kyc.esign-gate', (w) => {
            if (verifiedFollowUp(w) !== followUp) throw new KycError('conflict');
            w.next = want;
          }, { redecide: false });
        } catch (e) {
          if (!(e instanceof KycError && e.code === 'conflict')) throw e;
          rec = await this.load(userId);
        }
      }
    }
    if (this.kraUploadDue(rec)) {
      const r = await this.systemPaid(userId, 'kra-upload', CHECK_CONSENT['kra-upload'], () => this.deps.partner.uploadToKra(userId));
      if (r !== null && !isTimeout(r)) {
        try {
          rec = await this.commit(userId, 'kyc.kra-upload', (w) => {
            // another run stored its upload first: keep that one
            if (!this.kraUploadDue(w)) throw new KycError('conflict');
            w.partnerRefs.kraUpload = r.ref;
            w.next = 'none';
          }, { redecide: false });
        } catch (e) {
          if (!(e instanceof KycError && e.code === 'conflict')) throw e;
          rec = await this.load(userId);
        }
      }
    }
    return rec;
  }

  /**
   * System action after a staff Approve (or any verified case still waiting for it): uploads the
   * KYC to the KRA once e-signed, audited as 'kyc.kra-upload'; not e-signed yet → next 'esign'.
   * Retry-safe: a no-op once the upload ref is stored; a timeout or the daily cap leaves the step
   * pending for GET /kyc/status to retry.
   */
  async uploadToKra(userId: string): Promise<StatusView> {
    return statusView(await this.advance(userId));
  }

  // ----- system re-runs (R1 pre-checks, R3 retries) -----

  /** Under review for a person, but still gets the KRA lookup + PAN check (R1). */
  private staffPrecheck(rec: KycCaseRecord): boolean {
    return rec.status === 'under-review' && rec.reason !== null && STAFF_PRECHECK.has(rec.reason);
  }

  private needsKra(rec: KycCaseRecord): boolean {
    return isTimeout(rec.evidence.kra) || (this.staffPrecheck(rec) && rec.evidence.kra === undefined);
  }

  private needsPan(rec: KycCaseRecord): boolean {
    return isTimeout(rec.evidence.pan) || (this.staffPrecheck(rec) && rec.evidence.pan === undefined && rec.evidence.panIndividual);
  }

  /**
   * Runs the KRA lookup and / or PAN check a case still needs (a timeout, or a staff pre-check).
   * 'user': a user request, so the cap / consent / partner errors reach the caller.
   * 'system': deferred quietly (cap, missing consent, partner down) for a later status read.
   * Returns true when at least one call was made.
   */
  private async rerunSystemChecks(userId: string, mode: 'user' | 'system', ip?: string, attempts?: number): Promise<boolean> {
    const opts: PaidOptions = attempts !== undefined ? { attempts } : {};
    const call = <T>(check: PaidCheck, fn: () => Promise<T>): Promise<T | 'timeout' | null> => {
      const purpose = CHECK_CONSENT[check as Exclude<PaidCheck, 'aadhaar'>];
      return mode === 'user' ? this.paid(userId, check, purpose, fn, opts) : this.systemPaid(userId, check, purpose, fn, opts);
    };
    let ran = false;
    try {
      let rec = await this.load(userId);
      if (!TERMINAL.has(rec.status) && this.needsKra(rec)) {
        const pan = await this.pan(rec);
        const r = await call('kra-lookup', () => this.deps.partner.lookupKyc(pan));
        if (r === null) return ran;
        ran = true;
        rec = await this.commit(userId, 'kyc.kra-retry', (w) => {
          if (!this.needsKra(w)) throw new KycError('conflict');
          if (!isTimeout(r)) w.partnerRefs.kra = r.ref;
          w.evidence.kra = isTimeout(r) ? r : { status: r.status, ...(r.name ? { name: r.name } : {}), ...(r.dob ? { dob: r.dob } : {}) };
        }, { ip });
      }
      if (!TERMINAL.has(rec.status) && this.needsPan(rec)) {
        const pan = await this.pan(rec);
        const r = await call('pan-verify', () =>
          this.deps.partner.verifyPan(pan, `${rec.evidence.typed.firstName} ${rec.evidence.typed.lastName}`));
        if (r === null) return ran;
        ran = true;
        await this.commit(userId, 'kyc.pan-retry', (w) => {
          if (!this.needsPan(w)) throw new KycError('conflict');
          w.evidence.pan = r;
        }, { ip });
      }
    } catch (e) {
      if (mode === 'user') throw e;
      // system: leave the step for the next status read (partner down, a concurrent change)
      if (!(e instanceof KycError)) throw e;
    }
    return ran;
  }

  /** Automatic retries already used on today's India day (F9). */
  private autoRetriesToday(rec: KycCaseRecord): number {
    return rec.autoRetries?.day === this.day().day ? rec.autoRetries.count : 0;
  }

  /**
   * R3 + F9: a timed-out (or still missing pre-check) system step that GET /kyc/status may re-run
   * now: at most once per 10 minutes and MAX_AUTO_RETRIES_PER_DAY times per India day.
   */
  private autoRetryDue(rec: KycCaseRecord): boolean {
    if (TERMINAL.has(rec.status)) return false;
    if (!this.needsKra(rec) && !this.needsPan(rec)) return false;
    if (this.autoRetriesToday(rec) >= MAX_AUTO_RETRIES_PER_DAY) return false;
    return this.now() - (rec.autoRetryAt ?? 0) >= AUTO_RETRY_MS;
  }

  private async autoRetry(userId: string): Promise<void> {
    try {
      // claim the 10-minute slot (and one of today's retries) first, so parallel reads never pay twice
      await this.commit(userId, 'kyc.auto-retry', (w) => {
        if (!this.autoRetryDue(w)) throw new KycError('conflict');
        w.autoRetryAt = this.now();
        w.autoRetries = { day: this.day().day, count: this.autoRetriesToday(w) + 1 };
      }, { redecide: false });
    } catch (e) {
      if (e instanceof KycError) return;
      throw e;
    }
    // F9: one partner attempt per automatic retry
    await this.rerunSystemChecks(userId, 'system', undefined, 1);
  }

  // ----- routes -----

  /**
   * POST /kyc/start: creates the case and runs the KRA lookup (R2); on a KRA / PAN timeout,
   * retries it. Hand-check and pan-in-use cases go to a person and also get the KRA lookup + PAN
   * check (R1). A start that fails after claiming the PAN releases the claim (R9).
   */
  async start(userId: string, input: StartInput, ip?: string): Promise<StatusView> {
    assertAdult(input.dob, this.now());
    const existing = await this.deps.repos.cases.get(userId);
    // S#11: a NEW case after a withdrawal needs fresh consent. A fresh POST /kyc/consent archives the
    // stopped case, so a stopped case still here means no consent was given since: refuse, and
    // leave the old case as it was.
    if (existing && newConsentStartsNewCase(existing)) throw new KycError('consent-required');
    if (existing) return this.retryStart(existing, ip);

    const { mac, encryptor } = this.deps;
    const now = this.iso();
    const panLast4 = input.pan.slice(-4);
    const draft: KycCaseRecord = {
      userId,
      status: input.deviceResult,
      path: null,
      masks: { pan: panMask(panLast4), aadhaar: aadhaarMask(input.aadhaarLast4) },
      partnerRefs: {},
      checks: {},
      reason: null,
      updatedAt: now,
      version: 1,
      createdAt: now,
      caseId: this.newId(),
      panEnc: await encryptor.encrypt(input.pan, { purpose: 'pan', userId }),
      panHash: await hmacLookup(mac, 'pan', input.pan),
      evidence: {
        typed: { firstName: input.firstName, lastName: input.lastName, dob: input.dob },
        deviceHandCheck: input.deviceResult === 'under-review',
        otpAadhaarLast4: input.aadhaarLast4,
        panIndividual: isIndividualPan(input.pan),
      },
      next: 'kra-lookup',
    };
    // A non-individual PAN is rejected without a paid call; a hand check goes to a person.
    let rec = this.decided(null, draft);
    let claimed = false;
    try {
      if (rec.status !== 'rejected') {
        // One PAN, one account: a PAN another account already holds goes to a person. The
        // response never says which account holds it.
        claimed = await this.deps.repos.cases.claimPan(draft.panHash, userId);
        if (!claimed) rec = { ...draft, status: 'under-review', path: null, reason: 'pan-in-use', next: 'wait', checks: {} };
      }
      if (rec.next === 'kra-lookup') {
        const r = await this.paid(userId, 'kra-lookup', CHECK_CONSENT['kra-lookup'], () => this.deps.partner.lookupKyc(input.pan), {
          caseId: draft.caseId,
        });
        if (!isTimeout(r)) draft.partnerRefs.kra = r.ref;
        draft.evidence.kra = isTimeout(r) ? r : { status: r.status, ...(r.name ? { name: r.name } : {}), ...(r.dob ? { dob: r.dob } : {}) };
        rec = this.decided(null, draft);
      }
      if (!(await this.deps.repos.cases.save(rec, 0, await this.audit(null, rec, 'kyc.start', ip)))) {
        claimed = false; // a parallel start saved this user's case: the claim is that case's
        throw new KycError('already_started');
      }
    } catch (e) {
      if (claimed && !(await this.deps.repos.cases.get(userId))) {
        await this.deps.repos.cases.releasePan(draft.panHash, userId);
      }
      throw e;
    }
    if (this.staffPrecheck(rec)) await this.rerunSystemChecks(userId, 'system', ip);
    return statusView(await this.advance(userId));
  }

  /** POST /kyc/start again: a partner-timeout case re-runs its timed-out system step. */
  private async retryStart(rec: KycCaseRecord, ip?: string): Promise<StatusView> {
    if (TERMINAL.has(rec.status)) throw new KycError('decided');
    if (rec.reason !== 'partner-timeout' || (!isTimeout(rec.evidence.kra) && !isTimeout(rec.evidence.pan))) {
      throw new KycError('already_started');
    }
    await this.rerunSystemChecks(rec.userId, 'user', ip);
    return statusView(await this.advance(rec.userId));
  }

  /**
   * POST /kyc/retry (R3): re-runs a timed-out KRA lookup / PAN check now (paid, counts toward the
   * daily cap); for a timed-out user step (Aadhaar, selfie, e-sign) it reopens nothing new but
   * says which step to redo (`redo`), which is open again because of the timeout.
   */
  async retry(userId: string, ip?: string): Promise<RetryView> {
    const rec = await this.load(userId);
    if (TERMINAL.has(rec.status)) throw new KycError('decided');
    const ev = rec.evidence;
    if (isTimeout(ev.kra) || isTimeout(ev.pan) || (this.staffPrecheck(rec) && (this.needsKra(rec) || this.needsPan(rec)))) {
      await this.rerunSystemChecks(userId, 'user', ip);
      return statusView(await this.advance(userId));
    }
    if (rec.reason !== 'partner-timeout') throw new KycError('wrong_step');
    const redo = isTimeout(ev.aadhaar) ? 'aadhaar' : isTimeout(ev.face?.[ev.face.length - 1]) ? 'selfie' : isTimeout(ev.esign) ? 'esign' : null;
    if (redo === null) throw new KycError('wrong_step');
    return { ...statusView(rec), redo };
  }

  /** POST /kyc/aadhaar: starts DigiLocker consent or Aadhaar OTP at the partner. */
  async startAadhaar(userId: string, b: Record<string, unknown>, ip?: string): Promise<Record<string, unknown>> {
    const mode = b.mode;
    if (mode !== 'digilocker' && mode !== 'otp') throw new KycError('bad_request');
    const returnUrl = this.assertReturnUrl(b.returnUrl);
    const rec = await this.load(userId);
    if (!this.stepOpen(rec, 'aadhaar', isTimeout(rec.evidence.aadhaar))) throw new KycError('wrong_step');
    const purpose: ConsentPurpose = mode === 'digilocker' ? 'digilocker' : 'aadhaar-otp';
    const r = await this.paid(userId, 'aadhaar', purpose, () => this.deps.partner.startAadhaar(userId, mode, returnUrl));
    if (isTimeout(r)) throw new KycError('partner_unavailable');
    const after = await this.commit(userId, 'kyc.aadhaar-start', (w) => {
      if (!this.stepOpen(w, 'aadhaar', isTimeout(w.evidence.aadhaar))) throw new KycError('wrong_step');
      if (r.challengeRef) w.partnerRefs.aadhaar = r.challengeRef;
      delete w.evidence.aadhaar; // a restart after a timeout clears the old result
    }, { ip });
    return {
      ...(r.redirectUrl ? { redirectUrl: r.redirectUrl } : {}),
      ...(r.challengeRef ? { challengeRef: r.challengeRef } : {}),
      kyc: statusView(after),
    };
  }

  /**
   * POST /kyc/documents: presigned PUT URLs (10 MB, JPG/PNG/PDF; selfie JPG/PNG), at most
   * MAX_SIGNINGS_PER_DAY per user per day (S11). Each upload starts tagged `state=pending`; the
   * case lists it until it is linked (GET /kyc/status, POST /kyc/selfie) or expires.
   */
  async documentUploads(userId: string, b: Record<string, unknown>): Promise<Record<string, unknown>> {
    const files = b.files;
    if (!Array.isArray(files) || files.length < 1 || files.length > DOC_KINDS.length) throw new KycError('bad_request');
    const rec = await this.load(userId);
    if (TERMINAL.has(rec.status)) throw new KycError('decided');
    const seen = new Set<string>();
    const parsed = files.map((f: unknown) => {
      if (typeof f !== 'object' || f === null) throw new KycError('bad_request');
      const { kind, contentType, size } = f as Record<string, unknown>;
      if (typeof kind !== 'string' || !(DOC_KINDS as readonly string[]).includes(kind) || seen.has(kind)) throw new KycError('bad_request');
      seen.add(kind);
      const ext = typeof contentType === 'string' ? DOC_TYPES[contentType] : undefined;
      if (!ext || (kind === 'selfie' && ext === 'pdf')) throw new KycError('bad_request');
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) throw new KycError('bad_request');
      return { kind: kind as DocumentKind, contentType: contentType as string, size, ext };
    });
    if (!(await this.deps.repos.costs.reserveSignings(userId, this.day().day, parsed.length, MAX_SIGNINGS_PER_DAY))) {
      throw new KycError('limit_reached');
    }
    const signedAt = this.now();
    const expiresAt = new Date(signedAt + UPLOAD_URL_TTL_SEC * 1000).toISOString();
    const uploads = await Promise.all(parsed.map(async (p) => {
      const uploadId = `${p.kind}-${this.newId()}.${p.ext}`;
      const signed = await this.deps.uploads.signPut({
        key: this.docKey(userId, uploadId), contentType: p.contentType, contentLength: p.size, expiresInSec: UPLOAD_URL_TTL_SEC,
      });
      return { kind: p.kind, uploadId, method: 'PUT', url: signed.url, headers: signed.headers, expiresAt, maxBytes: MAX_UPLOAD_BYTES };
    }));
    await this.commit(userId, 'kyc.documents-signed', (w) => {
      if (TERMINAL.has(w.status)) throw new KycError('decided');
      const add = uploads.map((u) => ({ uploadId: u.uploadId, signedAt }));
      w.pendingUploads = [...(w.pendingUploads ?? []), ...add].slice(-MAX_SIGNINGS_PER_DAY);
    }, { redecide: false });
    return { uploads };
  }

  /** S3 key for one of the user's uploads. */
  docKey(userId: string, uploadId: string): string {
    return `${this.prefix}${userId}/${uploadId}`;
  }

  /** Tags an upload `linked` and the one it replaces `pending` (so the lifecycle deletes the old one). */
  private async linkUpload(rec: KycCaseRecord, uploadId: string): Promise<void> {
    const kind = kindOf(uploadId);
    await this.deps.uploads.setState(this.docKey(rec.userId, uploadId), 'linked');
    const old = rec.documents?.[kind];
    if (old && old.state === 'linked' && old.uploadId !== uploadId) {
      await this.deps.uploads.setState(this.docKey(rec.userId, old.uploadId), 'pending');
    }
  }

  /**
   * S11 + S14: links the case's uploaded-but-pending documents. Each is checked (magic bytes vs its
   * type): a match is tagged `linked` and becomes the case's document of that kind; a mismatch is
   * marked 'rejected' and stays `pending` (deleted by the lifecycle). Expired, never-uploaded
   * signings are dropped. F1: runs for open, under-review AND verified cases (a verified case's
   * documents are the KYC record the retention rule keeps); never for a rejected case.
   */
  private async linkPendingUploads(userId: string): Promise<void> {
    const rec = await this.deps.repos.cases.get(userId);
    if (!rec || rec.status === 'rejected' || !rec.pendingUploads?.length) return;
    const done = new Set<string>();
    const set: Partial<Record<DocumentKind, { uploadId: string; state: 'linked' | 'rejected' }>> = {};
    for (const p of rec.pendingUploads) {
      if (!UPLOAD_ID.test(p.uploadId)) {
        done.add(p.uploadId);
        continue;
      }
      const res = await checkUploadContent(this.deps.uploads, this.docKey(userId, p.uploadId));
      if (res === 'missing') {
        if (this.now() > p.signedAt + (UPLOAD_URL_TTL_SEC + 60) * 1000) done.add(p.uploadId);
        continue;
      }
      done.add(p.uploadId);
      if (res === 'ok') {
        await this.linkUpload({ ...rec, documents: { ...rec.documents, ...set } }, p.uploadId);
        set[kindOf(p.uploadId)] = { uploadId: p.uploadId, state: 'linked' };
      } else {
        set[kindOf(p.uploadId)] = { uploadId: p.uploadId, state: 'rejected' };
      }
    }
    if (done.size === 0) return;
    try {
      await this.commit(userId, 'kyc.documents-linked', (w) => {
        w.pendingUploads = (w.pendingUploads ?? []).filter((p) => !done.has(p.uploadId));
        if (w.pendingUploads.length === 0) delete w.pendingUploads;
        if (Object.keys(set).length > 0) w.documents = { ...(w.documents ?? {}), ...set };
      }, { redecide: false });
    } catch (e) {
      if (!(e instanceof KycError)) throw e; // a concurrent change: the next status read links again
    }
  }

  /**
   * F2 hook for the review routes (ReviewDeps.linkDocuments): the link step above, run before staff
   * open or approve a case, so documents sent since the user's last status read count.
   */
  async linkDocuments(userId: string): Promise<void> {
    await this.linkPendingUploads(userId);
  }

  /** POST /kyc/selfie: face match + liveness of an uploaded selfie against the Aadhaar photo. */
  async submitSelfie(userId: string, b: Record<string, unknown>, ip?: string): Promise<StatusView> {
    const uploadId = str(b.uploadId, 80);
    if (!SELFIE_ID.test(uploadId)) throw new KycError('bad_request');
    const rec = await this.load(userId);
    const open = (r: KycCaseRecord) => this.stepOpen(r, 'selfie', isTimeout(r.evidence.face?.[r.evidence.face.length - 1]));
    if (!open(rec)) throw new KycError('wrong_step');
    const aadhaarRef = rec.partnerRefs.aadhaar;
    if (!aadhaarRef) throw new KycError('wrong_step');
    const key = this.docKey(userId, uploadId);
    const content = await checkUploadContent(this.deps.uploads, key);
    if (content === 'missing') throw new KycError('upload_missing');
    if (content === 'mismatch') throw new KycError('upload_rejected'); // S14: never sent to the partner
    const r = await this.paid(userId, 'face-match', CHECK_CONSENT['face-match'], () => this.deps.partner.faceMatch(key, aadhaarRef));
    await this.linkUpload(rec, uploadId);
    await this.commit(userId, 'kyc.selfie', (w) => {
      if (!open(w)) throw new KycError('wrong_step');
      w.evidence.face = [...(w.evidence.face ?? []), r];
      w.documents = { ...(w.documents ?? {}), selfie: { uploadId, state: 'linked' } };
      if (w.pendingUploads) {
        w.pendingUploads = w.pendingUploads.filter((p) => p.uploadId !== uploadId);
        if (w.pendingUploads.length === 0) delete w.pendingUploads;
      }
    }, { ip });
    return statusView(await this.advance(userId));
  }

  /** An e-sign the user may start: the `esign` step, its timeout retry, or after a staff Approve (R1). */
  private esignOpen(r: KycCaseRecord): boolean {
    return verifiedFollowUp(r) === 'esign' || this.stepOpen(r, 'esign', isTimeout(r.evidence.esign));
  }

  /** POST /kyc/esign: starts the partner e-sign; returns its redirect URL. */
  async startEsign(userId: string, b: Record<string, unknown>, ip?: string): Promise<Record<string, unknown>> {
    const returnUrl = this.assertReturnUrl(b.returnUrl);
    const rec = await this.load(userId);
    if (!this.esignOpen(rec)) throw new KycError('wrong_step');
    // F1: the e-sign result can verify the case by webhook; link the Aadhaar / PAN uploads now
    if (rec.pendingUploads?.length) await this.linkPendingUploads(userId);
    const r = await this.paid(userId, 'esign', CHECK_CONSENT.esign, () => this.deps.partner.startEsign(userId, returnUrl));
    if (isTimeout(r)) throw new KycError('partner_unavailable');
    const after = await this.commit(userId, 'kyc.esign-start', (w) => {
      if (!this.esignOpen(w)) throw new KycError('wrong_step');
      w.partnerRefs.esign = r.ref;
      w.evidence.esign = 'pending';
    }, { ip, redecide: rec.status !== 'verified' });
    return { redirectUrl: r.redirectUrl, kyc: statusView(after) };
  }

  /** GET /kyc/status */
  async status(userId: string): Promise<StatusView> {
    const rec = await this.read(userId);
    if (!rec) return statusView(null);
    if (TERMINAL.has(rec.status)) {
      // A staff Approve may still wait for e-sign or the KRA upload (retried here); a verified case
      // still links uploads that arrived before it was decided (F1).
      const more = verifiedFollowUp(rec) !== null || (rec.status === 'verified' && !!rec.pendingUploads?.length);
      return statusView(more ? await this.advance(userId) : rec);
    }
    if (this.autoRetryDue(rec)) await this.autoRetry(userId);
    if (rec.pendingUploads?.length) await this.linkPendingUploads(userId);
    // A webhook may have moved the case to a system step (PAN check, KRA upload): run it now.
    return statusView(await this.advance(userId));
  }

  // ----- partner results (called by the webhook handler) -----

  /** Aadhaar eKYC / DigiLocker result. Only the last 4 digits are accepted. */
  async recordAadhaar(userId: string, result: AadhaarResult): Promise<StatusView> {
    if (!isTimeout(result) && (result.verified !== true || !/^\d{4}$/.test(result.last4))) throw new KycError('bad_request');
    const value: AadhaarResult = isTimeout(result) ? result : { verified: true, last4: result.last4 };
    await this.commit(userId, 'kyc.aadhaar-result', (w) => {
      if (w.next !== 'aadhaar' || !w.partnerRefs.aadhaar) throw new KycError('wrong_step');
      w.evidence.aadhaar = value;
    });
    return statusView(await this.advance(userId));
  }

  /** E-sign result (also after a staff Approve, R1: 'done' makes the KRA upload due). */
  async recordEsign(userId: string, result: EsignResult): Promise<StatusView> {
    if (result !== 'done' && result !== 'timeout') throw new KycError('bad_request');
    const cur = await this.load(userId);
    if (cur.status === 'verified') {
      await this.commit(userId, 'kyc.esign-result', (w) => {
        if (verifiedFollowUp(w) !== 'esign' || w.evidence.esign !== 'pending') throw new KycError('wrong_step');
        w.evidence.esign = result;
        if (result === 'done') {
          w.checks = { ...w.checks, esign: 'pass' };
          w.next = 'kra-upload';
        }
      }, { redecide: false });
    } else {
      await this.commit(userId, 'kyc.esign-result', (w) => {
        if (w.next !== 'esign' || w.evidence.esign !== 'pending') throw new KycError('wrong_step');
        w.evidence.esign = result;
      });
    }
    return statusView(await this.advance(userId));
  }
}

export type { KycEvidence };
