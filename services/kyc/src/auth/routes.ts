// Pure HTTP handlers for the auth routes. The Lambda adapter maps API Gateway events to
// RouteRequest and RouteResponse back. Responses use fixed messages only: no codes, tokens
// (other than the caller's own new ones), contacts or account-exists hints.
//
// Refresh-token transport (R2/S6, S4):
// - Cookie mode: the request has `x-wf-client: web` AND an `Origin` on the app-origin list (env
//   APP_ORIGINS: web app origins only, never the console or other CORS-only origins). The
//   refresh token travels only in the `wf_rt` cookie (Path=/; HttpOnly; Secure; SameSite=None;
//   Partitioned); it is never in a response body and a body token is ignored.
// - Body mode: no `x-wf-client: web` header (phones). The token travels only in the JSON body and
//   the cookie is never read, so a cross-site form post cannot spend the cookie.
// - `x-wf-client: web` from an Origin not on the list is refused with 403 (no cookie is read,
//   set or cleared).
// If the browser blocks the cookie, the web app asks for a new OTP (no localStorage fallback).
import { AUTH_ERROR_STATUS, AuthError, isAuthError } from '../lib/errors';
import type { TokenPair, TokenService } from '../lib/tokens';
import { normalizeContact, type OtpService } from './otp';

export const REFRESH_COOKIE = 'wf_rt';
/** Path=/ so the cookie also matches the REST API's `/<stage>/auth/...` URLs. */
export const REFRESH_COOKIE_PATH = '/';
export const CLIENT_HEADER = 'x-wf-client';

export interface RouteRequest {
  /** parsed JSON or the raw string body */
  body: unknown;
  /** header names in any case */
  headers: Record<string, string | undefined>;
  ip: string;
}

export interface Cookie {
  name: string;
  value: string;
  httpOnly: true;
  secure: true;
  sameSite: 'None' | 'Strict' | 'Lax';
  /** CHIPS: keyed to the top-level site, so it keeps working where third-party cookies are limited */
  partitioned?: boolean;
  path: string;
  /** seconds; 0 clears the cookie */
  maxAge: number;
}

export interface RouteResponse {
  status: number;
  body: Record<string, unknown>;
  cookies?: Cookie[];
}

export interface AuthRouteDeps {
  otp: OtpService;
  tokens: TokenService;
  clock: { now(): number };
  /** exact web APP origins allowed to use the refresh cookie (env APP_ORIGINS; not the CORS list) */
  appOrigins?: readonly string[];
  /**
   * LOCAL MODE ONLY (src/local/demo.ts LocalDemoSender): the last code sent to a contact, answered
   * as `demoCode` by POST /auth/otp/send. The router drops it unless STAGE is exactly 'local'.
   */
  demo?: DemoCodeSource;
  /**
   * LOCAL MODE ONLY: LOCAL_PERSONAS ids. With these, `x-wf-persona: <id>` picks the refresh cookie
   * `wf_rt_<id>`, so local test users in one browser keep separate sessions. The router drops
   * them unless STAGE is exactly 'local'.
   */
  personaIds?: readonly string[];
}

/** Where the local demo reads the code it just "sent" (kind + normalised contact). */
export interface DemoCodeSource {
  codeFor(kind: 'email' | 'mobile', normalizedContact: string): string | undefined;
}

export type AuthHandler = (req: RouteRequest, deps: AuthRouteDeps) => Promise<RouteResponse>;

// ---------- helpers ----------

function header(req: RouteRequest, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(req.headers ?? {})) if (k.toLowerCase() === want) return v;
  return undefined;
}

function parseBody(body: unknown): Record<string, unknown> {
  let v = body;
  if (typeof v === 'string') {
    if (v.length > 4096) throw new AuthError('bad_request');
    if (v.trim() === '') return {};
    try {
      v = JSON.parse(v);
    } catch {
      throw new AuthError('bad_request');
    }
  }
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new AuthError('bad_request');
  return v as Record<string, unknown>;
}

type Transport = 'cookie' | 'body';

/** Cookie mode needs `x-wf-client: web` and an allowed Origin; web from any other Origin is 403. */
function transport(req: RouteRequest, deps: AuthRouteDeps): Transport {
  if (header(req, CLIENT_HEADER) !== 'web') return 'body';
  const origin = header(req, 'origin');
  if (origin && (deps.appOrigins ?? []).includes(origin)) return 'cookie';
  throw new AuthError('forbidden');
}

function readCookie(req: RouteRequest, name: string): string | undefined {
  const raw = header(req, 'cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** LOCAL MODE ONLY: the header naming the local test user (LOCAL_PERSONAS id). */
export const PERSONA_HEADER = 'x-wf-persona';

/**
 * The refresh cookie name for this request: `wf_rt_<id>` when the deps carry the local persona
 * ids (the router sets them only on STAGE=local) and `x-wf-persona` names one of them; else `wf_rt`.
 */
export function refreshCookieName(req: RouteRequest, deps: AuthRouteDeps): string {
  const ids = deps.personaIds;
  if (!ids || ids.length === 0) return REFRESH_COOKIE;
  const id = header(req, PERSONA_HEADER);
  return id !== undefined && ids.includes(id) && /^[a-z0-9]{1,32}$/.test(id) ? `${REFRESH_COOKIE}_${id}` : REFRESH_COOKIE;
}

export function refreshCookie(value: string, maxAgeSec: number, name: string = REFRESH_COOKIE): Cookie {
  return {
    name, value, httpOnly: true, secure: true, sameSite: 'None', partitioned: true, path: REFRESH_COOKIE_PATH, maxAge: maxAgeSec,
  };
}

function tokenResponse(
  mode: Transport, deps: AuthRouteDeps, t: TokenPair, extra: Record<string, unknown> = {}, cookieName: string = REFRESH_COOKIE,
): RouteResponse {
  const body: Record<string, unknown> = {
    userId: t.userId,
    accessToken: t.accessToken,
    accessExpiresAt: t.accessExpiresAt,
    refreshExpiresAt: t.refreshExpiresAt,
    ...extra,
  };
  if (mode === 'body') return { status: 200, body: { ...body, refreshToken: t.refreshToken } };
  const maxAge = Math.max(0, Math.floor((t.refreshExpiresAt - deps.clock.now()) / 1000));
  return { status: 200, body, cookies: [refreshCookie(t.refreshToken, maxAge, cookieName)] };
}

/** Cookie mode reads only the cookie; body mode reads only the body. */
function refreshTokenFrom(
  mode: Transport, req: RouteRequest, body: Record<string, unknown>, cookieName: string = REFRESH_COOKIE,
): string | undefined {
  if (mode === 'cookie') return readCookie(req, cookieName) || undefined;
  const fromBody = body.refreshToken;
  return typeof fromBody === 'string' && fromBody ? fromBody : undefined;
}

/** Maps any thrown value to a safe response. Unknown errors never expose their message. */
export function errorResponse(e: unknown): RouteResponse {
  if (isAuthError(e)) {
    const body: Record<string, unknown> = { error: e.code, message: e.message };
    if (e.retryAfterMs !== undefined) body.retryAfterMs = e.retryAfterMs;
    if (e.triesLeft !== undefined) body.triesLeft = e.triesLeft;
    return { status: AUTH_ERROR_STATUS[e.code], body };
  }
  return { status: 500, body: { error: 'internal', message: 'Something went wrong. Try again.' } };
}

function safe(handler: AuthHandler): AuthHandler {
  return async (req, deps) => {
    try {
      return await handler(req, deps);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

// ---------- handlers ----------

/**
 * POST /auth/otp/send  body {kind: 'email'|'mobile', contact} -> 200 {challengeId, expiresAt, resendAt}
 * (+ `demoCode` in local mode only, when `deps.demo` is set: the router sets it only on STAGE=local)
 */
export const handleOtpSend: AuthHandler = safe(async (req, deps) => {
  const b = parseBody(req.body);
  const r = await deps.otp.send({ kind: b.kind as 'email' | 'mobile', contact: b.contact as string, ip: req.ip });
  const body: Record<string, unknown> = { challengeId: r.challengeId, expiresAt: r.expiresAt, resendAt: r.resendAt };
  if (deps.demo) {
    // send() already validated the contact, so this cannot throw here
    const c = normalizeContact(b.kind, b.contact);
    const code = deps.demo.codeFor(c.kind, c.value);
    if (code) body.demoCode = code;
  }
  return { status: 200, body };
});

/** POST /auth/otp/verify  body {challengeId, code, device?} -> 200 tokens */
export const handleOtpVerify: AuthHandler = safe(async (req, deps) => {
  const mode = transport(req, deps);
  const b = parseBody(req.body);
  const r = await deps.otp.verify({
    challengeId: b.challengeId as string,
    code: b.code as string,
    device: typeof b.device === 'string' ? b.device : undefined,
    ip: req.ip,
  });
  return tokenResponse(mode, deps, r.tokens, { isNewUser: r.isNewUser }, refreshCookieName(req, deps));
});

/** POST /auth/refresh  body {refreshToken} (phones) or the cookie (web) -> 200 new tokens; 401 on reuse/expiry */
export const handleRefresh: AuthHandler = safe(async (req, deps) => {
  const mode = transport(req, deps);
  const name = refreshCookieName(req, deps);
  const b = parseBody(req.body);
  const token = refreshTokenFrom(mode, req, b, name);
  const clear = mode === 'cookie' ? { cookies: [refreshCookie('', 0, name)] } : {};
  if (!token) return { ...errorResponse(new AuthError('invalid_token')), ...clear };
  try {
    return tokenResponse(mode, deps, await deps.tokens.refresh(token), {}, name);
  } catch (e) {
    return { ...errorResponse(e), ...clear };
  }
});

/** POST /auth/logout  body {refreshToken} (phones) or the cookie (web) -> 200 always (idempotent) */
export const handleLogout: AuthHandler = safe(async (req, deps) => {
  const mode = transport(req, deps);
  const name = refreshCookieName(req, deps);
  const b = parseBody(req.body);
  const token = refreshTokenFrom(mode, req, b, name);
  if (token) await deps.tokens.revoke(token);
  return { status: 200, body: { ok: true }, ...(mode === 'cookie' ? { cookies: [refreshCookie('', 0, name)] } : {}) };
});

export const AUTH_ROUTES: Record<string, AuthHandler> = {
  'POST /auth/otp/send': handleOtpSend,
  'POST /auth/otp/verify': handleOtpVerify,
  'POST /auth/refresh': handleRefresh,
  'POST /auth/logout': handleLogout,
};
