// Final KYC server (services/kyc, design §6) on Android / iOS. Only active when app.json `expo.extra.apiUrl` is set.
// Without it `useKycServer()` is null and every screen keeps its device-only behaviour (demo OTP, device status).
//
// Tokens: the access token stays in memory only. The refresh token is kept in expo-secure-store (iOS Keychain /
// Android Keystore). expo-secure-store is loaded through a guarded require: without its native module the refresh
// token is kept in memory only (signed out on restart), never in AsyncStorage. A dead session shows
// 'Please sign in again.' and asks for an OTP to the onboarding contact (same as web).
// DigiLocker / Aadhaar OTP / e-sign pages open in an auth session (expo-web-browser) that returns to KYC_RETURN_URL;
// only HTTPS pages on the API origin or extra.kycRedirectOrigins are opened.
// Same steps, consent ticks and texts as apps/web/src/components/ServerKyc.tsx (texts from @wealthfire/core). Sends
// names, PAN, Aadhaar last 4, date of birth and the device result only; the full Aadhaar never leaves the phone and the
// documents (selfie, Aadhaar card, PAN card) go straight to their presigned upload URLs.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { AccessibilityInfo, ActivityIndicator, findNodeHandle, Pressable, StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { File, UploadType } from 'expo-file-system';
import {
  CONSENT_TEXT, DOB_HINT, DOB_LABEL, hasKycCase, HttpOtpProvider, isConsentRequired, isServerError, KYC_TEXT, kycDocsNeeded, kycReasonText,
  kycStatusLabel, maskEmail, maskMobile, needsSignIn, normalizeDob, onboardingReducer, OTP_RULES, ServerKycClient, STEP_CONSENT, validateDob,
  type ConsentPurpose, type DocFile, type DocKind, type KycStatusView, type OnboardingState, type StartKycInput, type TokenStore,
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
const FAILED = 'Something went wrong. Try again.';

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

type Docs = Partial<Record<DocKind, DocFile>>;

export interface KycServer {
  client: ServerKycClient;
  /** Last server view; null before the first read, when signed out or offline. The device value is a cache. */
  view: KycStatusView | null;
  busy: boolean;
  error: string;
  /** Short success text ('Documents sent.'). */
  notice: string;
  /** Document kinds uploaded this session. */
  sent: ReadonlySet<DocKind>;
  /** The session ended (refresh token missing or refused): 'Please sign in again.' with an OTP. */
  signIn: boolean;
  /** POST /kyc/retry answered consent_required: the pan-check tick shows again. */
  retryConsent: boolean;
  /** GET /kyc/status */
  refresh(): Promise<void>;
  /** POST /kyc/start (after the pan-check tick). */
  start(input: StartKycInput): Promise<void>;
  /** The Aadhaar step (DigiLocker or partner OTP) in an auth session, then the status again. */
  aadhaar(mode: 'digilocker' | 'otp'): Promise<void>;
  /** e-sign (after the esign and kra-upload ticks) in an auth session, then the status again. */
  esign(): Promise<void>;
  /** R3: POST /kyc/retry after a partner timeout. */
  retry(): Promise<void>;
  /** Selfie step: upload the chosen documents, then POST /kyc/selfie. True when both worked. */
  submitDocuments(docs: Docs, kinds: DocKind[]): Promise<boolean>;
  /** Under review: upload the documents for the reviewer. True when every upload worked. */
  sendForReview(docs: Docs, kinds: DocKind[]): Promise<boolean>;
  /** POST /kyc/consent/withdraw for every purpose, then the status again. */
  withdrawConsent(): Promise<boolean>;
  /** DELETE /kyc/data, then the status again. */
  deleteData(): Promise<boolean>;
  /** After an OTP sign-in: read the status again. */
  signedIn(): Promise<void>;
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
  const [notice, setNotice] = useState('');
  const [sent, setSent] = useState<ReadonlySet<DocKind>>(() => client.sentDocuments());
  const [signIn, setSignIn] = useState(false);
  const [retryConsent, setRetryConsent] = useState(false);
  const alive = useRef(true);
  const running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const show = (v: KycStatusView | null) => { if (alive.current) setView(v); };

  /** One action at a time, with busy and a fixed error text. `quiet`: no error line (first read without a session). */
  const run = useCallback(async (task: () => Promise<void>, fallback: string, quiet = false): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      await task();
      return true;
    } catch (e) {
      if (needsSignIn(e)) {
        show(null);
        // the launch read before onboarding's sign-in stays quiet; later a dead session asks for an OTP
        if (alive.current && !quiet) setSignIn(true);
        return false;
      }
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

  /** R1: one /kyc/documents call, then a binary PUT of each cache file straight to S3 (never through the API). */
  const uploadDocs = useCallback(async (docs: Docs, kinds: DocKind[]) => {
    if (kinds.some((k) => !docs[k])) throw new LocalError(KYC_TEXT.pickAll);
    const files = kinds.map((k) => docs[k]!);
    try {
      return await client.uploadDocuments(files.map((f) => ({ kind: f.kind, contentType: f.mime, size: f.size })), async (u, kind) => {
        const d = docs[kind];
        if (!d) return false;
        const r = await new File(d.uri).upload(u.url, { httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT, headers: u.headers });
        return r.status >= 200 && r.status < 300;
      });
    } finally {
      if (alive.current) setSent(client.sentDocuments());
    }
  }, [client]);

  const refresh = useCallback(async () => { await run(async () => show(await client.getStatus()), LOAD_FAILED); }, [client, run]);
  // DigiLocker and e-sign need their own ticks, so after start / selfie / retry the panel shows the next step.
  const start = useCallback(async (input: StartKycInput) => {
    await run(async () => show(await client.startKyc(input)), LOAD_FAILED);
  }, [client, run]);
  const aadhaar = useCallback(async (mode: 'digilocker' | 'otp') => { await run(() => aadhaarStep(mode), LOAD_FAILED); }, [aadhaarStep, run]);
  const esign = useCallback(async () => { await run(esignStep, LOAD_FAILED); }, [esignStep, run]);
  const retry = useCallback(async () => {
    await run(async () => {
      try {
        show(await client.retry(retryConsent));
        if (alive.current) setRetryConsent(false);
      } catch (e) {
        if (isConsentRequired(e) && alive.current) setRetryConsent(true);
        throw e;
      }
    }, LOAD_FAILED);
  }, [client, retryConsent, run]);

  const submitDocuments = useCallback((docs: Docs, kinds: DocKind[]) => run(async () => {
    const ids = await uploadDocs(docs, kinds);
    if (!ids.selfie) throw new LocalError(KYC_TEXT.uploadFailed);
    show(await client.submitSelfie(ids.selfie));
  }, KYC_TEXT.uploadFailed), [client, run, uploadDocs]);

  const sendForReview = useCallback((docs: Docs, kinds: DocKind[]) => run(async () => {
    await uploadDocs(docs, kinds);
    if (alive.current) setNotice(KYC_TEXT.docsSent);
  }, KYC_TEXT.uploadFailed), [run, uploadDocs]);

  const withdrawConsent = useCallback(() => run(async () => {
    await client.withdrawConsent();
    show(await client.getStatus());
  }, FAILED), [client, run]);

  const deleteData = useCallback(() => run(async () => {
    await client.deleteKycData();
    if (alive.current) setSent(client.sentDocuments());
    show(await client.getStatus());
  }, FAILED), [client, run]);

  const signedIn = useCallback(async () => {
    setSignIn(false);
    await run(async () => show(await client.getStatus()), LOAD_FAILED);
  }, [client, run]);

  const signOut = useCallback(async () => {
    show(null); setError(''); setSignIn(false);
    try { await client.logout(); } catch { /* local tokens are cleared anyway */ }
  }, [client]);

  // First read after launch: quiet when there is no session yet (the user signs in during onboarding).
  useEffect(() => { void run(async () => show(await client.getStatus()), LOAD_FAILED, true); }, [client, run]);

  const value = useMemo<KycServer>(() => ({
    client, view, busy, error, notice, sent, signIn, retryConsent,
    refresh, start, aadhaar, esign, retry, submitDocuments, sendForReview, withdrawConsent, deleteData, signedIn, signOut,
  }), [client, view, busy, error, notice, sent, signIn, retryConsent,
    refresh, start, aadhaar, esign, retry, submitDocuments, sendForReview, withdrawConsent, deleteData, signedIn, signOut]);
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

// ---------- consent ticks ----------

type Ticks = Partial<Record<ConsentPurpose, boolean>>;

/** One tick box per purpose (the e-sign screen shows two). Same texts as web. */
function ConsentTicks({ purposes, ticks, setTicks, disabled }: {
  purposes: readonly ConsentPurpose[]; ticks: Ticks; setTicks: (t: Ticks) => void; disabled: boolean;
}) {
  return (
    <>
      {purposes.map((p) => {
        const on = !!ticks[p];
        return (
          <Pressable key={p} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled }} accessibilityLabel={CONSENT_TEXT[p]}
            disabled={disabled} onPress={() => setTicks({ ...ticks, [p]: !on })} style={st.check}>
            <View style={[st.box, on && st.boxOn]}>{on ? <Text style={st.tick}>✓</Text> : null}</View>
            <Text style={[s.text, { flex: 1 }]}>{CONSENT_TEXT[p]}</Text>
          </Pressable>
        );
      })}
    </>
  );
}

// ---------- sign in again (session ended) ----------

/** 'Please sign in again.': an OTP to the onboarding contact through the server. Same labels as web (OtpStep). */
function SignInAgain({ client, onDone }: { client: ServerKycClient; onDone: () => void }) {
  const { data } = useStore();
  const c = data.onboarding.contact;
  const provider = useMemo(() => new HttpOtpProvider(client), [client]);
  const [req, setReq] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useBlockBackWhile(busy);

  async function send() {
    if (!c) return;
    setBusy(true); setError('');
    const r = await provider.send({ channel: c.kind === 'email' ? 'email' : 'sms', target: c.value }, Date.now());
    if (!alive.current) return;
    setBusy(false);
    if (r.ok) { setReq(r.requestId); setCode(''); } else setError(r.message);
  }

  async function verify() {
    if (!req) return;
    setBusy(true); setError('');
    const r = await provider.verify(req, code, Date.now());
    if (!alive.current) return;
    setBusy(false);
    setCode('');
    if (r.ok) { setReq(null); onDone(); return; }
    if (r.reason === 'void' || r.reason === 'expired') setReq(null);
    setError(r.message);
  }

  return (
    <View>
      <Text style={[s.text, { color: theme.bad, marginVertical: 6 }]} accessibilityRole="alert">{KYC_TEXT.signInAgain}</Text>
      {c ? (
        <>
          <Text style={s.small}>{KYC_TEXT.signInAgainHint} {c.kind === 'email' ? maskEmail(c.value) : maskMobile(c.value)}.</Text>
          {req ? (
            <>
              <Input label="6-digit code" value={code} onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, OTP_RULES.length))}
                keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="sms-otp" maxLength={OTP_RULES.length + 6}
                placeholder="123456" error={error || null} />
              <Btn primary title="Sign in" disabled={busy || code.length !== OTP_RULES.length} onPress={() => void verify()} />
              <Btn title="Resend OTP" disabled={busy} onPress={() => void send()} />
            </>
          ) : (
            <>
              {error ? <Msg text={error} /> : null}
              <Btn primary title="Send OTP" disabled={busy} onPress={() => void send()} />
            </>
          )}
        </>
      ) : null}
    </View>
  );
}

// ---------- status panel (Done screen and Settings → Account) ----------

/** Server status, reason and the next step: start (date of birth), DigiLocker, documents, e-sign, Try again or wait. */
export function ServerKycPanel({ details }: { details: StartDetails | null }) {
  const server = useKycServer();
  const [dob, setDob] = useState('');
  const [dobTouched, setDobTouched] = useState(false);
  const [ticks, setTicks] = useState<Ticks>({});
  const [docs, setDocs] = useState<Docs>({});
  // Picked files sit in the app cache: delete them when this panel goes away (design B6).
  const docsRef = useRef<Docs>({});
  docsRef.current = docs;
  useEffect(() => () => { for (const d of Object.values(docsRef.current)) deleteDoc(d); }, []);
  useBlockBackWhile(!!server?.busy);
  const { update } = useStore();
  // The launch read ran before sign-in (no session yet): read the status once when the panel opens without one.
  const hasView = !!server?.view;
  useEffect(() => { if (server && !hasView) void server.refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const next = server?.view?.next.type;
  // A new step starts with its boxes unticked.
  useEffect(() => { setTicks({}); }, [next, server?.retryConsent]);
  if (!server) return null;
  const { view, busy, error, notice } = server;
  const reason = kycReasonText(view?.reason);
  const dobErr = validateDob(dob);
  const needed = kycDocsNeeded(view, server.sent);
  const ticked = (ps: readonly ConsentPurpose[]) => ps.every((p) => ticks[p]);
  const setDoc = (k: DocKind, d: DocFile | undefined) => setDocs((cur) => {
    const old = cur[k];
    if (old && old !== d) deleteDoc(old);
    const nextDocs = { ...cur };
    if (d) nextDocs[k] = d; else delete nextDocs[k];
    return nextDocs;
  });
  /** After an upload: drop the files that went through. */
  const dropSent = () => { for (const k of server.client.sentDocuments()) setDoc(k, undefined); };
  const docLabel = next === 'documents' && needed.length === 1 ? KYC_TEXT.uploadSelfieOnly : KYC_TEXT.uploadAll;
  const slots = needed.map((k) => <DocSlot key={k} kind={k} doc={docs[k]} onChange={(d) => setDoc(k, d)} disabled={busy} />);
  const allPicked = needed.every((k) => !!docs[k]);
  return (
    <View style={{ marginTop: 10 }} accessibilityState={{ busy }}>
      {view ? (
        <Text style={s.text} accessibilityLiveRegion="polite">
          Final KYC: <Text style={{ fontWeight: '800' }}>{kycStatusLabel(view.status)}</Text>{reason ? ` (${reason})` : ''}
        </Text>
      ) : null}
      {busy ? <ActivityIndicator color={theme.accent} style={{ marginVertical: 8 }} /> : null}
      {server.signIn ? <SignInAgain client={server.client} onDone={() => void server.signedIn()} /> : null}
      {next === 'start' && details?.dob ? (
        <>
          <Text style={[s.small, { marginVertical: 6 }]}>Your details are checked with the KYC records.</Text>
          <ConsentTicks purposes={STEP_CONSENT.start} ticks={ticks} setTicks={setTicks} disabled={busy} />
          <Btn primary title="Start final KYC" disabled={busy || !ticked(STEP_CONSENT.start)} onPress={() => void server.start({ ...details, dob: details.dob! })} />
        </>
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
          <ConsentTicks purposes={STEP_CONSENT.start} ticks={ticks} setTicks={setTicks} disabled={busy} />
          <Btn primary title="Start final KYC" disabled={busy || !!dobErr || !ticked(STEP_CONSENT.start)} onPress={() => {
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
          <ConsentTicks purposes={STEP_CONSENT.digilocker} ticks={ticks} setTicks={setTicks} disabled={busy} />
          <Btn primary title="Continue with DigiLocker" disabled={busy || !ticked(STEP_CONSENT.digilocker)} onPress={() => void server.aadhaar('digilocker')} />
        </>
      ) : null}
      {next === 'aadhaar-otp' ? (
        <>
          <ConsentTicks purposes={STEP_CONSENT['aadhaar-otp']} ticks={ticks} setTicks={setTicks} disabled={busy} />
          <Btn primary title="Continue to Aadhaar OTP" disabled={busy || !ticked(STEP_CONSENT['aadhaar-otp'])} onPress={() => void server.aadhaar('otp')} />
        </>
      ) : null}
      {next === 'documents' ? (
        <>
          <Text style={[s.small, { marginVertical: 6 }]}>{docLabel} (JPG, PNG or PDF; selfie JPG or PNG; up to 10 MB each).</Text>
          {slots}
          <ConsentTicks purposes={STEP_CONSENT.documents} ticks={ticks} setTicks={setTicks} disabled={busy} />
          <Btn primary title={KYC_TEXT.uploadContinue} disabled={busy || !allPicked || !ticked(STEP_CONSENT.documents)}
            onPress={() => void server.submitDocuments(docs, needed).finally(dropSent)} />
        </>
      ) : null}
      {next === 'esign' ? (
        <>
          <Text style={[s.small, { marginVertical: 6 }]}>Sign your KYC form with Aadhaar e-sign. You will come back here after.</Text>
          <ConsentTicks purposes={STEP_CONSENT.esign} ticks={ticks} setTicks={setTicks} disabled={busy} />
          <Btn primary title="Continue to e-sign" disabled={busy || !ticked(STEP_CONSENT.esign)} onPress={() => void server.esign()} />
        </>
      ) : null}
      {next === 'retry' ? (
        <>
          {server.retryConsent ? <ConsentTicks purposes={STEP_CONSENT.retry} ticks={ticks} setTicks={setTicks} disabled={busy} /> : null}
          <Btn primary title={KYC_TEXT.tryAgain} disabled={busy || (server.retryConsent && !ticked(STEP_CONSENT.retry))} onPress={() => void server.retry()} />
        </>
      ) : null}
      {next === 'wait' ? (
        <>
          <Text style={[s.muted, { marginVertical: 6 }]}>{WAIT_TEXT}</Text>
          <Btn title="Refresh" disabled={busy} onPress={() => void server.refresh()} />
        </>
      ) : null}
      {view?.status === 'under-review' && needed.length > 0 ? (
        <View style={{ marginTop: 8 }}>
          <Text style={[s.small, { marginVertical: 6 }]}>{KYC_TEXT.docsNeeded}{view.documents ? '' : ` ${KYC_TEXT.docsUnknownHint}`}</Text>
          {slots}
          <Btn title={KYC_TEXT.sendDocs} disabled={busy || !allPicked} onPress={() => void server.sendForReview(docs, needed).finally(dropSent)} />
        </View>
      ) : null}
      {notice ? <Msg text={notice} tone="muted" /> : null}
      {error ? (
        <>
          <Msg text={error} />
          {!view && !server.signIn ? <Btn title="Try again" disabled={busy} onPress={() => void server.refresh()} /> : null}
        </>
      ) : null}
    </View>
  );
}

// ---------- Profile: withdraw consent and delete my KYC data ----------

type Ask = 'withdraw' | 'delete' | null;

/**
 * Server mode only, and only when a KYC case exists. Each button opens a confirm step first (title,
 * one-line effect, Cancel + a red confirm button). Same texts and order as apps/web/src/components/KycDataControls.tsx.
 */
export function KycDataControls() {
  const server = useKycServer();
  const [ask, setAsk] = useState<Ask>(null);
  const [done, setDone] = useState('');
  const titleRef = useRef<ComponentRef<typeof Text>>(null);
  // Screen readers: move focus to the confirm title when it opens.
  useEffect(() => {
    if (!ask) return;
    const node = titleRef.current ? findNodeHandle(titleRef.current) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [ask]);
  if (!server || (!hasKycCase(server.view) && !done)) return null;
  const { busy, view } = server;
  const withdrawn = view?.reason === 'consent-withdrawn';

  const confirm = async () => {
    const what = ask;
    if (!what) return;
    const ok = what === 'withdraw' ? await server.withdrawConsent() : await server.deleteData();
    if (ok) { setDone(what === 'withdraw' ? KYC_TEXT.withdrawDone : KYC_TEXT.deleteDone); setAsk(null); }
  };

  return (
    <View testID="feature-kyc-data-controls" style={s.card}>
      <Text style={s.h2} accessibilityRole="header">{KYC_TEXT.dataTitle}</Text>
      {ask ? (
        <View style={st.confirm}>
          <Text ref={titleRef} style={[s.text, { fontWeight: '800' }]} accessibilityRole="header">
            {ask === 'withdraw' ? KYC_TEXT.withdrawTitle : KYC_TEXT.deleteTitle}
          </Text>
          <Text style={[s.text, { marginTop: 4 }]}>{ask === 'withdraw' ? KYC_TEXT.withdrawBody : KYC_TEXT.deleteBody}</Text>
          <Btn title={KYC_TEXT.cancel} disabled={busy} onPress={() => setAsk(null)} />
          <Btn danger solid title={ask === 'withdraw' ? KYC_TEXT.withdrawConfirm : KYC_TEXT.deleteConfirm} disabled={busy} onPress={() => void confirm()} />
        </View>
      ) : hasKycCase(view) ? (
        <>
          {!withdrawn ? <Btn danger title={KYC_TEXT.withdrawButton} onPress={() => { setDone(''); setAsk('withdraw'); }} /> : null}
          <Btn danger title={KYC_TEXT.deleteButton} onPress={() => { setDone(''); setAsk('delete'); }} />
        </>
      ) : null}
      {busy ? <ActivityIndicator color={theme.accent} style={{ marginVertical: 8 }} /> : null}
      {done ? <Msg text={done} tone="muted" /> : null}
      {ask && server.error ? <Msg text={server.error} /> : null}
    </View>
  );
}

const st = StyleSheet.create({
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 8, minHeight: 44 },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: theme.line, alignItems: 'center', justifyContent: 'center' },
  boxOn: { borderColor: theme.accent, backgroundColor: theme.accent },
  tick: { color: theme.bg, fontWeight: '800' },
  confirm: { borderColor: theme.bad, borderWidth: 1, borderRadius: 10, padding: 12 },
});
