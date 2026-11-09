// Contact OTP: send (rate-limited per target and per IP) and verify (issues tokens, creates the
// user on first sign-in). Limits mirror the app's OTP_RULES. Codes are argon2id-hashed, contacts
// are stored encrypted with an HMAC lookup key. Nothing here logs codes, tokens or contacts, and
// the send path never looks up whether the contact has an account.
import { randomInt, randomUUID } from 'node:crypto';
import { normalizeEmail, normalizeMobile, OTP_RULES, validateEmail, validateMobile } from '@wealthfire/core';
import type { Clock } from '../lib/clock';
import { hmacLookup, randomToken, type Encryptor, type MacSigner, type SecretHasher } from '../lib/crypto';
import { AuthError } from '../lib/errors';
import type { AuthRepos, ContactKind, OtpChallenge, SendLog } from '../lib/repo';
import type { TokenPair, TokenService } from '../lib/tokens';

export const OTP_LIMITS = {
  length: OTP_RULES.length,
  expiryMs: OTP_RULES.expiryMs,
  maxTries: OTP_RULES.maxTries,
  resendCooldownMs: OTP_RULES.resendCooldownMs,
  maxSendsPerTarget: OTP_RULES.maxSendsPerWindow,
  targetWindowMs: OTP_RULES.windowMs,
  maxSendsPerIp: 20,
  ipWindowMs: 60 * 60_000,
} as const;

const CAS_RETRIES = 5;

// ---------- Sender ----------

/** Delivers a code by SMS or email. Implementations must not log `to` or `code`. */
export interface Sender {
  send(kind: ContactKind, to: string, code: string): Promise<void>;
}

/** Test sender: records the last message in memory. */
export class FakeSender implements Sender {
  last: { kind: ContactKind; to: string; code: string } | null = null;
  count = 0;
  fail = false;

  get lastCode(): string | null {
    return this.last?.code ?? null;
  }

  async send(kind: ContactKind, to: string, code: string): Promise<void> {
    if (this.fail) throw new Error(`fake send failed for ${to} with ${code}`);
    this.last = { kind, to, code };
    this.count += 1;
  }
}

// ---------- Service ----------

export interface OtpDeps {
  repos: AuthRepos;
  clock: Clock;
  mac: MacSigner;
  encryptor: Encryptor;
  hasher: SecretHasher;
  sender: Sender;
  tokens: TokenService;
  /** Injectable for tests; defaults to a uniform crypto-random 6-digit code. */
  generateCode?: () => string;
}

export interface SendInput {
  kind: ContactKind;
  contact: string;
  ip: string;
}

export interface SendResult {
  challengeId: string;
  expiresAt: number;
  /** earliest time a resend is allowed */
  resendAt: number;
}

export interface VerifyInput {
  challengeId: string;
  code: string;
  device?: string;
}

export interface VerifyResult {
  tokens: TokenPair;
  isNewUser: boolean;
}

/** Validates and normalises a contact; throws bad_request. */
export function normalizeContact(kind: unknown, contact: unknown): { kind: ContactKind; value: string } {
  if (typeof contact !== 'string' || contact.length > 320) throw new AuthError('bad_request');
  if (kind === 'email') {
    if (validateEmail(contact) !== null) throw new AuthError('bad_request');
    return { kind, value: normalizeEmail(contact) };
  }
  if (kind === 'mobile') {
    if (validateMobile(contact) !== null) throw new AuthError('bad_request');
    return { kind, value: normalizeMobile(contact) };
  }
  throw new AuthError('bad_request');
}

/** HMAC lookup key for a normalised contact (shared by OTP targets and users). */
export function contactLookup(mac: MacSigner, kind: ContactKind, value: string): Promise<string> {
  return hmacLookup(mac, 'contact', `${kind}:${value}`);
}

const defaultCode = (): string => String(randomInt(0, 10 ** OTP_LIMITS.length)).padStart(OTP_LIMITS.length, '0');

export class OtpService {
  constructor(private readonly deps: OtpDeps) {}

  async send(input: SendInput): Promise<SendResult> {
    const { repos, clock, mac, encryptor, hasher, sender } = this.deps;
    const { kind, value } = normalizeContact(input.kind, input.contact);
    const targetHash = await contactLookup(mac, kind, value);
    const ipHash = await hmacLookup(mac, 'ip', typeof input.ip === 'string' && input.ip ? input.ip : 'unknown');

    // Per-IP first, so a limited IP cannot use up a target's sends.
    await this.reserve(`ip:${ipHash}`, OTP_LIMITS.ipWindowMs, OTP_LIMITS.maxSendsPerIp, 0);

    const challengeId = randomToken(16);
    const previous = await this.reserve(
      `t:${targetHash}`, OTP_LIMITS.targetWindowMs, OTP_LIMITS.maxSendsPerTarget, OTP_LIMITS.resendCooldownMs, challengeId,
    );
    if (previous) await repos.otp.deleteChallenge(previous); // a resend replaces the old code

    const now = clock.now();
    const code = (this.deps.generateCode ?? defaultCode)();
    const challenge: OtpChallenge = {
      challengeId,
      targetHash,
      contactKind: kind,
      contactEnc: await encryptor.encrypt(value, { purpose: 'otp', challengeId }),
      codeHash: await hasher.hash(code),
      createdAt: now,
      expiresAt: now + OTP_LIMITS.expiryMs,
      tries: 0,
    };
    await repos.otp.putChallenge(challenge);
    try {
      await sender.send(kind, value, code);
    } catch {
      await repos.otp.deleteChallenge(challengeId);
      throw new AuthError('send_failed');
    }
    return { challengeId, expiresAt: challenge.expiresAt, resendAt: now + OTP_LIMITS.resendCooldownMs };
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const { repos, clock, encryptor, hasher, tokens } = this.deps;
    if (typeof input.challengeId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(input.challengeId)) throw new AuthError('bad_request');
    if (typeof input.code !== 'string' || !new RegExp(`^\\d{${OTP_LIMITS.length}}$`).test(input.code)) throw new AuthError('bad_request');
    const device = typeof input.device === 'string' && input.device.length <= 100 ? input.device : undefined;

    const c = await repos.otp.getChallenge(input.challengeId);
    if (!c) throw new AuthError('invalid_code', { triesLeft: 0 });
    if (clock.now() >= c.expiresAt) {
      await repos.otp.deleteChallenge(c.challengeId);
      throw new AuthError('invalid_code', { triesLeft: 0 });
    }
    const tries = await repos.otp.incrementTries(c.challengeId, OTP_LIMITS.maxTries);
    if (tries === null) {
      await repos.otp.deleteChallenge(c.challengeId);
      throw new AuthError('invalid_code', { triesLeft: 0 });
    }
    if (!(await hasher.verify(c.codeHash, input.code))) {
      const left = OTP_LIMITS.maxTries - tries;
      if (left <= 0) await repos.otp.deleteChallenge(c.challengeId);
      throw new AuthError('invalid_code', { triesLeft: left });
    }
    // Single use: only the caller that deletes the challenge wins.
    if (!(await repos.otp.deleteChallenge(c.challengeId))) throw new AuthError('invalid_code', { triesLeft: 0 });

    const value = await encryptor.decrypt(c.contactEnc, { purpose: 'otp', challengeId: c.challengeId });
    const userId = randomUUID();
    const { user, created } = await repos.users.createIfAbsent({
      userId,
      contactKind: c.contactKind,
      contactHash: c.targetHash,
      contactEnc: await encryptor.encrypt(value, { purpose: 'contact', userId }),
      createdAt: clock.now(),
    });
    return { tokens: await tokens.issue(user.userId, device), isNewUser: created };
  }

  /**
   * Records a send in the log at `key` if the window limit and cooldown allow it (optimistic
   * concurrency, retried). Returns the previous challenge id stored on the log, if any.
   */
  private async reserve(
    key: string, windowMs: number, max: number, cooldownMs: number, challengeId?: string,
  ): Promise<string | undefined> {
    const { repos, clock } = this.deps;
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      const now = clock.now();
      const log: SendLog | null = await repos.otp.getSendLog(key);
      const sends = (log?.sends ?? []).filter((t) => now - t < windowMs && t <= now).sort((a, b) => a - b);
      if (sends.length >= max) throw new AuthError('rate_limited', { retryAfterMs: sends[0]! + windowMs - now });
      const last = sends[sends.length - 1];
      if (cooldownMs > 0 && last !== undefined && now - last < cooldownMs) {
        throw new AuthError('rate_limited', { retryAfterMs: last + cooldownMs - now });
      }
      const next = { key, sends: [...sends, now], lastChallengeId: challengeId ?? log?.lastChallengeId };
      if (await repos.otp.putSendLog(next, log?.version ?? 0, now + windowMs)) return log?.lastChallengeId;
    }
    throw new AuthError('rate_limited', { retryAfterMs: 1000 });
  }
}
