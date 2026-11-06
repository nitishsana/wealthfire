// Onboarding journey (design D5 + B5 + C1): sign in → contact OTP → your details → Aadhaar OTP (the only
// Aadhaar verification) → upload documents → check your numbers → "You're all set".
// The full Aadhaar, the documents, the number checks and OTP codes stay in component state only;
// AppData keeps the final PAN, Aadhaar last 4 and masked review fields.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  applyReread, canReread, canSend, canSendForHandCheck, checkOutcome, countsAsFailedRead, confirmAadhaarRetype, DOC_MESSAGES, groupAadhaar, initialChecks, MAX_REREADS, maskAadhaar,
  maskEmail, maskMobile, normalizeAadhaar, normalizeEmail, normalizeMobile, normalizePan, onboardingReducer, panSurnameWarning,
  readBlocked, readsLeft, resendIn, reviewFields, sameDocument, takeDocumentNumber, validateAadhaar, validateEmail, validateMobile, validateName, validatePan,
  type ContactKind, type DocFile, type DocKind, type FieldCheck, type KycField, type OnboardingEvent,
} from '@wealthfire/core';
import { useStore } from '../store';
import { otpProvider } from '../otp';
import * as readerModule from '../docreader';
import { documentReader } from '../docreader';
import { OtpStep, requestOtp, type OtpRequest } from '../components/OtpStep';
import { DOC_LABEL, DocPreview, DocSlot } from '../components/DocSlot';
import { PdfPassword } from '../components/PdfPassword';
import { Card, Disclaimer } from '../ui';

interface Props {
  /** Called just before "Confirm" on Check numbers completes onboarding, so the shell keeps showing "You're all set". */
  onCompleting: () => void;
  /** "Go to Home". */
  onFinish: () => void;
}

type Docs = Record<DocKind, DocFile | null>;
const NO_DOCS: Docs = { selfie: null, aadhaar: null, pan: null };
const DOC_KINDS: DocKind[] = ['selfie', 'aadhaar', 'pan'];

export const UNDER_REVIEW_TEXT = "Your account is open. We're checking your details by hand, usually within 1 working day. You can use the planner meanwhile.";
export const RETYPE_AADHAAR_LABEL = 'Enter your Aadhaar number again';
export const CONFIRM_FAILED = 'Could not confirm your numbers. Try again.';
/** Must-fix 1: shown on a local Upload documents view when another tab already reached Check numbers. */
export const MOVED_ON_IN_OTHER_TAB = 'Your onboarding moved on in another tab. Continue here by reading your documents again, or switch to that tab.';
/** Shown on a local Your details view when the stored step is Aadhaar OTP but this tab has no full Aadhaar. */
export const RETYPE_FOR_NEW_OTP = 'Enter your Aadhaar number again to get a new OTP.';
/** Same text as phones (mobile-ui Documents HAND_CHECK_FAILED). */
export const HAND_CHECK_FAILED = 'Could not send your documents. Try again.';
/** Shown once on Sign in right after Settings → "Delete all data" (the gate switches to Sign in at once). */
export const DATA_DELETED_TEXT = 'All data deleted.';
const DATA_DELETED_KEY = 'wealthfire.dataDeleted';
/** Settings calls this just before deleting, so Sign in can say the data was deleted. */
export function markDataDeleted() {
  try { window.sessionStorage.setItem(DATA_DELETED_KEY, '1'); } catch { /* storage blocked: no message */ }
}
function dataDeletedFlag(): boolean {
  try { return window.sessionStorage.getItem(DATA_DELETED_KEY) === '1'; } catch { return false; }
}
function clearDataDeletedFlag() {
  try { window.sessionStorage.removeItem(DATA_DELETED_KEY); } catch { /* storage blocked */ }
}
const couldNotRead = DOC_MESSAGES.unreadable;

/** Shared match label ("✅ Match") with the emoji hidden from screen readers. */
function MatchLabel({ matched }: { matched: boolean }) {
  const [icon, ...rest] = Array.from(matched ? DOC_MESSAGES.matchLabel : DOC_MESSAGES.mismatchLabel);
  return <><span aria-hidden="true">{icon}</span>{rest.join('')}</>;
}

/**
 * `failed`: the reader returned !ok (or threw), so a 'read-failed' event is sent.
 * `unavailable`: reading can't work here at all (reader unavailable in this build, or the OCR files didn't load).
 */
type ReadOutcome = { value: string; nameMatch: boolean | null } | { error: string; locked?: boolean; failed?: { unavailable: boolean } };
/** Sends 'read-failed' for one card (review bug 2). */
type ReadFailed = (field: KycField, unavailable: boolean) => void;
/** Notes the full number of a successful read (memory only), sent with a hand check (minor 6); null forgets it. */
type ReadOk = (field: KycField, value: string | null) => void;
/** The name entered in "Your details", checked against the name on each card. */
type PersonName = { first: string; last: string };
type ReadValue = { value: string; nameMatch: boolean | null };

/** A PAN-shaped number whose 4th letter is not P (company, firm, trust…). */
const isCompanyPan = (v: string) => /^[A-Z]{3}[ABCFGHLJT][A-Z]\d{4}[A-Z]$/.test(normalizePan(v));

/**
 * Strict or normal read of one card; returns the number or the reader's message to show under the slot.
 * `password` opens a locked PDF for this one read only. `locked` = the PDF needs a (correct) password.
 */
async function readNumber(doc: DocFile, field: KycField, strict: boolean, expected: string, name: PersonName | undefined,
  password?: string): Promise<ReadOutcome> {
  try {
    const r = await documentReader.read(doc, field, {
      strict, expected, ...(name ? { name } : {}), ...(password ? { password } : {}),
    });
    // Minor 6: core decides which reads count toward the hand check (every failed read, company PAN included).
    if (!r.ok && r.reason === 'locked') {
      return { error: r.message || (password ? DOC_MESSAGES.wrongPdfPassword : DOC_MESSAGES.pdfLocked), locked: true,
        ...(countsAsFailedRead(r) ? { failed: { unavailable: false } } : {}) };
    }
    // notPan / notAadhaar / maskedAadhaar / companyPan / readerUnavailable / unreadable / file / network messages come from the reader.
    if (!r.ok) {
      const unavailable = r.reason === 'network' || (r.reason === 'unreadable' && r.message === DOC_MESSAGES.readerUnavailable);
      return { error: r.message || couldNotRead(field), ...(countsAsFailedRead(r) ? { failed: { unavailable } } : {}) };
    }
    // A number the reader returned but that is not a usable personal card number is a failed read too.
    if (field === 'pan' && isCompanyPan(r.value)) return { error: DOC_MESSAGES.companyPan, failed: { unavailable: false } };
    const bad = field === 'pan' ? validatePan(r.value) : validateAadhaar(r.value);
    if (bad) return { error: couldNotRead(field), failed: { unavailable: false } };
    return { value: field === 'pan' ? normalizePan(r.value) : normalizeAadhaar(r.value), nameMatch: r.nameMatch ?? null };
  } catch {
    // The reader itself failed (same message as reason 'network').
    return { error: DOC_MESSAGES.couldNotReadDocs, failed: { unavailable: true } };
  }
}

/** Review bug 2: a way past cards that can't be read. Shown once canSendForHandCheck(kyc) allows it. */
function HandCheck({ disabled, onSend }: { disabled: boolean; onSend: () => boolean }) {
  const [error, setError] = useState('');
  return (
    <div className="hand-check" data-feature="onboard-hand-check">
      <p className="muted" id="hand-check-note">{DOC_MESSAGES.handCheckNote}</p>
      <button type="button" className="btn" disabled={disabled} aria-describedby="hand-check-note"
        onClick={() => setError(onSend() ? '' : HAND_CHECK_FAILED)}>
        {DOC_MESSAGES.handCheckButton}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

type ProgressSubscribe = (cb: (p: number) => void) => () => void;

/** Optional reading progress from the web reader (`onProgress` export or method), if it offers one. */
function progressSource(): ProgressSubscribe | null {
  const mod = readerModule as unknown as { onProgress?: unknown };
  if (typeof mod.onProgress === 'function') return mod.onProgress as ProgressSubscribe;
  const r = documentReader as unknown as { onProgress?: unknown };
  if (typeof r.onProgress === 'function') return (cb) => (r.onProgress as ProgressSubscribe).call(documentReader, cb);
  return null;
}

/** Percentage (0–100) while `active`, or null when the reader gives no progress. */
function useReadProgress(active: boolean): number | null {
  const [pct, setPct] = useState<number | null>(null);
  useEffect(() => {
    setPct(null);
    if (!active) return;
    const sub = progressSource();
    if (!sub) return;
    const off = sub((p) => {
      if (!Number.isFinite(p)) return;
      const v = p <= 1 ? p * 100 : p; // accept 0–1 or 0–100
      setPct(Math.max(0, Math.min(100, Math.round(v))));
    });
    return () => { if (typeof off === 'function') off(); };
  }, [active]);
  return pct;
}

function ReadingStatus({ active }: { active: boolean }) {
  const pct = useReadProgress(active);
  if (!active) return null;
  return <p role="status" className="muted">Reading your documents…{pct !== null ? ` ${pct}%` : ''}</p>;
}

export function OnboardingPage({ onCompleting, onFinish }: Props) {
  const { data, update } = useStore();
  const ob = data.onboarding;
  const dispatch = (event: OnboardingEvent) => update((d) => ({ ...d, onboarding: onboardingReducer(d.onboarding, event) }));
  // Full Aadhaar: typed in "Your details", OTP-verified, then kept in memory only until Check numbers is confirmed.
  const [aadhaar, setAadhaar] = useState('');
  // Documents (blob: URLs) and number checks: memory only, dropped on done and on unmount.
  const [docs, setDocs] = useState<Docs>(NO_DOCS);
  const [checks, setChecks] = useState<FieldCheck[] | null>(null);
  // Minor 2: the whole Check numbers result per card when Back was pressed (like phones' `previous`), so a card
  // with no re-checks left keeps the PAN chosen via "Use number from document" or "Edit number".
  const [previous, setPrevious] = useState<FieldCheck[] | null>(null);
  // Minor 6: full number of the last successful read per card (memory only), sent with a hand check; the reducer stores masks only.
  const lastReads = useRef<Partial<Record<KycField, string>>>({});
  const noteRead: ReadOk = (field, value) => {
    const next = { ...lastReads.current };
    if (value === null) delete next[field]; else next[field] = value;
    lastReads.current = next;
  };
  // Minor 3: one-time "All data deleted." after Settings → Delete all data (flag cleared once shown).
  const [dataDeleted] = useState(dataDeletedFlag);
  useEffect(() => { if (dataDeleted) clearDataDeletedFlag(); }, [dataDeleted]);
  const [firstSend, setFirstSend] = useState<OtpRequest | undefined>(undefined);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const docsRef = useRef<Docs>(NO_DOCS);
  docsRef.current = docs;

  /** Put a document in a slot (or clear it), revoking the old blob URL. */
  const setDoc = (kind: DocKind, d: DocFile | null) => {
    setDocs((cur) => {
      const old = cur[kind];
      if (old && old.uri !== d?.uri) URL.revokeObjectURL(old.uri);
      return { ...cur, [kind]: d };
    });
  };
  const dropSessionData = () => {
    for (const k of DOC_KINDS) { const d = docsRef.current[k]; if (d) URL.revokeObjectURL(d.uri); }
    setDocs(NO_DOCS); setChecks(null); setPrevious(null); setAadhaar(''); setFirstSend(undefined);
    lastReads.current = {};
  };

  // Revoke every blob URL when the page goes away (done, sign-out, reload).
  useEffect(() => () => {
    for (const k of DOC_KINDS) { const d = docsRef.current[k]; if (d) URL.revokeObjectURL(d.uri); }
  }, []);

  // Move focus to the new step's heading so screen readers announce the step change.
  useEffect(() => {
    if (mounted.current) headingRef.current?.focus();
    mounted.current = true;
    // lostCheck: the local Upload documents ↔ Check numbers switch has no step change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ob.step, ob.step === 'check' && !checks, ob.step === 'aadhaar-otp' && !aadhaar]);

  // After a reload on Aadhaar OTP the full Aadhaar is gone: back to "Your details" (name and PAN kept).
  // On Upload documents the Aadhaar is locked, so the re-type field is shown there instead (C1).
  const lostOtp = ob.step === 'aadhaar-otp' && !aadhaar;
  // Stored step is Check numbers but this tab has no reads in memory: another tab got there (a reload
  // opens on documents). Must-fix 1: nothing is dispatched; Upload documents is shown here locally only.
  const lostCheck = ob.step === 'check' && !checks;
  // lostOtp is likewise render-only (no dispatch on load or on a cross-tab update): "Your details" is shown
  // here locally, and only the user's Continue moves the stored step back (back-to-identity, identity-saved).

  /** Onboarding is done: drop the full Aadhaar, documents and checks (Req 4.3 / 7.10) and free the text engine (C3). */
  const finishSession = () => {
    dropSessionData();
    const term = (readerModule as unknown as { terminateOcr?: unknown }).terminateOcr;
    if (typeof term === 'function') void Promise.resolve(term()).catch(() => undefined);
  };
  const readFailed: ReadFailed = (field, unavailable) =>
    dispatch({ type: 'read-failed', field, ...(unavailable ? { unavailable: true } : {}) });
  // Review bug 2: after repeated failed reads (or no reader at all) the documents can go to a hand check.
  const handCheck = canSendForHandCheck(ob.kyc)
    ? () => {
      // Minor 6: the review lists every card; a card read earlier shows its masked read, not just the failed one.
      const ev: OnboardingEvent = { type: 'send-for-hand-check', at: new Date().toISOString(), reads: { ...lastReads.current } };
      // Refused (e.g. no identity or verified Aadhaar yet): HandCheck shows HAND_CHECK_FAILED.
      if (onboardingReducer(ob, ev).step !== 'done') return false;
      onCompleting();
      dispatch(ev);
      finishSession();
      return true;
    }
    : undefined;

  const heading = (text: string) => <h1 ref={headingRef} tabIndex={-1}>{text}</h1>;
  // Name check: the name from "Your details" is compared with the name on each card.
  const personName: PersonName | undefined = ob.identity ? { first: ob.identity.firstName, last: ob.identity.lastName } : undefined;
  /** Earlier read of `field` in this session (number + name result), if any. */
  const priorCheck = (field: KycField): FieldCheck | undefined => (previous ?? checks)?.find((x) => x.field === field);
  const priorRead = (field: KycField): ReadValue | null => {
    const c = priorCheck(field);
    return c ? { value: c.read, nameMatch: c.nameMatch } : null;
  };

  let body: ReactNode = null;
  if (ob.step === 'signin') {
    body = (
      <section data-feature="onboard-signin" aria-label="Sign in">
        {heading('Sign in')}
        {dataDeleted && <p className="muted" role="status">{DATA_DELETED_TEXT}</p>}
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
  } else if (ob.step === 'identity' || lostOtp) {
    body = (
      <section data-feature="onboard-identity" aria-label="Your details">
        {heading('Your details')}
        {lostOtp && <p className="muted" role="status">{RETYPE_FOR_NEW_OTP}</p>}
        <p className="intro">We need these to tie your account to you.</p>
        <Identity initial={ob.identity} onContinue={async (id, digits) => {
          // Req 3.8 / C1: save name + PAN, keep the full Aadhaar in memory, send the Aadhaar OTP.
          const r = await requestOtp(otpProvider, 'aadhaar', digits, ob.sends.aadhaar, ob.aadhaarLockedUntil);
          setAadhaar(digits);
          setChecks(null);
          setPrevious(null);
          lastReads.current = {};
          setFirstSend(r);
          // Local view over a stored Aadhaar OTP step: the user's Continue moves the stored step back first.
          if (lostOtp) dispatch({ type: 'back-to-identity' });
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
              // Req 4.3 / C1: only the last 4 is stored; the full number stays in memory until Check numbers.
              setFirstSend(undefined);
              dispatch({ type: 'aadhaar-verified', last4, at: new Date().toISOString(), provider: otpProvider.id });
            }}
            onLocked={(until) => dispatch({ type: 'aadhaar-locked', until })} />
          {/* C1: Back returns to "Your details" (name and PAN kept, Aadhaar typed again). */}
          <button type="button" className="link-btn" onClick={() => { setFirstSend(undefined); setAadhaar(''); dispatch({ type: 'back-to-identity' }); }}>Back</button>
        </Card>
      </section>
    );
  } else if (ob.step === 'documents' || lostCheck) {
    body = (
      <section data-feature="onboard-documents" aria-label="Upload documents">
        {heading('Upload documents')}
        {lostCheck && <p className="muted" role="status">{MOVED_ON_IN_OTHER_TAB}</p>}
        <p className="intro">{DOC_MESSAGES.uploadIntro}</p>
        <Documents docs={docs} setDoc={setDoc} pan={ob.identity?.pan ?? ''} aadhaar={aadhaar} verifiedLast4={ob.aadhaar?.last4 ?? ''}
          name={personName} onReadFailed={readFailed} onReadOk={noteRead} handCheck={handCheck}
          // Bug 1: after Back from Check numbers, a field with no re-reads left is not read again;
          // its earlier read result (kept in `checks`) is used instead.
          blocked={{ pan: readBlocked(ob.kyc, 'pan'), aadhaar: readBlocked(ob.kyc, 'aadhaar') }}
          prior={{ pan: priorRead('pan'), aadhaar: priorRead('aadhaar') }}
          onRead={(pan, aad, verified) => {
            const ev: OnboardingEvent = { type: 'documents-ready', at: new Date().toISOString(), reader: documentReader.id };
            // Already on Check numbers (another tab): only this tab's checks are created; nothing is dispatched.
            const already = ob.step === 'check';
            // The reducer counts a read after Back as a re-read; seed the checks with the counts it will store (Req 8.8).
            const counted = already ? ob.kyc.rereads : onboardingReducer(ob, ev).kyc.rereads;
            const cs = initialChecks({ pan: ob.identity?.pan ?? '', aadhaar: verified }, { pan: pan.value, aadhaar: aad.value },
              { pan: pan.nameMatch, aadhaar: aad.nameMatch })
              // Minor 2: a card with no re-checks left keeps its whole earlier check (the PAN chosen via
              // "Use number from document" / "Edit number" included), not a fresh one built from the typed PAN.
              .map((c) => (readBlocked(ob.kyc, c.field) ? priorCheck(c.field) : undefined) ?? c)
              .map((c) => ({ ...c, rereads: Math.min(MAX_REREADS, Math.max(c.rereads, counted[c.field])) }));
            setAadhaar(verified);
            setChecks(cs);
            setPrevious(null);
            if (!already) dispatch(ev);
          }} />
      </section>
    );
  } else if (ob.step === 'check' && checks) {
    body = (
      <section data-feature="onboard-check" aria-label="Check your numbers">
        {heading('Check your numbers')}
        <CheckNumbers checks={checks} docs={docs} personName={personName} setDoc={setDoc} onReadFailed={readFailed} onReadOk={noteRead} handCheck={handCheck}
          left={{ pan: readsLeft(ob.kyc, 'pan'), aadhaar: readsLeft(ob.kyc, 'aadhaar') }}
          onChange={(cs, reread) => { setChecks(cs); if (reread) dispatch({ type: 'reread-used', field: reread }); }}
          onBack={() => { setPrevious(checks); dispatch({ type: 'back-to-documents' }); }}
          onConfirm={() => {
            const out = checkOutcome(checks);
            const pan = checks.find((c) => c.field === 'pan')?.final ?? ob.identity?.pan ?? '';
            const ev: OnboardingEvent = { type: 'check-confirmed', match: out.match, pan, fields: reviewFields(checks), at: new Date().toISOString() };
            // Req 9.1: the status is settled here, after the Aadhaar OTP and the number check.
            if (onboardingReducer(ob, ev).step !== 'done') return false;
            onCompleting();
            dispatch(ev);
            finishSession();
            return true;
          }} />
      </section>
    );
  } else if (ob.step === 'done') {
    body = (
      <section data-feature="onboard-aadhaar-otp" aria-label="You're all set">
        {heading(ob.identity ? `You're all set, ${ob.identity.firstName}.` : "You're all set.")}
        <p className="intro" role="status">{ob.kyc.status === 'pre-verified' ? DOC_MESSAGES.donePreVerified : ob.kyc.status === 'verified' ? DOC_MESSAGES.doneVerified : UNDER_REVIEW_TEXT}</p>
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

function Documents({ docs, setDoc, pan, name, aadhaar, verifiedLast4, blocked, prior, onRead, onReadFailed, onReadOk, handCheck }: {
  docs: Docs;
  onReadFailed: ReadFailed;
  onReadOk: ReadOk;
  /** "Send for hand check", when canSendForHandCheck allows it. */
  handCheck: (() => boolean) | undefined;
  setDoc: (k: DocKind, d: DocFile | null) => void;
  pan: string;
  /** Name from "Your details", checked against each card. */
  name: PersonName | undefined;
  /** Full verified Aadhaar from this session, or '' after a reload / Redo documents. */
  aadhaar: string;
  verifiedLast4: string;
  /** readBlocked() per field: no re-reads left after Back, so the field is not read again. */
  blocked: Record<KycField, boolean>;
  /** Earlier read result per field from this session, if any. */
  prior: Record<KycField, ReadValue | null>;
  onRead: (pan: ReadValue, aadhaar: ReadValue, verifiedAadhaar: string) => void;
}) {
  const [reading, setReading] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<KycField, string>>>({});
  // Fields whose PDF needs a password (reader reason 'locked'); the password field shows under that slot.
  const [locked, setLocked] = useState<Partial<Record<KycField, boolean>>>({});
  // Numbers already read from the current documents, so "Open PDF" only reads the locked one.
  const [results, setResults] = useState<Partial<Record<KycField, ReadValue>>>({});
  // Re-typed Aadhaar (memory only), needed when the verified number is no longer in memory (C1).
  const needRetype = !aadhaar;
  const [retype, setRetype] = useState('');
  const [showRetype, setShowRetype] = useState(false);
  const [retypeTouched, setRetypeTouched] = useState(false);
  const retypeErr = needRetype ? confirmAadhaarRetype(retype, verifiedLast4) : null;
  const showRetypeErr = retypeTouched && retype !== '' ? retypeErr : null;
  const verified = needRetype ? normalizeAadhaar(retype) : aadhaar;
  const ready = DOC_KINDS.every((k) => docs[k]) && !retypeErr;

  /** Blocked field: keep the earlier result; with none (after a reload) do one strict read. */
  function readField(field: KycField, password?: string): Promise<ReadOutcome> {
    const doc = docs[field]!;
    const typed = field === 'pan' ? pan : verified;
    if (!blocked[field]) return readNumber(doc, field, false, typed, name, password);
    const p = prior[field];
    return p ? Promise.resolve(p) : readNumber(doc, field, true, typed, name, password);
  }

  /** Read `fields` (others keep their earlier result); go on to Check numbers once both numbers are in. */
  async function readAndGo(fields: KycField[], password?: string) {
    setReading(true);
    const outs = await Promise.all(fields.map((f) => readField(f, password)));
    setReading(false);
    const nextResults = { ...results };
    const nextErrors = { ...errors };
    const nextLocked = { ...locked };
    fields.forEach((f, i) => {
      const o = outs[i]!;
      if ('value' in o) { nextResults[f] = o; nextErrors[f] = undefined; nextLocked[f] = false; onReadOk(f, o.value); }
      else {
        delete nextResults[f]; nextErrors[f] = o.error; nextLocked[f] = !!o.locked;
        if (o.failed) onReadFailed(f, o.failed.unavailable);
      }
    });
    setResults(nextResults); setErrors(nextErrors); setLocked(nextLocked);
    if (nextResults.pan && nextResults.aadhaar) onRead(nextResults.pan, nextResults.aadhaar, verified);
  }

  function go() {
    if (!ready || reading) return;
    // The Aadhaar result depends on the (re-)typed number, so it is read again on every Continue.
    const todo: KycField[] = results.pan ? ['aadhaar'] : ['pan', 'aadhaar'];
    void readAndGo(todo);
  }

  /** New file in a slot. The same file in both card slots is refused (review bug 1). */
  function change(k: DocKind, d: DocFile | null) {
    if (k !== 'selfie') {
      const other = docs[k === 'pan' ? 'aadhaar' : 'pan'];
      if (d && other && sameDocument(d, other)) {
        URL.revokeObjectURL(d.uri);
        setErrors((e) => ({ ...e, [k]: DOC_MESSAGES.sameFile }));
        return;
      }
      setErrors((e) => ({ ...e, [k]: undefined }));
      setLocked((l) => ({ ...l, [k]: false }));
      setResults((r) => { const n = { ...r }; delete n[k]; return n; });
      // The remembered read belonged to the old document: forget it when the card is replaced or removed.
      onReadOk(k, null);
    }
    setDoc(k, d);
  }

  return (
    <>
      {DOC_KINDS.map((k, i) => {
        const card = k !== 'selfie';
        // Review bug 7: no re-reads left and an earlier read exists, so this card can't be replaced.
        const frozen = card && blocked[k] && !!prior[k] && !!docs[k];
        const needsPassword = card && !!locked[k] && docs[k]?.mime === 'application/pdf';
        return (
          <Card key={k}>
            <DocSlot kind={k} number={i + 1} doc={docs[k]} disabled={reading} error={card ? errors[k] : undefined}
              frozen={frozen ? DOC_MESSAGES.noRereadsLeft : undefined} onChange={(d) => change(k, d)} />
            {needsPassword && <PdfPassword disabled={reading} onOpen={(pw) => readAndGo([k as KycField], pw)} />}
          </Card>
        );
      })}
      {needRetype && (
        <Card>
          <div className="field">
            <label htmlFor="ob-aadhaar-again">{RETYPE_AADHAAR_LABEL}</label>
            <span className="input-wrap has-toggle">
              {/* Plain text input (not type=password) so password managers never offer to save it; masked with CSS when hidden. */}
              <input id="ob-aadhaar-again" type="text" className={showRetype ? undefined : 'masked'} inputMode="numeric" autoComplete="off"
                data-lpignore="true" data-1p-ignore="" spellCheck={false} autoCorrect="off" autoCapitalize="off"
                value={groupAadhaar(retype)} maxLength={14} placeholder="XXXX XXXX XXXX" required disabled={reading}
                aria-invalid={showRetypeErr ? true : undefined}
                aria-describedby={['ob-aadhaar-again-hint', showRetypeErr ? 'ob-aadhaar-again-err' : ''].filter(Boolean).join(' ')}
                onChange={(e) => setRetype(normalizeAadhaar(e.target.value).slice(0, 12))} onBlur={() => setRetypeTouched(true)} />
              <button type="button" className="toggle" aria-controls="ob-aadhaar-again" aria-pressed={showRetype}
                aria-label={showRetype ? 'Hide Aadhaar number' : 'Show Aadhaar number'}
                onClick={() => setShowRetype((v) => !v)}>{showRetype ? 'Hide' : 'Show'}</button>
            </span>
            <span id="ob-aadhaar-again-hint" className="muted small">Verified Aadhaar {maskAadhaar(verifiedLast4)}</span>
            {showRetypeErr && <span id="ob-aadhaar-again-err" className="error" role="status">{showRetypeErr}</span>}
          </div>
        </Card>
      )}
      <ReadingStatus active={reading} />
      <button type="button" className="btn primary" disabled={!ready || reading} onClick={go}>Continue</button>
      {/* All three documents must be added before they can go for a hand check. */}
      {handCheck && <HandCheck disabled={reading || !DOC_KINDS.every((k) => docs[k])} onSend={handCheck} />}
    </>
  );
}

function CheckNumbers({ checks, docs, personName, setDoc, left, onChange, onBack, onConfirm, onReadFailed, onReadOk, handCheck }: {
  checks: FieldCheck[];
  onReadFailed: ReadFailed;
  onReadOk: ReadOk;
  /** "Send for hand check", when canSendForHandCheck allows it. */
  handCheck: (() => boolean) | undefined;
  personName: PersonName | undefined;
  docs: Docs;
  /** Stored re-reads left per field (readsLeft). */
  left: Record<KycField, number>;
  setDoc: (k: DocKind, d: DocFile | null) => void;
  onChange: (cs: FieldCheck[], rereadField?: KycField) => void;
  onBack: () => void;
  /** Settles the status; false when the reducer refused it. */
  onConfirm: () => boolean;
}) {
  // Numbers only: "Use number from document" makes final === read even when the name failed (matched is false then).
  const numbersMatch = checks.every((c) => c.matched || (c.final !== '' && c.final === c.read));
  // The numbers match but a card still goes to review: its name failed or wasn't checked (null goes to review
  // like false), or its number was taken without a name match.
  const nameReview = checks.some((c) => c.nameMatch !== true || !c.matched);
  const intro = !numbersMatch ? '\u00a0' : nameReview ? DOC_MESSAGES.numbersMatchNameReview : 'Both numbers match your documents.';
  const [confirmError, setConfirmError] = useState('');

  return (
    <>
      <p className="intro" role="status">{intro}</p>
      {checks.map((c) => (
        <FieldRow key={c.field} check={c} doc={docs[c.field]} otherDoc={docs[c.field === 'pan' ? 'aadhaar' : 'pan']} personName={personName} storedLeft={left[c.field]}
          setDoc={(d) => setDoc(c.field, d)} onReadFailed={onReadFailed} onReadOk={onReadOk}
          onChange={(next, reread) => onChange(checks.map((x) => (x.field === c.field ? next : x)), reread ? c.field : undefined)} />
      ))}
      <div className="row">
        <button type="button" className="btn primary" aria-describedby={confirmError ? 'chk-confirm-err' : undefined}
          onClick={() => setConfirmError(onConfirm() ? '' : CONFIRM_FAILED)}>Confirm</button>
        <button type="button" className="link-btn" onClick={onBack}>Back</button>
      </div>
      {confirmError && <p id="chk-confirm-err" className="error" role="alert">{confirmError}</p>}
      {handCheck && <HandCheck disabled={!DOC_KINDS.every((k) => docs[k])} onSend={handCheck} />}
    </>
  );
}

function FieldRow({ check: c, doc, otherDoc, personName, storedLeft, setDoc, onChange, onReadFailed, onReadOk }: {
  check: FieldCheck;
  onReadFailed: ReadFailed;
  onReadOk: ReadOk;
  /** Name from "Your details", checked again on every re-read. */
  personName: PersonName | undefined;
  doc: DocFile | null;
  /** The other card's document, so the same file can't go into both slots. */
  otherDoc: DocFile | null;
  storedLeft: number;
  setDoc: (d: DocFile | null) => void;
  onChange: (c: FieldCheck, reread: boolean) => void;
}) {
  const isPan = c.field === 'pan';
  // C1: the Aadhaar is locked to the OTP-verified number; only "Upload again" (a re-read) is offered.
  const locked = !isPan;
  const name = isPan ? 'PAN' : 'Aadhaar';
  const [showFull, setShowFull] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  /** The PDF being re-read needs a (correct) password; the field shows under the slot or the edit form. */
  const [pdfLocked, setPdfLocked] = useState(false);
  /**
   * Review bug 10: the file chosen in "Upload again", kept aside until its read succeeds. Only then it
   * replaces the old document (and thumbnail); until then the old document and numbers stay together.
   */
  const [pending, setPending] = useState<DocFile | null>(null);
  const pendingRef = useRef<DocFile | null>(null);
  const keepPending = (d: DocFile | null) => {
    const old = pendingRef.current;
    if (old && old.uri !== d?.uri) URL.revokeObjectURL(old.uri);
    pendingRef.current = d;
    setPending(d);
  };
  // A pending file that never got used is dropped with the row.
  useEffect(() => () => { if (pendingRef.current) URL.revokeObjectURL(pendingRef.current.uri); }, []);
  const fmt = (v: string) => (isPan ? v : showFull ? groupAadhaar(v) : maskAadhaar(v.slice(-4)));
  const draftN = normalizePan(draft);
  const draftErr = draft ? validatePan(draftN) : null;
  const left = Math.max(0, Math.min(MAX_REREADS - c.rereads, storedLeft));
  // "Edit number" / "Upload again" dispatch reread-used, so both the session and stored counts must allow one.
  const mayReread = canReread(c) && left > 0;
  const id = `chk-${c.field}`;
  // c.matched also needs the name when the number came from the document (takeDocumentNumber).
  const numberMatch = c.matched || (c.final !== '' && c.final === c.read);
  const takenByHand = c.source === 'document' && !c.matched;

  /** Strict re-read (Req 8.6) of `d` against the number the user now stands by. */
  async function reread(final: string, d: DocFile, password?: string): Promise<'ok' | 'locked' | 'failed'> {
    setReading(true); setError('');
    // Demo reader: the number the document "really" holds is the one first typed.
    const r = await readNumber(d, c.field, true, c.typed, personName, password);
    setReading(false);
    if ('error' in r) {
      setError(r.error); setPdfLocked(!!r.locked);
      if (r.failed) onReadFailed(c.field, r.failed.unavailable);
      return r.locked ? 'locked' : 'failed';
    }
    setPdfLocked(false);
    onReadOk(c.field, r.value);
    onChange(applyReread(c, final, r.value, r.nameMatch), true);
    return 'ok';
  }

  /** "Upload again": read the new file first; swap the document in only once that read succeeds. */
  async function rereadUpload(d: DocFile, password?: string) {
    keepPending(d); // drops an earlier pending file; this one is revoked below if its read fails
    // Aadhaar: always checked against the verified number (c.final never changes for Aadhaar).
    const res = await reread(c.final, d, password);
    if (res === 'ok') {
      pendingRef.current = null; setPending(null); // now owned by the parent, which revokes the old one
      setDoc(d);
      setUploading(false);
      return;
    }
    // A locked PDF keeps the new file for the password; any other failure drops it.
    keepPending(res === 'locked' && d.mime === 'application/pdf' ? d : null);
  }

  function cancelUpload() {
    keepPending(null);
    setUploading(false); setPdfLocked(false); setError('');
  }

  return (
    <Card className="check-row">
      <div className="check-head">
        <h2 id={`${id}-h`}>{name}</h2>
        {doc && <DocPreview doc={doc} small />}
      </div>
      <dl className="account">
        {/* Aadhaar is the OTP-verified number, not something typed on this screen. */}
        <dt>{isPan ? 'You typed' : DOC_MESSAGES.verifiedNumberLabel}</dt>
        <dd>{fmt(c.final)}</dd>
        <dt>Read from document</dt>
        <dd>{fmt(c.read)}</dd>
      </dl>
      {/* The number label compares numbers only; the name has its own line below. */}
      <p className={numberMatch ? 'match good' : 'match bad'}>
        <MatchLabel matched={numberMatch} />
      </p>
      {c.nameMatch === true && <p className="name-check good">{DOC_MESSAGES.nameMatches}</p>}
      {c.nameMatch === false && (
        // Review bug 3: the mismatch line, then what happens next on its own line.
        <div className="name-check warn" role="status">
          <p>{DOC_MESSAGES.nameMismatch}</p>
          <p>{DOC_MESSAGES.nameReview}</p>
        </div>
      )}
      {c.nameMatch === null && (
        // Not checked (e.g. a name typed in an Indian script) goes to review like a mismatch.
        <div className="name-check" role="status">
          <p className="muted small">{DOC_MESSAGES.nameNotChecked}</p>
          <p>{DOC_MESSAGES.nameReview}</p>
        </div>
      )}
      {!isPan && (
        // R8.3: the text says what the button will do ("Hide" while shown, "Show" while hidden).
        <button type="button" className="link-btn" aria-label={showFull ? 'Hide Aadhaar number' : 'Show Aadhaar number'}
          onClick={() => setShowFull((v) => !v)}>
          {showFull ? 'Hide' : 'Show'}
        </button>
      )}
      {/* "Use number from document" without a name match (false or null): the name lines above already show nameReview. */}
      {!c.matched && !takenByHand && (
        <div role="status">
          <p>The number you typed doesn't match your {DOC_LABEL[c.field]}.</p>
          {(c.rereads > 0 || (locked && !mayReread)) && <p>We'll check this by hand.</p>}
        </div>
      )}
      {/* Review bug 9: after "Use number from document" without a name match (false or null), "Upload again" stays on offer. */}
      {!c.matched && !editing && !uploading && (locked || takenByHand ? mayReread : true) && (
        <>
          <div className="row">
            {!locked && !takenByHand && (
              <button type="button" className="btn" disabled={reading} onClick={() => onChange(takeDocumentNumber(c), false)}>Use number from document</button>
            )}
            {mayReread && (
              <>
                {!locked && !takenByHand && (
                  <button type="button" className="btn" disabled={reading} onClick={() => { setDraft(c.final); setEditing(true); setError(''); setPdfLocked(false); }}>Edit number</button>
                )}
                <button type="button" className="btn" disabled={reading} onClick={() => { setUploading(true); setError(''); setPdfLocked(false); }}>Upload again</button>
              </>
            )}
          </div>
          <p className="muted small">{left} re-check{left === 1 ? '' : 's'} left</p>
        </>
      )}
      {editing && !locked && (
        <form noValidate onSubmit={async (e) => {
          e.preventDefault();
          if (!doc || draftErr || !draftN) return;
          if (await reread(draftN, doc) === 'ok') setEditing(false);
        }}>
          <label className="field" htmlFor={`${id}-edit`}>
            <span>PAN</span>
            <input id={`${id}-edit`} value={draftN} autoComplete="off" data-lpignore="true" data-1p-ignore="" spellCheck={false} maxLength={10}
              placeholder="ABCPE1234F"
              aria-invalid={draftErr ? true : undefined} aria-describedby={draftErr ? `${id}-edit-err` : undefined}
              onChange={(e) => setDraft(e.target.value)} />
          </label>
          {draftErr && <p id={`${id}-edit-err`} className="error" role="status">{draftErr}</p>}
          <div className="row">
            <button type="submit" className="btn primary" disabled={!!draftErr || !draftN || reading}>Check again</button>
            <button type="button" className="btn" disabled={reading} onClick={() => { setEditing(false); setPdfLocked(false); }}>Cancel</button>
          </div>
        </form>
      )}
      {editing && !locked && pdfLocked && doc?.mime === 'application/pdf' && (
        // Review bug 8: the "Edit number" re-read of a locked PDF needs the password too (outside the edit form: no nested forms).
        <PdfPassword disabled={reading || !!draftErr || !draftN}
          onOpen={async (pw) => { if (await reread(draftN, doc, pw) === 'ok') setEditing(false); }} />
      )}
      {uploading && (
        <>
          {/* Review bug 10: the old document stays in the slot until the new one has been read. */}
          <DocSlot kind={c.field} doc={doc} removable={false} disabled={reading} error={error || undefined}
            onChange={async (d) => {
              if (!d) return;
              // Review bug 1: the same file can't be both cards.
              if (otherDoc && sameDocument(d, otherDoc)) {
                URL.revokeObjectURL(d.uri);
                keepPending(null);
                setPdfLocked(false);
                setError(DOC_MESSAGES.sameFile);
                return;
              }
              await rereadUpload(d);
            }} />
          {pdfLocked && pending?.mime === 'application/pdf' && (
            <PdfPassword disabled={reading} onOpen={(pw) => rereadUpload(pending, pw)} />
          )}
          <button type="button" className="btn" disabled={reading} onClick={cancelUpload}>Cancel</button>
        </>
      )}
      <ReadingStatus active={reading} />
      {error && !uploading && <p className="error" role="status">{error}</p>}
    </Card>
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
          {coolMs > 0 ? resendIn(coolMs) : 'Send OTP'}
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
