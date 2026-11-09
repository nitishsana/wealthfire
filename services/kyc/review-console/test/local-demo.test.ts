// Local test mode (`localDemo: true`): "Sign in as demo reviewer" makes a session whose token is
// `local-demo-reviewer`, every /review call sends `Authorization: Bearer local-demo-reviewer`, sign
// out stays on the page, and demo mode only runs on a loopback page with a loopback API. Online
// builds never fetch config.json. Like test/review/console.test.ts, the console modules are DOM
// code with a build-time config, so they are loaded by path at run time with globals stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CONFIG_PATH = '../src/config';
const AUTH_PATH = '../src/auth';
const API_PATH = '../src/api';

interface Cfg {
  apiUrl: string; cognitoDomain: string; clientId: string; redirectUri: string; logoutUri: string; localDemo?: boolean;
}
interface ConfigMod {
  config: Cfg;
  isLocalDemo(): boolean;
  localDemoAllowed(c: Cfg, host: string): boolean;
  mergeRuntimeConfig(baked: Cfg, raw: unknown): { config: Cfg } | { error: string };
  loadRuntimeConfig(): Promise<string | null>;
}
interface AuthMod {
  LOCAL_DEMO_TOKEN: string;
  signInDemo(): { idToken: string; sub: string; groups: string[] };
  signOut(): boolean;
  current(): { idToken: string } | null;
  completeSignIn(): Promise<unknown>;
}
interface ApiMod {
  listCases(): Promise<unknown>;
  getCase(id: string): Promise<unknown>;
  decide(id: string, body: Record<string, unknown>): Promise<unknown>;
}

const LOCAL: Cfg = { apiUrl: 'http://127.0.0.1:5181', cognitoDomain: '', clientId: '', redirectUri: '', logoutUri: '', localDemo: true };
const ONLINE: Cfg = {
  apiUrl: 'https://api.example/dev/', cognitoDomain: 'https://auth.example', clientId: 'c', redirectUri: 'https://c.example/', logoutUri: 'https://c.example/',
};

function stubPage(hostname: string, baked: Cfg) {
  const assign = vi.fn();
  vi.stubGlobal('__CONFIG__', baked);
  vi.stubGlobal('location', { hostname, search: '', pathname: '/', hash: '', assign });
  return { assign };
}

async function load<T>(path: string): Promise<T> {
  return (await import(/* @vite-ignore */ path)) as T;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('review console local test mode', () => {
  it('demo mode only on a loopback page with a loopback API and localDemo true', async () => {
    stubPage('127.0.0.1', LOCAL);
    const c = await load<ConfigMod>(CONFIG_PATH);
    expect(c.isLocalDemo()).toBe(true);
    expect(c.localDemoAllowed(LOCAL, 'localhost')).toBe(true);
    expect(c.localDemoAllowed(LOCAL, 'review.wealthfire.example')).toBe(false);
    expect(c.localDemoAllowed({ ...LOCAL, apiUrl: 'https://api.example/' }, '127.0.0.1')).toBe(false);
    expect(c.localDemoAllowed({ ...LOCAL, localDemo: false }, '127.0.0.1')).toBe(false);
    expect(c.localDemoAllowed(ONLINE, '127.0.0.1')).toBe(false);
  });

  it('demo sign-in sends Authorization: Bearer local-demo-reviewer on every /review call', async () => {
    stubPage('127.0.0.1', LOCAL);
    const auth = await load<AuthMod>(AUTH_PATH);
    const api = await load<ApiMod>(API_PATH);
    const s = auth.signInDemo();
    expect(auth.LOCAL_DEMO_TOKEN).toBe('local-demo-reviewer');
    expect(s).toMatchObject({ idToken: 'local-demo-reviewer', sub: 'demo-reviewer', groups: ['reviewer'] });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ items: [], case: {}, documents: [], history: [] }), { status: 200 });
    });
    await api.listCases();
    await api.getCase('abc');
    await api.decide('abc', { action: 'approve', version: 1 });
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:5181/review/cases?limit=20',
      'http://127.0.0.1:5181/review/cases/abc',
      'http://127.0.0.1:5181/review/cases/abc',
    ]);
    for (const c of calls) {
      expect((c.init.headers as Record<string, string>).authorization).toBe('Bearer local-demo-reviewer');
      expect(c.init.credentials).toBe('omit');
    }
  });

  it('sign out in demo mode clears the session without leaving the page', async () => {
    const { assign } = stubPage('127.0.0.1', LOCAL);
    const auth = await load<AuthMod>(AUTH_PATH);
    auth.signInDemo();
    expect(auth.signOut()).toBe(false);
    expect(auth.current()).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    // no Cognito redirect to finish in demo mode
    await expect(auth.completeSignIn()).resolves.toBeNull();
  });

  it('online: no demo sign-in, sign out goes to the Cognito logout page', async () => {
    const { assign } = stubPage('c.example', ONLINE);
    const auth = await load<AuthMod>(AUTH_PATH);
    expect(() => auth.signInDemo()).toThrow();
    expect(auth.signOut()).toBe(true);
    expect(String(assign.mock.calls[0]?.[0])).toMatch(/^https:\/\/auth\.example\/logout\?/);
  });

  it('a local build on a non-loopback page refuses demo sign-in', async () => {
    stubPage('review.wealthfire.example', LOCAL);
    const auth = await load<AuthMod>(AUTH_PATH);
    expect(() => auth.signInDemo()).toThrow();
  });

  it('runtime config.json: only apiUrl on the baked origin and localDemo true', async () => {
    stubPage('127.0.0.1', LOCAL);
    const c = await load<ConfigMod>(CONFIG_PATH);
    expect(c.mergeRuntimeConfig(LOCAL, { apiUrl: 'http://127.0.0.1:5181/', localDemo: true })).toEqual({
      config: { ...LOCAL, apiUrl: 'http://127.0.0.1:5181/' },
    });
    expect(c.mergeRuntimeConfig(LOCAL, { apiUrl: 'http://127.0.0.1:9999' })).toHaveProperty('error');
    expect(c.mergeRuntimeConfig(LOCAL, { apiUrl: 'https://api.example/' })).toHaveProperty('error');
    expect(c.mergeRuntimeConfig(LOCAL, { localDemo: false })).toHaveProperty('error');
    expect(c.mergeRuntimeConfig(LOCAL, { secret: 'x' })).toHaveProperty('error');
    expect(c.mergeRuntimeConfig(LOCAL, [])).toHaveProperty('error');
  });

  it('a local build reads config.json; a missing file keeps the baked config', async () => {
    stubPage('127.0.0.1', LOCAL);
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ apiUrl: 'http://127.0.0.1:5181/x', localDemo: true }), { status: 200 });
    });
    const c = await load<ConfigMod>(CONFIG_PATH);
    await expect(c.loadRuntimeConfig()).resolves.toBeNull();
    expect(urls).toEqual(['config.json']);
    expect(c.config.apiUrl).toBe('http://127.0.0.1:5181/x');

    vi.resetModules();
    vi.stubGlobal('fetch', async () => new Response('not found', { status: 404 }));
    const c2 = await load<ConfigMod>(CONFIG_PATH);
    await expect(c2.loadRuntimeConfig()).resolves.toBeNull();
    expect(c2.config.apiUrl).toBe(LOCAL.apiUrl);

    vi.resetModules();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ apiUrl: 'https://evil.example' }), { status: 200 }));
    const c3 = await load<ConfigMod>(CONFIG_PATH);
    await expect(c3.loadRuntimeConfig()).resolves.toMatch(/apiUrl/);
    expect(c3.config.apiUrl).toBe(LOCAL.apiUrl);
  });

  it('an online build never fetches config.json', async () => {
    stubPage('c.example', ONLINE);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const c = await load<ConfigMod>(CONFIG_PATH);
    await expect(c.loadRuntimeConfig()).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(c.isLocalDemo()).toBe(false);
  });
});
