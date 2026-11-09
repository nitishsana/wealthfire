// HTTP router for the api Lambda: /auth/* (public + refresh cookie), /kyc/* (user access token),
// /review/* (staff Cognito token, group 'reviewer'). Pure: the Lambda adapter (handlers/api.ts)
// maps API Gateway events to HttpRequest and HttpResponse back.
//
// Every response is JSON with no-store caching, HSTS and nosniff (the fake partner pages,
// registered only when STAGE=dev or STAGE=local, may answer text/html). Errors use fixed messages and
// never echo a PAN, Aadhaar number, contact, OTP or token. Logs hold the route template, status
// and latency only.
import { AUTH_ERROR_MESSAGES } from './lib/errors';
import type { TokenService } from './lib/tokens';
import { AUTH_ROUTES, type AuthRouteDeps, type Cookie } from './auth/routes';
import type { KycHandler } from './kyc/routes';
import type { Logger } from './kyc/log';
import type { StaffVerifier } from './kyc/staff';
import type { Handler as ReviewHandler } from './review/routes';

export const REVIEWER_GROUP = 'reviewer';
export const MAX_BODY_BYTES = 16 * 1024;

export interface HttpRequest {
  method: string;
  /** path without the API stage, e.g. /kyc/start */
  path: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  /** raw (already base64-decoded) body */
  body?: string;
  ip: string;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  /** Set-Cookie values */
  cookies: string[];
}

/** Request passed to a dev-only fake partner page handler (no auth: the fake partner is public on dev). */
export interface DevPartnerRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body?: string;
  ip: string;
}

/** Same shape as the other route responses; a string body with a text/html content type is sent as-is. */
export interface DevPartnerResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type DevPartnerHandler = (req: DevPartnerRequest) => Promise<DevPartnerResponse>;

export interface RouterDeps {
  auth: AuthRouteDeps;
  tokens: TokenService;
  /** the kyc route map ('METHOD /path' -> handler); every key is registered as-is */
  kyc: Record<string, KycHandler>;
  review: Record<string, ReviewHandler>;
  staff: StaffVerifier;
  /** CORS allow-list (exact origins: app + review console, dev preview). NOT used for the refresh cookie. */
  allowedOrigins: readonly string[];
  /**
   * Web app origins allowed to use the refresh cookie (env APP_ORIGINS, S#8). Unset or empty =
   * cookie mode off: `x-wf-client: web` is refused with 403. Never falls back to allowedOrigins.
   */
  appOrigins?: readonly string[];
  logger: Logger;
  clock: { now(): number };
  /**
   * env STAGE; dev partner pages are registered only when this is exactly 'dev' or 'local' (the
   * local Node server; the Lambda refuses STAGE=local). `auth.demo` is used only on 'local'.
   */
  stage?: string;
  /** devPartnerRoutes(deps) from src/partner/devPages.ts (ignored unless stage is 'dev' or 'local') */
  devPartner?: Record<string, DevPartnerHandler>;
}

/** The local-only stage (services/kyc/local/server.ts). */
export const LOCAL_STAGE = 'local';

/** Stages that serve the fake DigiLocker / e-sign pages. */
export function servesDevPartner(stage: string | undefined): boolean {
  return stage === 'dev' || stage === LOCAL_STAGE;
}

export const CORS_ALLOW_METHODS = 'GET, POST, DELETE, OPTIONS';
export const CORS_ALLOW_HEADERS = 'content-type, authorization, idempotency-key, x-wf-client';

const SECURITY_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const ERR = {
  not_found: { status: 404, message: 'Not found.' },
  payload_too_large: { status: 413, message: 'That request is too large.' },
  unauthorized: { status: 401, message: AUTH_ERROR_MESSAGES.unauthorized },
  forbidden: { status: 403, message: 'You do not have access to this.' },
  internal: { status: 500, message: 'Something went wrong. Try again.' },
} as const;

type ErrKey = keyof typeof ERR;

function header(h: Record<string, string | undefined>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(h ?? {})) if (k.toLowerCase() === want) return v;
  return undefined;
}

export function serializeCookie(c: Cookie): string {
  return [
    `${c.name}=${c.value}`, `Max-Age=${c.maxAge}`, `Path=${c.path}`, 'HttpOnly', 'Secure', `SameSite=${c.sameSite}`,
    ...(c.partitioned ? ['Partitioned'] : []),
  ].join('; ');
}

/** Matches 'METHOD /a/{id}' templates; returns the template key and params. */
export function matchRoute(
  keys: Iterable<string>, method: string, path: string,
): { key: string; params: Record<string, string> } | null {
  const segs = path.split('/').filter(Boolean);
  for (const key of keys) {
    const [m, tpl] = key.split(' ');
    if (m !== method || !tpl) continue;
    const t = tpl.split('/').filter(Boolean);
    if (t.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < t.length; i++) {
      const ts = t[i]!;
      const s = segs[i]!;
      if (ts.startsWith('{') && ts.endsWith('}')) {
        let v: string;
        try {
          v = decodeURIComponent(s);
        } catch {
          ok = false;
          break;
        }
        params[ts.slice(1, -1)] = v;
      } else if (ts !== s) {
        ok = false;
        break;
      }
    }
    if (ok) return { key, params };
  }
  return null;
}

function bearer(authorization: string | undefined): string | null {
  if (typeof authorization !== 'string') return null;
  const m = /^Bearer\s+(\S{1,4096})$/.exec(authorization.trim());
  return m ? m[1]! : null;
}

export function createRouter(deps: RouterDeps): (req: HttpRequest) => Promise<HttpResponse> {
  const authKeys = Object.keys(AUTH_ROUTES);
  const kycKeys = Object.keys(deps.kyc);
  const reviewKeys = Object.keys(deps.review);
  const dev = servesDevPartner(deps.stage) ? (deps.devPartner ?? {}) : {};
  const devKeys = Object.keys(dev);
  // The demo OTP source (answers `demoCode`) is dropped on every stage but exactly 'local'.
  // ... and so are the local persona cookie names (x-wf-persona is never read online).
  const { demo, personaIds, ...auth } = deps.auth;
  const local = deps.stage === LOCAL_STAGE;
  const authDeps: AuthRouteDeps = {
    ...auth, appOrigins: deps.appOrigins ?? [],
    ...(local && demo ? { demo } : {}),
    ...(local && personaIds ? { personaIds } : {}),
  };

  const respond = (req: HttpRequest, status: number, body: unknown, extra: Record<string, string> = {}, cookies: string[] = []): HttpResponse => {
    const headers: Record<string, string> = { ...SECURITY_HEADERS, ...extra };
    const origin = header(req.headers, 'origin');
    if (origin && deps.allowedOrigins.includes(origin)) {
      headers['access-control-allow-origin'] = origin;
      headers['access-control-allow-credentials'] = 'true';
      headers.vary = 'Origin';
    }
    const html = typeof body === 'string' && /^text\/html\b/i.test(headers['content-type'] ?? '');
    return { statusCode: status, headers, body: html ? (body as string) : JSON.stringify(body ?? {}), cookies };
  };
  const fail = (req: HttpRequest, k: ErrKey): HttpResponse => respond(req, ERR[k].status, { error: k, message: ERR[k].message });

  async function route(req: HttpRequest): Promise<{ res: HttpResponse; key: string }> {
    const method = req.method.toUpperCase();
    const path = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
    if (method === 'OPTIONS') {
      return {
        key: 'OPTIONS',
        res: respond(req, 204, {}, {
          'access-control-allow-methods': CORS_ALLOW_METHODS,
          'access-control-allow-headers': CORS_ALLOW_HEADERS,
          'access-control-max-age': '600',
        }),
      };
    }
    if (req.body !== undefined && Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) {
      return { key: 'too-large', res: fail(req, 'payload_too_large') };
    }

    const a = matchRoute(authKeys, method, path);
    if (a) {
      const r = await AUTH_ROUTES[a.key]!({ body: req.body, headers: req.headers, ip: req.ip }, authDeps);
      return { key: a.key, res: respond(req, r.status, r.body, {}, (r.cookies ?? []).map(serializeCookie)) };
    }

    // Fake partner pages (DigiLocker / e-sign); never registered outside STAGE=dev / STAGE=local.
    const d = devKeys.length ? matchRoute(devKeys, method, path) : null;
    if (d) {
      const r = await dev[d.key]!({ method, path, params: d.params, query: req.query ?? {}, headers: req.headers, body: req.body, ip: req.ip });
      return { key: d.key, res: respond(req, r.status, r.body, r.headers ?? {}) };
    }

    const k = matchRoute(kycKeys, method, path);
    if (k) {
      const token = bearer(header(req.headers, 'authorization'));
      if (!token) return { key: k.key, res: fail(req, 'unauthorized') };
      let userId: string;
      try {
        userId = (await deps.tokens.authenticate(token)).sub;
      } catch {
        return { key: k.key, res: fail(req, 'unauthorized') };
      }
      const r = await deps.kyc[k.key]!({ userId, body: req.body, headers: req.headers, ip: req.ip });
      return { key: k.key, res: respond(req, r.status, r.body, r.headers ?? {}) };
    }

    const v = matchRoute(reviewKeys, method, path);
    if (v) {
      const staff = await deps.staff.verify(header(req.headers, 'authorization'));
      if (!staff) return { key: v.key, res: fail(req, 'unauthorized') };
      if (!staff.groups.includes(REVIEWER_GROUP)) return { key: v.key, res: fail(req, 'forbidden') };
      const r = await deps.review[v.key]!({ params: v.params, query: req.query ?? {}, body: req.body, staff });
      return { key: v.key, res: respond(req, r.status, r.body) };
    }
    return { key: 'unknown', res: fail(req, 'not_found') };
  }

  return async (req) => {
    const started = deps.clock.now();
    let out: { res: HttpResponse; key: string };
    try {
      out = await route(req);
    } catch {
      out = { key: 'error', res: fail(req, 'internal') };
      deps.logger.error('unhandled_error', { method: req.method });
    }
    deps.logger.info('request', { route: out.key, status: out.res.statusCode, ms: deps.clock.now() - started });
    return out.res;
  };
}
