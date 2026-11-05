import { useState } from 'react';
import { GmailAuthError, inr, mergeExpenses, syncGmail, type Expense } from '@wealthfire/core';
import { useStore } from '../store';
import { clientIdFromBuild, forgetGmailToken, getClientId, getGmailToken, hasGmailToken, isValidClientId, setClientId } from '../google';
import { Card, Page, Stat } from '../ui';

const DAY_OPTIONS = [30, 90, 180, 365];

export function GmailPage() {
  const { data, update } = useStore();
  const [clientId, setId] = useState(getClientId());
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [last, setLast] = useState<{ added: Expense[]; scanned: number; skipped: number; duplicates: number } | null>(null);
  const [connected, setConnected] = useState(hasGmailToken());
  const configured = isValidClientId(clientId);
  const gmailCount = data.expenses.filter((e) => e.source === 'gmail').length;

  async function sync() {
    setBusy(true); setError(''); setProgress('Opening Google sign-in…');
    try {
      const token = await getGmailToken();
      setConnected(true);
      setProgress('Reading alert emails…');
      const r = await syncGmail(token, {
        days,
        existingIds: new Set(data.expenses.map((e) => e.id)),
        onProgress: (d, t) => setProgress(`Read ${d} of ${t} emails…`),
      });
      update((d) => ({ ...mergeExpenses(d, r.added), gmailLastSync: new Date().toISOString() }));
      setLast(r);
      setProgress('');
    } catch (e) {
      if (e instanceof GmailAuthError) { forgetGmailToken(); setConnected(false); }
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setProgress('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page feature="gmail" title="Gmail spends" intro="Read your card spend alert emails and add them to Expenses automatically.">
      <div className="grid stats">
        <Stat label="Status" value={connected ? 'Connected' : 'Not connected'} tone={connected ? 'good' : undefined} />
        <Stat label="Spends from Gmail" value={String(gmailCount)} />
        <Stat label="Last sync" value={data.gmailLastSync ? new Date(data.gmailLastSync).toLocaleDateString('en-IN') : 'Never'}
          sub={data.gmailLastSync ? new Date(data.gmailLastSync).toLocaleTimeString('en-IN') : undefined} />
      </div>

      {!configured && (
        <Card title="Step 1: Add your Google client ID" className="notice">
          <p>Google needs an app ID before Wealthfire can read Gmail. You make it once, for free.</p>
          <ol className="tips">
            <li>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud credentials</a> and create a project.</li>
            <li>Turn on the <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noreferrer">Gmail API</a>.</li>
            <li>OAuth consent screen: type External, add yourself as a test user, add the scope <code>gmail.readonly</code>.</li>
            <li>Create credentials → OAuth client ID → Web application.</li>
            <li>Authorized JavaScript origin: <code>{window.location.origin}</code></li>
            <li>Copy the client ID and paste it below.</li>
          </ol>
          <label className="field" htmlFor="cid"><span>Google client ID</span>
            <input id="cid" value={clientId} onChange={(e) => setId(e.target.value)} placeholder="1234-abcd.apps.googleusercontent.com" spellCheck={false} />
          </label>
          <button className="btn primary" disabled={!isValidClientId(clientId)} onClick={() => { setClientId(clientId); setId(getClientId()); }}>Save client ID</button>
          {clientId && !isValidClientId(clientId) && <p className="error" role="alert">That doesn't look like a client ID. It ends in .apps.googleusercontent.com</p>}
        </Card>
      )}

      {configured && (
        <Card title={connected ? 'Sync again' : 'Step 2: Connect Gmail'}>
          <p>Wealthfire asks Google for <strong>read-only</strong> access. It looks only for card spend alerts. Nothing is sent anywhere else.</p>
          <label className="field" htmlFor="days"><span>Look back</span>
            <select id="days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {DAY_OPTIONS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
            </select>
          </label>
          <div className="row">
            <button className="btn primary" onClick={sync} disabled={busy}>{busy ? 'Working…' : connected ? 'Sync Gmail now' : 'Connect Gmail and sync'}</button>
            {connected && <button className="btn" onClick={() => { forgetGmailToken(); setConnected(false); }} disabled={busy}>Disconnect</button>}
            {!clientIdFromBuild() && <button className="btn" onClick={() => { setClientId(''); setId(''); }} disabled={busy}>Change client ID</button>}
          </div>
          {progress && <p role="status" className="muted">{progress}</p>}
          {error && <p role="alert" className="error">{error}</p>}
        </Card>
      )}

      {last && (
        <Card title="Last sync">
          <p>Checked {last.scanned} emails. Added <strong>{last.added.length}</strong> spends. {last.duplicates} were already added. {last.skipped} were not card spends.</p>
          {last.added.length > 0 && (
            <table>
              <thead><tr><th scope="col">Date</th><th scope="col">Where</th><th scope="col">Category</th><th scope="col" className="num">Amount</th></tr></thead>
              <tbody>
                {last.added.slice(0, 30).map((e) => (
                  <tr key={e.id}><td>{e.date}</td><td>{e.description}</td><td>{e.category}</td><td className="num">{inr(e.amount)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small">Fix any category in <a href="#/expenses">Expenses</a>.</p>
        </Card>
      )}

      <Card title="Good to know">
        <ul className="tips">
          <li>Turn on email alerts for card spends in your bank app. Most Indian banks send them.</li>
          <li>Refunds, OTPs, payments and declined charges are skipped.</li>
          <li>Monthly statement PDFs are not read yet. They are often password-locked.</li>
          <li>Your Google access ends when you close this tab. Revoke any time at <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">Google account permissions</a>.</li>
        </ul>
      </Card>
    </Page>
  );
}
