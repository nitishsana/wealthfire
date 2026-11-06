import { useState } from 'react';
import { DEFAULT_ASSUMPTIONS, demoData, emptyData, maskAadhaar, maskEmail, maskMobile, maskPan, onboardingReducer, serialize, type Assumptions } from '@wealthfire/core';
import { useStore } from '../store';
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
              {ob.aadhaar ? <>{maskAadhaar(ob.aadhaar.last4)} <span className="badge">Verified</span></> : '—'}
            </dd>
          </dl>
          <p className="muted small">Signing out keeps your financial data in this browser.</p>
          <button className="btn" onClick={() => update((d) => ({ ...d, onboarding: onboardingReducer(d.onboarding, { type: 'sign-out' }) }))}>Sign out</button>
        </Card>
      </div>
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
              if (window.confirm('Delete all Wealthfire data in this browser? This cannot be undone.')) { replace(emptyData()); setMsg('All data deleted.'); }
            }}>Delete all data</button>
          </div>
        </Card>
      </div>
      {msg && <p role="status">{msg}</p>}
    </Page>
  );
}
