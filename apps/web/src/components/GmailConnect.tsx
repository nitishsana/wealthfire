// "Connect Gmail" card shown inside Expenses. Reads credit card spend alert emails
// (read-only) and adds them straight to Expenses. Token stays in memory only.
import { useState } from 'react';
import { GmailAuthError, mergeExpenses, syncGmail } from '@wealthfire/core';
import { useStore } from '../store';
import { clientIdFromBuild, forgetGmailToken, getClientId, getGmailToken, hasGmailToken, isValidClientId, setClientId } from '../google';
import { Card } from '../ui';

export function GmailConnect() {
  const { data, update } = useStore();
  const [clientId, setId] = useState(getClientId());
  const [draftId, setDraftId] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(hasGmailToken());
  const configured = isValidClientId(clientId);
  const gmailCount = data.expenses.filter((e) => e.source === 'gmail').length;
  // First sync looks back 90 days; later syncs only since the last one (plus a day of overlap).
  const days = data.gmailLastSync ? Math.max(1, Math.ceil((Date.now() - Date.parse(data.gmailLastSync)) / 86_400_000) + 1) : 90;

  async function sync() {
    setBusy(true); setError(''); setStatus('Opening Google sign-in…');
    try {
      const token = await getGmailToken();
      setConnected(true);
      setStatus('Reading card alert emails…');
      const r = await syncGmail(token, {
        days,
        existingIds: new Set(data.expenses.map((e) => e.id)),
        onProgress: (d, t) => setStatus(`Read ${d} of ${t} emails…`),
      });
      update((d) => ({ ...mergeExpenses(d, r.added), gmailLastSync: new Date().toISOString() }));
      setStatus(r.added.length ? `Added ${r.added.length} card spends to your expenses.` : 'No new card spends found.');
    } catch (e) {
      if (e instanceof GmailAuthError) { forgetGmailToken(); setConnected(false); }
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-feature="gmail">
      <Card title="📧 Credit cards via Gmail">
        <p>Connect Gmail and Wealthfire picks up your card spend alerts and adds them here.</p>
        <p className="muted small">
          {gmailCount} spends from Gmail · Last sync {data.gmailLastSync ? new Date(data.gmailLastSync).toLocaleString('en-IN') : 'never'}
        </p>

        {configured ? (
          <div className="row">
            <button className="btn primary" onClick={sync} disabled={busy}>
              {busy ? 'Working…' : connected || data.gmailLastSync ? 'Sync card spends' : 'Connect Gmail'}
            </button>
            {connected && <button className="btn" onClick={() => { forgetGmailToken(); setConnected(false); setStatus('Disconnected.'); }} disabled={busy}>Disconnect</button>}
          </div>
        ) : (
          <>
            <button className="btn primary" onClick={() => setShowSetup((v) => !v)} aria-expanded={showSetup}>Connect Gmail</button>
            {showSetup && (
              <div className="setup">
                <p className="small">One-time setup: Google needs an app ID for Wealthfire.</p>
                <ol className="tips small">
                  <li>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud credentials</a> and create a project.</li>
                  <li>Turn on the <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noreferrer">Gmail API</a>.</li>
                  <li>OAuth consent screen: External, add yourself as a test user, scope <code>gmail.readonly</code>.</li>
                  <li>Create an OAuth client ID of type Web application, with origin <code>{window.location.origin}</code>.</li>
                </ol>
                <label className="field" htmlFor="cid"><span>Google client ID</span>
                  <input id="cid" value={draftId} onChange={(e) => setDraftId(e.target.value)} placeholder="1234-abcd.apps.googleusercontent.com" spellCheck={false} />
                </label>
                {draftId && !isValidClientId(draftId) && <p className="error" role="alert">It should end in .apps.googleusercontent.com</p>}
                <button className="btn primary" disabled={!isValidClientId(draftId)} onClick={() => { setClientId(draftId); setId(getClientId()); setShowSetup(false); }}>Save and continue</button>
              </div>
            )}
          </>
        )}

        {status && <p role="status" className="muted">{status}</p>}
        {error && <p role="alert" className="error">{error}</p>}
        <p className="muted small">
          Read-only. Refunds, OTPs and payments are skipped. Access ends when you close the tab.
          {configured && !clientIdFromBuild() && <> <button className="link" onClick={() => { setClientId(''); setId(''); }}>Change app ID</button></>}
        </p>
      </Card>
    </div>
  );
}
