// Pure HTTP handlers for /kyc/*. The router has already checked the access token and passes the
// caller's userId. Responses carry masks and step info only; errors use fixed messages.
import { isKycError, KYC_ERROR_STATUS, KycError } from './errors';
import { parseStartInput, type KycService } from './service';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const BODY_MAX = 8192;

export interface KycRouteRequest {
  userId: string;
  /** raw string body or parsed JSON */
  body: unknown;
  headers: Record<string, string | undefined>;
  ip: string;
}

export interface KycRouteResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export type KycHandler = (req: KycRouteRequest) => Promise<KycRouteResponse>;

function header(req: KycRouteRequest, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(req.headers ?? {})) if (k.toLowerCase() === want) return v;
  return undefined;
}

export function parseBody(body: unknown): Record<string, unknown> {
  let v = body;
  if (typeof v === 'string') {
    if (v.length > BODY_MAX) throw new KycError('bad_request');
    if (v.trim() === '') return {};
    try {
      v = JSON.parse(v);
    } catch {
      throw new KycError('bad_request');
    }
  }
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new KycError('bad_request');
  return v as Record<string, unknown>;
}

/** Maps any thrown value to a safe response. Unknown errors never expose their message. */
export function kycErrorResponse(e: unknown): KycRouteResponse {
  if (isKycError(e)) return { status: KYC_ERROR_STATUS[e.code], body: { error: e.code, message: e.message } };
  return { status: 500, body: { error: 'internal', message: 'Something went wrong. Try again.' } };
}

function safe(fn: KycHandler): KycHandler {
  return async (req) => {
    try {
      return await fn(req);
    } catch (e) {
      return kycErrorResponse(e);
    }
  };
}

/** Paid route: Idempotency-Key required; a retry replays the stored response. */
function paidRoute(svc: KycService, route: string, run: (req: KycRouteRequest, b: Record<string, unknown>) => Promise<Record<string, unknown>>): KycHandler {
  return safe(async (req) => {
    const b = parseBody(req.body);
    const r = await svc.idempotent(req.userId, route, header(req, IDEMPOTENCY_HEADER), b, async () => ({
      status: 200, body: await run(req, b),
    }));
    return { status: r.status, body: r.body, ...(r.replayed ? { headers: { 'idempotent-replayed': 'true' } } : {}) };
  });
}

export function kycRoutes(svc: KycService): Record<string, KycHandler> {
  return {
    /** body {firstName, lastName, dob, pan, aadhaarLast4, deviceResult} -> 200 StatusView */
    'POST /kyc/start': paidRoute(svc, 'start', async (req, b) => ({ ...(await svc.start(req.userId, parseStartInput(b), req.ip)) })),
    /** body {mode: 'digilocker'|'otp', returnUrl} -> 200 {redirectUrl?, challengeRef?, kyc} */
    'POST /kyc/aadhaar': paidRoute(svc, 'aadhaar', (req, b) => svc.startAadhaar(req.userId, b, req.ip)),
    /** body {files: [{kind: 'selfie'|'aadhaar'|'pan', contentType, size}]} -> 200 {uploads} (not paid; 9 signings / day; send every returned header) */
    'POST /kyc/documents': safe(async (req) => ({ status: 200, body: await svc.documentUploads(req.userId, parseBody(req.body)) })),
    /** body {uploadId} -> 200 StatusView (face match + liveness) */
    'POST /kyc/selfie': paidRoute(svc, 'selfie', async (req, b) => ({ ...(await svc.submitSelfie(req.userId, b, req.ip)) })),
    /** body {returnUrl} -> 200 {redirectUrl, kyc} */
    'POST /kyc/esign': paidRoute(svc, 'esign', (req, b) => svc.startEsign(req.userId, b, req.ip)),
    /** -> 200 StatusView ({status: null, next: 'start'} before the first start); re-runs a timed-out system step at most once per 10 min */
    'GET /kyc/status': safe(async (req) => ({ status: 200, body: { ...(await svc.status(req.userId)) } })),
    /** R3: -> 200 {...StatusView, redo?: 'aadhaar'|'selfie'|'esign'} (paid: counts toward the daily cap) */
    'POST /kyc/retry': paidRoute(svc, 'retry', async (req) => ({ ...(await svc.retry(req.userId, req.ip)) })),
    /** S2: body {purpose} -> 200 {purpose, consent: 'given', at, kyc}; after a withdrawal this starts a new case */
    'POST /kyc/consent': safe(async (req) => ({ status: 200, body: await svc.giveConsent(req.userId, parseBody(req.body), req.ip) })),
    /** S2: body {purpose} -> 200 {purpose, consent: 'withdrawn', at, kyc}; an open case stops ('consent-withdrawn') */
    'POST /kyc/consent/withdraw': safe(async (req) => ({ status: 200, body: await svc.withdrawConsent(req.userId, parseBody(req.body), req.ip) })),
    /** S2: -> 200 {deleted: {documents, case}, kept: [{what, reason}]} */
    'DELETE /kyc/data': safe(async (req) => ({ status: 200, body: await svc.deleteData(req.userId, req.ip) })),
  };
}
