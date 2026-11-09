// Final KYC with the Wealthfire server (only rendered when VITE_API_URL is set).
// Shows the server status and the next step: start (date of birth), DigiLocker, selfie upload,
// e-sign, or wait. Sends names, PAN, Aadhaar last 4 and the device result only; the full Aadhaar
// never leaves the device and the selfie goes straight to its presigned upload URL.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { isServerError, kycStatusLabel, needsDob, normalizeDob, onboardingReducer, validateDob, type AppData, type KycStatusView, type ServerKycClient } from '@wealthfire/core';
import { useStore } from '../store';
import { DobField } from './DobField';
import { clearKycReturn, isKycReturn, kycReturnUrl, safeRedirect } from '../server';

export const WAIT_TEXT = "We're checking your details. This can take a few minutes.";
export const REDIRECT_BLOCKED = 'Could not open the next step. Try again later.';
export const LOAD_FAILED = 'Could not get your KYC status. Try again.';
export const SELFIE_TOO_BIG = 'Choose a JPG or PNG photo up to 10 MB.';
const MAX_UPLOAD = 10 * 1024 * 1024;

/** Short text for a server reason code (unknown codes show nothing). */
export const REASON_TEXT: Record<string, string> = {
  'kra-validated': 'Your KYC record was confirmed.',
  'full-kyc-passed': 'All checks passed.',
  'in-progress': 'Checks are in progress.',
  'check-unclear': 'Our team is taking a closer look.',
  'partner-timeout': 'The KYC service did not answer. We will try again.',
  'device-hand-check': 'Our team is checking your documents by hand.',
  'pan-invalid': 'Your PAN could not be verified.',
  'pan-not-individual': 'This PAN is not for an individual.',
  'aadhaar-mismatch': 'Your Aadhaar details did not match.',
  'liveness-failed': 'The selfie check did not pass.',
  'staff-approved': 'Approved by our team.',
  'staff-rejected': 'Rejected by our team.',
};

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

export function ServerKyc({ client, details, autoStart = false }: {
  client: ServerKycClient;
  /** Start the final KYC by itself when no case exists yet (done screen right after Confirm). */
  autoStart?: boolean;
  /** Needed to start the final KYC; null when onboarding has no identity yet. */
  details: StartDetails | null;
}) {
  const [view, setView] = useState<KycStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [back] = useState(isKycReturn);
  const fileId = useId();
  const { data, update } = useStore();
  // R5 / DOB: identities saved before DOB was asked have none; ask for it before /kyc/start.
  const askDob = needsDob(data.onboarding);
  const [dobInput, setDobInput] = useState('');
  const [dobTouched, setDobTouched] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await task(); } finally { setBusy(false); }
  }

  const load = () => run(async () => {
    try { setView(await client.getStatus()); } catch (e) { setError(message(e, LOAD_FAILED)); }
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

  /** Follow `next` right after a user action (start / selfie): redirects for DigiLocker and e-sign. */
  async function follow(v: KycStatusView) {
    setView(v);
    if (v.next.type === 'digilocker') await aadhaarStep('digilocker');
    else if (v.next.type === 'esign') await esignStep();
  }

  /** POST /kyc/start with names, PAN, DOB, Aadhaar last 4 and the device result (never the full Aadhaar). */
  const start = (dob = details?.dob) => {
    // Never start without a date of birth.
    if (!details || !dob) return;
    void run(async () => {
      try { await follow(await client.startKyc({ ...details, dob })); } catch (err) { setError(message(err, LOAD_FAILED)); }
    });
  };

  // Done screen (autoStart): start the final KYC once, as soon as the server says no case exists yet.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current || busy || view?.next.type !== 'start' || !details?.dob) return;
    autoStarted.current = true;
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, busy, view, details?.dob]);

  /** Old identity without DOB: save it (dob-added), then start with it. */
  const saveDob = (e: FormEvent) => {
    e.preventDefault();
    setDobTouched(true);
    if (validateDob(dobInput)) return;
    const iso = normalizeDob(dobInput);
    update((d) => ({ ...d, onboarding: onboardingReducer(d.onboarding, { type: 'dob-added', dob: iso, at: new Date().toISOString() }) }));
    autoStarted.current = true;
    start(iso);
  };

  const step = (fn: () => Promise<void>) => () => void run(async () => {
    try { await fn(); } catch (err) { setError(message(err, LOAD_FAILED)); }
  });

  const uploadSelfie = () => void run(async () => {
    const f = fileRef.current?.files?.[0];
    const type = f?.type === 'image/jpeg' || f?.type === 'image/png' ? f.type : null;
    if (!f || !type || f.size > MAX_UPLOAD || f.size === 0) { setError(SELFIE_TOO_BIG); return; }
    try {
      const urls = await client.documentUploadUrls([{ kind: 'selfie', contentType: type, size: f.size }]);
      const u = urls.selfie;
      if (!u) { setError(LOAD_FAILED); return; }
      const res = await window.fetch(u.url, { method: 'PUT', headers: u.headers, body: f });
      if (!res.ok) { setError('Could not upload your selfie. Try again.'); return; }
      await follow(await client.submitSelfie(u.uploadId));
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) { setError(message(err, 'Could not upload your selfie. Try again.')); }
  });

  const next = view?.next.type;
  const reason = view?.reason ? REASON_TEXT[view.reason] : undefined;

  return (
    <div className="server-kyc" aria-busy={busy || undefined}>
      {back && !view && !error && <p className="muted" role="status">Welcome back. Checking your status…</p>}
      {view && (
        <p role="status">
          Final KYC: <strong>{kycStatusLabel(view.status)}</strong>
          {reason ? <> ({reason})</> : null}
        </p>
      )}
      {next === 'start' && details && askDob && (
        <form onSubmit={saveDob} noValidate>
          <p className="muted small">Add your date of birth to finish your KYC. It is checked with the KYC records.</p>
          <DobField id="kyc-dob" value={dobInput} touched={dobTouched} disabled={busy} onChange={setDobInput} onBlur={() => setDobTouched(true)} />
          <button type="submit" className="btn primary" disabled={busy || !!validateDob(dobInput)}>Start final KYC</button>
        </form>
      )}
      {next === 'start' && details && !askDob && (
        <>
          <p className="muted small">Your details are checked with the KYC records.</p>
          <button type="button" className="btn primary" disabled={busy} onClick={() => start()}>Start final KYC</button>
        </>
      )}
      {next === 'digilocker' && (
        <>
          <p className="muted small">Verify your Aadhaar with DigiLocker. You will come back here after.</p>
          <button type="button" className="btn primary" disabled={busy} onClick={step(() => aadhaarStep('digilocker'))}>Continue with DigiLocker</button>
        </>
      )}
      {next === 'aadhaar-otp' && (
        <button type="button" className="btn primary" disabled={busy}
          onClick={() => { if (!go(view?.next.url)) void step(() => aadhaarStep('otp'))(); }}>Continue to Aadhaar OTP</button>
      )}
      {next === 'documents' && (
        <div className="field">
          <label htmlFor={fileId}>Upload a selfie (JPG or PNG, up to 10 MB)</label>
          <input id={fileId} ref={fileRef} type="file" accept="image/jpeg,image/png" capture="user" disabled={busy} />
          <button type="button" className="btn primary" disabled={busy} onClick={uploadSelfie}>Upload selfie</button>
        </div>
      )}
      {next === 'esign' && (
        <>
          <p className="muted small">Sign your KYC form with Aadhaar e-sign. You will come back here after.</p>
          <button type="button" className="btn primary" disabled={busy} onClick={step(esignStep)}>Continue to e-sign</button>
        </>
      )}
      {next === 'wait' && (
        <>
          <p className="muted">{WAIT_TEXT}</p>
          <button type="button" className="btn" disabled={busy} onClick={() => void load()}>Refresh</button>
        </>
      )}
      {error && (
        <>
          <p className="error" role="alert">{error}</p>
          {!view && <button type="button" className="btn" disabled={busy} onClick={() => void load()}>Try again</button>}
        </>
      )}
    </div>
  );
}
