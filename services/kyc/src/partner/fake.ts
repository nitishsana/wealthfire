// Deterministic, network-free KycPartner for tests and the dev stack before sandbox access.
//
// Scenario by PAN (digits 6–9 of the PAN, e.g. ABCPE0001F):
//   0001 kra-validated  KRA says validated with the registered person (default ASHA RAO, 1990-08-15)
//   0003 unclear        KRA not found; PAN name only partly matches (pan-name unclear)
//   0004 reject         KRA not found; PAN is invalid at the Income Tax database
//   0005 timeout        every KRA lookup times out
//   anything else       full-kyc-pass: KRA not found, every full-KYC check passes
// Test hooks: setScenario(panOrUserId, scenario) overrides the PAN rule; a userId set to
// 'unclear' gives a low face score (calls without a PAN are matched by userId), 'timeout' makes
// that user's calls time out. failNext(op, n) makes the next n calls of one operation time out.
// The fake keeps no PAN or Aadhaar number: scenarios are keyed by an internal hash.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PartnerTimeoutError, type KycPartner } from './types';

export type FakeScenario = 'kra-validated' | 'full-kyc-pass' | 'unclear' | 'reject' | 'timeout';

export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';
export const FAKE_LOW_FACE_SCORE = 0.5;
export const FAKE_GOOD_FACE_SCORE = 0.95;

type Op = keyof KycPartner;

const BY_DIGITS: Record<string, FakeScenario> = {
  '0001': 'kra-validated',
  '0003': 'unclear',
  '0004': 'reject',
  '0005': 'timeout',
};

const key = (v: string): string => createHash('sha256').update(v.trim().toUpperCase()).digest('hex');

export interface FakePartnerOptions {
  /** person the KRA returns for kra-validated PANs */
  person?: { name: string; dob: string };
  /** HMAC key for verifyWebhook */
  webhookSecret?: string;
  /** base of the fake redirect URLs */
  baseUrl?: string;
}

export class FakePartner implements KycPartner {
  readonly calls: Record<Op, number> = {
    lookupKyc: 0, startAadhaar: 0, verifyPan: 0, faceMatch: 0, startEsign: 0, uploadToKra: 0, verifyWebhook: 0,
  };
  private readonly overrides = new Map<string, FakeScenario>();
  private readonly people = new Map<string, { name: string; dob: string }>();
  private readonly failures = new Map<Op, number>();
  /** aadhaar / esign ref → userId */
  private readonly refOwner = new Map<string, string>();
  private seq = 0;
  private readonly person: { name: string; dob: string };
  private readonly secret: string;
  private readonly baseUrl: string;

  constructor(opts: FakePartnerOptions = {}) {
    this.person = opts.person ?? { name: 'ASHA RAO', dob: '1990-08-15' };
    this.secret = opts.webhookSecret ?? 'fake-webhook-secret';
    this.baseUrl = opts.baseUrl ?? 'https://fake-partner.invalid';
  }

  // ---------- test hooks ----------

  /** Override the scenario for a PAN or a userId. */
  setScenario(panOrUserId: string, scenario: FakeScenario): void {
    this.overrides.set(key(panOrUserId), scenario);
  }

  /** The KRA person for one PAN (kra-validated). */
  setPerson(pan: string, person: { name: string; dob: string }): void {
    this.people.set(key(pan), person);
  }

  /** The next `n` calls of `op` throw PartnerTimeoutError. */
  failNext(op: Op, n = 1): void {
    this.failures.set(op, (this.failures.get(op) ?? 0) + n);
  }

  /** Who a ref returned by startAadhaar / startEsign belongs to. */
  ownerOf(ref: string): string | undefined {
    return this.refOwner.get(ref);
  }

  /** Signature header for a webhook body. */
  sign(body: string): Record<string, string> {
    return { [FAKE_SIGNATURE_HEADER]: createHmac('sha256', this.secret).update(body).digest('hex') };
  }

  /** Scenario for a PAN: override first, then the digit rule. */
  scenarioForPan(pan: string): FakeScenario {
    const o = this.overrides.get(key(pan));
    if (o) return o;
    return BY_DIGITS[pan.trim().toUpperCase().slice(5, 9)] ?? 'full-kyc-pass';
  }

  private scenarioForUser(userId: string | undefined): FakeScenario {
    return (userId && this.overrides.get(key(userId))) || 'full-kyc-pass';
  }

  private enter(op: Op, scenario: FakeScenario = 'full-kyc-pass'): void {
    this.calls[op] += 1;
    const left = this.failures.get(op) ?? 0;
    if (left > 0) {
      this.failures.set(op, left - 1);
      throw new PartnerTimeoutError(op);
    }
    if (scenario === 'timeout') throw new PartnerTimeoutError(op);
  }

  private ref(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(6, '0')}`;
  }

  // ---------- KycPartner ----------

  async lookupKyc(pan: string): Promise<{ status: 'validated' | 'registered' | 'on-hold' | 'not-found'; name?: string; dob?: string; ref: string }> {
    const s = this.scenarioForPan(pan);
    this.enter('lookupKyc', s);
    const ref = this.ref('kra');
    if (s === 'kra-validated') {
      const p = this.people.get(key(pan)) ?? this.person;
      return { status: 'validated', name: p.name, dob: p.dob, ref };
    }
    return { status: 'not-found', ref };
  }

  async startAadhaar(userId: string, mode: 'digilocker' | 'otp', returnUrl: string): Promise<{ redirectUrl?: string; challengeRef?: string }> {
    this.enter('startAadhaar', this.scenarioForUser(userId));
    const challengeRef = this.ref('aad');
    this.refOwner.set(challengeRef, userId);
    if (mode === 'otp') return { challengeRef };
    const url = new URL('/digilocker', this.baseUrl);
    url.searchParams.set('ref', challengeRef);
    url.searchParams.set('return', returnUrl);
    return { redirectUrl: url.toString(), challengeRef };
  }

  async verifyPan(pan: string, _name: string): Promise<{ valid: boolean; nameMatch: boolean; aadhaarLinked: boolean }> {
    const s = this.scenarioForPan(pan);
    this.enter('verifyPan', s === 'timeout' ? 'full-kyc-pass' : s);
    if (s === 'reject') return { valid: false, nameMatch: false, aadhaarLinked: false };
    return { valid: true, nameMatch: s !== 'unclear', aadhaarLinked: true };
  }

  async faceMatch(_selfieKey: string, aadhaarRef: string): Promise<{ match: number; live: boolean }> {
    const s = this.scenarioForUser(this.refOwner.get(aadhaarRef));
    this.enter('faceMatch', s);
    return { match: s === 'unclear' ? FAKE_LOW_FACE_SCORE : FAKE_GOOD_FACE_SCORE, live: true };
  }

  async startEsign(userId: string, returnUrl: string): Promise<{ redirectUrl: string; ref: string }> {
    this.enter('startEsign', this.scenarioForUser(userId));
    const ref = this.ref('esign');
    this.refOwner.set(ref, userId);
    const url = new URL('/esign', this.baseUrl);
    url.searchParams.set('ref', ref);
    url.searchParams.set('return', returnUrl);
    return { redirectUrl: url.toString(), ref };
  }

  async uploadToKra(userId: string): Promise<{ ref: string }> {
    this.enter('uploadToKra', this.scenarioForUser(userId));
    return { ref: this.ref('kraup') };
  }

  verifyWebhook(headers: Record<string, string>, body: string): boolean {
    this.calls.verifyWebhook += 1;
    let given: string | undefined;
    for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === FAKE_SIGNATURE_HEADER) given = v;
    if (typeof given !== 'string' || typeof body !== 'string') return false;
    const want = createHmac('sha256', this.secret).update(body).digest('hex');
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(want, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
