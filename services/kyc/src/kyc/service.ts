// Final KYC flow (design §3–5, R2, R3, R6, R7). Every status change goes through decide();
// paid partner calls are capped per user per day and logged in `costs`; requests that trigger a
// paid call need an Idempotency-Key and replay the stored result on a retry.
//
// Steps: start (KRA lookup) → aadhaar (DigiLocker / OTP; result arrives by webhook →
// recordAadhaar) → pan-check (automatic) → selfie (upload + face match) → esign (result by webhook →
// recordEsign) → verified → KRA upload (automatic).
//
// Never stored: the full Aadhaar number. The PAN is stored only encrypted plus an HMAC lookup key.
import { randomUUID } from 'node:crypto';
import { normalizePan } from '@wealthfire/core';
import type { KycConfig } from '../config';
import type { Clock } from '../lib/clock';
import { decideFromEvidence } from '../store/evidence';
import { hmacLookup, sha256, type Encryptor, type MacSigner } from '../lib/crypto';
import { isIndividualPan, parseDob } from '../match';
import { isPartnerTimeout, type KycPartner, type PaidCheck } from '../partner/types';
import type { CheckName, CheckResult, KycPath, KycStatus, NextStep, ReasonCode } from '../types';
import { KycError } from './errors';
import type { CaseSnapshot, KycAuditRow, KycCaseRecord, KycEvidence, KycRepos } from './repo';
import type { UploadSigner } from './uploads';

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

/** Return-URL allow-list for DigiLocker / e-sign (placeholder until the app URLs are final). */
export const DEFAULT_RETURN_URL_PREFIXES: readonly string[] = Object.freeze([
  'https://nitishsana.github.io/wealthfire/',
  'http://127.0.0.1:5180/',
  'wealthfire://',
]);

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_URL_TTL_SEC = 300;
export const DEFAULT_DOCS_PREFIX = 'kyc/';
const SAVE_RETRIES = 3;
const IST_OFFSET_MS = 330 * 60_000;

const DOC_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
const DOC_KINDS = ['selfie', 'aadhaar', 'pan'] as const;
type DocKind = (typeof DOC_KINDS)[number];
const PAN_SHAPE = /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/;
const SELFIE_ID = /^selfie-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/;
const IDEM_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const TERMINAL: ReadonlySet<KycStatus> = new Set(['verified', 'rejected']);

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
  updatedAt?: string;
}

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

const panMask = (last4: string): string => `XXXXXX${last4}`;
const aadhaarMask = (last4: string): string => `XXXX XXXX ${last4}`;

export function statusView(rec: KycCaseRecord | null): StatusView {
  if (!rec) return { status: null, path: null, reason: null, next: 'start', eligibleToInvest: false };
  return {
    status: rec.status,
    path: rec.path,
    reason: rec.reason,
    // a staff decision keeps the stored `next` ('wait'); a decided case has nothing left for the user
    next: TERMINAL.has(rec.status) && rec.next !== 'kra-upload' ? 'none' : rec.next,
    eligibleToInvest: rec.status === 'verified',
    masks: { pan: rec.masks.pan, aadhaar: rec.masks.aadhaar },
    checks: { ...rec.checks },
    ...(rec.unclear && rec.unclear.length > 0 ? { unclear: [...rec.unclear] } : {}),
    updatedAt: rec.updatedAt,
  };
}

function snapshot(c: KycCaseRecord | null): CaseSnapshot | null {
  return c ? { status: c.status, path: c.path, reason: c.reason, version: c.version } : null;
}

const isTimeout = (v: unknown): v is 'timeout' => v === 'timeout';

/** Audit action of a KYC-route system write. */
type KycAction = `kyc.${string}`;

// ---------- service ----------

export class KycService {
  private readonly attempts: number;
  private readonly prefix: string;
  private readonly newId: () => string;

  constructor(private readonly deps: KycServiceDeps) {
    this.attempts = Math.max(1, deps.partnerAttempts ?? DEFAULT_PARTNER_ATTEMPTS);
    this.prefix = deps.docsPrefix ?? DEFAULT_DOCS_PREFIX;
    this.newId = deps.newId ?? randomUUID;
  }

  // ----- idempotency -----

  /**
   * Runs `fn` once per (user, route, Idempotency-Key). A retry with the same key and body gets the
   * stored result; the same key with another body is refused; a request still running is 409.
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
    const existing = await idempotency.get(id);
    if (existing) return this.replay(existing, requestHash);
    if (!(await idempotency.claim({ id, requestHash, state: 'pending', createdAt: this.deps.clock.now() }))) {
      const again = await idempotency.get(id);
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

  // ----- paid calls -----

  private day(): { day: string; month: string; at: string } {
    const now = this.deps.clock.now();
    const ist = new Date(now + IST_OFFSET_MS).toISOString();
    return { day: ist.slice(0, 10), month: ist.slice(0, 7), at: new Date(now).toISOString() };
  }

  /**
   * Calls the partner with retries. EVERY paid partner call counts against the user's daily cap
   * (R7): user steps, system follow-ups (PAN check, KRA upload) and each retry. No call is made
   * past the cap: before the first try that is `limit_reached`; before a retry the call ends as
   * 'timeout' (a later retry continues it). Every attempt is logged in `costs`.
   */
  private async paid<T>(userId: string, check: PaidCheck, fn: () => Promise<T>): Promise<T | 'timeout'> {
    const { costs } = this.deps.repos;
    const { day, month, at } = this.day();
    const costInr = this.deps.costs?.[check] ?? DEFAULT_CHECK_COSTS[check];
    for (let i = 0; i < this.attempts; i++) {
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

  private audit(before: KycCaseRecord | null, after: KycCaseRecord, action: KycAction, ip?: string): KycAuditRow {
    const ts = `${new Date(this.deps.clock.now()).toISOString()}#${this.newId()}`;
    return { userId: after.userId, ts, actor: 'system', action, before: snapshot(before), after: snapshot(after), ...(ip ? { ip } : {}) };
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
      after.updatedAt = new Date(this.deps.clock.now()).toISOString();
      if (await this.deps.repos.cases.save(after, before.version, this.audit(before, after, action, opts.ip))) return after;
    }
    throw new KycError('conflict');
  }

  /** A user step is open: it is `next`, or it is being retried after its own partner timeout. */
  private stepOpen(rec: KycCaseRecord, step: NextStep, timedOut: boolean): boolean {
    if (TERMINAL.has(rec.status)) return false;
    return rec.next === step || (rec.reason === 'partner-timeout' && timedOut);
  }

  private assertReturnUrl(v: unknown): string {
    const url = str(v, 500);
    try {
      new URL(url);
    } catch {
      throw new KycError('bad_request');
    }
    if (!(this.deps.returnUrlPrefixes ?? DEFAULT_RETURN_URL_PREFIXES).some((p) => url.startsWith(p))) throw new KycError('bad_request');
    return url;
  }

  private async pan(rec: KycCaseRecord): Promise<string> {
    return this.deps.encryptor.decrypt(rec.panEnc, { purpose: 'pan', userId: rec.userId });
  }

  /**
   * A system follow-up's paid call. Past the daily cap it is deferred (null): the step stays as
   * `next` and GET /kyc/status runs it on a later day, so the user's own step still succeeds.
   */
  private async systemPaid<T>(userId: string, check: PaidCheck, fn: () => Promise<T>): Promise<T | 'timeout' | null> {
    try {
      return await this.paid(userId, check, fn);
    } catch (e) {
      if (e instanceof KycError && e.code === 'limit_reached') return null;
      throw e;
    }
  }

  /** True when the case waits for its KRA upload (full-KYC verified or staff-approved). */
  private kraUploadDue(rec: KycCaseRecord): boolean {
    return rec.status === 'verified' && rec.next === 'kra-upload' && !rec.partnerRefs.kraUpload;
  }

  /** System follow-ups after a change: PAN check when it is next; KRA upload once verified. */
  private async advance(userId: string): Promise<KycCaseRecord> {
    let rec = await this.load(userId);
    if (rec.next === 'pan-check' && !TERMINAL.has(rec.status)) {
      const pan = await this.pan(rec);
      const r = await this.systemPaid(userId, 'pan-verify', () =>
        this.deps.partner.verifyPan(pan, `${rec.evidence.typed.firstName} ${rec.evidence.typed.lastName}`));
      if (r === null) return rec;
      rec = await this.commit(userId, 'kyc.pan-check', (w) => {
        if (w.next !== 'pan-check') throw new KycError('conflict');
        w.evidence.pan = r;
      });
    }
    if (this.kraUploadDue(rec)) {
      const r = await this.systemPaid(userId, 'kra-upload', () => this.deps.partner.uploadToKra(userId));
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
   * KYC to the KRA, audited as 'kyc.kra-upload'. Retry-safe: a no-op once the upload ref is stored;
   * a timeout or the daily cap leaves the step pending for GET /kyc/status to retry.
   */
  async uploadToKra(userId: string): Promise<StatusView> {
    return statusView(await this.advance(userId));
  }

  // ----- routes -----

  /** POST /kyc/start: creates the case and runs the KRA lookup (R2); on a KRA / PAN timeout, retries it. */
  async start(userId: string, input: StartInput, ip?: string): Promise<StatusView> {
    const existing = await this.deps.repos.cases.get(userId);
    if (existing) return this.retry(existing, ip);

    const { mac, encryptor } = this.deps;
    const now = new Date(this.deps.clock.now()).toISOString();
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
    // A hand check or a non-individual PAN is decided without paying for a lookup.
    let rec = this.decided(null, draft);
    // One PAN, one account: a PAN another account already holds goes to a person, with no paid
    // call. The response never says which account holds it.
    if (rec.status !== 'rejected' && !(await this.deps.repos.cases.claimPan(draft.panHash, userId))) {
      rec = { ...draft, status: 'under-review', path: null, reason: 'pan-in-use', next: 'wait', checks: {} };
      if (!(await this.deps.repos.cases.save(rec, 0, this.audit(null, rec, 'kyc.start', ip)))) {
        throw new KycError('already_started');
      }
      return statusView(rec);
    }
    if (rec.next === 'kra-lookup') {
      const r = await this.paid(userId, 'kra-lookup', () => this.deps.partner.lookupKyc(input.pan));
      if (!isTimeout(r)) draft.partnerRefs.kra = r.ref;
      draft.evidence.kra = isTimeout(r) ? r : { status: r.status, ...(r.name ? { name: r.name } : {}), ...(r.dob ? { dob: r.dob } : {}) };
      rec = this.decided(null, draft);
    }
    if (!(await this.deps.repos.cases.save(rec, 0, this.audit(null, rec, 'kyc.start', ip)))) {
      throw new KycError('already_started');
    }
    return statusView(await this.advance(userId));
  }

  private async retry(rec: KycCaseRecord, ip?: string): Promise<StatusView> {
    if (TERMINAL.has(rec.status)) throw new KycError('decided');
    if (rec.reason !== 'partner-timeout') throw new KycError('already_started');
    const userId = rec.userId;
    if (isTimeout(rec.evidence.kra)) {
      const pan = await this.pan(rec);
      const r = await this.paid(userId, 'kra-lookup', () => this.deps.partner.lookupKyc(pan));
      await this.commit(userId, 'kyc.kra-retry', (w) => {
        if (!isTimeout(w.evidence.kra)) throw new KycError('conflict');
        if (!isTimeout(r)) w.partnerRefs.kra = r.ref;
        w.evidence.kra = isTimeout(r) ? r : { status: r.status, ...(r.name ? { name: r.name } : {}), ...(r.dob ? { dob: r.dob } : {}) };
      }, { ip });
    } else if (isTimeout(rec.evidence.pan)) {
      const pan = await this.pan(rec);
      const r = await this.paid(userId, 'pan-verify', () =>
        this.deps.partner.verifyPan(pan, `${rec.evidence.typed.firstName} ${rec.evidence.typed.lastName}`));
      await this.commit(userId, 'kyc.pan-retry', (w) => {
        if (!isTimeout(w.evidence.pan)) throw new KycError('conflict');
        w.evidence.pan = r;
      }, { ip });
    } else {
      throw new KycError('already_started');
    }
    return statusView(await this.advance(userId));
  }

  /** POST /kyc/aadhaar: starts DigiLocker consent or Aadhaar OTP at the partner. */
  async startAadhaar(userId: string, b: Record<string, unknown>, ip?: string): Promise<Record<string, unknown>> {
    const mode = b.mode;
    if (mode !== 'digilocker' && mode !== 'otp') throw new KycError('bad_request');
    const returnUrl = this.assertReturnUrl(b.returnUrl);
    const rec = await this.load(userId);
    if (!this.stepOpen(rec, 'aadhaar', isTimeout(rec.evidence.aadhaar))) throw new KycError('wrong_step');
    const r = await this.paid(userId, 'aadhaar', () => this.deps.partner.startAadhaar(userId, mode, returnUrl));
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

  /** POST /kyc/documents: presigned PUT URLs (10 MB, JPG/PNG/PDF; selfie JPG/PNG). */
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
      return { kind: kind as DocKind, contentType: contentType as string, size, ext };
    });
    const expiresAt = new Date(this.deps.clock.now() + UPLOAD_URL_TTL_SEC * 1000).toISOString();
    const uploads = await Promise.all(parsed.map(async (p) => {
      const uploadId = `${p.kind}-${this.newId()}.${p.ext}`;
      const signed = await this.deps.uploads.signPut({
        key: this.docKey(userId, uploadId), contentType: p.contentType, contentLength: p.size, expiresInSec: UPLOAD_URL_TTL_SEC,
      });
      return { kind: p.kind, uploadId, method: 'PUT', url: signed.url, headers: signed.headers, expiresAt, maxBytes: MAX_UPLOAD_BYTES };
    }));
    return { uploads };
  }

  /** S3 key for one of the user's uploads. */
  docKey(userId: string, uploadId: string): string {
    return `${this.prefix}${userId}/${uploadId}`;
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
    if (!(await this.deps.uploads.exists(key))) throw new KycError('upload_missing');
    const r = await this.paid(userId, 'face-match', () => this.deps.partner.faceMatch(key, aadhaarRef));
    await this.commit(userId, 'kyc.selfie', (w) => {
      if (!open(w)) throw new KycError('wrong_step');
      w.evidence.face = [...(w.evidence.face ?? []), r];
    }, { ip });
    return statusView(await this.advance(userId));
  }

  /** POST /kyc/esign: starts the partner e-sign; returns its redirect URL. */
  async startEsign(userId: string, b: Record<string, unknown>, ip?: string): Promise<Record<string, unknown>> {
    const returnUrl = this.assertReturnUrl(b.returnUrl);
    const rec = await this.load(userId);
    const open = (r: KycCaseRecord) => this.stepOpen(r, 'esign', isTimeout(r.evidence.esign));
    if (!open(rec)) throw new KycError('wrong_step');
    const r = await this.paid(userId, 'esign', () => this.deps.partner.startEsign(userId, returnUrl));
    if (isTimeout(r)) throw new KycError('partner_unavailable');
    const after = await this.commit(userId, 'kyc.esign-start', (w) => {
      if (!open(w)) throw new KycError('wrong_step');
      w.partnerRefs.esign = r.ref;
      w.evidence.esign = 'pending';
    }, { ip });
    return { redirectUrl: r.redirectUrl, kyc: statusView(after) };
  }

  /** GET /kyc/status */
  async status(userId: string): Promise<StatusView> {
    const rec = await this.read(userId);
    // A webhook may have moved the case to a system step (PAN check, KRA upload): run it now.
    if (rec && (rec.next === 'pan-check' || (rec.status === 'verified' && rec.next === 'kra-upload' && !rec.partnerRefs.kraUpload))) {
      return statusView(await this.advance(userId));
    }
    return statusView(rec);
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

  /** E-sign result. */
  async recordEsign(userId: string, result: EsignResult): Promise<StatusView> {
    if (result !== 'done' && result !== 'timeout') throw new KycError('bad_request');
    await this.commit(userId, 'kyc.esign-result', (w) => {
      if (w.next !== 'esign' || w.evidence.esign !== 'pending') throw new KycError('wrong_step');
      w.evidence.esign = result;
    });
    return statusView(await this.advance(userId));
  }
}

export type { KycEvidence };
