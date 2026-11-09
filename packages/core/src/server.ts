// Client for the final KYC service (services/kyc, design §3 and §6). Same code on web and phones:
// the app passes its own fetch and token store. Error messages are fixed strings chosen here, so
// they never carry a PAN, Aadhaar number, contact, OTP or token (not even if a server echoed one).
//
// Tokens: the access token lives in `tokens`. The refresh token is
// - web (`client: 'web'`, default): the HttpOnly cookie `wf_rt` (Path=/, SameSite=None, Partitioned);
//   every request sends `x-wf-client: web`, /auth/* also `credentials: 'include'`, so the app never
//   sees it. If the browser blocks the cookie, refresh fails and the app shows KYC_TEXT.signInAgain
//   and asks for an OTP: the refresh token is never kept in localStorage or anywhere else;
// - phones (`client: 'app'`): in the JSON body; kept through `tokens.getRefresh / setRefresh`
//   (expo-secure-store).
// On a 401 from a /kyc route the client refreshes once (or calls `opts.refresh`) and retries.
import type { KycStatus } from './types';
import type { OtpProvider, OtpSendRequest, OtpSendResult, OtpVerifyResult } from './otp';
import { OTP_MESSAGES } from './otp';
import type { OtpProviderId } from './types';
import type { DocKind } from './docreader';

export type ServerStatus = KycStatus; // 'pre-verified' | 'under-review' | 'verified' | 'rejected'

/** What the user does next. `url` is a partner page (DigiLocker / Aadhaar OTP / e-sign) to open. */
export interface ServerNext {
  /**
   * start: no case yet, call startKyc. digilocker: the Aadhaar step is open (call startAadhaar,
   * 'digilocker' or 'otp'). documents: upload the selfie (plus Aadhaar and PAN cards), then submitSelfie.
   * esign: call startEsign. retry: a partner timed out, offer Try again (retry). wait: the server or a
   * reviewer is working. none: decided.
   */
  type: 'start' | 'digilocker' | 'aadhaar-otp' | 'documents' | 'esign' | 'retry' | 'wait' | 'none';
  url?: string;
}

export interface KycStatusView {
  status: ServerStatus | null;
  /** server reason code, e.g. 'kra-validated', 'check-unclear', 'staff-rejected' */
  reason: string | null;
  next: ServerNext;
  /** Document kinds the server already holds for this case, when the server says (else unknown). */
  documents?: DocKind[];
  /** The server's eligibleToInvest; false e.g. for a staff-approved case still waiting for e-sign. */
  eligibleToInvest?: boolean;
}

// ---------- consent (DPDP, design 7) ----------

/** One consent row per paid partner check. The server answers 409 consent-required without it. */
export type ConsentPurpose = 'digilocker' | 'aadhaar-otp' | 'pan-check' | 'face-match' | 'esign' | 'kra-upload';
export const CONSENT_PURPOSES: readonly ConsentPurpose[] = ['digilocker', 'aadhaar-otp', 'pan-check', 'face-match', 'esign', 'kra-upload'];

/** Tick-box text per purpose. Same on web, Android and iOS. */
export const CONSENT_TEXT: Record<ConsentPurpose, string> = {
  'pan-check': 'I agree that Wealthfire checks my PAN and KYC record with the KRA and the Income Tax Department.',
  digilocker: 'I agree that Wealthfire gets my Aadhaar details from DigiLocker for my KYC.',
  'aadhaar-otp': 'I agree that Wealthfire checks my Aadhaar with an OTP for my KYC.',
  'face-match': 'I agree that Wealthfire matches my selfie with my Aadhaar photo.',
  esign: 'I agree to sign my KYC form with Aadhaar e-sign.',
  'kra-upload': 'I agree that Wealthfire sends my KYC record to the KRA after it is approved.',
};

/** Purposes each user step needs (the e-sign screen asks two separate ticks). */
export const STEP_CONSENT = {
  start: ['pan-check'],
  digilocker: ['digilocker'],
  'aadhaar-otp': ['aadhaar-otp'],
  documents: ['face-match'],
  esign: ['esign', 'kra-upload'],
  /** retry re-runs the KRA lookup / PAN check: only asked again when the server has no consent on record */
  retry: ['pan-check'],
} as const satisfies Record<string, readonly ConsentPurpose[]>;

// ---------- shared texts (web, Android, iOS) ----------

/**
 * Short text for a server reason code. Unknown codes show nothing, so no server value is ever echoed.
 * `hand-check` and `device-hand-check` show the same text.
 */
export const KYC_REASON_TEXT: Record<string, string> = {
  'kra-validated': 'Your KYC record was confirmed.',
  'full-kyc-passed': 'All checks passed.',
  'in-progress': 'Checks are in progress.',
  'check-unclear': 'Our team is taking a closer look.',
  'partner-timeout': 'Our partner is slow. Tap Try again.',
  'hand-check': 'We\u2019re checking your documents by hand.',
  'device-hand-check': 'We\u2019re checking your documents by hand.',
  'pan-in-use': 'We need to check your PAN by hand.',
  'consent-withdrawn': 'You withdrew consent, so we stopped your KYC.',
  'pan-invalid': 'Your PAN could not be verified.',
  'pan-not-individual': 'This PAN is not for an individual.',
  'aadhaar-mismatch': 'Your Aadhaar details did not match.',
  'liveness-failed': 'The selfie check did not pass.',
  'staff-approved': 'Approved by our team.',
  'staff-rejected': 'Rejected by our team.',
};

/** Reason text, or undefined for an unknown / missing code. */
export function kycReasonText(reason: string | null | undefined): string | undefined {
  return reason && Object.prototype.hasOwnProperty.call(KYC_REASON_TEXT, reason) ? KYC_REASON_TEXT[reason] : undefined;
}

export const KYC_TEXT = {
  tryAgain: 'Try again',
  /** web refresh cookie blocked or the session ended: ask for an OTP (no localStorage fallback) */
  signInAgain: 'Please sign in again.',
  signInAgainHint: 'We will send a code to',
  docsNeeded: 'Our team needs your selfie, Aadhaar card and PAN card to check your KYC.',
  docsUnknownHint: 'Skip this if you already sent them.',
  sendDocs: 'Send documents',
  docsSent: 'Documents sent.',
  uploadAll: 'Upload your selfie, Aadhaar card and PAN card',
  uploadSelfieOnly: 'Upload a new selfie',
  uploadContinue: 'Upload and continue',
  pickAll: 'Choose every document first.',
  uploadFailed: 'Could not upload your documents. Try again.',
  consentNeeded: 'Tick the box to continue.',
  withdrawButton: 'Withdraw consent',
  withdrawTitle: 'Withdraw consent?',
  withdrawBody: 'We will stop your KYC. You can\u2019t invest until you finish KYC again.',
  withdrawConfirm: 'Withdraw',
  withdrawDone: 'You withdrew consent, so we stopped your KYC.',
  deleteButton: 'Delete my KYC data',
  deleteTitle: 'Delete your KYC data?',
  deleteBody: 'We delete your documents and details. Some records stay if the law needs them.',
  deleteConfirm: 'Delete',
  deleteDone: 'We deleted your KYC data.',
  cancel: 'Cancel',
  dataTitle: 'Your KYC data',
} as const;

/** True when the error means the session has ended (refresh cookie / token missing or refused). */
export function needsSignIn(e: unknown): boolean {
  return isServerError(e) && e.status === 401 && (e.code === 'unauthorized' || e.code === 'invalid_token');
}

/** True when the server refused a step for a missing consent row. */
export function isConsentRequired(e: unknown): boolean {
  return isServerError(e) && e.code === 'consent_required';
}

const ALL_DOCS: readonly DocKind[] = ['selfie', 'aadhaar', 'pan'];

/**
 * Documents the app should ask for now (R1). `sent`: kinds uploaded in this session.
 * - selfie step: always a new selfie, plus the Aadhaar and PAN cards not yet held;
 * - under review (hand check, PAN in use, unclear, timeout): every kind not yet held, for the reviewer;
 * - otherwise nothing.
 */
export function kycDocsNeeded(view: KycStatusView | null, sent: ReadonlySet<DocKind> = new Set()): DocKind[] {
  if (!view || view.status === null || view.status === 'verified' || view.status === 'rejected') return [];
  const held = new Set<DocKind>([...(view.documents ?? []), ...sent]);
  if (view.next.type === 'documents') return ALL_DOCS.filter((k) => k === 'selfie' || !held.has(k));
  if (view.status === 'under-review') return ALL_DOCS.filter((k) => !held.has(k));
  return [];
}

/** True when the Profile buttons (withdraw consent, delete data) apply: server mode and a case exists. */
export function hasKycCase(view: KycStatusView | null): boolean {
  return !!view && view.status !== null;
}

export interface TokenStore {
  get(): Promise<string | null>;
  set(access: string | null): Promise<void>;
  /** phones only: the refresh token (secure store) */
  getRefresh?(): Promise<string | null>;
  setRefresh?(refresh: string | null): Promise<void>;
}

export type DocContentType = 'image/jpeg' | 'image/png' | 'application/pdf';

export interface DocUploadUrl {
  /** pass to submitSelfie for the selfie */
  uploadId: string;
  /** HTTP PUT the file here with exactly these headers */
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StartKycInput {
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD or DD/MM/YYYY */
  dob: string;
  pan: string;
  aadhaarLast4: string;
  deviceStatus: 'pre-verified' | 'under-review';
  /** accepted for the device record; not sent (the server does not take it) */
  reviewFields?: { field: string; typedMasked: string; readMasked: string }[];
}

/** What the client needs from a request (subset of RequestInit). */
export interface ServerFetchInit {
  method: 'GET' | 'POST' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
  credentials?: 'include';
}

/** What the client reads from a response (subset of Response). */
export interface ServerFetchResponse {
  status: number;
  text(): Promise<string>;
}

/**
 * The fetch the client calls. The global `fetch` (browser, React Native, Node 18+) fits it; core
 * builds without DOM types, so this is declared here instead of `typeof fetch`.
 */
export type ServerFetch = (url: string, init: ServerFetchInit) => Promise<ServerFetchResponse>;

export interface ServerKycClientOptions {
  baseUrl: string;
  fetch: ServerFetch;
  tokens: TokenStore;
  /** custom refresh: returns a new access token or null. Default: POST /auth/refresh. */
  refresh?: () => Promise<string | null>;
  /** 'web' (default): refresh token in a cookie. 'app': refresh token in the body via tokens.getRefresh/setRefresh. */
  client?: 'web' | 'app';
  /** Idempotency-Key source (tests) */
  newKey?: () => string;
}

/** Fixed, client-safe messages by server error code. */
export const SERVER_ERROR_MESSAGES: Record<string, string> = {
  bad_request: 'Check the details and try again.',
  invalid_code: 'That code is wrong or has expired.',
  invalid_token: 'Your session has ended. Sign in again.',
  rate_limited: 'Too many tries. Wait a little and try again.',
  send_failed: 'We could not send the code. Try again shortly.',
  unauthorized: 'Sign in to continue.',
  missing_idempotency_key: 'Something went wrong. Try again.',
  idempotency_mismatch: 'Something went wrong. Try again.',
  in_progress: 'This request is still being processed. Try again shortly.',
  not_found: 'Start your KYC first.',
  already_started: 'Your KYC has already started.',
  decided: 'Your KYC has already been decided.',
  wrong_step: 'That step is not open right now. Check your KYC status.',
  upload_missing: 'We could not find that upload. Upload the file again.',
  conflict: 'Your KYC changed meanwhile. Check your status and try again.',
  limit_reached: 'You have reached today\u2019s limit for KYC checks. Try again tomorrow.',
  partner_unavailable: 'The KYC service is not answering right now. Try again shortly.',
  consent_required: 'Tick the box to continue.',
  'consent-required': 'Tick the box to continue.',
  upload_failed: 'Could not upload your documents. Try again.',
  payload_too_large: 'That request is too large.',
  forbidden: 'You do not have access to this.',
  internal: 'Something went wrong. Try again.',
  network: 'Could not reach Wealthfire. Check your connection and try again.',
  bad_response: 'Something went wrong. Try again.',
};

const SAFE_CODE = /^[a-z_]{1,40}$/;

export class ServerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs?: number;
  readonly triesLeft?: number;

  constructor(status: number, rawCode: string, extra: { retryAfterMs?: number; triesLeft?: number } = {}) {
    // the contract spells it 'consent-required'; codes are snake_case everywhere else
    const code = rawCode === 'consent-required' ? 'consent_required' : rawCode;
    const known = Object.prototype.hasOwnProperty.call(SERVER_ERROR_MESSAGES, code);
    super(known ? SERVER_ERROR_MESSAGES[code]! : SERVER_ERROR_MESSAGES.internal!);
    this.name = 'ServerError';
    this.status = status;
    // only known codes or plain snake_case words: never a value the server might have echoed
    this.code = known || SAFE_CODE.test(code) ? code : 'internal';
    if (typeof extra.retryAfterMs === 'number' && Number.isFinite(extra.retryAfterMs)) this.retryAfterMs = Math.max(0, extra.retryAfterMs);
    if (typeof extra.triesLeft === 'number' && Number.isFinite(extra.triesLeft)) this.triesLeft = Math.max(0, extra.triesLeft);
  }
}

export function isServerError(e: unknown): e is ServerError {
  return e instanceof ServerError;
}

/** Investing needs a server-confirmed 'verified' status. */
export function serverEligibleToInvest(v: KycStatusView | null): boolean {
  // a server that says eligibleToInvest: false (approved, e-sign still open) wins over the status
  return v?.status === 'verified' && v.eligibleToInvest !== false;
}

const STATUSES: readonly ServerStatus[] = ['pre-verified', 'under-review', 'verified', 'rejected'];

/** Maps the server's StatusView body to the app's view. */
export function toKycStatusView(body: unknown): KycStatusView {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const status = STATUSES.includes(b.status as ServerStatus) ? (b.status as ServerStatus) : null;
  const reason = typeof b.reason === 'string' ? b.reason : null;
  const view: KycStatusView = { status, reason, next: { type: mapNext(status, reason, b.next) } };
  if (typeof b.eligibleToInvest === 'boolean') view.eligibleToInvest = b.eligibleToInvest;
  if (Array.isArray(b.documents)) {
    view.documents = ALL_DOCS.filter((k) => (b.documents as unknown[]).includes(k));
  }
  return view;
}

function mapNext(status: ServerStatus | null, reason: string | null, next: unknown): ServerNext['type'] {
  const t = mapStep(status, reason, next);
  // R3: a partner timeout the user can retry (not a step the server already re-opened)
  return t === 'wait' && reason === 'partner-timeout' && status === 'under-review' ? 'retry' : t;
}

function mapStep(status: ServerStatus | null, reason: string | null, next: unknown): ServerNext['type'] {
  // R1: a staff approval before e-sign keeps the e-sign step open (KRA upload only after it)
  if (status === 'verified' && next === 'esign') return 'esign';
  if (status === 'verified' || status === 'rejected') return 'none';
  switch (next) {
    // after consent was withdrawn a new start is allowed (the old case stays stopped)
    case 'start': return status === null || reason === 'consent-withdrawn' ? 'start' : 'wait';
    case 'aadhaar': return 'digilocker';
    case 'selfie': return 'documents';
    case 'esign': return 'esign';
    case 'none': return 'none';
    default: return status === null ? 'start' : 'wait'; // kra-lookup, pan-check, kra-upload, wait
  }
}

function defaultKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const a = new Uint32Array(4);
  if (c?.getRandomValues) c.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 2 ** 32);
  return `k-${Array.from(a, (n) => n.toString(16).padStart(8, '0')).join('')}`;
}

interface CallOpts {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  /** needs the access token (/kyc/*) */
  auth?: boolean;
  /** paid route: send an Idempotency-Key (the same one on the retry) */
  idempotent?: boolean;
}

export class ServerKycClient {
  private readonly baseUrl: string;
  private readonly doFetch: ServerFetch;
  private readonly tokens: TokenStore;
  private readonly customRefresh?: () => Promise<string | null>;
  private readonly web: boolean;
  private readonly newKey: () => string;
  private refreshing: Promise<string | null> | null = null;
  /** consents recorded through this client (memory only) */
  private readonly consents = new Set<ConsentPurpose>();
  /** document kinds uploaded through this client (memory only) */
  private readonly sent = new Set<DocKind>();

  constructor(opts: ServerKycClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    const f = opts.fetch;
    // call unbound: window.fetch throws "Illegal invocation" when called as a method of another object
    this.doFetch = (url, init) => f(url, init);
    this.tokens = opts.tokens;
    this.customRefresh = opts.refresh;
    this.web = (opts.client ?? 'web') === 'web';
    this.newKey = opts.newKey ?? defaultKey;
  }

  // ----- auth -----

  /** POST /auth/otp/send. `value` is the email or 10-digit mobile. */
  async sendOtp(kind: 'email' | 'mobile', value: string): Promise<{ challengeId: string; expiresAt?: number; resendAt?: number }> {
    const b = await this.call({ method: 'POST', path: '/auth/otp/send', body: { kind, contact: value } });
    if (typeof b.challengeId !== 'string') throw new ServerError(502, 'bad_response');
    return {
      challengeId: b.challengeId,
      ...(typeof b.expiresAt === 'number' ? { expiresAt: b.expiresAt } : {}),
      ...(typeof b.resendAt === 'number' ? { resendAt: b.resendAt } : {}),
    };
  }

  /** POST /auth/otp/verify. Stores the new tokens. */
  async verifyOtp(challengeId: string, code: string): Promise<void> {
    const b = await this.call({ method: 'POST', path: '/auth/otp/verify', body: { challengeId, code } });
    await this.storeTokens(b);
  }

  /** POST /auth/logout (idempotent). Clears local tokens even if the server can't be reached. */
  async logout(): Promise<void> {
    try {
      const refreshToken = this.web ? null : await this.tokens.getRefresh?.();
      await this.call({ method: 'POST', path: '/auth/logout', body: refreshToken ? { refreshToken } : {} });
    } finally {
      await this.tokens.set(null);
      await this.tokens.setRefresh?.(null);
    }
  }

  // ----- consent and data (DPDP) -----

  /** POST /kyc/consent for one purpose. Call only after the user ticked its box. */
  async giveConsent(purpose: ConsentPurpose): Promise<void> {
    await this.call({ method: 'POST', path: '/kyc/consent', body: { purpose }, auth: true });
    this.consents.add(purpose);
  }

  /** True when this client recorded the purpose (this session only; the server is the record). */
  hasConsent(purpose: ConsentPurpose): boolean {
    return this.consents.has(purpose);
  }

  /** Records each purpose in turn (POST /kyc/consent), before the step that needs them. */
  private async consentFor(purposes: readonly ConsentPurpose[]): Promise<void> {
    for (const p of purposes) await this.giveConsent(p);
  }

  /**
   * POST /kyc/consent/withdraw for each purpose (default: all of them, since the server holds the
   * record). The server stops the KYC with reason 'consent-withdrawn'. A purpose with no row
   * (404 not_found) counts as withdrawn.
   */
  async withdrawConsent(purposes: readonly ConsentPurpose[] = CONSENT_PURPOSES): Promise<void> {
    for (const purpose of purposes) {
      try {
        await this.call({ method: 'POST', path: '/kyc/consent/withdraw', body: { purpose }, auth: true });
      } catch (e) {
        if (!(isServerError(e) && e.status === 404)) throw e;
      }
      this.consents.delete(purpose);
    }
  }

  /** DELETE /kyc/data: deletes the documents and details the rules allow (the server keeps and audits the rest). */
  async deleteKycData(): Promise<void> {
    await this.call({ method: 'DELETE', path: '/kyc/data', auth: true });
    this.sent.clear();
    this.consents.clear();
  }

  // ----- kyc -----

  /** POST /kyc/start (paid). Records the 'pan-check' consent first. */
  async startKyc(input: StartKycInput): Promise<KycStatusView> {
    await this.consentFor(STEP_CONSENT.start);
    const body = {
      firstName: input.firstName,
      lastName: input.lastName,
      dob: input.dob,
      pan: input.pan,
      aadhaarLast4: input.aadhaarLast4,
      deviceResult: input.deviceStatus,
    };
    return toKycStatusView(await this.call({ method: 'POST', path: '/kyc/start', body, auth: true, idempotent: true }));
  }

  /** POST /kyc/aadhaar (paid). `next.url` is the partner page to open (DigiLocker; Aadhaar OTP when the partner gives one). */
  async startAadhaar(mode: 'digilocker' | 'otp', returnUrl: string): Promise<KycStatusView> {
    await this.consentFor(mode === 'otp' ? STEP_CONSENT['aadhaar-otp'] : STEP_CONSENT.digilocker);
    const b = await this.call({ method: 'POST', path: '/kyc/aadhaar', body: { mode, returnUrl }, auth: true, idempotent: true });
    const view = toKycStatusView(b.kyc);
    if (view.status === 'verified' || view.status === 'rejected') return view;
    const type = mode === 'otp' ? 'aadhaar-otp' : 'digilocker';
    return { ...view, next: typeof b.redirectUrl === 'string' ? { type, url: b.redirectUrl } : { type } };
  }

  /** POST /kyc/documents: presigned PUT URLs by kind (size must be the exact file size in bytes, max 10 MB). */
  async documentUploadUrls(files: { kind: DocKind; contentType: DocContentType; size: number }[]): Promise<Record<string, DocUploadUrl>> {
    const b = await this.call({
      method: 'POST', path: '/kyc/documents', auth: true,
      body: { files: files.map((f) => ({ kind: f.kind, contentType: f.contentType, size: f.size })) },
    });
    if (!Array.isArray(b.uploads)) throw new ServerError(502, 'bad_response');
    const out: Record<string, DocUploadUrl> = {};
    for (const u of b.uploads as Record<string, unknown>[]) {
      if (typeof u?.kind !== 'string' || typeof u.url !== 'string' || typeof u.uploadId !== 'string') throw new ServerError(502, 'bad_response');
      const headers: Record<string, string> = {};
      if (typeof u.headers === 'object' && u.headers !== null) {
        for (const [k, v] of Object.entries(u.headers as Record<string, unknown>)) if (typeof v === 'string') headers[k] = v;
      }
      out[u.kind] = { uploadId: u.uploadId, url: u.url, headers, expiresAt: typeof u.expiresAt === 'string' ? u.expiresAt : '' };
    }
    return out;
  }

  /**
   * R1: one /kyc/documents call for these files, then `put` sends each file to its presigned URL
   * (true = 2xx). Returns the uploadId per kind. Any failed PUT throws upload_failed; the kinds
   * that did go through count as sent.
   */
  async uploadDocuments(
    files: { kind: DocKind; contentType: DocContentType; size: number }[],
    put: (upload: DocUploadUrl, kind: DocKind) => Promise<boolean>,
  ): Promise<Partial<Record<DocKind, string>>> {
    const urls = await this.documentUploadUrls(files);
    const ids: Partial<Record<DocKind, string>> = {};
    let failed = false;
    for (const f of files) {
      const u = urls[f.kind];
      let ok = false;
      if (u) {
        try { ok = await put(u, f.kind); } catch { ok = false; }
      }
      if (ok && u) { ids[f.kind] = u.uploadId; this.sent.add(f.kind); } else failed = true;
    }
    if (failed) throw new ServerError(0, 'upload_failed');
    return ids;
  }

  /** Document kinds uploaded through this client (this session). */
  sentDocuments(): ReadonlySet<DocKind> {
    return new Set(this.sent);
  }

  /** POST /kyc/selfie (paid): face match + liveness on an uploaded selfie. Records 'face-match' consent first. */
  async submitSelfie(uploadId: string): Promise<KycStatusView> {
    await this.consentFor(STEP_CONSENT.documents);
    return toKycStatusView(await this.call({ method: 'POST', path: '/kyc/selfie', body: { uploadId }, auth: true, idempotent: true }));
  }

  /** POST /kyc/esign (paid). `next.url` is the e-sign page. */
  async startEsign(returnUrl: string): Promise<KycStatusView> {
    // one screen, two separate ticks: e-sign now, KRA upload after approval
    await this.consentFor(STEP_CONSENT.esign);
    const b = await this.call({ method: 'POST', path: '/kyc/esign', body: { returnUrl }, auth: true, idempotent: true });
    const view = toKycStatusView(b.kyc);
    // a staff-approved case may still have e-sign open (verified, next 'esign')
    if (view.next.type === 'none') return view;
    return { ...view, next: typeof b.redirectUrl === 'string' ? { type: 'esign', url: b.redirectUrl } : view.next };
  }

  /**
   * POST /kyc/retry (paid, counts toward the daily cap): retries a partner-timeout step. No consent
   * call while consent is on record; the server answers consent_required otherwise, and the app
   * asks the tick again and calls retry(true), which records 'pan-check' first.
   * `redo` in the answer opens that user step (Aadhaar, selfie or e-sign).
   */
  async retry(withConsent = false): Promise<KycStatusView> {
    if (withConsent) await this.consentFor(STEP_CONSENT.retry);
    const b = await this.call({ method: 'POST', path: '/kyc/retry', body: {}, auth: true, idempotent: true });
    const view = toKycStatusView(b);
    if (view.status === 'verified' || view.status === 'rejected') return view;
    const redo = b.redo === 'aadhaar' ? 'digilocker' : b.redo === 'selfie' ? 'documents' : b.redo === 'esign' ? 'esign' : null;
    return redo ? { ...view, next: { type: redo } } : view;
  }

  /** GET /kyc/status */
  async getStatus(): Promise<KycStatusView> {
    return toKycStatusView(await this.call({ method: 'GET', path: '/kyc/status', auth: true }));
  }

  // ----- plumbing -----

  private async storeTokens(b: Record<string, unknown>): Promise<string> {
    if (typeof b.accessToken !== 'string' || b.accessToken === '') throw new ServerError(502, 'bad_response');
    await this.tokens.set(b.accessToken);
    if (!this.web && typeof b.refreshToken === 'string') await this.tokens.setRefresh?.(b.refreshToken);
    return b.accessToken;
  }

  /** One refresh at a time; concurrent 401s share it. Resolves null when the session has ended. */
  private refresh(): Promise<string | null> {
    if (!this.refreshing) {
      this.refreshing = this.runRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async runRefresh(): Promise<string | null> {
    if (this.customRefresh) {
      const t = await this.customRefresh();
      await this.tokens.set(t);
      return t;
    }
    let body: Record<string, unknown> = {};
    if (!this.web) {
      const rt = await this.tokens.getRefresh?.();
      if (!rt) {
        await this.tokens.set(null);
        return null;
      }
      body = { refreshToken: rt };
    }
    try {
      return await this.storeTokens(await this.call({ method: 'POST', path: '/auth/refresh', body }));
    } catch (e) {
      // 401: refused. Web 400/403: the browser blocked the cookie (no token reached the server) or the
      // Origin / header check failed. Either way the user signs in again with an OTP; no other store.
      if (isServerError(e) && (e.status === 401 || (this.web && (e.status === 400 || e.status === 403)))) {
        await this.tokens.set(null);
        await this.tokens.setRefresh?.(null);
        return null;
      }
      throw e;
    }
  }

  private async call(o: CallOpts): Promise<Record<string, unknown>> {
    const idemKey = o.idempotent ? this.newKey() : undefined;
    if (!o.auth) return this.send(o, null, idemKey);
    let token = await this.tokens.get();
    let refreshed = false;
    if (!token) {
      token = await this.refresh();
      refreshed = true;
    }
    if (!token) throw new ServerError(401, 'unauthorized');
    try {
      return await this.send(o, token, idemKey);
    } catch (e) {
      if (!isServerError(e) || e.status !== 401) throw e;
      if (refreshed) {
        await this.tokens.set(null);
        throw e;
      }
    }
    // refresh once, then retry with the same Idempotency-Key
    const fresh = await this.refresh();
    if (!fresh) throw new ServerError(401, 'unauthorized');
    try {
      return await this.send(o, fresh, idemKey);
    } catch (e) {
      if (isServerError(e) && e.status === 401) await this.tokens.set(null);
      throw e;
    }
  }

  private async send(o: CallOpts, token: string | null, idemKey: string | undefined): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (this.web) headers['x-wf-client'] = 'web';
    if (token) headers.authorization = `Bearer ${token}`;
    if (idemKey) headers['idempotency-key'] = idemKey;
    const init: ServerFetchInit = { method: o.method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) };
    // the refresh cookie lives on the API's /auth path
    if (this.web && o.path.startsWith('/auth/')) init.credentials = 'include';
    let res: ServerFetchResponse;
    try {
      res = await this.doFetch(`${this.baseUrl}${o.path}`, init);
    } catch {
      throw new ServerError(0, 'network');
    }
    let data: unknown = {};
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    const b = (typeof data === 'object' && data !== null && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
    if (res.status >= 200 && res.status < 300) return b;
    const code = typeof b.error === 'string' ? b.error : res.status === 401 ? 'unauthorized' : 'internal';
    throw new ServerError(res.status, code, {
      ...(typeof b.retryAfterMs === 'number' ? { retryAfterMs: b.retryAfterMs } : {}),
      ...(typeof b.triesLeft === 'number' ? { triesLeft: b.triesLeft } : {}),
    });
  }
}

/**
 * Contact OTP (email / mobile) through the server. Aadhaar is not an OTP here: real Aadhaar goes
 * through ServerKycClient.startAadhaar (DigiLocker / partner OTP).
 */
export class HttpOtpProvider implements OtpProvider {
  readonly id: OtpProviderId = 'http';
  readonly isDemo = false;

  constructor(private readonly client: ServerKycClient) {}

  async send(req: OtpSendRequest, now: number): Promise<OtpSendResult> {
    if (req.channel === 'aadhaar') throw new Error('Aadhaar OTP is not supported by HttpOtpProvider');
    try {
      const r = await this.client.sendOtp(req.channel === 'email' ? 'email' : 'mobile', req.target);
      return { ok: true, requestId: r.challengeId, expiresAt: r.expiresAt ?? now + 10 * 60_000 };
    } catch (e) {
      const err = isServerError(e) ? e : new ServerError(0, 'network');
      if (err.code === 'bad_request') return { ok: false, reason: 'invalid-target', message: OTP_MESSAGES.invalidTarget };
      if (err.code === 'rate_limited') return { ok: false, reason: 'rate-limited', message: err.message };
      return { ok: false, reason: 'network', message: err.message };
    }
  }

  async verify(requestId: string, code: string, _now: number): Promise<OtpVerifyResult> {
    try {
      await this.client.verifyOtp(requestId, code.trim());
      return { ok: true };
    } catch (e) {
      const err = isServerError(e) ? e : new ServerError(0, 'network');
      if (err.code === 'invalid_code') {
        const left = err.triesLeft ?? 0;
        return left > 0
          ? { ok: false, reason: 'wrong', message: OTP_MESSAGES.wrong(left) }
          : { ok: false, reason: 'void', message: OTP_MESSAGES.void };
      }
      if (err.code === 'bad_request') return { ok: false, reason: 'wrong', message: SERVER_ERROR_MESSAGES.invalid_code! };
      return { ok: false, reason: 'network', message: err.message };
    }
  }
}
