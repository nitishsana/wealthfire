// Thin client for the /review/* routes. Sends the Cognito ID token (the API's Cognito
// authorizer validates ID tokens). A 401 drops the in-memory session.
import { current, forget } from './auth';
import { config } from './config';

export type CheckResult = 'pass' | 'fail' | 'unclear';

export interface CaseView {
  id: string;
  status: string;
  path: string | null;
  reason: string | null;
  updatedAt: string;
  version: number;
  masks: { pan: string; aadhaar: string };
  checks: Record<string, CheckResult>;
  unclear: string[];
}

export interface DocumentLink {
  id: string;
  kind: string;
  uploadedAt?: string;
  url: string;
  expiresAt: string;
}

export interface HistoryRow {
  ts: string;
  actor: string;
  action: string;
  from: string | null;
  to: string | null;
  note?: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const s = current();
  if (!s) throw new ApiError(401, 'Your session has ended. Sign in again.');
  const res = await fetch(`${config.apiUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      authorization: s.idToken,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
    credentials: 'omit',
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    if (res.status === 401) forget();
    const d = (data ?? {}) as { message?: unknown; error?: unknown };
    const msg = typeof d.message === 'string' ? d.message : res.status === 401 ? 'Your session has ended. Sign in again.' : 'Something went wrong. Try again.';
    throw new ApiError(res.status, msg, typeof d.error === 'string' ? d.error : undefined);
  }
  return data as T;
}

export function listCases(cursor?: string): Promise<{ items: CaseView[]; nextCursor?: string }> {
  const q = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) });
  return call('GET', `/review/cases?${q.toString()}`);
}

export function getCase(id: string): Promise<{ case: CaseView; documents: DocumentLink[]; history: HistoryRow[] }> {
  return call('GET', `/review/cases/${encodeURIComponent(id)}`);
}

export function decide(
  id: string,
  body: { action: 'approve'; note?: string; version: number } | { action: 'reject'; reason: string; version: number },
): Promise<{ case: CaseView }> {
  return call('POST', `/review/cases/${encodeURIComponent(id)}`, body);
}
