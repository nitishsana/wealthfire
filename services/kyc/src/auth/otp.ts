// Contact OTP: send (rate-limited per target and per IP, with a daily cap) and verify (per-IP
// limit, failed-challenge lockout; issues tokens, creates the user on first sign-in). Short-window
// limits mirror the app's OTP_RULES. Codes are argon2id-hashed, contacts are stored encrypted
// (context {purpose: 'contact'}) with an HMAC lookup key. Nothing here logs codes, tokens or
// contacts (failure metrics carry a fixed reason and the contact kind only), and the send path
// never looks up whether the contact has an account.
import { randomInt, randomUUID } from 'node:crypto';
import { normalizeEmail, normalizeMobile, OTP_RULES, validateEmail, validateMobile } from '@wealthfire/core';
import type { Clock } from '../lib/clock';
import { hmacLookup, randomToken, type Encryptor, type MacSigner, type SecretHasher } from '../lib/crypto';
import { AuthError } from '../lib/errors';
import { emfAuthMetrics, type AuthMetrics, type OtpFailureReason } from '../lib/metrics';
import type { AuthRepos, ContactKind, OtpChallenge, SendLog } from '../lib/repo';
import type { TokenPair, TokenService } from '../lib/tokens';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export const OTP_LIMITS = {
  length: OTP_RULES.length,
  expiryMs: OTP_RULES.expiryMs,
  maxTries: OTP_RULES.maxTries,
  resendCooldownMs: OTP_RULES.resendCooldownMs,
  maxSendsPerTarget: OTP_RULES.maxSendsPerWindow,
  targetWindowMs: OTP_RULES.windowMs,
  /** daily cap on sends per target (S3) */
  maxSendsPerTargetDay: 10,
  targetDayWindowMs: DAY,
  maxSendsPerIp: 20,
  ipWindowMs: HOUR,
  /**
   * failed challenges per (target, caller IP) in failWindowMs that start a lockout for that pair
   * (S#7: a stranger typing wrong codes from their own IP does not lock the owner out)
   */
  maxFailedChallenges: 3,
  /** failed challenges per target from ANY IP in failWindowMs that lock the target everywhere */
  maxFailedChallengesGlobal: 10,
  failWindowMs: DAY,
  lockoutMs: HOUR,
  /** verify calls per IP per hour */
  maxVerifiesPerIp: 30,
  verifyIpWindowMs: HOUR,
} as const;

const CAS_RETRIES = 5;

interface Limit {
  windowMs: number;
  max: number;
}

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
  /** failure counters (default: CloudWatch EMF lines) */
  metrics?: AuthMetrics;
  /** Injectable for tests; defaults to a uniform crypto-random 6-digit code. */
  generateCode?: () => string;
  /**
   * Local test server only: per-IP caps. Every tester on the laptop is 127.0.0.1, so the online
   * per-IP caps would block a test run. Per-target caps and lockouts are never changed.
   */
  ipLimits?: { maxSendsPerIp: number; maxVerifiesPerIp: number };
}

/** Per-IP caps for the local test server (STAGE=local only; online keeps OTP_LIMITS). */
export const LOCAL_IP_LIMITS = { maxSendsPerIp: 10_000, maxVerifiesPerIp: 10_000 } as const;

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
  /** caller IP (request context); counts toward the per-IP verify limit */
  ip?: string;
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

/** Encryption context for a challenge's contact (field key, purpose 'contact'). */
export function challengeContactContext(challengeId: string): Record<string, string> {
  return { purpose: 'contact', challengeId };
}

const defaultCode = (): string => String(randomInt(0, 10 ** OTP_LIMITS.length)).padStart(OTP_LIMITS.length, '0');

export class OtpService {
  constructor(private readonly deps: OtpDeps) {}

  private fail(reason: OtpFailureReason, kind?: ContactKind): void {
    try {
      (this.deps.metrics ?? emfAuthMetrics).otpFailure(kind ? { reason, kind } : { reason });
    } catch {
      // metrics never break sign-in
    }
  }

  private ipHash(ip: unknown): Promise<string> {
    return hmacLookup(this.deps.mac, 'ip', typeof ip === 'string' && ip ? ip : 'unknown');
  }

  async send(input: SendInput): Promise<SendResult> {
    const { repos, clock, mac, encryptor, hasher, sender } = this.deps;
    const { kind, value } = normalizeContact(input.kind, input.contact);
    const targetHash = await contactLookup(mac, kind, value);
    const ipHash = await this.ipHash(input.ip);

    try {
      // Per-IP first, so a limited IP cannot use up a target's sends.
      const maxSendsPerIp = this.deps.ipLimits?.maxSendsPerIp ?? OTP_LIMITS.maxSendsPerIp;
      await this.reserve(`ip:${ipHash}`, [{ windowMs: OTP_LIMITS.ipWindowMs, max: maxSendsPerIp }], 0);
    } catch (e) {
      this.fail('send-limited', kind);
      throw e;
    }
    await this.assertNotLocked(targetHash, ipHash, kind);

    const challengeId = randomToken(16);
    let previous: string | undefined;
    try {
      previous = await this.reserve(`t:${targetHash}`, [
        { windowMs: OTP_LIMITS.targetWindowMs, max: OTP_LIMITS.maxSendsPerTarget },
        { windowMs: OTP_LIMITS.targetDayWindowMs, max: OTP_LIMITS.maxSendsPerTargetDay },
      ], OTP_LIMITS.resendCooldownMs, challengeId);
    } catch (e) {
      this.fail('send-limited', kind);
      throw e;
    }
    if (previous) await repos.otp.deleteChallenge(previous); // a resend replaces the old code

    const now = clock.now();
    const code = (this.deps.generateCode ?? defaultCode)();
    const challenge: OtpChallenge = {
      challengeId,
      targetHash,
      contactKind: kind,
      contactEnc: await encryptor.encrypt(value, challengeContactContext(challengeId)),
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
      this.fail('send-failed', kind);
      throw new AuthError('send_failed');
    }
    return { challengeId, expiresAt: challenge.expiresAt, resendAt: now + OTP_LIMITS.resendCooldownMs };
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const { repos, clock, encryptor, hasher, tokens } = this.deps;
    if (typeof input.challengeId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(input.challengeId)) throw new AuthError('bad_request');
    if (typeof input.code !== 'string' || !new RegExp(`^\\d{${OTP_LIMITS.length}}$`).test(input.code)) throw new AuthError('bad_request');
    const device = typeof input.device === 'string' && input.device.length <= 100 ? input.device : undefined;

    const ipHash = await this.ipHash(input.ip);
    try {
      const maxVerifiesPerIp = this.deps.ipLimits?.maxVerifiesPerIp ?? OTP_LIMITS.maxVerifiesPerIp;
      await this.reserve(`v:${ipHash}`, [{ windowMs: OTP_LIMITS.verifyIpWindowMs, max: maxVerifiesPerIp }], 0);
    } catch (e) {
      this.fail('verify-limited');
      throw e;
    }

    const c = await repos.otp.getChallenge(input.challengeId);
    if (!c) {
      this.fail('dead-challenge');
      throw new AuthError('invalid_code', { triesLeft: 0 });
    }
    await this.assertNotLocked(c.targetHash, ipHash, c.contactKind);
    if (clock.now() >= c.expiresAt) {
      await repos.otp.deleteChallenge(c.challengeId);
      this.fail('dead-challenge', c.contactKind);
      throw new AuthError('invalid_code', { triesLeft: 0 });
    }
    const tries = await repos.otp.incrementTries(c.challengeId, OTP_LIMITS.maxTries);
    if (tries === null) {
      await repos.otp.deleteChallenge(c.challengeId);
      this.fail('dead-challenge', c.contactKind);
      throw new AuthError('invalid_code', { triesLeft: 0 });
    }
    if (!(await hasher.verify(c.codeHash, input.code))) {
      this.fail('wrong-code', c.contactKind);
      let left = OTP_LIMITS.maxTries - tries;
      // A challenge counts as failed at its first wrong code (once per challenge), so resending
      // before the tries run out cannot dodge the lockout.
      if (tries === 1 && (await this.recordFailedChallenge(c.targetHash, ipHash))) {
        this.fail('lockout-started', c.contactKind);
        left = 0;
      }
      if (left <= 0) await repos.otp.deleteChallenge(c.challengeId);
      throw new AuthError('invalid_code', { triesLeft: left });
    }
    // Single use: only the caller that deletes the challenge wins.
    if (!(await repos.otp.deleteChallenge(c.challengeId))) throw new AuthError('invalid_code', { triesLeft: 0 });

    const value = await encryptor.decrypt(c.contactEnc, challengeContactContext(c.challengeId));
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
   * The two failed-challenge logs (S#7): per (target, caller IP), threshold 3; per target from any
   * IP, threshold 10. Each locks for lockoutMs after its latest failure once its threshold is met.
   */
  private failLogs(targetHash: string, ipHash: string): { key: string; max: number }[] {
    return [
      { key: `f:${targetHash}:${ipHash}`, max: OTP_LIMITS.maxFailedChallenges },
      { key: `fg:${targetHash}`, max: OTP_LIMITS.maxFailedChallengesGlobal },
    ];
  }

  /** Throws rate_limited while the (target, IP) pair or the whole target is locked out. */
  private async assertNotLocked(targetHash: string, ipHash: string, kind: ContactKind): Promise<void> {
    const now = this.deps.clock.now();
    let wait = 0;
    for (const { key, max } of this.failLogs(targetHash, ipHash)) {
      const log = await this.deps.repos.otp.getSendLog(key);
      const fails = (log?.sends ?? []).filter((t) => now - t < OTP_LIMITS.failWindowMs && t <= now).sort((a, b) => a - b);
      if (fails.length < max) continue;
      const last = fails[fails.length - 1]!;
      if (now - last < OTP_LIMITS.lockoutMs) wait = Math.max(wait, last + OTP_LIMITS.lockoutMs - now);
    }
    if (wait > 0) {
      this.fail('locked', kind);
      throw new AuthError('rate_limited', { retryAfterMs: wait });
    }
  }

  /** Records a failed challenge in both logs; true when this failure starts a lockout in either. */
  private async recordFailedChallenge(targetHash: string, ipHash: string): Promise<boolean> {
    let started = false;
    for (const { key, max } of this.failLogs(targetHash, ipHash)) {
      if (await this.appendFailure(key, max)) started = true;
    }
    return started;
  }

  /** Appends `now` to the failure log at `key`; true when the log reaches `max` in the window. */
  private async appendFailure(key: string, max: number): Promise<boolean> {
    const { repos, clock } = this.deps;
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      const now = clock.now();
      const log = await repos.otp.getSendLog(key);
      const fails = (log?.sends ?? []).filter((t) => now - t < OTP_LIMITS.failWindowMs && t <= now);
      const next = { key, sends: [...fails, now] };
      if (await repos.otp.putSendLog(next, log?.version ?? 0, now + OTP_LIMITS.failWindowMs)) {
        return next.sends.length >= max;
      }
    }
    // Could not record under contention: fail closed with a lockout. The log was not written, so
    // this caller's challenge is ended (triesLeft 0) but no later sign-in is blocked by it.
    return true;
  }

  /**
   * Records a send in the log at `key` if every window limit and the cooldown allow it
   * (optimistic concurrency, retried). Returns the previous challenge id stored on the log, if any.
   */
  private async reserve(key: string, limits: readonly Limit[], cooldownMs: number, challengeId?: string): Promise<string | undefined> {
    const { repos, clock } = this.deps;
    const keepMs = Math.max(...limits.map((l) => l.windowMs));
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      const now = clock.now();
      const log: SendLog | null = await repos.otp.getSendLog(key);
      const sends = (log?.sends ?? []).filter((t) => now - t < keepMs && t <= now).sort((a, b) => a - b);
      let wait = 0;
      for (const l of limits) {
        const inWindow = sends.filter((t) => now - t < l.windowMs);
        if (inWindow.length >= l.max) wait = Math.max(wait, inWindow[inWindow.length - l.max]! + l.windowMs - now);
      }
      if (wait > 0) throw new AuthError('rate_limited', { retryAfterMs: wait });
      const last = sends[sends.length - 1];
      if (cooldownMs > 0 && last !== undefined && now - last < cooldownMs) {
        throw new AuthError('rate_limited', { retryAfterMs: last + cooldownMs - now });
      }
      const next = { key, sends: [...sends, now], lastChallengeId: challengeId ?? log?.lastChallengeId };
      if (await repos.otp.putSendLog(next, log?.version ?? 0, now + keepMs)) return log?.lastChallengeId;
    }
    throw new AuthError('rate_limited', { retryAfterMs: 1000 });
  }
}
