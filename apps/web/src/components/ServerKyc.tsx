// Final KYC with the Wealthfire server (only rendered when VITE_API_URL is set).
// Shows the server status and the next step: start (date of birth), DigiLocker, documents (selfie,
// Aadhaar card, PAN card), e-sign, Try again after a partner timeout, or wait. Each paid step asks
// its consent tick first (the core client records it with POST /kyc/consent). Sends names, PAN, DOB,
// Aadhaar last 4 and the device result only; the full Aadhaar never leaves the device and documents
// go straight to their presigned upload URLs. Same steps and texts as packages/mobile-ui/src/server.tsx.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  CONSENT_TEXT, isConsentRequired, isServerError, KYC_TEXT, kycDocsNeeded, kycReasonText, kycStatusLabel, maskEmail, maskMobile, needsDob,
  needsSignIn, normalizeDob, onboardingReducer, STEP_CONSENT, validateDob,
  type AppData, type ConsentPurpose, type DocFile, type DocKind, type KycStatusView, type ServerKycClient,
} from '@wealthfire/core';
import { useStore } from '../store';
import { otpProvider } from '../otp';
import { DobField } from './DobField';
import { DocSlot } from './DocSlot';
import { OtpStep } from './OtpStep';
import { clearKycReturn, isKycReturn, kycReturnUrl, safeRedirect } from '../server';

export const WAIT_TEXT = "We're checking your details. This can take a few minutes.";
export const REDIRECT_BLOCKED = 'Could not open the next step. Try again later.';
export const LOAD_FAILED = 'Could not get your KYC status. Try again.';

export interface StartDetails {
  firstName: string;
  lastName: string;
  pan: string;
  /** ISO yyyy-mm-dd from Your details; missing for users who onboarded before DOB was asked (needsDob) */
  dob?: string;
  aadhaarLast4: string;
  deviceStatus: 'pre-verified' | 'under-review';
}

/** What /kyc/start needs from onboarding (no full Aadhaar), or null when it can't start. */
export function startDetails(ob: AppData['onboarding']): StartDetails | null {
  const s = ob.kyc.status;
  if (ob.step !== 'done' || !ob.identity || !ob.aadhaar || (s !== 'pre-verified' && s !== 'under-review')) return null;
  return { firstName: ob.identity.firstName, lastName: ob.identity.lastName, pan: ob.identity.pan, ...(ob.identity.dob ? { dob: ob.identity.dob } : {}), aadhaarLast4: ob.aadhaar.last4, deviceStatus: s };
}

function message(e: unknown, fallback: string): string {
  return isServerError(e) ? e.message : fallback;
}

type Ticks = Partial<Record<ConsentPurpose, boolean>>;

/** One tick box per purpose (the e-sign screen shows two). */
function ConsentTicks({ purposes, ticks, setTicks, disabled }: {
  purposes: readonly ConsentPurpose[]; ticks: Ticks; setTicks: (t: Ticks) => void; disabled: boolean;
}) {
  const id = useId();
  return (
    <>
      {purposes.map((p) => (
        <label key={p} className="check" htmlFor={`${id}-${p}`}>
          <input id={`${id}-${p}`} type="checkbox" checked={!!ticks[p]} disabled={disabled}
            onChange={(e) => setTicks({ ...ticks, [p]: e.target.checked })} />
          {CONSENT_TEXT[p]}
        </label>
      ))}
    </>
  );
}

type Docs = Partial<Record<DocKind, DocFile>>;

export function ServerKyc({ client, details }: {
  client: ServerKycClient;
  /** Needed to start the final KYC; null when onboarding has no identity yet. */
  details: StartDetails | null;
}) {
  const [view, setView] = useState<KycStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [back] = useState(isKycReturn);
  const { data, update } = useStore();
  // R5 / DOB: identities saved before DOB was asked have none; ask for it before /kyc/start.
  const askDob = needsDob(data.onboarding);
  const [dobInput, setDobInput] = useState('');
  const [dobTouched, setDobTouched] = useState(false);
  const [ticks, setTicks] = useState<Ticks>({});
  const [docs, setDocs] = useState<Docs>({});
  const [sent, setSent] = useState<ReadonlySet<DocKind>>(() => client.sentDocuments());
  /** POST /kyc/retry answered consent_required: ask the pan-check tick again. */
  const [retryConsent, setRetryConsent] = useState(false);
  /** The session ended (refresh cookie blocked or expired): sign in again with an OTP. */
  const [signIn, setSignIn] = useState(false);
  const [sends, setSends] = useState<string[]>([]);

  // Files are blob: URLs owned here: revoke on replace, remove and unmount.
  const docsRef = useRef<Docs>({});
  docsRef.current = docs;
  useEffect(() => () => { for (const d of Object.values(docsRef.current)) if (d) URL.revokeObjectURL(d.uri); }, []);
  const setDoc = (kind: DocKind, d: DocFile | null) => setDocs((cur) => {
    const old = cur[kind];
    if (old && old !== d) URL.revokeObjectURL(old.uri);
    const nextDocs = { ...cur };
    if (d) nextDocs[kind] = d; else delete nextDocs[kind];
    return nextDocs;
  });
  const dropDocs = (kinds: DocKind[]) => { for (const k of kinds) setDoc(k, null); };

  const next = view?.next.type;
  // A new step starts with its boxes unticked.
  useEffect(() => { setTicks({}); }, [next]);

  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await task(); } finally { setBusy(false); }
  }

  /** Error handling shared by every step: a dead session asks for an OTP; others show a fixed text. */
  function fail(e: unknown, fallback = LOAD_FAILED) {
    if (needsSignIn(e)) { setView(null); setSignIn(true); return; }
    setError(message(e, fallback));
  }

  const load = () => run(async () => {
    try { setView(await client.getStatus()); setSignIn(false); } catch (e) { fail(e); }
  });

  // On open (and on return from DigiLocker / e-sign with ?kyc=return): read the status.
  useEffect(() => {
    if (back) clearKycReturn();
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Opens a partner page, only if its origin is allow-listed. */
  function go(url: string | undefined): boolean {
    const safe = safeRedirect(url);
    if (!safe) { setError(REDIRECT_BLOCKED); return false; }
    window.location.assign(safe);
    return true;
  }

  async function aadhaarStep(mode: 'digilocker' | 'otp') {
    const v = await client.startAadhaar(mode, kycReturnUrl());
    setView(v);
    if (v.next.type === 'digilocker' || v.next.type === 'aadhaar-otp') go(v.next.url);
  }

  async function esignStep() {
    const v = await client.startEsign(kycReturnUrl());
    setView(v);
    if (v.next.type === 'esign') go(v.next.url);
  }

  /** Follow `next` after start / selfie / retry. DigiLocker and e-sign need their own ticks, so they wait for a tap. */
  function follow(v: KycStatusView) {
    setView(v);
  }

  /** POST /kyc/start (after the pan-check tick) with names, PAN, DOB, Aadhaar last 4 and the device result. */
  const start = (dob = details?.dob) => {
    // Never start without a date of birth.
    if (!details || !dob) return;
    void run(async () => {
      try { follow(await client.startKyc({ ...details, dob })); } catch (err) { fail(err); }
    });
  };

  /** Old identity without DOB: save it (dob-added), then start with it. */
  const saveDob = (e: FormEvent) => {
    e.preventDefault();
    setDobTouched(true);
    if (validateDob(dobInput) || !ticked(STEP_CONSENT.start)) return;
    const iso = normalizeDob(dobInput);
    update((d) => ({ ...d, onboarding: onboardingReducer(d.onboarding, { type: 'dob-added', dob: iso, at: new Date().toISOString() }) }));
    start(iso);
  };

  const step = (fn: () => Promise<void>) => () => void run(async () => {
    try { await fn(); } catch (err) { fail(err); }
  });

  const ticked = (ps: readonly ConsentPurpose[]) => ps.every((p) => ticks[p]);

  /** R1: one /kyc/documents call for the chosen files, then a PUT of each to its presigned URL. */
  async function uploadDocs(kinds: DocKind[]): Promise<Partial<Record<DocKind, string>> | null> {
    const files = kinds.map((k) => docs[k]);
    if (files.some((f) => !f)) { setError(KYC_TEXT.pickAll); return null; }
    const chosen = files as DocFile[];
    try {
      return await client.uploadDocuments(chosen.map((f) => ({ kind: f.kind, contentType: f.mime, size: f.size })), async (u, kind) => {
        const d = docsRef.current[kind];
        if (!d) return false;
        const body = await (await window.fetch(d.uri)).blob();
        return (await window.fetch(u.url, { method: 'PUT', headers: u.headers, body })).ok;
      });
    } finally {
      const now = client.sentDocuments();
      setSent(now);
      dropDocs(kinds.filter((k) => now.has(k)));
    }
  }

  const needed = kycDocsNeeded(view, sent);

  /** Selfie step: selfie (+ cards not yet sent), then face match after the face-match tick. */
  const submitDocuments = () => void run(async () => {
    try {
      const ids = await uploadDocs(needed);
      if (!ids?.selfie) return;
      follow(await client.submitSelfie(ids.selfie));
    } catch (err) { fail(err, KYC_TEXT.uploadFailed); }
  });

  /** Under review (hand check, PAN in use, …): the reviewer needs all three documents. */
  const sendForReview = () => void run(async () => {
    try {
      if (!(await uploadDocs(needed))) return;
      setNotice(KYC_TEXT.docsSent);
    } catch (err) { fail(err, KYC_TEXT.uploadFailed); }
  });

  /** R3: POST /kyc/retry; with consent only when the server asked for it again. */
  const retry = () => void run(async () => {
    try {
      follow(await client.retry(retryConsent));
      setRetryConsent(false);
    } catch (err) {
      if (isConsentRequired(err)) { setRetryConsent(true); setTicks({}); }
      fail(err);
    }
  });

  const reason = kycReasonText(view?.reason);
  const contact = data.onboarding.contact;
  const docLabel = next === 'documents' && needed.length === 1 ? KYC_TEXT.uploadSelfieOnly : KYC_TEXT.uploadAll;
  const slots = (
    <div className="server-docs" role="group" aria-label={docLabel}>
      {needed.map((k) => <DocSlot key={k} kind={k} doc={docs[k] ?? null} disabled={busy} onChange={(d) => setDoc(k, d)} />)}
    </div>
  );

  return (
    <div className="server-kyc" aria-busy={busy || undefined}>
      {back && !view && !error && !signIn && <p className="muted" role="status">Welcome back. Checking your status…</p>}
      {view && (
        <p role="status">
          Final KYC: <strong>{kycStatusLabel(view.status)}</strong>
          {reason ? <> ({reason})</> : null}
        </p>
      )}
      {signIn && (
        <div className="sign-in-again">
          <p className="error" role="alert">{KYC_TEXT.signInAgain}</p>
          {contact && (
            <>
              <p className="muted small">{KYC_TEXT.signInAgainHint} {contact.kind === 'email' ? maskEmail(contact.value) : maskMobile(contact.value)}.</p>
              <OtpStep provider={otpProvider} channel={contact.kind === 'email' ? 'email' : 'sms'} target={contact.value} sends={sends} lockedUntil={null}
                verifyLabel="Sign in" onSent={(at) => setSends((x) => [...x, at])}
                onVerified={() => { setSignIn(false); setSends([]); void load(); }} onLocked={() => undefined} />
            </>
          )}
        </div>
      )}
      {next === 'start' && details && askDob && (
        <form onSubmit={saveDob} noValidate>
          <p className="muted small">Add your date of birth to finish your KYC. It is checked with the KYC records.</p>
          <DobField id="kyc-dob" value={dobInput} touched={dobTouched} disabled={busy} onChange={setDobInput} onBlur={() => setDobTouched(true)} />
          <ConsentTicks purposes={STEP_CONSENT.start} ticks={ticks} setTicks={setTicks} disabled={busy} />
          <button type="submit" className="btn primary" disabled={busy || !!validateDob(dobInput) || !ticked(STEP_CONSENT.start)}>Start final KYC</button>
        </form>
      )}
      {next === 'start' && details && !askDob && (
        <>
          <p className="muted small">Your details are checked with the KYC records.</p>
          <ConsentTicks purposes={STEP_CONSENT.start} ticks={ticks} setTicks={setTicks} disabled={busy} />
          <button type="button" className="btn primary" disabled={busy || !ticked(STEP_CONSENT.start)} onClick={() => start()}>Start final KYC</button>
        </>
      )}
      {next === 'digilocker' && (
        <>
          <p className="muted small">Verify your Aadhaar with DigiLocker. You will come back here after.</p>
          <ConsentTicks purposes={STEP_CONSENT.digilocker} ticks={ticks} setTicks={setTicks} disabled={busy} />
          <button type="button" className="btn primary" disabled={busy || !ticked(STEP_CONSENT.digilocker)} onClick={step(() => aadhaarStep('digilocker'))}>Continue with DigiLocker</button>
        </>
      )}
      {next === 'aadhaar-otp' && (
        <>
          <ConsentTicks purposes={STEP_CONSENT['aadhaar-otp']} ticks={ticks} setTicks={setTicks} disabled={busy} />
          <button type="button" className="btn primary" disabled={busy || !ticked(STEP_CONSENT['aadhaar-otp'])}
            onClick={step(() => aadhaarStep('otp'))}>Continue to Aadhaar OTP</button>
        </>
      )}
      {next === 'documents' && (
        <>
          <p className="muted small">{docLabel} (JPG, PNG or PDF; selfie JPG or PNG; up to 10 MB each).</p>
          {slots}
          <ConsentTicks purposes={STEP_CONSENT.documents} ticks={ticks} setTicks={setTicks} disabled={busy} />
          <button type="button" className="btn primary" disabled={busy || !ticked(STEP_CONSENT.documents) || needed.some((k) => !docs[k])}
            onClick={submitDocuments}>{KYC_TEXT.uploadContinue}</button>
        </>
      )}
      {next === 'esign' && (
        <>
          <p className="muted small">Sign your KYC form with Aadhaar e-sign. You will come back here after.</p>
          <ConsentTicks purposes={STEP_CONSENT.esign} ticks={ticks} setTicks={setTicks} disabled={busy} />
          <button type="button" className="btn primary" disabled={busy || !ticked(STEP_CONSENT.esign)} onClick={step(esignStep)}>Continue to e-sign</button>
        </>
      )}
      {next === 'retry' && (
        <>
          {retryConsent && <ConsentTicks purposes={STEP_CONSENT.retry} ticks={ticks} setTicks={setTicks} disabled={busy} />}
          <button type="button" className="btn primary" disabled={busy || (retryConsent && !ticked(STEP_CONSENT.retry))} onClick={retry}>{KYC_TEXT.tryAgain}</button>
        </>
      )}
      {next === 'wait' && (
        <>
          <p className="muted">{WAIT_TEXT}</p>
          <button type="button" className="btn" disabled={busy} onClick={() => void load()}>Refresh</button>
        </>
      )}
      {view?.status === 'under-review' && needed.length > 0 && (
        <div className="server-review-docs">
          <p className="muted small">{KYC_TEXT.docsNeeded}{view.documents ? '' : ` ${KYC_TEXT.docsUnknownHint}`}</p>
          {slots}
          <button type="button" className="btn" disabled={busy || needed.some((k) => !docs[k])} onClick={sendForReview}>{KYC_TEXT.sendDocs}</button>
        </div>
      )}
      {notice && <p className="muted" role="status">{notice}</p>}
      {error && (
        <>
          <p className="error" role="alert">{error}</p>
          {!view && !signIn && <button type="button" className="btn" disabled={busy} onClick={() => void load()}>Try again</button>}
        </>
      )}
    </div>
  );
}
