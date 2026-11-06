// OTP provider slot. v1 ships DemoOtpProvider, which runs on the device and shows the code.
// A real provider (DigiLocker / Digio) needs a server that holds the API secret; it plugs in
// through createOtpProvider without any screen change. Codes are never stored or logged.
import type { OtpProviderId } from './types';
import { OTP_RULES, normalizeAadhaar, normalizeEmail, normalizeMobile, validateAadhaar, validateEmail, validateMobile } from './onboarding';

export type OtpChannel = 'email' | 'sms' | 'aadhaar';

export interface OtpSendRequest {
  channel: OtpChannel;
  /** email address, 10-digit mobile, or full 12-digit Aadhaar (aadhaar channel; never stored by the app) */
  target: string;
}

export type OtpSendResult =
  | { ok: true; requestId: string; expiresAt: number; demoCode?: string }
  | { ok: false; reason: 'no-linked-mobile' | 'invalid-target' | 'rate-limited' | 'network'; message: string };

export type OtpVerifyResult =
  | { ok: true; aadhaarLast4?: string }
  | { ok: false; reason: 'wrong' | 'expired' | 'void' | 'network'; message: string };

export interface OtpProvider {
  id: OtpProviderId;
  /** true → screens show the "Demo code" banner */
  isDemo: boolean;
  send(req: OtpSendRequest, now: number): Promise<OtpSendResult>;
  verify(requestId: string, code: string, now: number): Promise<OtpVerifyResult>;
}

export const OTP_MESSAGES = {
  noLinkedMobile: 'Your Aadhaar has no linked mobile. Link one at an Aadhaar centre, then try again.',
  invalidTarget: 'Check the number or address and try again.',
  expired: 'Code expired. Send a new one.',
  void: 'This code no longer works. Send a new one.',
  wrong: (left: number) => `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
} as const;

/** Random number in [0, 1). Uses crypto when present (web, modern RN), else Math.random (Hermes fallback). */
export function defaultRandom(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
  return Math.random();
}

interface Pending {
  key: string;
  code: string;
  expiresAt: number;
  tries: number;
  aadhaarLast4?: string;
}

function normalizeTarget(req: OtpSendRequest): string | null {
  if (req.channel === 'email') return validateEmail(req.target) ? null : normalizeEmail(req.target);
  if (req.channel === 'sms') return validateMobile(req.target) ? null : normalizeMobile(req.target);
  const a = normalizeAadhaar(req.target);
  return /^\d{12}$/.test(a) ? a : null;
}

/** On-device stand-in for a real OTP service. In-memory only, so a restart voids every code. */
export class DemoOtpProvider implements OtpProvider {
  readonly id: OtpProviderId = 'demo';
  readonly isDemo = true;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(private readonly random: () => number = defaultRandom) {}

  async send(req: OtpSendRequest, now: number): Promise<OtpSendResult> {
    const target = normalizeTarget(req);
    if (!target) return { ok: false, reason: 'invalid-target', message: OTP_MESSAGES.invalidTarget };
    if (req.channel === 'aadhaar') {
      // Demo hook: any Aadhaar ending 0000 has "no linked mobile".
      if (target.endsWith('0000')) return { ok: false, reason: 'no-linked-mobile', message: OTP_MESSAGES.noLinkedMobile };
      if (validateAadhaar(target)) return { ok: false, reason: 'invalid-target', message: OTP_MESSAGES.invalidTarget };
    }
    const key = `${req.channel}:${target}`;
    // Email/SMS: a new send voids the older code for the same target.
    // Aadhaar: a new send voids every Aadhaar code, so no older full number stays in memory.
    for (const [id, p] of this.pending) {
      if (p.key === key || (req.channel === 'aadhaar' && p.key.startsWith('aadhaar:'))) this.pending.delete(id);
    }

    const n = Math.min(999_999, Math.floor(this.random() * 1_000_000));
    const code = String(n).padStart(OTP_RULES.length, '0');
    const requestId = `demo-${++this.seq}-${Math.floor(this.random() * 1e9).toString(36)}`;
    const expiresAt = now + OTP_RULES.expiryMs;
    this.pending.set(requestId, {
      key,
      code,
      expiresAt,
      tries: 0,
      aadhaarLast4: req.channel === 'aadhaar' ? target.slice(-4) : undefined,
    });
    return { ok: true, requestId, expiresAt, demoCode: code };
  }

  async verify(requestId: string, code: string, now: number): Promise<OtpVerifyResult> {
    const p = this.pending.get(requestId);
    if (!p) return { ok: false, reason: 'void', message: OTP_MESSAGES.void };
    if (now > p.expiresAt) {
      this.pending.delete(requestId);
      return { ok: false, reason: 'expired', message: OTP_MESSAGES.expired };
    }
    if (code.trim() !== p.code) {
      p.tries++;
      if (p.tries >= OTP_RULES.maxTries) {
        this.pending.delete(requestId);
        return { ok: false, reason: 'void', message: OTP_MESSAGES.void };
      }
      return { ok: false, reason: 'wrong', message: OTP_MESSAGES.wrong(OTP_RULES.maxTries - p.tries) };
    }
    this.pending.delete(requestId);
    return p.aadhaarLast4 ? { ok: true, aadhaarLast4: p.aadhaarLast4 } : { ok: true };
  }

  /** @internal Test hook: number of live codes. */
  pendingCount(): number {
    return this.pending.size;
  }
}

/** Single factory for the app's OTP provider. v1 builds only the demo provider. */
export function createOtpProvider(cfg: { provider?: string; apiUrl?: string }): OtpProvider {
  const id = cfg.provider;
  // '' counts as unset: CI turns a missing repo variable into an empty string.
  if (id === undefined || id === '' || id === 'demo') return new DemoOtpProvider();
  throw new Error(`OTP provider "${id}" is not built yet`);
}
