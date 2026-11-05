// "Credit cards via Gmail" card shown inside Expenses on Android / iOS.
// Same flow and wording as apps/web/src/components/GmailConnect.tsx.
// Sign-in uses expo-auth-session's Google provider (PKCE). The token is kept in memory only.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { GMAIL_SCOPE, GmailAuthError, mergeExpenses, syncGmail } from '@wealthfire/core';
import { useStore } from '../store';
import { Btn, Card, s, Tips } from '../ui';

WebBrowser.maybeCompleteAuthSession();

export interface GoogleConfig {
  androidClientId?: string;
  iosClientId?: string;
}
export const GoogleCtx = createContext<GoogleConfig>({});

let memToken: { value: string; expiresAt: number } | null = null;

function Summary() {
  const { data } = useStore();
  const gmailCount = data.expenses.filter((e) => e.source === 'gmail').length;
  return (
    <>
      <Text style={s.text}>Connect Gmail and Wealthfire picks up your card spend alerts and adds them here.</Text>
      <Text style={[s.small, { marginTop: 6 }]}>
        {gmailCount} spends from Gmail · Last sync {data.gmailLastSync ? new Date(data.gmailLastSync).toLocaleString('en-IN') : 'never'}
      </Text>
    </>
  );
}

const FOOTER = 'Read-only. Refunds, OTPs and payments are skipped. Access ends when you close the app.';

function Connected({ google }: { google: GoogleConfig }) {
  const { data, update } = useStore();
  const [request, response, promptAsync] = Google.useAuthRequest({ ...google, scopes: [GMAIL_SCOPE] });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(Boolean(memToken && Date.now() < memToken.expiresAt));
  const pendingSync = useRef(false);
  const days = data.gmailLastSync ? Math.max(1, Math.ceil((Date.now() - Date.parse(data.gmailLastSync)) / 86_400_000) + 1) : 90;

  async function run(token: string) {
    setBusy(true); setError(''); setStatus('Reading card alert emails…');
    try {
      const r = await syncGmail(token, {
        days,
        existingIds: new Set(data.expenses.map((e) => e.id)),
        onProgress: (d, t) => setStatus(`Read ${d} of ${t} emails…`),
      });
      update((d) => ({ ...mergeExpenses(d, r.added), gmailLastSync: new Date().toISOString() }));
      setStatus(r.added.length ? `Added ${r.added.length} card spends to your expenses.` : 'No new card spends found.');
    } catch (e) {
      if (e instanceof GmailAuthError) { memToken = null; setConnected(false); }
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setStatus('');
    } finally {
      setBusy(false);
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
      setError(response.error?.message ?? 'Google sign-in failed.'); setStatus(''); pendingSync.current = false;
    } else if (response.type === 'dismiss' || response.type === 'cancel') {
      setError('Sign-in window was closed.'); setStatus(''); pendingSync.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  async function onSync() {
    setError('');
    if (memToken && Date.now() < memToken.expiresAt - 60_000) return run(memToken.value);
    pendingSync.current = true;
    setStatus('Opening Google sign-in…');
    await promptAsync();
  }

  return (
    <>
      <Btn primary title={busy ? 'Working…' : connected || data.gmailLastSync ? 'Sync card spends' : 'Connect Gmail'} disabled={busy || !request} onPress={onSync} />
      {connected ? <Btn title="Disconnect" disabled={busy} onPress={() => { memToken = null; setConnected(false); setStatus('Disconnected.'); }} /> : null}
      {status ? <Text style={[s.muted, { marginTop: 8 }]} accessibilityLiveRegion="polite">{status}</Text> : null}
      {error ? <Text style={{ color: '#ff6b6b', marginTop: 8 }} accessibilityRole="alert">{error}</Text> : null}
    </>
  );
}

function Setup() {
  const [open, setOpen] = useState(false);
  const ios = Platform.OS === 'ios';
  return (
    <>
      <Btn primary title="Connect Gmail" onPress={() => setOpen((v) => !v)} />
      {open ? (
        <View style={{ marginTop: 10 }}>
          <Text style={s.small}>One-time setup: Google needs an app ID for Wealthfire.</Text>
          <Tips items={[
            'In Google Cloud, use the same project as the website.',
            `Create an OAuth client ID of type ${ios ? 'iOS, bundle ID com.nitishsana.wealthfire' : 'Android, package com.nitishsana.wealthfire and your SHA-1'}.`,
            `Put it in apps/${ios ? 'ios' : 'android'}/app.json under expo.extra.${ios ? 'googleIosClientId' : 'googleAndroidClientId'}, then rebuild.`,
          ]} />
          <Btn title="Open Google Cloud credentials" onPress={() => Linking.openURL('https://console.cloud.google.com/apis/credentials')} />
        </View>
      ) : null}
    </>
  );
}

export function GmailConnect() {
  const google = useContext(GoogleCtx);
  const id = Platform.OS === 'ios' ? google.iosClientId : google.androidClientId;
  const configured = Boolean(id && /\.apps\.googleusercontent\.com$/.test(id));
  return (
    <View testID="feature-gmail">
      <Card title="📧 Credit cards via Gmail">
        <Summary />
        {configured ? <Connected google={google} /> : <Setup />}
        <Text style={[s.small, { marginTop: 8 }]}>{FOOTER}</Text>
      </Card>
    </View>
  );
}
