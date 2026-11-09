// Google sign-in for Gmail read-only, using Google Identity Services (browser-only token flow).
// The access token lives in memory for this tab only and is never saved.
import { GMAIL_SCOPE } from '@wealthfire/core';
import { storageKey } from './localTest';

interface TokenResponse { access_token?: string; expires_in?: number; error?: string; error_description?: string }
interface TokenClient { requestAccessToken: (o?: { prompt?: string }) => void }
declare global {
  interface Window {
    google?: { accounts: { oauth2: {
      initTokenClient: (c: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string; message?: string }) => void }) => TokenClient;
      revoke: (token: string, done?: () => void) => void;
    } } };
  }
}

// prefixed per test user in the localkyc build (?persona=), unchanged otherwise
const CLIENT_ID_KEY = storageKey('wealthfire.googleClientId');

/** Build-time id (GitHub repo variable) wins; else one the user pasted in the app. */
export function getClientId(): string {
  return (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() || localStorage.getItem(CLIENT_ID_KEY) || '';
}
export function setClientId(id: string) {
  localStorage.setItem(CLIENT_ID_KEY, id.trim());
}
export const clientIdFromBuild = () => Boolean((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim());

/** Google web client ids look like 1234-abc.apps.googleusercontent.com */
export const isValidClientId = (id: string) => /^[\w-]+\.apps\.googleusercontent\.com$/.test(id.trim());

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('Could not load Google sign-in. Check your internet or ad blocker.')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

let token: { value: string; expiresAt: number } | null = null;

/** Opens Google's consent popup (first time) and returns an access token. */
export async function getGmailToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  const clientId = getClientId();
  if (!isValidClientId(clientId)) throw new Error('Add a Google client ID first.');
  await loadScript();
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GMAIL_SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) return reject(new Error(r.error_description || r.error || 'Google sign-in failed.'));
        token = { value: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'Sign-in window was closed.' : e.message || 'Google sign-in failed.')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

export function forgetGmailToken() {
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token.value);
  token = null;
}

export const hasGmailToken = () => Boolean(token && Date.now() < token.expiresAt);
