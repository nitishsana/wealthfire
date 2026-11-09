import { describe, expect, it } from 'vitest';
import {
  LOCAL_PERSONAS,
  isLocalApiUrl,
  personaBarText,
  personaPrefill,
  personaStorageKey,
  resolveLocalTestMode,
  testAadhaarFor,
  validateAadhaar,
  validateMobile,
  validatePan,
  STORAGE_KEY,
  ServerKycClient,
} from '../src';

const LOCAL = 'http://127.0.0.1:5181';

describe('local test mode (localkyc build)', () => {
  it('is on only for a loopback API URL', () => {
    expect(isLocalApiUrl(LOCAL)).toBe(true);
    expect(isLocalApiUrl('http://localhost:5181/')).toBe(true);
    expect(isLocalApiUrl('https://api.wealthfire.example')).toBe(false);
    expect(isLocalApiUrl('http://127.0.0.1.evil.test')).toBe(false);
    expect(isLocalApiUrl('')).toBe(false);
    expect(isLocalApiUrl(undefined)).toBe(false);
    expect(isLocalApiUrl('not a url')).toBe(false);
  });

  it('?persona=<id> picks a known test user and keeps it for the tab', () => {
    const m = resolveLocalTestMode({ apiUrl: LOCAL, search: '?persona=fast', storedPersona: null });
    expect(m.persona?.id).toBe('fast');
    expect(m.store).toBe('fast');
    expect(m.serverOff).toBe(false);
  });

  it('a reload without the query keeps the stored persona; a new ?persona= replaces it', () => {
    expect(resolveLocalTestMode({ apiUrl: LOCAL, search: '', storedPersona: 'slow' })).toMatchObject({ persona: { id: 'slow' }, store: undefined });
    expect(resolveLocalTestMode({ apiUrl: LOCAL, search: '?persona=full', storedPersona: 'slow' })).toMatchObject({ persona: { id: 'full' }, store: 'full' });
  });

  it('an unknown id is ignored; an unknown stored id is removed', () => {
    expect(resolveLocalTestMode({ apiUrl: LOCAL, search: '?persona=nobody', storedPersona: null })).toEqual({ persona: null, serverOff: false, store: undefined });
    expect(resolveLocalTestMode({ apiUrl: LOCAL, search: '?persona=nobody', storedPersona: 'fast' }).persona?.id).toBe('fast');
    expect(resolveLocalTestMode({ apiUrl: LOCAL, search: '', storedPersona: 'gone' })).toEqual({ persona: null, serverOff: false, store: null });
  });

  it('?server=off turns the server off, in the localkyc build only', () => {
    expect(resolveLocalTestMode({ apiUrl: LOCAL, search: '?server=off', storedPersona: null }).serverOff).toBe(true);
    expect(resolveLocalTestMode({ apiUrl: LOCAL, search: '?server=on', storedPersona: null }).serverOff).toBe(false);
  });

  it('a non-local build ignores ?persona= and ?server=off and leaves sessionStorage alone', () => {
    for (const apiUrl of ['https://api.wealthfire.example', '', undefined, null]) {
      expect(resolveLocalTestMode({ apiUrl, search: '?persona=fast&server=off', storedPersona: 'fast' })).toEqual({ persona: null, serverOff: false, store: undefined });
    }
  });

  it('storage keys are prefixed per persona, unchanged without one', () => {
    expect(personaStorageKey({ id: 'fast' }, STORAGE_KEY)).toBe(`wf.persona.fast.${STORAGE_KEY}`);
    expect(personaStorageKey({ id: 'full' }, STORAGE_KEY)).not.toBe(personaStorageKey({ id: 'fast' }, STORAGE_KEY));
    expect(personaStorageKey(null, STORAGE_KEY)).toBe(STORAGE_KEY);
  });

  it('bar text names the test user', () => {
    expect(personaBarText({ name: 'Asha Rao' })).toBe('Test user: Asha Rao');
  });

  it('every persona prefills a valid mobile, PAN, ISO date of birth and an Aadhaar ending in its last 4', () => {
    for (const p of LOCAL_PERSONAS) {
      const f = personaPrefill(p);
      expect(validateMobile(f.mobile)).toBeNull();
      expect(validatePan(f.identity.pan)).toBeNull();
      expect(f.identity.dob).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(f.identity).toMatchObject({ firstName: p.firstName, lastName: p.lastName });
      expect(validateAadhaar(f.aadhaar)).toBeNull();
      expect(f.aadhaar.endsWith(p.aadhaarLast4)).toBe(true);
    }
    expect(personaPrefill(LOCAL_PERSONAS.find((p) => p.id === 'fast')!).identity.dob).toBe('1990-08-15');
  });

  it('testAadhaarFor refuses a bad last 4', () => {
    expect(testAadhaarFor('12a4')).toBe('');
    expect(validateAadhaar(testAadhaarFor('2346'))).toBeNull();
  });
});

describe('x-wf-persona header (local KYC server: one refresh cookie per test user)', () => {
  type Seen = { url: string; headers: Record<string, string> };
  function client(baseUrl: string, persona?: string | null) {
    const seen: Seen[] = [];
    const c = new ServerKycClient({
      baseUrl, persona, tokens: { get: async () => 'A1', set: async () => undefined },
      fetch: async (url, init) => {
        seen.push({ url, headers: init.headers });
        const body = url.endsWith('/auth/otp/send') ? { challengeId: 'c'.repeat(22) } : url.endsWith('/auth/refresh') ? { accessToken: 'A2' } : { status: 'pre-verified', next: 'aadhaar' };
        return { status: 200, text: async () => JSON.stringify(body) };
      },
    });
    return { c, seen };
  }

  it('is sent on /auth/* only, with a persona and a loopback server', async () => {
    const { c, seen } = client(LOCAL, 'fast');
    await c.sendOtp('mobile', '9000000001');
    await c.getStatus();
    await c.logout();
    const auth = seen.filter((s) => s.url.includes('/auth/'));
    expect(auth.length).toBeGreaterThanOrEqual(2);
    for (const s of auth) expect(s.headers['x-wf-persona']).toBe('fast');
    for (const s of seen.filter((x) => !x.url.includes('/auth/'))) expect(s.headers['x-wf-persona']).toBeUndefined();
  });

  it('is never sent without a persona, to a non-local server, or for an odd id', async () => {
    for (const [base, persona] of [[LOCAL, null], [LOCAL, undefined], ['https://api.wealthfire.example', 'fast'], [LOCAL, 'Fast; x'], [LOCAL, '']] as const) {
      const { c, seen } = client(base, persona);
      await c.sendOtp('mobile', '9000000001');
      expect(seen[0]!.headers['x-wf-persona']).toBeUndefined();
    }
  });
});
