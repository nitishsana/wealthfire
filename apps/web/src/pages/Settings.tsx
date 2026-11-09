import { useState } from 'react';
import {
  accountStatusNote, DEFAULT_ASSUMPTIONS, demoData, showDemoReviewer, emptyData, kycStatusLabel, maskAadhaar, maskEmail, maskMobile, maskPan, onboardingReducer, reviewRowReasonText, serialize,
  type Assumptions,
} from '@wealthfire/core';
import { useStore } from '../store';
import { documentReader } from '../docreader';
import { DATA_DELETED_TEXT, markDataDeleted } from './Onboarding';
import { kycServer } from '../server';
import { ServerKyc, startDetails } from '../components/ServerKyc';
import { Card, NumberField, Page } from '../ui';

const FIELDS: { key: keyof Assumptions; label: string; step: number }[] = [
  { key: 'inflation', label: 'Inflation', step: 0.5 },
  { key: 'equityReturn', label: 'Equity return', step: 0.5 },
  { key: 'debtReturn', label: 'Debt return', step: 0.5 },
  { key: 'cashReturn', label: 'Cash return', step: 0.5 },
  { key: 'safeWithdrawalRate', label: 'Safe withdrawal rate', step: 0.1 },
  { key: 'sipStepUp', label: 'SIP step-up each year', step: 1 },
];

export function SettingsPage() {
  const { data, update, replace } = useStore();
  const [msg, setMsg] = useState('');

  function exportJson() {
    const blob = new Blob([serialize(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'wealthfire-backup.json'; a.click();
    URL.revokeObjectURL(url);
  }

  const ob = data.onboarding;
  const contact = ob.contact ? (ob.contact.kind === 'email' ? maskEmail(ob.contact.value) : maskMobile(ob.contact.value)) : '—';

  return (
    <Page feature="demo" title="Settings" intro="Assumptions, demo data and backup.">
      <div data-feature="onboard-account">
        <Card title="Account">
          <dl className="account">
            <dt>{ob.contact?.kind === 'email' ? 'Email' : 'Mobile number'}</dt>
            <dd>{contact}</dd>
            <dt>PAN</dt>
            <dd>{ob.identity ? maskPan(ob.identity.pan) : '—'}</dd>
            <dt>Aadhaar</dt>
            <dd>
              {ob.aadhaar ? <>{maskAadhaar(ob.aadhaar.last4)} <span className="badge">OTP verified</span></> : '—'}
            </dd>
          </dl>
          {/* R5: with a KYC server its status decides (the device value is a cache); without one the device status shows. */}
          <div data-feature="kyc-final-status">
          {kycServer && <ServerKyc client={kycServer} details={startDetails(ob)} />}
          <div data-feature="onboard-review" className="account-status">
            {/* Live region on the text only, not on the block holding the button (Bug 10). */}
            <p role="status">
              {kycServer ? 'Device check: ' : 'Account status: '}<strong>{kycStatusLabel(ob.kyc.status)}</strong>
              {ob.kyc.status === 'rejected' && ob.kyc.review?.decision?.reason ? <> ({ob.kyc.review.decision.reason})</> : null}
            </p>
            {accountStatusNote(ob.kyc.status) && <p className="muted">{accountStatusNote(ob.kyc.status)}</p>}
            {ob.kyc.status === 'rejected' && (
              <button className="btn primary" onClick={() => update((d) => ({ ...d, onboarding: onboardingReducer(d.onboarding, { type: 'redo-documents' }) }))}>Redo documents</button>
            )}
          </div>
          </div>
          <p className="muted small">Signing out keeps your financial data in this browser.</p>
          <button className="btn" onClick={() => {
            // With a server, also end the server session (clears the in-memory token and the refresh cookie).
            if (kycServer) void kycServer.logout().catch(() => undefined);
            update((d) => ({ ...d, onboarding: onboardingReducer(d.onboarding, { type: 'sign-out' }) }));
          }}>Sign out</button>
        </Card>
      </div>
      {/* G2: dev builds only; the production bundle drops the Demo reviewer entirely. */}
      {/* Shown only while a final KYC approval can be given (pre-verified or under review), and never with a
          KYC server (F8: Verified then comes only from the server). */}
      {showDemoReviewer({ dev: import.meta.env.DEV, demoReader: documentReader.isDemo, serverConfigured: !!kycServer, kyc: ob.kyc }) && <DemoReviewer />}
      <Card title="Assumptions (% per year)">
        <div className="form-grid">
          {FIELDS.map((f) => (
            <NumberField key={f.key} id={`as-${f.key}`} label={f.label} value={data.assumptions[f.key]} step={f.step} suffix="%"
              onChange={(v) => update((d) => ({ ...d, assumptions: { ...d.assumptions, [f.key]: v } }))} />
          ))}
        </div>
        <button className="btn" onClick={() => update((d) => ({ ...d, assumptions: { ...DEFAULT_ASSUMPTIONS } }))}>Reset to defaults</button>
      </Card>
      <div className="grid two">
        <Card title="Demo">
          <p>Fill the app with a sample user to look around.</p>
          <button className="btn primary" onClick={() => { replace({ ...demoData(), onboarding: data.onboarding }); setMsg('Demo data loaded.'); }}>Load demo data</button>
        </Card>
        <Card title="Your data">
          <p className="muted">Stored only in this browser. Clearing browser data deletes it.</p>
          <div className="row">
            <button className="btn" onClick={exportJson}>Download backup</button>
            <button className="btn danger" onClick={() => {
              if (window.confirm('Delete all Wealthfire data in this browser? This cannot be undone.')) { markDataDeleted(); replace(emptyData()); setMsg(DATA_DELETED_TEXT); }
            }}>Delete all data</button>
          </div>
        </Card>
      </div>
      {msg && <p role="status">{msg}</p>}
    </Page>
  );
}

/** Demo stand-in for the hand check (Req 9.6). Shows masks only; documents are never stored. */
function DemoReviewer() {
  const { data, update } = useStore();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const kyc = data.onboarding.kyc;
  // Under review: a pending hand check (Approve or Reject). Pre-verified: the device checks passed,
  // so only the final KYC approval is simulated (no Reject).
  const pre = kyc.status === 'pre-verified';
  const pending = kyc.status === 'under-review' ? kyc.review : null;
  const r = reason.trim();
  const reasonErr = r.length < 1 || r.length > 200 ? 'Enter a reason (1–200 characters).' : null;
  const decide = (result: 'approved' | 'rejected') => {
    update((d) => ({ ...d, onboarding: onboardingReducer(d.onboarding, { type: 'review-decided', result, reason: result === 'rejected' ? r : null, at: new Date().toISOString() }) }));
    setReason(''); setTouched(false);
  };

  return (
    <div>
      <Card title="Demo reviewer">
        <p className="muted small">Demo mode: this stands in for the Wealthfire team's hand check.</p>
        {pre ? (
          <>
            <p>The documents matched on this device. Final KYC is pending.</p>
            <div className="row">
              <button className="btn primary" onClick={() => decide('approved')}>Approve final KYC (demo)</button>
            </div>
          </>
        ) : !pending ? (
          <p>No review waiting.</p>
        ) : (
          <>
            {pending.sentAt ? <p className="muted small">Sent {new Date(pending.sentAt).toLocaleString('en-IN')}</p> : null}
            <table>
              <thead><tr><th scope="col">Field</th><th scope="col">Typed</th><th scope="col">Read from document</th><th scope="col">Reason</th></tr></thead>
              <tbody>
                {/* Review bug 11: the reason column says why each field is under review (numbers differ / name didn't match). */}
                {pending.fields.map((f) => (
                  <tr key={f.field}><td>{f.field === 'pan' ? 'PAN' : 'Aadhaar'}</td><td>{f.typedMasked}</td><td>{f.readMasked}</td><td>{reviewRowReasonText(f, pending.fields)}</td></tr>
                ))}
              </tbody>
            </table>
            <label className="field" htmlFor="rv-reason">
              <span>Reason (needed to reject)</span>
              <input id="rv-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} onBlur={() => setTouched(true)}
                aria-invalid={touched && reasonErr ? true : undefined} aria-describedby={touched && reasonErr ? 'rv-reason-err' : undefined} />
            </label>
            {touched && reasonErr && <p id="rv-reason-err" className="error" role="status">{reasonErr}</p>}
            <div className="row">
              <button className="btn primary" onClick={() => decide('approved')}>Approve final KYC (demo)</button>
              <button className="btn danger" disabled={!!reasonErr} onClick={() => decide('rejected')}>Reject</button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
