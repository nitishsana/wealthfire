// Shared 6-digit OTP step for the contact and Aadhaar screens (design D5).
// Request ids, demo codes and typed codes live in component state only; nothing here is saved.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { canSend, OTP_RULES, type OtpChannel, type OtpProvider, type OtpVerifyResult } from '@wealthfire/core';

export const NO_LINKED_MOBILE = 'Your Aadhaar has no linked mobile. Link one at an Aadhaar centre, then try again.';

export type OtpRequest =
  | { ok: true; at: string; requestId: string; demoCode?: string }
  | { ok: false; error: string; lockUntil?: string; cooldown?: true };

/** "0:SS" style countdown text. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function tooMany(waitMs: number): string {
  const m = Math.max(1, Math.ceil(waitMs / 60_000));
  return `Too many tries. Try again in ${m} minute${m === 1 ? '' : 's'}.`;
}

/** Check the send limits, then ask the provider for a code. Used by the first send and by resend. */
export async function requestOtp(
  provider: OtpProvider, channel: OtpChannel, target: string, sends: string[], lockedUntil: string | null, now = Date.now(),
): Promise<OtpRequest> {
  const gate = canSend(sends, now, lockedUntil);
  if (!gate.ok) {
    if (gate.reason === 'cooldown') return { ok: false, error: `Resend in ${clock(gate.waitMs)}`, cooldown: true };
    if (gate.reason === 'limit' && channel === 'aadhaar') {
      return { ok: false, error: tooMany(OTP_RULES.aadhaarLockMs), lockUntil: new Date(now + OTP_RULES.aadhaarLockMs).toISOString() };
    }
    return { ok: false, error: tooMany(gate.waitMs) };
  }
  try {
    const r = await provider.send({ channel, target }, now);
    if (!r.ok) return { ok: false, error: r.reason === 'no-linked-mobile' ? NO_LINKED_MOBILE : r.message };
    return { ok: true, at: new Date(now).toISOString(), requestId: r.requestId, demoCode: r.demoCode };
  } catch {
    return { ok: false, error: 'Could not send the code. Check your connection and try again.' };
  }
}

interface Props {
  provider: OtpProvider;
  channel: OtpChannel;
  /** Email, 10-digit mobile, or full Aadhaar (never stored). */
  target: string;
  sends: string[];
  lockedUntil: string | null;
  /** Result of the send that opened this screen, if any. */
  initial?: OtpRequest;
  verifyLabel: string;
  onSent: (at: string) => void;
  onVerified: (r: Extract<OtpVerifyResult, { ok: true }>) => void;
  onLocked: (until: string) => void;
}

export function OtpStep({ provider, channel, target, sends, lockedUntil, initial, verifyLabel, onSent, onVerified, onLocked }: Props) {
  const id = useId();
  const [requestId, setRequestId] = useState(initial?.ok ? initial.requestId : '');
  const [demoCode, setDemoCode] = useState(initial?.ok ? initial.demoCode ?? '' : '');
  const [code, setCode] = useState('');
  const [error, setError] = useState(initial && !initial.ok && !initial.cooldown ? initial.error : '');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // 1-second ticker for the resend countdown and lock timer; cleared on unmount.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const lockLeft = lockedUntil ? Date.parse(lockedUntil) - now : 0;
  const locked = lockLeft > 0;
  const gate = canSend(sends, now, lockedUntil);
  const coolMs = !gate.ok && gate.reason === 'cooldown' ? gate.waitMs : 0;
  const cooling = coolMs > 0;

  async function send() {
    setBusy(true); setError('');
    const r = await requestOtp(provider, channel, target, sends, lockedUntil);
    setBusy(false);
    if (r.ok) {
      setRequestId(r.requestId); setDemoCode(r.demoCode ?? ''); setCode('');
      onSent(r.at);
    } else {
      if (r.lockUntil) { onLocked(r.lockUntil); setRequestId(''); setDemoCode(''); setCode(''); }
      // Cooldown: the Send/Resend button already shows a ticking "Resend in 0:SS".
      if (!r.cooldown) setError(r.error);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!requestId || code.length !== OTP_RULES.length || busy || locked) return;
    setBusy(true); setError('');
    let r: OtpVerifyResult;
    try {
      r = await provider.verify(requestId, code, Date.now());
    } catch {
      r = { ok: false, reason: 'network', message: 'Could not check the code. Check your connection and try again.' };
    }
    setBusy(false);
    if (r.ok) {
      setRequestId(''); setDemoCode(''); setCode('');
      onVerified(r);
      return;
    }
    setCode('');
    if (r.reason === 'void' || r.reason === 'expired') { setRequestId(''); setDemoCode(''); }
    if (r.reason === 'void' && channel === 'aadhaar') {
      // Req 4.9: 5 wrong tries on the Aadhaar code lock the step for 30 minutes.
      const until = new Date(Date.now() + OTP_RULES.aadhaarLockMs).toISOString();
      onLocked(until);
      setError(tooMany(OTP_RULES.aadhaarLockMs));
      return;
    }
    setError(r.message);
  }

  const banner = channel === 'aadhaar'
    ? `Demo mode: no real Aadhaar OTP is sent. Your code is ${demoCode}. In the live app this comes from UIDAI to your Aadhaar-linked mobile.`
    : `Demo mode: no real SMS or email is sent. Your code is ${demoCode}.`;
  const errId = `${id}-err`;

  if (locked) {
    return <p className="error" role="status">{tooMany(lockLeft)}</p>;
  }

  return (
    <form onSubmit={verify} noValidate className="otp-step">
      {provider.isDemo && demoCode && <p className="demo-banner" role="status">{banner}</p>}
      {requestId ? (
        <label className="field" htmlFor={`${id}-code`}>
          <span>6-digit code</span>
          <input id={`${id}-code`} className="otp-input" value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={12} placeholder="123456"
            pattern="[0-9]*" aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, OTP_RULES.length))} />
        </label>
      ) : null}
      {error && <p id={errId} className="error" role="status">{error}</p>}
      <div className="row">
        {requestId ? (
          <>
            <button className="btn primary" type="submit" disabled={busy || code.length !== OTP_RULES.length}>{verifyLabel}</button>
            <button className="btn" type="button" onClick={send} disabled={busy || cooling}>
              {cooling ? `Resend in ${clock(coolMs)}` : 'Resend OTP'}
            </button>
          </>
        ) : (
          <button className="btn primary" type="button" onClick={send} disabled={busy || cooling}>
            {cooling ? `Resend in ${clock(coolMs)}` : 'Send OTP'}
          </button>
        )}
      </div>
    </form>
  );
}
