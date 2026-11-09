// S8: the review console sends `Authorization: Bearer <idToken>`, the format the Lambda staff
// verifier (and the gateway authorizer) accept. The console's own modules are DOM code with a
// build-time config, so they are loaded by path at run time (not type-checked here) with the
// sign-in module mocked.
import { afterEach, describe, expect, it, vi } from 'vitest';

const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzMSJ9.c2lnbmF0dXJl';

vi.mock('../../review-console/src/auth', () => ({
  current: () => ({ idToken: ID_TOKEN, sub: 's1', email: 'r@example.com', groups: ['reviewer'], expiresAt: Date.now() + 3_600_000 }),
  forget: () => undefined,
}));

const API_PATH = '../../review-console/src/api';

interface ConsoleApi {
  authorizationHeader(idToken: string): string;
  listCases(cursor?: string): Promise<unknown>;
  getCase(id: string): Promise<{ documentsAvailable?: boolean }>;
  decide(id: string, body: Record<string, unknown>): Promise<unknown>;
  ApiError: new (...a: never[]) => Error & { status: number; code?: string };
}

async function loadApi(): Promise<ConsoleApi> {
  vi.stubGlobal('__CONFIG__', {
    apiUrl: 'https://api.example/dev/', cognitoDomain: 'https://auth.example', clientId: 'c', redirectUri: 'https://c.example/', logoutUri: 'https://c.example/',
  });
  return (await import(/* @vite-ignore */ API_PATH)) as ConsoleApi;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('review console API client (S8)', () => {
  it('authorizationHeader is Bearer + the ID token', async () => {
    const api = await loadApi();
    expect(api.authorizationHeader(ID_TOKEN)).toBe(`Bearer ${ID_TOKEN}`);
  });

  it('every /review call sends Authorization: Bearer <idToken> and no cookies', async () => {
    const api = await loadApi();
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ items: [], case: {}, documents: [], documentsAvailable: false, history: [] }), { status: 200 });
    });
    await api.listCases();
    const d = await api.getCase('abc');
    await api.decide('abc', { action: 'approve', version: 1 });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.example/dev/review/cases?limit=20',
      'https://api.example/dev/review/cases/abc',
      'https://api.example/dev/review/cases/abc',
    ]);
    for (const c of calls) {
      expect((c.init.headers as Record<string, string>).authorization).toBe(`Bearer ${ID_TOKEN}`);
      expect(c.init.credentials).toBe('omit');
    }
    expect(d.documentsAvailable).toBe(false);
  });

  it('a documents_missing 409 keeps its code and message', async () => {
    const api = await loadApi();
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ error: 'documents_missing', message: 'Approve needs the selfie, Aadhaar and PAN documents. Missing: PAN.' }),
      { status: 409 },
    ));
    const err = await api.decide('abc', { action: 'approve', version: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err).toMatchObject({ status: 409, code: 'documents_missing', message: expect.stringContaining('Missing: PAN') });
  });
});
