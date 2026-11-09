// Pure HTTP handlers for the auth routes. The Lambda adapter maps API Gateway events to
// RouteRequest and RouteResponse back. Responses use fixed messages only: no codes, tokens
// (other than the caller's own new ones), contacts or account-exists hints.
//
// Refresh-token transport: web clients send `x-wf-client: web` and get the refresh token only as
// an HttpOnly cookie; other clients (phones) get it in the JSON body and send it back in the body.
import { AUTH_ERROR_STATUS, AuthError, isAuthError } from '../lib/errors';
import type { TokenPair, TokenService } from '../lib/tokens';
import type { OtpService } from './otp';

export const REFRESH_COOKIE = 'wf_refresh';
export const REFRESH_COOKIE_PATH = '/auth';

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

function isWeb(req: RouteRequest): boolean {
  return header(req, 'x-wf-client') === 'web';
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

function refreshCookie(value: string, maxAgeSec: number): Cookie {
  return { name: REFRESH_COOKIE, value, httpOnly: true, secure: true, sameSite: 'None', path: REFRESH_COOKIE_PATH, maxAge: maxAgeSec };
}

function tokenResponse(req: RouteRequest, deps: AuthRouteDeps, t: TokenPair, extra: Record<string, unknown> = {}): RouteResponse {
  const body: Record<string, unknown> = {
    userId: t.userId,
    accessToken: t.accessToken,
    accessExpiresAt: t.accessExpiresAt,
    refreshExpiresAt: t.refreshExpiresAt,
    ...extra,
  };
  if (!isWeb(req)) return { status: 200, body: { ...body, refreshToken: t.refreshToken } };
  const maxAge = Math.max(0, Math.floor((t.refreshExpiresAt - deps.clock.now()) / 1000));
  return { status: 200, body, cookies: [refreshCookie(t.refreshToken, maxAge)] };
}

function refreshTokenFrom(req: RouteRequest, body: Record<string, unknown>): string | undefined {
  const fromBody = body.refreshToken;
  if (typeof fromBody === 'string' && fromBody) return fromBody;
  return readCookie(req, REFRESH_COOKIE);
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

/** POST /auth/otp/send  body {kind: 'email'|'mobile', contact} -> 200 {challengeId, expiresAt, resendAt} */
export const handleOtpSend: AuthHandler = safe(async (req, deps) => {
  const b = parseBody(req.body);
  const r = await deps.otp.send({ kind: b.kind as 'email' | 'mobile', contact: b.contact as string, ip: req.ip });
  return { status: 200, body: { challengeId: r.challengeId, expiresAt: r.expiresAt, resendAt: r.resendAt } };
});

/** POST /auth/otp/verify  body {challengeId, code, device?} -> 200 tokens */
export const handleOtpVerify: AuthHandler = safe(async (req, deps) => {
  const b = parseBody(req.body);
  const r = await deps.otp.verify({
    challengeId: b.challengeId as string,
    code: b.code as string,
    device: typeof b.device === 'string' ? b.device : undefined,
  });
  return tokenResponse(req, deps, r.tokens, { isNewUser: r.isNewUser });
});

/** POST /auth/refresh  body {refreshToken} or cookie -> 200 new tokens; 401 on reuse/expiry */
export const handleRefresh: AuthHandler = safe(async (req, deps) => {
  const b = parseBody(req.body);
  const token = refreshTokenFrom(req, b);
  if (!token) throw new AuthError('invalid_token');
  try {
    return tokenResponse(req, deps, await deps.tokens.refresh(token));
  } catch (e) {
    const res = errorResponse(e);
    return isWeb(req) ? { ...res, cookies: [refreshCookie('', 0)] } : res;
  }
});

/** POST /auth/logout  body {refreshToken} or cookie -> 200 always (idempotent) */
export const handleLogout: AuthHandler = safe(async (req, deps) => {
  const b = parseBody(req.body);
  const token = refreshTokenFrom(req, b);
  if (token) await deps.tokens.revoke(token);
  return { status: 200, body: { ok: true }, ...(isWeb(req) ? { cookies: [refreshCookie('', 0)] } : {}) };
});

export const AUTH_ROUTES: Record<string, AuthHandler> = {
  'POST /auth/otp/send': handleOtpSend,
  'POST /auth/otp/verify': handleOtpVerify,
  'POST /auth/refresh': handleRefresh,
  'POST /auth/logout': handleLogout,
};
