// Client for the final KYC service (services/kyc, design §3 and §6). Same code on web and phones:
// the app passes its own fetch and token store. Error messages are fixed strings chosen here, so
// they never carry a PAN, Aadhaar number, contact, OTP or token (not even if a server echoed one).
//
// Tokens: the access token lives in `tokens`. The refresh token is
// - web (`client: 'web'`, default): an HttpOnly cookie on the API's /auth path; requests send
//   `x-wf-client: web` and `credentials: 'include'`, so the app never sees it;
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
   * 'digilocker' or 'otp'). documents: upload a selfie, then submitSelfie. esign: call startEsign.
   * wait: the server or a reviewer is working. none: decided.
   */
  type: 'start' | 'digilocker' | 'aadhaar-otp' | 'documents' | 'esign' | 'wait' | 'none';
  url?: string;
}

export interface KycStatusView {
  status: ServerStatus | null;
  /** server reason code, e.g. 'kra-validated', 'check-unclear', 'staff-rejected' */
  reason: string | null;
  next: ServerNext;
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
  method: 'GET' | 'POST';
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

  constructor(status: number, code: string, extra: { retryAfterMs?: number; triesLeft?: number } = {}) {
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
  return v?.status === 'verified';
}

const STATUSES: readonly ServerStatus[] = ['pre-verified', 'under-review', 'verified', 'rejected'];

/** Maps the server's StatusView body to the app's view. */
export function toKycStatusView(body: unknown): KycStatusView {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const status = STATUSES.includes(b.status as ServerStatus) ? (b.status as ServerStatus) : null;
  const reason = typeof b.reason === 'string' ? b.reason : null;
  return { status, reason, next: { type: mapNext(status, b.next) } };
}

function mapNext(status: ServerStatus | null, next: unknown): ServerNext['type'] {
  if (status === 'verified' || status === 'rejected') return 'none';
  switch (next) {
    case 'start': return status === null ? 'start' : 'wait';
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
  method: 'GET' | 'POST';
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

  // ----- kyc -----

  /** POST /kyc/start (paid). */
  async startKyc(input: StartKycInput): Promise<KycStatusView> {
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

  /** POST /kyc/selfie (paid): face match + liveness on an uploaded selfie. */
  async submitSelfie(uploadId: string): Promise<KycStatusView> {
    return toKycStatusView(await this.call({ method: 'POST', path: '/kyc/selfie', body: { uploadId }, auth: true, idempotent: true }));
  }

  /** POST /kyc/esign (paid). `next.url` is the e-sign page. */
  async startEsign(returnUrl: string): Promise<KycStatusView> {
    const b = await this.call({ method: 'POST', path: '/kyc/esign', body: { returnUrl }, auth: true, idempotent: true });
    const view = toKycStatusView(b.kyc);
    if (view.status === 'verified' || view.status === 'rejected') return view;
    return { ...view, next: typeof b.redirectUrl === 'string' ? { type: 'esign', url: b.redirectUrl } : view.next };
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
      if (isServerError(e) && e.status === 401) {
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
