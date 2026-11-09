// Onboarding on Android / iOS (design C1): sign in (mobile or email) → contact OTP → your details → Aadhaar OTP (the only
// Aadhaar verification) → upload documents → check numbers → done. Same steps, rules and wording as
// apps/web/src/pages/Onboarding.tsx. All rules come from @wealthfire/core.
// Privacy: the full Aadhaar number, documents, FieldChecks and every OTP / request id live in component state only, never in AppData.
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  canSend, checkOutcome, DOC_MESSAGES, kycDemoCodeText, MAX_REREADS, resendIn, groupAadhaar, maskAadhaar, maskEmail, maskMobile, normalizeAadhaar, normalizeEmail, normalizeMobile, normalizePan,
  normalizeDob, onboardingReducer, OTP_RULES, DOB_HINT, DOB_LABEL, validateDob, panSurnameWarning, pruneSends, reviewFields, validateAadhaar, validateEmail, validateMobile, validateName,
  validatePan, type ContactKind, type DocFile, type DocKind, type FieldCheck, type KycField, type OtpChannel, type OtpProvider, type OtpVerifyResult,
} from '@wealthfire/core';
import { useStore } from '../store';
import { useOtpProvider } from '../otp';
import { useDocReader } from '../reader';
import { formatDobInput, isoToDmy, ServerKycPanel, startDetails, useKycServer } from '../server';
import { OnboardingBusyCtx, useBlockBackWhile, useOnboardingBackRef, useSignInNotice } from '../shell';
import { theme } from '../theme';
import { Btn, Chips, s, Screen } from '../ui';
import { CheckStep, DocumentsStep, dropDocs, type Docs } from './Documents';
import { Input, Link } from './onboardUi';

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
/** `cooldown`: the resend wait is still running. The button shows the live "Resend in 0:SS", so no error line (Bugs 4/5). */
type SendOutcome = { ok: true; at: string; code: PendingCode } | { ok: false; message: string; lockUntil?: string; cooldown?: boolean };

/** Checks the resend rules, then asks the provider for a code. Shared by the sign-in button and OtpStep. */
async function sendOtp(provider: OtpProvider, channel: OtpChannel, target: string, sends: string[], lockedUntil: string | null): Promise<SendOutcome> {
  const now = Date.now();
  const gate = canSend(pruneSends(sends, now), now, lockedUntil);
  if (!gate.ok) {
    if (gate.reason === 'cooldown') return { ok: false, message: resendIn(gate.waitMs), cooldown: true };
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

interface OtpStepProps {
  channel: OtpChannel;
  target: string;
  sends: string[];
  lockedUntil: string | null;
  initial?: PendingCode | null;
  /** Error from the send that opened this screen, if it failed. */
  initialError?: string;
  verifyLabel: string;
  demoText: (code: string) => string;
  onSent: (at: string) => void;
  onVerified: (r: Extract<OtpVerifyResult, { ok: true }>) => void;
  onLocked: (until: string) => void;
}

/** Same contract as apps/web/src/components/OtpStep.tsx. */
function OtpStep({ channel, target, sends, lockedUntil, initial, initialError, verifyLabel, demoText, onSent, onVerified, onLocked }: OtpStepProps) {
  // Contact codes go through the KYC server when one is set; the Aadhaar OTP stays on the device provider.
  const provider = useOtpProvider(channel === 'aadhaar' ? 'aadhaar' : 'contact');
  const [req, setReq] = useState<PendingCode | null>(initial ?? null);
  const [code, setCode] = useState('');
  const [error, setError] = useState(initialError ?? '');
  const [busy, setBusy] = useState(false);
  useBlockBackWhile(busy); // hardware Back does nothing while a send / verify runs
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true);

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
    if (!r.cooldown) setError(r.message); // cooldown: the button shows the countdown (Bug 4)
  }

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
          {/* Local KYC server only (no SMS or email): same 'DEMO code: …' line as web, under the code box */}
          {!provider.isDemo && req.demoCode ? (
            <Text style={[s.text, st.demoCode]} accessibilityLiveRegion="polite">{kycDemoCodeText(req.demoCode)}</Text>
          ) : null}
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
  const provider = useOtpProvider('contact');
  const { data } = useStore();
  const [kind, setKind] = useState<ContactKind>('mobile');
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [sendError, setSendError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  // Minor issue 3: "All data deleted." after Delete all data, shown on this screen once (memory only).
  const signInNotice = useSignInNotice();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { const t = signInNotice.take(); if (t) setNotice(t); }, [signInNotice]);
  const alive = useRef(true);
  const target = kind === 'email' ? normalizeEmail(value) : normalizeMobile(value);
  const err = kind === 'email' ? validateEmail(target) : validateMobile(target);
  const shown = touched && value !== '' ? err : null; // error after blur (Req 1.5)
  // Bug 5: live "Resend in 0:SS" on the button during the resend wait, same as web.
  const sends = data.onboarding.sends.contact;
  const gate = canSend(pruneSends(sends, now), now, null);
  const coolMs = !gate.ok && gate.reason === 'cooldown' ? gate.waitMs : 0;
  const cooling = coolMs > 0;

  useEffect(() => {
    alive.current = true;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive.current = false; clearInterval(t); };
  }, []);

  async function send() {
    if (err) { setTouched(true); return; }
    setBusy(true); setSendError('');
    const r = await sendOtp(provider, kind === 'email' ? 'email' : 'sms', target, sends, null);
    if (!alive.current) return;
    setBusy(false);
    if (r.ok) onSent(kind, target, r.at, r.code);
    else if (!r.cooldown) setSendError(r.message); // cooldown: the button shows the countdown (Bug 4)
  }

  return (
    <Screen feature="onboard-signin" title="Sign in">
      {notice ? <Text style={[s.text, { marginBottom: 10 }]} accessibilityLiveRegion="polite">{notice}</Text> : null}
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
      <Btn primary title={cooling ? resendIn(coolMs) : 'Send OTP'} disabled={busy || !!err || cooling} onPress={() => void send()} />
    </Screen>
  );
}

function IdentityStep({ onContinue }: { onContinue: (firstName: string, lastName: string, pan: string, dob: string, aadhaar: string) => Promise<void> }) {
  const { data } = useStore();
  const saved = data.onboarding.identity;
  const [first, setFirst] = useState(saved?.firstName ?? '');
  const [last, setLast] = useState(saved?.lastName ?? '');
  const [pan, setPan] = useState(saved?.pan ?? '');
  const [dob, setDob] = useState(isoToDmy(saved?.dob ?? ''));
  const [aadhaar, setAadhaarDigits] = useState(''); // full number: this screen's memory only
  const [hidden, setHidden] = useState(true);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false); // sending the Aadhaar OTP
  useBlockBackWhile(busy);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const touch = (k: string) => setTouched((t) => ({ ...t, [k]: true }));
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const panN = normalizePan(pan);
  const errs = { first: validateName(first), last: validateName(last), pan: validatePan(panN), dob: validateDob(dob), aadhaar: validateAadhaar(aadhaar) };
  const warn = touched.pan && !errs.pan && !errs.last ? panSurnameWarning(panN, last.trim()) : null;
  const valid = !errs.first && !errs.last && !errs.pan && !errs.dob && !errs.aadhaar && consent;

  return (
    <Screen feature="onboard-identity" title="Your details" intro="We need these to tie your account to you.">
      <Input label="First name" value={first} onChangeText={setFirst} onBlur={() => touch('first')} autoComplete="given-name"
        textContentType="givenName" maxLength={50} error={touched.first ? errs.first : null} />
      <Input label="Last name" value={last} onChangeText={setLast} onBlur={() => touch('last')} autoComplete="family-name"
        textContentType="familyName" maxLength={50} error={touched.last ? errs.last : null} />
      <Input label="PAN" value={pan} onChangeText={(t) => setPan(t.toUpperCase())} onBlur={() => touch('pan')} autoCapitalize="characters"
        autoCorrect={false} maxLength={10} placeholder="ABCPE1234F" error={touched.pan ? errs.pan : null} warn={warn} />
      {/* Date of birth (same label, hint and rules as web); checked with the KYC records (KRA name / DOB match). */}
      <Input label={DOB_LABEL} value={dob} onChangeText={(t) => setDob(formatDobInput(t))} onBlur={() => touch('dob')}
        keyboardType="number-pad" autoComplete="birthdate-full" textContentType="birthdate" maxLength={10} placeholder={DOB_HINT}
        error={touched.dob ? errs.dob : null} />
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
      <Btn primary title="Continue" disabled={!valid || busy} onPress={async () => {
        setBusy(true);
        await onContinue(first.trim(), last.trim(), panN, normalizeDob(dob), aadhaar);
        if (alive.current) { setBusy(false); setAadhaarDigits(''); }
      }} />
    </Screen>
  );
}

// Done-screen texts (Req 9.2, 9.3), same as web. A device-only match is 'pre-verified' (DOC_MESSAGES.donePreVerified);
// DOC_MESSAGES.doneVerified is only for a final KYC approval.
const DONE_REVIEW = "Your account is open. We're checking your details by hand, usually within 1 working day. You can use the planner meanwhile.";
const CONFIRM_FAILED = 'Could not confirm your numbers. Try again.';

/** Full-screen onboarding. Body shows it instead of the tabs until onboarding is done; onFinish opens Home. */
export function OnboardingScreen({ onFinish }: { onFinish: () => void }) {
  const provider = useOtpProvider();
  const reader = useDocReader();
  const { data, update } = useStore();
  const ob = data.onboarding;
  // Memory only (never in AppData): the full Aadhaar (typed, later the final one), the documents and the number checks.
  const [aadhaar, setAadhaar] = useState('');
  const [docs, setDocs] = useState<Docs>({});
  const [checks, setChecks] = useState<FieldCheck[] | null>(null);
  const [prevChecks, setPrevChecks] = useState<FieldCheck[] | null>(null); // checks before Back to Upload documents (Bug 1)
  const [pending, setPending] = useState<PendingCode | null>(null); // code sent just before the OTP screen opened
  const [pendingError, setPendingError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  // With a KYC server (app.json extra.apiUrl): the Done screen shows the final KYC panel.
  const server = useKycServer();
  const dispatch = useCallback((e: OnboardingEvent) => update((d) => ({ ...d, onboarding: onboardingReducer(d.onboarding, e) })), [update]);

  // Picked files sit in the app cache: delete them when this screen goes away (design B6).
  const docsRef = useRef<Docs>({});
  docsRef.current = docs;
  useEffect(() => () => dropDocs(docsRef.current), []);
  const setDoc = (k: DocKind, d: DocFile | undefined) => {
    setDocs((x) => ({ ...x, [k]: d }));
    // A replaced or removed card forgets its remembered read, so a hand check never shows the old file's mask.
    if (k !== 'selfie') setReads((r) => ({ ...r, [k]: undefined }));
  };
  // Name from Your details, checked against the name on each card (PAN and Aadhaar reads and re-reads).
  const cardName = ob.identity ? { first: ob.identity.firstName, last: ob.identity.lastName } : undefined;
  // Last successful read per card (full numbers, memory only), sent with a hand check; the store keeps masks only (minor issue 6).
  const [reads, setReads] = useState<Partial<Record<KycField, string>>>({});
  const onReadOk = (field: KycField, value: string) => setReads((r) => ({ ...r, [field]: value }));
  const clearKyc = () => { dropDocs(docsRef.current); setDocs({}); setChecks(null); setPrevChecks(null); setAadhaar(''); setReads({}); };
  // Bug 2: every failed read is counted; after enough of them (or with the reader unavailable) a hand check is offered.
  const onReadFailed = (field: KycField, unavailable: boolean) =>
    dispatch(unavailable ? { type: 'read-failed', field, unavailable: true } : { type: 'read-failed', field });
  // With a server the Done screen's panel asks the consent tick, then Start final KYC (POST /kyc/start); no start
  // without that tick, so nothing starts on its own when onboarding completes (same as web).
  // Sends all three documents for a hand check: Under review, then the done screen (same as web).
  const onHandCheck = (): boolean => {
    if (!docs.selfie || !docs.aadhaar || !docs.pan) return false;
    // Both cards go to the review: the failed one as unreadable, the other with its last successful read (masked by core).
    const ev: OnboardingEvent = { type: 'send-for-hand-check', at: new Date().toISOString(), reads };
    const after = onboardingReducer(ob, ev);
    if (after.step !== 'done') return false;
    dispatch(ev);
    clearKyc(); // documents, checks and the full Aadhaar are dropped when onboarding completes
    return true;
  };

  // After a restart the full Aadhaar is gone (never stored). Before the Aadhaar OTP passes: back to Your details.
  // After it passes the Aadhaar is locked: Upload documents asks for the number again instead (design C1).
  // A stored 'check' already opens on 'documents' after a reload (sanitizeOnboarding).
  const lostMemory = ob.step === 'aadhaar-otp' && !aadhaar;
  useEffect(() => {
    if (lostMemory) dispatch({ type: 'back-to-identity' });
  }, [lostMemory, dispatch]);
  // Check numbers with no checks in memory (only if this screen was re-created mid-step): back to Upload documents.
  const lostChecks = ob.step === 'check' && !checks;
  useEffect(() => {
    if (lostChecks) dispatch({ type: 'back-to-documents' });
  }, [lostChecks, dispatch]);

  // Minor issue 5: Android hardware Back does what the step's own Back does (Change contact on the contact OTP,
  // Back to Your details on the Aadhaar OTP, Back to Upload documents on Check numbers). Steps without a Back
  // (Sign in, Your details, done) return false, so Android closes the app as usual. Upload documents ignores Back
  // so the documents held in memory are not lost; so does any step while a read, re-read or OTP call is running.
  const backRef = useOnboardingBackRef();
  const busyCount = useContext(OnboardingBusyCtx);
  const hardwareBack = useRef<() => boolean>(() => false);
  hardwareBack.current = () => {
    if (busyCount.current > 0) return true;
    if (ob.step === 'documents') return true;
    if (ob.step === 'otp') { changeContact(); return true; }
    if (ob.step === 'aadhaar-otp' && aadhaar) { backToIdentity(); return true; }
    if (ob.step === 'check' && checks) { backToDocuments(checks); return true; }
    return false;
  };
  useEffect(() => {
    if (!backRef) return;
    backRef.current = () => hardwareBack.current();
    return () => { backRef.current = null; };
  }, [backRef]);
  function changeContact() { setPending(null); dispatch({ type: 'change-contact' }); }
  function backToIdentity() { setPending(null); setPendingError(''); setAadhaar(''); dispatch({ type: 'back-to-identity' }); }
  function backToDocuments(cs: FieldCheck[]) { setPrevChecks(cs); setChecks(null); dispatch({ type: 'back-to-documents' }); }

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
          <Link title="Change" label={c.kind === 'email' ? 'Change email' : 'Change mobile number'} onPress={changeContact} />
        </View>
        <OtpStep channel={c.kind === 'email' ? 'email' : 'sms'} target={c.value} sends={ob.sends.contact} lockedUntil={null} initial={pending}
          verifyLabel="Verify" demoText={DEMO_CONTACT}
          onSent={(at) => dispatch({ type: 'otp-sent', channel: 'contact', at, contact: { kind: c.kind, value: c.value } })}
          onVerified={() => { setPending(null); dispatch({ type: 'contact-verified', at: new Date().toISOString() }); }}
          onLocked={() => {}} />
      </Screen>
    );
  }

  if (ob.step === 'identity' || lostMemory) {
    return (
      <IdentityStep onContinue={async (firstName, lastName, pan, dob, digits) => {
        clearKyc();
        // The one Aadhaar OTP goes to the number typed here, then the Aadhaar OTP screen opens (design C1).
        const r = await sendOtp(provider, 'aadhaar', digits, ob.sends.aadhaar, ob.aadhaarLockedUntil);
        setAadhaar(digits);
        setPending(r.ok ? r.code : null);
        setPendingError(r.ok || r.cooldown ? '' : r.message); // cooldown: OtpStep's button shows the countdown
        dispatch({ type: 'identity-saved', firstName, lastName, pan, dob, at: new Date().toISOString() });
        if (r.ok) dispatch({ type: 'otp-sent', channel: 'aadhaar', at: r.at });
        else if (r.lockUntil) dispatch({ type: 'aadhaar-locked', until: r.lockUntil });
      }} />
    );
  }

  if (ob.step === 'documents' && ob.aadhaar) {
    return (
      <DocumentsStep docs={docs} setDoc={setDoc} typed={{ pan: ob.identity?.pan ?? '', aadhaar }} name={cardName} verifiedLast4={ob.aadhaar.last4}
        kyc={ob.kyc} previous={prevChecks} onReadFailed={onReadFailed} onReadOk={onReadOk} onHandCheck={onHandCheck}
        onRead={(cs, full) => {
          setAadhaar(full); // re-typed after a reload / Redo documents: kept for this session only
          // Re-reads already used this session or before a reload still count (Req 8.8), same as web.
          // Bug 1: a read after Back counts as a re-read; 'documents-ready' adds it in the store, so seed the same count here.
          const counted = (f: KycField) =>
            ob.kyc.returnedFromCheck ? Math.min(MAX_REREADS, ob.kyc.rereads[f] + 1) : ob.kyc.rereads[f];
          setChecks(cs.map((c) => ({ ...c, rereads: Math.min(MAX_REREADS, Math.max(c.rereads, counted(c.field))) })));
          setPrevChecks(null);
          dispatch({ type: 'documents-ready', at: new Date().toISOString(), reader: reader.id }); }} />
    );
  }

  if (ob.step === 'check' && checks) {
    return (
      <CheckStep checks={checks} setChecks={setChecks} docs={docs} setDoc={setDoc} name={cardName} confirming={false} error={confirmError}
        kyc={ob.kyc} onReadFailed={onReadFailed} onReadOk={onReadOk} onHandCheck={onHandCheck}
        onRereadUsed={(field) => dispatch({ type: 'reread-used', field })}
        onBack={() => backToDocuments(checks)}
        onConfirm={() => {
          // Confirm finishes onboarding (design C1): no second Aadhaar OTP. Any field still differing goes to manual review.
          const outcome = checkOutcome(checks);
          const pan = checks.find((c) => c.field === 'pan')?.final ?? ob.identity?.pan ?? '';
          const ev: OnboardingEvent = { type: 'check-confirmed', match: outcome.match, pan, fields: reviewFields(checks), at: new Date().toISOString() };
          // The reducer refuses a confirm it cannot accept; keep this screen and its data instead of dropping them.
          const after = onboardingReducer(ob, ev);
          if (after.step !== 'done') { setConfirmError(CONFIRM_FAILED); return; }
          setConfirmError('');
          dispatch(ev);
          clearKyc(); // documents, checks and the full Aadhaar are dropped when onboarding completes
        }} />
    );
  }

  if (ob.step === 'aadhaar-otp' && aadhaar) {
    return (
      <Screen feature="onboard-aadhaar-otp" title="Verify Aadhaar">
        <Text style={[s.text, { marginBottom: 10 }]}>Enter the OTP sent to the mobile linked with Aadhaar {maskAadhaar(aadhaar.slice(-4))}.</Text>
        <OtpStep channel="aadhaar" target={aadhaar} sends={ob.sends.aadhaar} lockedUntil={ob.aadhaarLockedUntil} initial={pending} initialError={pendingError}
          verifyLabel="Verify Aadhaar" demoText={DEMO_AADHAAR}
          onSent={(at) => dispatch({ type: 'otp-sent', channel: 'aadhaar', at })}
          onVerified={(r) => {
            const last4 = r.aadhaarLast4 ?? aadhaar.slice(-4);
            setPending(null); setPendingError('');
            // Opens Upload documents. The full Aadhaar stays in screen memory until Confirm on Check numbers (design C1).
            dispatch({ type: 'aadhaar-verified', last4, at: new Date().toISOString(), provider: provider.id });
          }}
          onLocked={(until) => dispatch({ type: 'aadhaar-locked', until })} />
        {/* Back to Your details to fix the Aadhaar number; only possible before the OTP passes. */}
        <Link title="Back" onPress={backToIdentity} />
      </Screen>
    );
  }

  if (ob.step === 'check' || (ob.step === 'documents' && !ob.aadhaar)) {
    // Check numbers without checks in memory: the effect above returns to Upload documents. Documents without a
    // verified Aadhaar cannot be stored (sanitizeOnboarding). Nothing to show meanwhile.
    return null;
  }

  if (ob.step === 'done') {
    const first = ob.identity?.firstName;
    return (
      <Screen feature="onboard-aadhaar-otp" title={first ? `You're all set, ${first}.` : "You're all set."}
        intro={ob.kyc.status === 'verified' ? DOC_MESSAGES.doneVerified : ob.kyc.status === 'pre-verified' ? DOC_MESSAGES.donePreVerified : DONE_REVIEW}>
        {/* With a server: final KYC status and its next step (DigiLocker, selfie, e-sign or the wait text + Refresh). */}
        {server ? <ServerKycPanel details={startDetails(ob)} /> : null}
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
  demoCode: { fontWeight: '600', marginBottom: 8 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 10, minHeight: 44 },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: theme.line, alignItems: 'center', justifyContent: 'center' },
  boxOn: { borderColor: theme.accent, backgroundColor: theme.accent },
  tick: { color: theme.bg, fontWeight: '800' },
});
