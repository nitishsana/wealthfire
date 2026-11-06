// Onboarding journey (design D5): sign in → contact OTP → your details → Aadhaar OTP → "You're all set".
// The full Aadhaar number and OTP codes stay in component state only; AppData keeps last 4 digits.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  canSend, groupAadhaar, maskAadhaar, maskEmail, maskMobile, normalizeAadhaar, normalizeEmail, normalizeMobile, normalizePan,
  onboardingReducer, panSurnameWarning, validateAadhaar, validateEmail, validateMobile, validateName, validatePan,
  type ContactKind, type OnboardingEvent,
} from '@wealthfire/core';
import { useStore } from '../store';
import { otpProvider } from '../otp';
import { clock, OtpStep, requestOtp, type OtpRequest } from '../components/OtpStep';
import { Card, Disclaimer } from '../ui';

interface Props {
  /** Called just before the Aadhaar OTP passes, so the shell keeps showing "You're all set". */
  onCompleting: () => void;
  /** "Go to Home". */
  onFinish: () => void;
}

export function OnboardingPage({ onCompleting, onFinish }: Props) {
  const { data, update } = useStore();
  const ob = data.onboarding;
  const dispatch = (event: OnboardingEvent) => update((d) => ({ ...d, onboarding: onboardingReducer(d.onboarding, event) }));
  // Full Aadhaar: memory only. Cleared on verify and Back; gone on unmount with the component.
  const [aadhaar, setAadhaar] = useState('');
  const [firstSend, setFirstSend] = useState<OtpRequest | undefined>(undefined);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);

  // Move focus to the new step's heading so screen readers announce the step change.
  useEffect(() => {
    if (mounted.current) headingRef.current?.focus();
    mounted.current = true;
  }, [ob.step]);

  // After a reload on the Aadhaar OTP step the full number is gone, so ask for it again (lock still applies).
  useEffect(() => {
    if (ob.step === 'aadhaar-otp' && !aadhaar) dispatch({ type: 'back-to-identity' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ob.step, aadhaar]);

  const heading = (text: string) => <h1 ref={headingRef} tabIndex={-1}>{text}</h1>;

  let body: ReactNode = null;
  if (ob.step === 'signin') {
    body = (
      <section data-feature="onboard-signin" aria-label="Sign in">
        {heading('Sign in')}
        <SignIn onSent={(kind, value, r) => {
          setFirstSend(r);
          dispatch({ type: 'otp-sent', channel: 'contact', at: r.at, contact: { kind, value } });
        }} />
      </section>
    );
  } else if (ob.step === 'otp' && ob.contact) {
    const c = ob.contact;
    const masked = c.kind === 'email' ? maskEmail(c.value) : maskMobile(c.value);
    body = (
      <section data-feature="onboard-otp" aria-label="Verify your contact">
        {heading(c.kind === 'email' ? 'Verify your email' : 'Verify your mobile number')}
        <p className="intro">
          We sent a code to {masked}.{' '}
          <button type="button" className="link-btn" onClick={() => { setFirstSend(undefined); dispatch({ type: 'change-contact' }); }}>Change</button>
        </p>
        <Card>
          <OtpStep provider={otpProvider} channel={c.kind === 'email' ? 'email' : 'sms'} target={c.value}
            sends={ob.sends.contact} lockedUntil={null} initial={firstSend} verifyLabel="Verify"
            onSent={(at) => dispatch({ type: 'otp-sent', channel: 'contact', at })}
            onVerified={() => { setFirstSend(undefined); dispatch({ type: 'contact-verified', at: new Date().toISOString() }); }}
            onLocked={() => undefined} />
        </Card>
      </section>
    );
  } else if (ob.step === 'identity' || (ob.step === 'aadhaar-otp' && !aadhaar)) {
    body = (
      <section data-feature="onboard-identity" aria-label="Your details">
        {heading('Your details')}
        <p className="intro">We need these to tie your account to you.</p>
        <Identity initial={ob.identity} onContinue={async (id, digits) => {
          const r = await requestOtp(otpProvider, 'aadhaar', digits, ob.sends.aadhaar, ob.aadhaarLockedUntil);
          setAadhaar(digits);
          setFirstSend(r);
          dispatch({ type: 'identity-saved', ...id });
          if (r.ok) dispatch({ type: 'otp-sent', channel: 'aadhaar', at: r.at });
          else if (r.lockUntil) dispatch({ type: 'aadhaar-locked', until: r.lockUntil });
        }} />
      </section>
    );
  } else if (ob.step === 'aadhaar-otp') {
    body = (
      <section data-feature="onboard-aadhaar-otp" aria-label="Verify Aadhaar">
        {heading('Verify Aadhaar')}
        <p className="intro">Enter the OTP sent to the mobile linked with Aadhaar {maskAadhaar(aadhaar.slice(-4))}.</p>
        <Card>
          <OtpStep provider={otpProvider} channel="aadhaar" target={aadhaar}
            sends={ob.sends.aadhaar} lockedUntil={ob.aadhaarLockedUntil} initial={firstSend} verifyLabel="Verify Aadhaar"
            onSent={(at) => dispatch({ type: 'otp-sent', channel: 'aadhaar', at })}
            onVerified={(r) => {
              const last4 = r.aadhaarLast4 ?? aadhaar.slice(-4);
              setAadhaar(''); setFirstSend(undefined);
              onCompleting();
              dispatch({ type: 'aadhaar-verified', last4, at: new Date().toISOString(), provider: otpProvider.id });
            }}
            onLocked={(until) => dispatch({ type: 'aadhaar-locked', until })} />
          <button type="button" className="link-btn" onClick={() => { setAadhaar(''); setFirstSend(undefined); dispatch({ type: 'back-to-identity' }); }}>Back</button>
        </Card>
      </section>
    );
  } else if (ob.step === 'done') {
    body = (
      <section data-feature="onboard-aadhaar-otp" aria-label="You're all set">
        {heading(ob.identity ? `You're all set, ${ob.identity.firstName}.` : "You're all set.")}
        <p className="intro">Your contact and Aadhaar are verified.</p>
        <button type="button" className="btn primary" onClick={onFinish}>Go to Home</button>
      </section>
    );
  } else {
    // 'otp' with no contact cannot happen through the reducer; send the user back to sign-in.
    body = (
      <section data-feature="onboard-signin" aria-label="Sign in">
        {heading('Sign in')}
        <button type="button" className="btn primary" onClick={() => dispatch({ type: 'change-contact' })}>Start again</button>
      </section>
    );
  }

  return (
    <div className="onboard">
      <header className="brand onboard-brand">
        <span aria-hidden="true">🔥</span> Wealthfire
      </header>
      <p className="privacy onboard-privacy">🔒 Your data stays in this browser.</p>
      <main id="main" className="onboard-main">
        {body}
        <Disclaimer />
      </main>
    </div>
  );
}

function SignIn({ onSent }: { onSent: (kind: ContactKind, value: string, r: Extract<OtpRequest, { ok: true }>) => void }) {
  const [kind, setKind] = useState<ContactKind>('mobile');
  const [raw, setRaw] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState('');
  const { data } = useStore();
  // 1-second ticker so the cooldown on "Send OTP" counts down live; cleared on unmount.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const gate = canSend(data.onboarding.sends.contact, now, null);
  const coolMs = !gate.ok && gate.reason === 'cooldown' ? gate.waitMs : 0;

  const value = kind === 'email' ? normalizeEmail(raw) : normalizeMobile(raw);
  const invalid = kind === 'email' ? validateEmail(value) : validateMobile(raw);
  const showError = touched && raw !== '' && invalid;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid || busy) return;
    setBusy(true); setSendError('');
    const r = await requestOtp(otpProvider, kind === 'email' ? 'email' : 'sms', value, data.onboarding.sends.contact, null);
    setBusy(false);
    if (r.ok) onSent(kind, value, r);
    else if (!r.cooldown) setSendError(r.error);
  }

  return (
    <form onSubmit={submit} noValidate>
      <Card>
        <fieldset>
          <legend>Sign in with</legend>
          <div className="choices">
            {(['mobile', 'email'] as const).map((k) => (
              <label key={k} className={`choice ${kind === k ? 'on' : ''}`}>
                <input type="radio" name="ob-kind" checked={kind === k}
                  onChange={() => { setKind(k); setRaw(''); setTouched(false); setSendError(''); }} />
                {k === 'mobile' ? 'Mobile number' : 'Email'}
              </label>
            ))}
          </div>
        </fieldset>
        {kind === 'mobile' ? (
          <label className="field ob-field" htmlFor="ob-mobile">
            <span>Mobile number</span>
            <span className="input-wrap has-prefix">
              <span className="prefix"><span aria-hidden="true">+91</span><span className="sr-only">Country code plus 91</span></span>
              <input id="ob-mobile" type="tel" inputMode="tel" autoComplete="tel-national" value={raw} placeholder="98765 43210"
                aria-invalid={showError ? true : undefined} aria-describedby={showError ? 'ob-contact-err' : undefined}
                onChange={(e) => setRaw(e.target.value)} onBlur={() => setTouched(true)} />
            </span>
          </label>
        ) : (
          <label className="field ob-field" htmlFor="ob-email">
            <span>Email</span>
            <input id="ob-email" type="email" autoComplete="email" value={raw} maxLength={254} placeholder="you@example.com"
              aria-invalid={showError ? true : undefined} aria-describedby={showError ? 'ob-contact-err' : undefined}
              onChange={(e) => setRaw(e.target.value)} onBlur={() => setTouched(true)} />
          </label>
        )}
        {showError && <p id="ob-contact-err" className="error" role="status">{invalid}</p>}
        {sendError && <p className="error" role="status">{sendError}</p>}
        <button className="btn primary" type="submit" disabled={!!invalid || busy || coolMs > 0}>
          {coolMs > 0 ? `Resend in ${clock(coolMs)}` : 'Send OTP'}
        </button>
      </Card>
    </form>
  );
}

interface IdentityValues { firstName: string; lastName: string; pan: string }

function Identity({ initial, onContinue }: {
  initial: IdentityValues | null;
  onContinue: (id: IdentityValues, aadhaarDigits: string) => Promise<void>;
}) {
  const [firstName, setFirst] = useState(initial?.firstName ?? '');
  const [lastName, setLast] = useState(initial?.lastName ?? '');
  const [pan, setPan] = useState(initial?.pan ?? '');
  // Full Aadhaar typed here: component state only, empty again after Back.
  const [aadhaar, setAadhaar] = useState('');
  const [showAadhaar, setShowAadhaar] = useState(false);
  const [consent, setConsent] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const touch = (k: string) => setTouched((t) => ({ ...t, [k]: true }));

  const panN = normalizePan(pan);
  const errs = {
    first: validateName(firstName),
    last: validateName(lastName),
    pan: validatePan(panN),
    aadhaar: validateAadhaar(aadhaar),
  };
  const panWarn = !errs.pan && !errs.last ? panSurnameWarning(panN, lastName.trim()) : null;
  const allValid = !errs.first && !errs.last && !errs.pan && !errs.aadhaar;
  const show = (k: keyof typeof errs) => (touched[k] ? errs[k] : null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!allValid || !consent || busy) return;
    setBusy(true);
    await onContinue({ firstName: firstName.trim(), lastName: lastName.trim(), pan: panN }, aadhaar);
    setBusy(false);
  }

  const described = (k: keyof typeof errs, extra?: string | null) =>
    [show(k) ? `ob-${k}-err` : '', extra ?? ''].filter(Boolean).join(' ') || undefined;

  return (
    <form onSubmit={submit} noValidate>
      <Card>
        <div className="form-grid">
          <label className="field" htmlFor="ob-first">
            <span>First name</span>
            <input id="ob-first" value={firstName} autoComplete="given-name" maxLength={50} required
              aria-invalid={show('first') ? true : undefined} aria-describedby={described('first')}
              onChange={(e) => setFirst(e.target.value)} onBlur={() => touch('first')} />
            {show('first') && <span id="ob-first-err" className="error" role="status">{show('first')}</span>}
          </label>
          <label className="field" htmlFor="ob-last">
            <span>Last name</span>
            <input id="ob-last" value={lastName} autoComplete="family-name" maxLength={50} required
              aria-invalid={show('last') ? true : undefined} aria-describedby={described('last')}
              onChange={(e) => setLast(e.target.value)} onBlur={() => touch('last')} />
            {show('last') && <span id="ob-last-err" className="error" role="status">{show('last')}</span>}
          </label>
          <label className="field" htmlFor="ob-pan">
            <span>PAN</span>
            <input id="ob-pan" value={panN} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={10} placeholder="ABCPE1234F" required
              aria-invalid={show('pan') ? true : undefined} aria-describedby={described('pan', panWarn && touched.pan ? 'ob-pan-warn' : null)}
              onChange={(e) => setPan(e.target.value)} onBlur={() => touch('pan')} />
            {show('pan') && <span id="ob-pan-err" className="error" role="status">{show('pan')}</span>}
            {panWarn && touched.pan && <span id="ob-pan-warn" className="field-warn" role="status">{panWarn}</span>}
          </label>
          <div className="field">
            <label htmlFor="ob-aadhaar">Aadhaar number</label>
            <span className="input-wrap has-toggle">
              {/* Plain text input (not type=password) so password managers never offer to save the Aadhaar; masked with CSS when hidden. */}
              <input id="ob-aadhaar" type="text" className={showAadhaar ? undefined : 'masked'} inputMode="numeric" autoComplete="off"
                data-lpignore="true" data-1p-ignore="" spellCheck={false} autoCorrect="off" autoCapitalize="off"
                value={groupAadhaar(aadhaar)} maxLength={14} placeholder="XXXX XXXX XXXX" required
                aria-invalid={show('aadhaar') ? true : undefined} aria-describedby={described('aadhaar', 'ob-aadhaar-mask')}
                onChange={(e) => setAadhaar(normalizeAadhaar(e.target.value).slice(0, 12))} onBlur={() => touch('aadhaar')} />
              <button type="button" className="toggle" aria-controls="ob-aadhaar" aria-pressed={showAadhaar}
                aria-label={showAadhaar ? 'Hide Aadhaar number' : 'Show Aadhaar number'}
                onClick={() => setShowAadhaar((v) => !v)}>{showAadhaar ? 'Hide' : 'Show'}</button>
            </span>
            <span id="ob-aadhaar-mask" className="muted small">{!errs.aadhaar ? maskAadhaar(aadhaar.slice(-4)) : 'XXXX XXXX XXXX'}</span>
            {show('aadhaar') && <span id="ob-aadhaar-err" className="error" role="status">{show('aadhaar')}</span>}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          I agree to share my Aadhaar for OTP verification.
        </label>
        <button className="btn primary" type="submit" disabled={!allValid || !consent || busy}>Continue</button>
      </Card>
    </form>
  );
}
