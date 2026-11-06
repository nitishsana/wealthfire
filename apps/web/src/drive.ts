// "Choose from Google Drive" for the Aadhaar and PAN slots (design B6).
// Google Picker + Google Identity Services token flow with the drive.file scope, so the app
// only ever sees the one file the user picks. The token stays in memory and is revoked after the pick.

import { validateDocFile, type DocMime } from '@wealthfire/core';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_NOT_SET_UP = "Google Drive isn't set up yet. Upload from your computer instead.";
const DRIVE_MIMES = 'image/jpeg,image/png,application/pdf';

interface TokenResponse { access_token?: string; error?: string; error_description?: string }
interface PickerDoc { id: string; name?: string; mimeType?: string; sizeBytes?: number }
interface PickerResult { action: string; docs?: PickerDoc[] }
interface PickerBuilder {
  addView(v: unknown): PickerBuilder;
  setOAuthToken(t: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setCallback(cb: (r: PickerResult) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}
interface GoogleNs {
  accounts?: { oauth2?: {
    initTokenClient: (c: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string; message?: string }) => void }) => { requestAccessToken: (o?: { prompt?: string }) => void };
    revoke: (token: string, done?: () => void) => void;
  } };
  picker?: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId?: unknown) => { setMimeTypes(m: string): unknown };
    ViewId: { DOCS: unknown };
    Action: { PICKED: string; CANCEL: string };
  };
}
interface DriveWindow { google?: GoogleNs; gapi?: { load: (lib: string, cb: () => void) => void } }
const w = () => window as unknown as DriveWindow;

const env = () => ({
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? '',
  apiKey: import.meta.env.VITE_GOOGLE_API_KEY?.trim() ?? '',
  appId: import.meta.env.VITE_GOOGLE_APP_ID?.trim() ?? '',
});

/** True only when the client id, API key and app id were all set at build time. */
export function isDriveConfigured(): boolean {
  const e = env();
  return Boolean(e.clientId && e.apiKey && e.appId);
}

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { scripts.delete(src); reject(new Error('Could not load Google Drive. Check your internet or ad blocker.')); };
      document.head.appendChild(s);
    });
    scripts.set(src, p);
  }
  return p;
}

async function loadPicker(): Promise<void> {
  await Promise.all([loadScript('https://accounts.google.com/gsi/client'), loadScript('https://apis.google.com/js/api.js')]);
  if (w().google?.picker) return;
  await new Promise<void>((resolve) => w().gapi!.load('picker', () => resolve()));
}

function getToken(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const oauth = w().google?.accounts?.oauth2;
    if (!oauth) return reject(new Error('Could not load Google sign-in.'));
    oauth.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (r) => (r.error || !r.access_token ? reject(new Error(r.error_description || r.error || 'Google sign-in failed.')) : resolve(r.access_token)),
      error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'Sign-in window was closed.' : e.message || 'Google sign-in failed.')),
    }).requestAccessToken({ prompt: '' });
  });
}

/** Opens Google's picker and downloads the chosen file. Returns null if the user cancels. */
export async function pickFromDrive(): Promise<File | null> {
  const e = env();
  if (!isDriveConfigured()) throw new Error(DRIVE_NOT_SET_UP);
  await loadPicker();
  const token = await getToken(e.clientId);
  // Every path from here (pick, cancel, picker error, size/type error, download error) revokes the token.
  try {
    const g = w().google!.picker!;
    const doc = await new Promise<PickerDoc | null>((resolve, reject) => {
      // Bug 8: settle on every picker action. 'loaded' is the only non-final action; anything
      // else that is not PICKED (cancel, close, error) ends the pick with nothing chosen.
      const view = new g.DocsView(g.ViewId.DOCS);
      view.setMimeTypes(DRIVE_MIMES);
      new g.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(e.apiKey)
        .setAppId(e.appId)
        .setCallback((r) => {
          if (r.action === g.Action.PICKED) resolve(r.docs?.[0] ?? null);
          else if (r.action === 'loaded') return;
          else if (r.action === 'error') reject(new Error('Could not open Google Drive.'));
          else resolve(null);
        })
        .build()
        .setVisible(true);
    });
    if (!doc) return null;
    // Bug 8: check type and size from the picker's metadata before downloading anything.
    // A missing field is checked again by the slot after download.
    const bad = validateDocFile({
      kind: 'pan', // Drive is offered for the Aadhaar and PAN cards only; both use the card rules.
      mime: (doc.mimeType ?? 'application/pdf') as DocMime,
      size: doc.sizeBytes === undefined ? 1 : Number(doc.sizeBytes),
    });
    if (bad) throw new Error(bad);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Could not download the file from Google Drive.');
    const blob = await res.blob();
    return new File([blob], doc.name ?? 'document', { type: doc.mimeType || blob.type });
  } finally {
    w().google?.accounts?.oauth2?.revoke(token);
  }
}
