// Onboarding on Android / iOS: sign in (mobile or email) → contact OTP → your details → Aadhaar OTP → done.
// Same steps, rules and wording as apps/web/src/pages/Onboarding.tsx. All rules come from @wealthfire/core.
// Privacy: the full Aadhaar number and every OTP / request id live in component state only, never in AppData.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import {
  canSend, groupAadhaar, maskAadhaar, maskEmail, maskMobile, normalizeAadhaar, normalizeEmail, normalizeMobile, normalizePan, onboardingReducer,
  OTP_RULES, panSurnameWarning, pruneSends, validateAadhaar, validateEmail, validateMobile, validateName, validatePan,
  type ContactKind, type OtpChannel, type OtpProvider, type OtpVerifyResult,
} from '@wealthfire/core';
import { useStore } from '../store';
import { useOtpProvider } from '../otp';
import { theme } from '../theme';
import { Btn, Chips, s, Screen } from '../ui';

type OnboardingEvent = Parameters<typeof onboardingReducer>[1];
interface PendingCode { requestId: string; demoCode?: string }

const DEMO_CONTACT = (code: string) => `Demo mode: no real SMS or email is sent. Your code is ${code}.`;
const DEMO_AADHAAR = (code: string) =>
  `Demo mode: no real Aadhaar OTP is sent. Your code is ${code}. In the live app this comes from UIDAI to your Aadhaar-linked mobile.`;

// Same text as apps/web/src/components/OtpStep.tsx.
const tooMany = (ms: number) => {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return `Too many tries. Try again in ${m} minute${m === 1 ? '' : 's'}.`;
};
const clock = (ms: number) => {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const resendIn = (ms: number) => `Resend in ${clock(ms)}`;

type SendOutcome = { ok: true; at: string; code: PendingCode } | { ok: false; message: string; lockUntil?: string };

/** Checks the resend rules, then asks the provider for a code. Shared by the sign-in button and OtpStep. */
async function sendOtp(provider: OtpProvider, channel: OtpChannel, target: string, sends: string[], lockedUntil: string | null): Promise<SendOutcome> {
  const now = Date.now();
  const gate = canSend(pruneSends(sends, now), now, lockedUntil);
  if (!gate.ok) {
    if (gate.reason === 'cooldown') return { ok: false, message: resendIn(gate.waitMs) };
    if (gate.reason === 'limit' && channel === 'aadhaar') {
      return { ok: false, message: tooMany(OTP_RULES.aadhaarLockMs), lockUntil: new Date(now + OTP_RULES.aadhaarLockMs).toISOString() };
    }
    return { ok: false, message: tooMany(gate.waitMs) };
  }
  try {
    const r = await provider.send({ channel, target }, now);
    if (!r.ok) return { ok: false, message: r.message };
    return { ok: true, at: new Date(now).toISOString(), code: { requestId: r.requestId, demoCode: r.demoCode } };
  } catch {
    return { ok: false, message: 'Could not send the code. Check your connection and try again.' };
  }
}

function Input({ label, error, warn, ...rest }: TextInputProps & { label: string; error?: string | null; warn?: string | null }) {
  return (
    <View style={s.field}>
      <Text style={s.muted}>{label}</Text>
      <TextInput accessibilityLabel={label} accessibilityHint={error ?? warn ?? undefined} style={[s.input, error ? { borderColor: theme.bad } : null]}
        placeholderTextColor={theme.muted} {...rest} />
      {error ? <Text style={[st.msg, { color: theme.bad }]} accessibilityLiveRegion="polite">{error}</Text> : null}
      {!error && warn ? <Text style={[st.msg, { color: theme.warn }]} accessibilityLiveRegion="polite">{warn}</Text> : null}
    </View>
  );
}

function Link({ title, label, onPress }: { title: string; label?: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label ?? title} onPress={onPress} hitSlop={10} style={st.link}>
      <Text style={st.linkText}>{title}</Text>
    </Pressable>
  );
}

interface OtpStepProps {
  channel: OtpChannel;
  target: string;
  sends: string[];
  lockedUntil: string | null;
  initial?: PendingCode | null;
  autoSend?: boolean;
  verifyLabel: string;
  demoText: (code: string) => string;
  onSent: (at: string) => void;
  onVerified: (r: Extract<OtpVerifyResult, { ok: true }>) => void;
  onLocked: (until: string) => void;
}

/** Same contract as apps/web/src/components/OtpStep.tsx. */
function OtpStep({ channel, target, sends, lockedUntil, initial, autoSend, verifyLabel, demoText, onSent, onVerified, onLocked }: OtpStepProps) {
  const provider = useOtpProvider();
  const [req, setReq] = useState<PendingCode | null>(initial ?? null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true);
  const autoSent = useRef(false);

  useEffect(() => {
    alive.current = true;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive.current = false; clearInterval(t); };
  }, []);

  const lockMs = lockedUntil ? Date.parse(lockedUntil) - now : 0;
  const locked = lockMs > 0;
  const gate = canSend(pruneSends(sends, now), now, lockedUntil);
  const coolMs = !gate.ok && gate.reason === 'cooldown' ? gate.waitMs : 0;
  const cooling = coolMs > 0;

  async function send() {
    setBusy(true); setError('');
    const r = await sendOtp(provider, channel, target, sends, lockedUntil);
    if (!alive.current) return;
    setBusy(false);
    if (r.ok) { setReq(r.code); setCode(''); onSent(r.at); return; }
    if (r.lockUntil) onLocked(r.lockUntil);
    setError(r.message);
  }

  useEffect(() => {
    if (autoSend && !req && !locked && !autoSent.current) { autoSent.current = true; void send(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify() {
    if (!req) return;
    setBusy(true); setError('');
    let r: OtpVerifyResult;
    try {
      r = await provider.verify(req.requestId, code, Date.now());
    } catch {
      r = { ok: false, reason: 'network', message: 'Could not check the code. Check your connection and try again.' };
    }
    if (!alive.current) return;
    setBusy(false);
    if (r.ok) { setReq(null); setCode(''); onVerified(r); return; }
    setCode('');
    if (r.reason === 'void' || r.reason === 'expired') setReq(null);
    if (r.reason === 'void' && channel === 'aadhaar') {
      // 5 wrong tries on the Aadhaar code lock the step for 30 minutes (Req 4.9).
      onLocked(new Date(Date.now() + OTP_RULES.aadhaarLockMs).toISOString());
      setError(tooMany(OTP_RULES.aadhaarLockMs));
      return;
    }
    setError(r.message);
  }

  if (locked) {
    return <Text style={[st.msg, { color: theme.bad }]} accessibilityLiveRegion="polite">{tooMany(lockMs)}</Text>;
  }

  return (
    <View>
      {provider.isDemo && req?.demoCode ? (
        <View style={st.demo} accessibilityLiveRegion="polite"><Text style={s.text}>{demoText(req.demoCode)}</Text></View>
      ) : null}
      {req ? (
        <>
          <Input label="6-digit code" value={code} onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, OTP_RULES.length))}
            keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="sms-otp" maxLength={OTP_RULES.length + 6}
            placeholder="123456" error={error || null} />
          <Btn primary title={verifyLabel} disabled={busy || code.length !== OTP_RULES.length} onPress={() => void verify()} />
          <Btn title={cooling ? resendIn(coolMs) : 'Resend OTP'} disabled={busy || cooling} onPress={() => void send()} />
        </>
      ) : (
        <>
          {error ? <Text style={[st.msg, { color: theme.bad }]} accessibilityLiveRegion="polite">{error}</Text> : null}
          <Btn primary title={cooling ? resendIn(coolMs) : 'Send OTP'} disabled={busy || cooling} onPress={() => void send()} />
        </>
      )}
    </View>
  );
}

function SignInStep({ onSent }: { onSent: (kind: ContactKind, value: string, at: string, code: PendingCode) => void }) {
  const provider = useOtpProvider();
  const { data } = useStore();
  const [kind, setKind] = useState<ContactKind>('mobile');
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [sendError, setSendError] = useState('');
  const [busy, setBusy] = useState(false);
  const target = kind === 'email' ? normalizeEmail(value) : normalizeMobile(value);
  const err = kind === 'email' ? validateEmail(target) : validateMobile(target);
  const shown = touched && value !== '' ? err : null; // error after blur (Req 1.5)

  async function send() {
    if (err) { setTouched(true); return; }
    setBusy(true); setSendError('');
    const r = await sendOtp(provider, kind === 'email' ? 'email' : 'sms', target, data.onboarding.sends.contact, null);
    setBusy(false);
    if (r.ok) onSent(kind, target, r.at, r.code);
    else setSendError(r.message);
  }

  return (
    <Screen feature="onboard-signin" title="Sign in">
      <Text style={[s.muted, { marginBottom: 6 }]}>Sign in with</Text>
      <Chips label="Sign in with" value={kind} onChange={(k) => { setKind(k); setValue(''); setTouched(false); setSendError(''); }}
        options={[{ label: 'Mobile number', value: 'mobile' as const }, { label: 'Email', value: 'email' as const }]} />
      <View style={{ height: 12 }} />
      {kind === 'mobile' ? (
        <View style={st.prefixRow}>
          <Text style={st.prefix} accessibilityLabel="Country code plus 91">+91</Text>
          <View style={{ flex: 1 }}>
            <Input label="Mobile number" value={value} onChangeText={setValue} onBlur={() => setTouched(true)}
              keyboardType="phone-pad" textContentType="telephoneNumber" autoComplete="tel" maxLength={14} placeholder="98765 43210"
              error={shown} />
          </View>
        </View>
      ) : (
        <Input label="Email" value={value} onChangeText={setValue} onBlur={() => setTouched(true)}
          keyboardType="email-address" autoCapitalize="none" autoCorrect={false} textContentType="emailAddress" autoComplete="email"
          maxLength={254} placeholder="you@example.com" error={shown} />
      )}
      {sendError ? <Text style={[st.msg, { color: theme.bad }]} accessibilityLiveRegion="polite">{sendError}</Text> : null}
      <Btn primary title="Send OTP" disabled={busy || !!err} onPress={() => void send()} />
    </Screen>
  );
}

function IdentityStep({ onContinue }: { onContinue: (firstName: string, lastName: string, pan: string, aadhaar: string) => void }) {
  const { data } = useStore();
  const saved = data.onboarding.identity;
  const [first, setFirst] = useState(saved?.firstName ?? '');
  const [last, setLast] = useState(saved?.lastName ?? '');
  const [pan, setPan] = useState(saved?.pan ?? '');
  const [aadhaar, setAadhaarDigits] = useState(''); // full number: this screen's memory only
  const [hidden, setHidden] = useState(true);
  const [consent, setConsent] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const touch = (k: string) => setTouched((t) => ({ ...t, [k]: true }));

  const panN = normalizePan(pan);
  const errs = { first: validateName(first), last: validateName(last), pan: validatePan(panN), aadhaar: validateAadhaar(aadhaar) };
  const warn = touched.pan && !errs.pan && !errs.last ? panSurnameWarning(panN, last.trim()) : null;
  const valid = !errs.first && !errs.last && !errs.pan && !errs.aadhaar && consent;

  return (
    <Screen feature="onboard-identity" title="Your details" intro="We need these to tie your account to you.">
      <Input label="First name" value={first} onChangeText={setFirst} onBlur={() => touch('first')} autoComplete="given-name"
        textContentType="givenName" maxLength={50} error={touched.first ? errs.first : null} />
      <Input label="Last name" value={last} onChangeText={setLast} onBlur={() => touch('last')} autoComplete="family-name"
        textContentType="familyName" maxLength={50} error={touched.last ? errs.last : null} />
      <Input label="PAN" value={pan} onChangeText={(t) => setPan(t.toUpperCase())} onBlur={() => touch('pan')} autoCapitalize="characters"
        autoCorrect={false} maxLength={10} placeholder="ABCPE1234F" error={touched.pan ? errs.pan : null} warn={warn} />
      <Input label="Aadhaar number" value={groupAadhaar(aadhaar)} onChangeText={(t) => setAadhaarDigits(normalizeAadhaar(t).slice(0, 12))}
        onBlur={() => touch('aadhaar')} keyboardType="number-pad" secureTextEntry={hidden} textContentType="none" autoComplete="off" importantForAutofill="no"
        autoCorrect={false} maxLength={14} placeholder="XXXX XXXX XXXX" error={touched.aadhaar ? errs.aadhaar : null} />
      <View style={st.row}>
        <Text style={[s.small, { flex: 1 }]}>{!errs.aadhaar ? maskAadhaar(aadhaar.slice(-4)) : 'XXXX XXXX XXXX'}</Text>
        <Link title={hidden ? 'Show' : 'Hide'} label={hidden ? 'Show Aadhaar number' : 'Hide Aadhaar number'} onPress={() => setHidden((h) => !h)} />
      </View>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: consent }} onPress={() => setConsent((c) => !c)} style={st.check}>
        <View style={[st.box, consent && st.boxOn]}>{consent ? <Text style={st.tick}>✓</Text> : null}</View>
        <Text style={[s.text, { flex: 1 }]}>I agree to share my Aadhaar for OTP verification.</Text>
      </Pressable>
      <Btn primary title="Continue" disabled={!valid} onPress={() => {
        const digits = aadhaar;
        setAadhaarDigits('');
        onContinue(first.trim(), last.trim(), panN, digits);
      }} />
    </Screen>
  );
}

/** Full-screen onboarding. Body shows it instead of the tabs until onboarding is done; onFinish opens Home. */
export function OnboardingScreen({ onFinish }: { onFinish: () => void }) {
  const provider = useOtpProvider();
  const { data, update } = useStore();
  const ob = data.onboarding;
  const [aadhaar, setAadhaar] = useState(''); // full Aadhaar, memory only; cleared on verify, Back and unmount
  const [pending, setPending] = useState<PendingCode | null>(null); // contact code sent from the sign-in step
  const dispatch = useCallback((e: OnboardingEvent) => update((d) => ({ ...d, onboarding: onboardingReducer(d.onboarding, e) })), [update]);

  // After a restart the Aadhaar number is gone (never stored), so the user re-enters it on Your details.
  useEffect(() => {
    if (ob.step === 'aadhaar-otp' && !aadhaar) dispatch({ type: 'back-to-identity' });
  }, [ob.step, aadhaar, dispatch]);

  if (ob.step === 'signin') {
    return <SignInStep onSent={(kind, value, at, code) => { setPending(code); dispatch({ type: 'otp-sent', channel: 'contact', at, contact: { kind, value } }); }} />;
  }

  if (ob.step === 'otp' && ob.contact) {
    const c = ob.contact;
    const masked = c.kind === 'email' ? maskEmail(c.value) : maskMobile(c.value);
    return (
      <Screen feature="onboard-otp" title={c.kind === 'email' ? 'Verify your email' : 'Verify your mobile number'}>
        <View style={st.row}>
          <Text style={[s.text, { flex: 1 }]}>We sent a code to {masked}.</Text>
          <Link title="Change" label={c.kind === 'email' ? 'Change email' : 'Change mobile number'} onPress={() => { setPending(null); dispatch({ type: 'change-contact' }); }} />
        </View>
        <OtpStep channel={c.kind === 'email' ? 'email' : 'sms'} target={c.value} sends={ob.sends.contact} lockedUntil={null} initial={pending}
          verifyLabel="Verify" demoText={DEMO_CONTACT}
          onSent={(at) => dispatch({ type: 'otp-sent', channel: 'contact', at, contact: { kind: c.kind, value: c.value } })}
          onVerified={() => { setPending(null); dispatch({ type: 'contact-verified', at: new Date().toISOString() }); }}
          onLocked={() => {}} />
      </Screen>
    );
  }

  if (ob.step === 'identity' || (ob.step === 'aadhaar-otp' && !aadhaar)) {
    return <IdentityStep onContinue={(firstName, lastName, pan, digits) => { setAadhaar(digits); dispatch({ type: 'identity-saved', firstName, lastName, pan }); }} />;
  }

  if (ob.step === 'aadhaar-otp' && aadhaar) {
    return (
      <Screen feature="onboard-aadhaar-otp" title="Verify Aadhaar">
        <Text style={[s.text, { marginBottom: 10 }]}>Enter the OTP sent to the mobile linked with Aadhaar {maskAadhaar(aadhaar.slice(-4))}.</Text>
        <OtpStep channel="aadhaar" target={aadhaar} sends={ob.sends.aadhaar} lockedUntil={ob.aadhaarLockedUntil} autoSend
          verifyLabel="Verify Aadhaar" demoText={DEMO_AADHAAR}
          onSent={(at) => dispatch({ type: 'otp-sent', channel: 'aadhaar', at })}
          onVerified={(r) => {
            const last4 = r.aadhaarLast4 ?? aadhaar.slice(-4);
            setAadhaar('');
            dispatch({ type: 'aadhaar-verified', last4, at: new Date().toISOString(), provider: provider.id });
          }}
          onLocked={(until) => dispatch({ type: 'aadhaar-locked', until })} />
        <Link title="Back" onPress={() => { setAadhaar(''); dispatch({ type: 'back-to-identity' }); }} />
      </Screen>
    );
  }

  if (ob.step === 'done') {
    return (
      <Screen feature="onboard-aadhaar-otp" title={ob.identity ? `You're all set, ${ob.identity.firstName}.` : "You're all set."}
        intro="Your contact and Aadhaar are verified.">
        <Btn primary title="Go to Home" onPress={onFinish} />
      </Screen>
    );
  }

  if (ob.step === 'otp') {
    // 'otp' with no contact cannot happen through the reducer; let the user start again (same as web).
    return (
      <Screen feature="onboard-signin" title="Sign in">
        <Btn primary title="Start again" onPress={() => dispatch({ type: 'change-contact' })} />
      </Screen>
    );
  }

  return null;
}

const st = StyleSheet.create({
  msg: { fontSize: 13, marginTop: 4 },
  link: { paddingVertical: 10, minHeight: 44, justifyContent: 'center' },
  linkText: { color: theme.accent, fontWeight: '700', fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  prefixRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  prefix: { color: theme.text, fontSize: 15, marginTop: 30, paddingHorizontal: 10, paddingVertical: 11, backgroundColor: theme.panel2, borderColor: theme.line, borderWidth: 1, borderRadius: 9 },
  demo: { backgroundColor: theme.panel2, borderColor: theme.warn, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 12 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 10, minHeight: 44 },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: theme.line, alignItems: 'center', justifyContent: 'center' },
  boxOn: { borderColor: theme.accent, backgroundColor: theme.accent },
  tick: { color: theme.bg, fontWeight: '800' },
});
