// Final KYC server (services/kyc, design §6) on Android / iOS. Only active when app.json `expo.extra.apiUrl` is set.
// Without it `useKycServer()` is null and every screen keeps its device-only behaviour (demo OTP, device status).
//
// Tokens: the access token stays in memory only. The refresh token is kept in expo-secure-store (iOS Keychain /
// Android Keystore). expo-secure-store is loaded through a guarded require: without its native module the refresh
// token is kept in memory only (signed out on restart), never in AsyncStorage.
// DigiLocker / Aadhaar OTP / e-sign pages open in an auth session (expo-web-browser) that returns to KYC_RETURN_URL;
// only HTTPS pages on the API origin or extra.kycRedirectOrigins are opened.
// Same steps and texts as apps/web/src/components/ServerKyc.tsx. Sends names, PAN, Aadhaar last 4, date of birth and the
// device result only; the full Aadhaar never leaves the phone and the selfie goes straight to its presigned upload URL.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { File, UploadType } from 'expo-file-system';
import {
  DOB_HINT, DOB_LABEL, isServerError, kycStatusLabel, normalizeDob, onboardingReducer, ServerKycClient, validateDob,
  type DocFile, type KycStatusView, type OnboardingState, type StartKycInput, type TokenStore,
} from '@wealthfire/core';
import { useBlockBackWhile } from './shell';
import { useStore } from './store';
import { theme } from './theme';
import { Btn, s } from './ui';
import { Input, Msg } from './screens/onboardUi';
import { deleteDoc, DocSlot } from './screens/Documents';

export interface KycServerConfig {
  /** services/kyc API base URL. HTTPS only (plain http only for a loopback dev API). Unset / '' = no server. */
  apiUrl?: string;
  /** Extra HTTPS origins (comma separated) DigiLocker / e-sign pages may come from. The API origin is always allowed. */
  redirectOrigins?: string;
}

/** Where DigiLocker / e-sign send the user back (app.json scheme 'wealthfire'). */
export const KYC_RETURN_URL = 'wealthfire://kyc-return';

// Same texts as apps/web/src/components/ServerKyc.tsx.
export const WAIT_TEXT = "We're checking your details. This can take a few minutes.";
export const REDIRECT_BLOCKED = 'Could not open the next step. Try again later.';
export const LOAD_FAILED = 'Could not get your KYC status. Try again.';
export const SELFIE_TOO_BIG = 'Choose a JPG or PNG photo up to 10 MB.';
const UPLOAD_FAILED = 'Could not upload your selfie. Try again.';
const MAX_UPLOAD = 10 * 1024 * 1024;

/** Short text for a server reason code (unknown codes show nothing, so no server value is ever echoed). Same as web. */
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

// ---------- URL checks (no URL class: React Native's is incomplete) ----------

const URL_RE = /^(https?):\/\/([^/?#\s]+)([^\s]*)$/i;

/** 'scheme://host[:port]' (lower-case), or null when not https (http only for loopback) or it carries credentials. */
function originOf(raw: string): string | null {
  const m = URL_RE.exec(raw.trim());
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  const host = m[2]!.toLowerCase();
  if (host.includes('@')) return null;
  const hostname = host.replace(/:\d+$/, '');
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost';
  if (scheme !== 'https' && !(scheme === 'http' && loopback)) return null;
  return `${scheme}://${host}`;
}

/** The API base without a trailing slash, or null (unset, not https, malformed). */
export function apiBase(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const origin = originOf(raw);
  if (!origin) return null;
  const path = URL_RE.exec(raw.trim())![3]!.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return origin + path;
}

function allowedOrigins(base: string, extra: string | undefined): ReadonlySet<string> {
  const list = [base, ...(extra ?? '').split(',')].map((x) => x.trim()).filter(Boolean);
  return new Set(list.flatMap((x) => { const o = originOf(x); return o ? [o] : []; }));
}

// ---------- token storage ----------

interface SecureStoreLike {
  getItemAsync(key: string, options?: object): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: object): Promise<void>;
  deleteItemAsync(key: string, options?: object): Promise<void>;
  WHEN_UNLOCKED_THIS_DEVICE_ONLY?: unknown;
}

declare const require: (id: string) => unknown;

/** expo-secure-store when it and its native module are in this build, else null. */
function loadSecureStore(): SecureStoreLike | null {
  try {
    const m = require('expo-secure-store') as Partial<SecureStoreLike> | null;
    if (m && typeof m.getItemAsync === 'function' && typeof m.setItemAsync === 'function' && typeof m.deleteItemAsync === 'function') {
      return m as SecureStoreLike;
    }
  } catch {
    // not installed / no native module: memory only
  }
  return null;
}

const REFRESH_KEY = 'wealthfire.kyc.refresh';

/** Access token in memory; refresh token in the secure store (this device only), or memory when it is missing. */
export function phoneTokens(store: SecureStoreLike | null = loadSecureStore()): TokenStore {
  let access: string | null = null;
  let refreshMem: string | null = null;
  const opts = store?.WHEN_UNLOCKED_THIS_DEVICE_ONLY !== undefined ? { keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY } : {};
  return {
    get: async () => access,
    set: async (t) => { access = t; },
    getRefresh: async () => {
      if (!store) return refreshMem;
      try { return await store.getItemAsync(REFRESH_KEY, opts); } catch { return null; }
    },
    setRefresh: async (t) => {
      if (!store) { refreshMem = t; return; }
      try {
        if (t) await store.setItemAsync(REFRESH_KEY, t, opts);
        else await store.deleteItemAsync(REFRESH_KEY, opts);
      } catch {
        // a failed write only means a new sign-in after a restart; never fall back to plain storage
      }
    },
  };
}

// ---------- context: one client and one status for the app's life ----------

export interface KycServer {
  client: ServerKycClient;
  /** Last server view; null before the first read, when signed out or offline. The device value is a cache. */
  view: KycStatusView | null;
  busy: boolean;
  error: string;
  /** GET /kyc/status */
  refresh(): Promise<void>;
  /** POST /kyc/start, then follows `next` (DigiLocker / e-sign open at once, like web). */
  start(input: StartKycInput): Promise<void>;
  /** The Aadhaar step (DigiLocker or partner OTP) in an auth session, then the status again. */
  aadhaar(mode: 'digilocker' | 'otp'): Promise<void>;
  /** e-sign in an auth session, then the status again. */
  esign(): Promise<void>;
  /** PUT the selfie to its presigned URL, then POST /kyc/selfie and follow `next`. True when both worked. */
  uploadSelfie(doc: DocFile): Promise<boolean>;
  /** POST /auth/logout and clear the tokens (also when offline). */
  signOut(): Promise<void>;
}

const KycServerCtx = createContext<KycServer | null>(null);
export const useKycServer = () => useContext(KycServerCtx);

/** A fixed app-side error text. */
class LocalError extends Error {}
const message = (e: unknown, fallback: string) => (isServerError(e) || e instanceof LocalError ? e.message : fallback);

export function KycServerScope({ config, children }: { config: KycServerConfig; children: ReactNode }) {
  // Created once; a config change needs an app restart (same as the OTP provider).
  const [setup] = useState(() => {
    const base = apiBase(config.apiUrl);
    if (!base) return null;
    const client = new ServerKycClient({ baseUrl: base, fetch: (url, init) => fetch(url, init), tokens: phoneTokens(), client: 'app' });
    return { client, origins: allowedOrigins(base, config.redirectOrigins) };
  });
  if (!setup) return <>{children}</>;
  return <ServerProvider client={setup.client} origins={setup.origins}>{children}</ServerProvider>;
}

function ServerProvider({ client, origins, children }: { client: ServerKycClient; origins: ReadonlySet<string>; children: ReactNode }) {
  const [view, setView] = useState<KycStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const show = (v: KycStatusView | null) => { if (alive.current) setView(v); };

  /** One action at a time, with busy and a fixed error text. `quiet`: no error line (first read without a session). */
  const run = useCallback(async (task: () => Promise<void>, fallback: string, quiet = false): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true); setError('');
    try {
      await task();
      return true;
    } catch (e) {
      if (isServerError(e) && e.status === 401) show(null);
      if (alive.current && !quiet) setError(message(e, fallback));
      return false;
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);

  /** Opens a partner page in an auth session if its origin is allow-listed; then the server decides (status read). */
  const open = useCallback(async (url: string | undefined) => {
    const origin = url ? originOf(url) : null;
    if (!url || !origin || !origins.has(origin)) throw new LocalError(REDIRECT_BLOCKED);
    // Success, cancel or dismiss: in every case read the status again.
    await WebBrowser.openAuthSessionAsync(url, KYC_RETURN_URL);
    show(await client.getStatus());
  }, [client, origins]);

  const aadhaarStep = useCallback(async (mode: 'digilocker' | 'otp') => {
    const v = await client.startAadhaar(mode, KYC_RETURN_URL);
    show(v);
    if (v.next.type === 'digilocker' || v.next.type === 'aadhaar-otp') await open(v.next.url);
  }, [client, open]);

  const esignStep = useCallback(async () => {
    const v = await client.startEsign(KYC_RETURN_URL);
    show(v);
    if (v.next.type === 'esign') await open(v.next.url);
  }, [client, open]);

  /** After a user action (start / selfie): DigiLocker and e-sign open at once, same as web. */
  const follow = useCallback(async (v: KycStatusView) => {
    show(v);
    if (v.next.type === 'digilocker') await aadhaarStep('digilocker');
    else if (v.next.type === 'esign') await esignStep();
  }, [aadhaarStep, esignStep]);

  const refresh = useCallback(async () => { await run(async () => show(await client.getStatus()), LOAD_FAILED); }, [client, run]);
  const start = useCallback(async (input: StartKycInput) => {
    await run(async () => follow(await client.startKyc(input)), LOAD_FAILED);
  }, [client, follow, run]);
  const aadhaar = useCallback(async (mode: 'digilocker' | 'otp') => { await run(() => aadhaarStep(mode), LOAD_FAILED); }, [aadhaarStep, run]);
  const esign = useCallback(async () => { await run(esignStep, LOAD_FAILED); }, [esignStep, run]);

  const uploadSelfie = useCallback((doc: DocFile) => run(async () => {
    if ((doc.mime !== 'image/jpeg' && doc.mime !== 'image/png') || doc.size <= 0 || doc.size > MAX_UPLOAD) throw new LocalError(SELFIE_TOO_BIG);
    const u = (await client.documentUploadUrls([{ kind: 'selfie', contentType: doc.mime, size: doc.size }])).selfie;
    if (!u) throw new LocalError(LOAD_FAILED);
    let ok = false;
    try {
      // Binary PUT of the cache file straight to S3 (expo-file-system upload; the file never goes through the API).
      const r = await new File(doc.uri).upload(u.url, { httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT, headers: u.headers });
      ok = r.status >= 200 && r.status < 300;
    } catch {
      ok = false;
    }
    if (!ok) throw new LocalError(UPLOAD_FAILED);
    await follow(await client.submitSelfie(u.uploadId));
  }, UPLOAD_FAILED), [client, follow, run]);

  const signOut = useCallback(async () => {
    show(null); setError('');
    try { await client.logout(); } catch { /* local tokens are cleared anyway */ }
  }, [client]);

  // First read after launch: quiet when there is no session yet (the user signs in during onboarding).
  useEffect(() => { void run(async () => show(await client.getStatus()), LOAD_FAILED, true); }, [client, run]);

  const value = useMemo<KycServer>(() => ({ client, view, busy, error, refresh, start, aadhaar, esign, uploadSelfie, signOut }),
    [client, view, busy, error, refresh, start, aadhaar, esign, uploadSelfie, signOut]);
  return <KycServerCtx.Provider value={value}>{children}</KycServerCtx.Provider>;
}

// ---------- start details and date of birth ----------

/** /kyc/start input; dob comes from Your details (missing only for onboarding saved before the field existed). */
export type StartDetails = Omit<StartKycInput, 'dob'> & { dob?: string };

/** What /kyc/start needs from onboarding (no full Aadhaar), or null when it can't start. Same rule as web. */
export function startDetails(ob: OnboardingState): StartDetails | null {
  const st = ob.kyc.status;
  if (ob.step !== 'done' || !ob.identity || !ob.aadhaar || (st !== 'pre-verified' && st !== 'under-review')) return null;
  const dob = ob.identity.dob;
  return { firstName: ob.identity.firstName, lastName: ob.identity.lastName, pan: ob.identity.pan, aadhaarLast4: ob.aadhaar.last4, deviceStatus: st,
    ...(dob ? { dob } : {}) };
}

/** ISO yyyy-mm-dd → DD/MM/YYYY for the field ('' stays ''). Same as web. */
export const isoToDmy = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : iso);
/** Typed digits → DD/MM/YYYY with the slashes added (the number pad has no '/'). Same as web. */
export function formatDobInput(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 8);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join('/');
}

// ---------- status panel (Done screen and Settings → Account) ----------

/** Server status, reason and the next step: start (date of birth), DigiLocker, selfie upload, e-sign or wait. */
export function ServerKycPanel({ details }: { details: StartDetails | null }) {
  const server = useKycServer();
  const [dob, setDob] = useState('');
  const [dobTouched, setDobTouched] = useState(false);
  const [selfie, setSelfie] = useState<DocFile | undefined>(undefined);
  // The selfie sits in the app cache: delete it when this panel goes away (design B6).
  const selfieRef = useRef<DocFile | undefined>(undefined);
  selfieRef.current = selfie;
  useEffect(() => () => deleteDoc(selfieRef.current), []);
  useBlockBackWhile(!!server?.busy);
  const { update } = useStore();
  // The launch read ran before sign-in (no session yet): read the status once when the panel opens without one.
  const hasView = !!server?.view;
  useEffect(() => { if (server && !hasView) void server.refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!server) return null;
  const { view, busy, error } = server;
  const next = view?.next.type;
  const reason = view?.reason ? REASON_TEXT[view.reason] : undefined;
  const dobErr = validateDob(dob);
  return (
    <View style={{ marginTop: 10 }} accessibilityState={{ busy }}>
      {view ? (
        <Text style={s.text} accessibilityLiveRegion="polite">
          Final KYC: <Text style={{ fontWeight: '800' }}>{kycStatusLabel(view.status)}</Text>{reason ? ` (${reason})` : ''}
        </Text>
      ) : null}
      {busy ? <ActivityIndicator color={theme.accent} style={{ marginVertical: 8 }} /> : null}
      {next === 'start' && details?.dob ? (
        <Btn primary title="Start final KYC" disabled={busy} onPress={() => void server.start({ ...details, dob: details.dob! })} />
      ) : null}
      {/* Onboarded before Date of birth was asked (needsDob): same field and errors as Your details, saved with
          'dob-added', then /kyc/start. startKyc is never called without a date of birth. */}
      {next === 'start' && details && !details.dob ? (
        <>
          <Text style={[s.small, { marginVertical: 6 }]}>To finish your KYC, confirm your date of birth. It is checked with the KYC records.</Text>
          <Input label={DOB_LABEL} value={dob} placeholder={DOB_HINT} keyboardType="number-pad" maxLength={10} textContentType="birthdate"
            autoComplete="birthdate-full" editable={!busy} onBlur={() => setDobTouched(true)}
            onChangeText={(t) => setDob(formatDobInput(t))}
            error={dobTouched ? dobErr : null} />
          <Btn primary title="Start final KYC" disabled={busy || !!dobErr} onPress={() => {
            const iso = normalizeDob(dob);
            update((d) => ({ ...d, onboarding: onboardingReducer(d.onboarding, { type: 'dob-added', dob: iso, at: new Date().toISOString() }) }));
            setDob(''); setDobTouched(false);
            void server.start({ ...details, dob: iso });
          }} />
        </>
      ) : null}
      {next === 'digilocker' ? (
        <>
          <Text style={[s.small, { marginVertical: 6 }]}>Verify your Aadhaar with DigiLocker. You will come back here after.</Text>
          <Btn primary title="Continue with DigiLocker" disabled={busy} onPress={() => void server.aadhaar('digilocker')} />
        </>
      ) : null}
      {next === 'aadhaar-otp' ? <Btn primary title="Continue to Aadhaar OTP" disabled={busy} onPress={() => void server.aadhaar('otp')} /> : null}
      {next === 'documents' ? (
        <>
          <Text style={[s.small, { marginVertical: 6 }]}>Upload a selfie (JPG or PNG, up to 10 MB)</Text>
          <DocSlot kind="selfie" doc={selfie} onChange={setSelfie} disabled={busy} />
          <Btn primary title="Upload selfie" disabled={busy || !selfie}
            onPress={() => { const d = selfie; if (d) void server.uploadSelfie(d).then((ok) => { if (ok) { deleteDoc(d); setSelfie(undefined); } }); }} />
        </>
      ) : null}
      {next === 'esign' ? (
        <>
          <Text style={[s.small, { marginVertical: 6 }]}>Sign your KYC form with Aadhaar e-sign. You will come back here after.</Text>
          <Btn primary title="Continue to e-sign" disabled={busy} onPress={() => void server.esign()} />
        </>
      ) : null}
      {next === 'wait' ? (
        <>
          <Text style={[s.muted, { marginVertical: 6 }]}>{WAIT_TEXT}</Text>
          <Btn title="Refresh" disabled={busy} onPress={() => void server.refresh()} />
        </>
      ) : null}
      {error ? (
        <>
          <Msg text={error} />
          {!view ? <Btn title="Try again" disabled={busy} onPress={() => void server.refresh()} /> : null}
        </>
      ) : null}
    </View>
  );
}
