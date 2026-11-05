// Gmail spends on Android / iOS. Same flow and wording as apps/web/src/pages/Gmail.tsx.
// Sign-in uses expo-auth-session's Google provider (PKCE). The token is kept in memory only.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Linking, Platform, Text } from 'react-native';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { GMAIL_SCOPE, GmailAuthError, inr, mergeExpenses, syncGmail, type Expense } from '@wealthfire/core';
import { useStore } from '../store';
import { Btn, Card, Chips, Line, s, Screen, Stat, Stats, Tips } from '../ui';

WebBrowser.maybeCompleteAuthSession();

export interface GoogleConfig {
  androidClientId?: string;
  iosClientId?: string;
}
export const GoogleCtx = createContext<GoogleConfig>({});

const DAY_OPTIONS = [30, 90, 180, 365];
let memToken: { value: string; expiresAt: number } | null = null;

function GoodToKnow() {
  return (
    <Card title="Good to know">
      <Tips items={[
        'Turn on email alerts for card spends in your bank app. Most Indian banks send them.',
        'Refunds, OTPs, payments and declined charges are skipped.',
        'Monthly statement PDFs are not read yet. They are often password-locked.',
        'Your Google access ends when you close the app. Revoke any time in your Google account permissions.',
      ]} />
      <Btn title="Open Google account permissions" onPress={() => Linking.openURL('https://myaccount.google.com/permissions')} />
    </Card>
  );
}

function Connected({ google }: { google: GoogleConfig }) {
  const { data, update } = useStore();
  const [request, response, promptAsync] = Google.useAuthRequest({ ...google, scopes: [GMAIL_SCOPE] });
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [last, setLast] = useState<{ added: Expense[]; scanned: number; skipped: number; duplicates: number } | null>(null);
  const [connected, setConnected] = useState(Boolean(memToken && Date.now() < memToken.expiresAt));
  const pendingSync = useRef(false);

  async function run(token: string) {
    setBusy(true); setError(''); setProgress('Reading alert emails…');
    try {
      const r = await syncGmail(token, {
        days,
        existingIds: new Set(data.expenses.map((e) => e.id)),
        onProgress: (d, t) => setProgress(`Read ${d} of ${t} emails…`),
      });
      update((d) => ({ ...mergeExpenses(d, r.added), gmailLastSync: new Date().toISOString() }));
      setLast(r);
    } catch (e) {
      if (e instanceof GmailAuthError) { memToken = null; setConnected(false); }
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setProgress(''); setBusy(false);
    }
  }

  useEffect(() => {
    if (!response) return;
    if (response.type === 'success' && response.authentication?.accessToken) {
      const a = response.authentication;
      memToken = { value: a.accessToken, expiresAt: Date.now() + (a.expiresIn ?? 3600) * 1000 };
      setConnected(true);
      if (pendingSync.current) { pendingSync.current = false; void run(a.accessToken); }
    } else if (response.type === 'error') {
      setError(response.error?.message ?? 'Google sign-in failed.');
      pendingSync.current = false;
    } else if (response.type === 'dismiss' || response.type === 'cancel') {
      setError('Sign-in window was closed.');
      pendingSync.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  async function onSync() {
    setError('');
    if (memToken && Date.now() < memToken.expiresAt - 60_000) return run(memToken.value);
    pendingSync.current = true;
    setProgress('Opening Google sign-in…');
    await promptAsync();
    setProgress('');
  }

  const gmailCount = data.expenses.filter((e) => e.source === 'gmail').length;
  return (
    <>
      <Stats>
        <Stat label="Status" value={connected ? 'Connected' : 'Not connected'} tone={connected ? 'good' : undefined} />
        <Stat label="Spends from Gmail" value={String(gmailCount)} />
        <Stat label="Last sync" value={data.gmailLastSync ? new Date(data.gmailLastSync).toLocaleDateString('en-IN') : 'Never'} />
      </Stats>
      <Card title={connected ? 'Sync again' : 'Connect Gmail'}>
        <Text style={s.text}>Wealthfire asks Google for read-only access. It looks only for card spend alerts. Nothing is sent anywhere else.</Text>
        <Text style={[s.muted, { marginTop: 10 }]}>Look back</Text>
        <Chips label="Look back" value={days} onChange={setDays} options={DAY_OPTIONS.map((d) => ({ label: `Last ${d} days`, value: d }))} />
        <Btn primary title={busy ? 'Working…' : connected ? 'Sync Gmail now' : 'Connect Gmail and sync'} disabled={busy || !request} onPress={onSync} />
        {connected ? <Btn title="Disconnect" disabled={busy} onPress={() => { memToken = null; setConnected(false); }} /> : null}
        {progress ? <Text style={[s.muted, { marginTop: 8 }]} accessibilityLiveRegion="polite">{progress}</Text> : null}
        {error ? <Text style={{ color: '#ff6b6b', marginTop: 8 }} accessibilityRole="alert">{error}</Text> : null}
      </Card>
      {last ? (
        <Card title="Last sync">
          <Text style={s.text}>Checked {last.scanned} emails. Added {last.added.length} spends. {last.duplicates} were already added. {last.skipped} were not card spends.</Text>
          {last.added.slice(0, 30).map((e) => <Line key={e.id} left={e.description} sub={`${e.date} · ${e.category}`} right={inr(e.amount)} />)}
        </Card>
      ) : null}
    </>
  );
}

export function GmailScreen() {
  const google = useContext(GoogleCtx);
  const id = Platform.OS === 'ios' ? google.iosClientId : google.androidClientId;
  const configured = Boolean(id && /\.apps\.googleusercontent\.com$/.test(id));
  return (
    <Screen feature="gmail" title="Gmail spends" intro="Read your card spend alert emails and add them to Expenses automatically.">
      {configured ? <Connected google={google} /> : (
        <Card title="Step 1: Add your Google client ID">
          <Text style={s.text}>Google needs an app ID before Wealthfire can read Gmail. You make it once, for free.</Text>
          <Tips items={[
            'In Google Cloud, use the same project as the website.',
            `Create credentials → OAuth client ID → ${Platform.OS === 'ios' ? 'iOS, bundle ID com.nitishsana.wealthfire' : 'Android, package com.nitishsana.wealthfire and your SHA-1'}.`,
            `Put the client ID in apps/${Platform.OS === 'ios' ? 'ios' : 'android'}/app.json under expo.extra.${Platform.OS === 'ios' ? 'googleIosClientId' : 'googleAndroidClientId'}.`,
            'Rebuild the app. Google sign-in needs a dev build, not Expo Go.',
          ]} />
          <Btn title="Open Google Cloud credentials" onPress={() => Linking.openURL('https://console.cloud.google.com/apis/credentials')} />
        </Card>
      )}
      <GoodToKnow />
    </Screen>
  );
}
