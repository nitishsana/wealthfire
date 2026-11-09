// Local test users keep separate refresh cookies (`wf_rt_<id>`) via `x-wf-persona`, STAGE=local only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../src/kyc/log';
import { FakeStaffVerifier } from '../../src/kyc/staff';
import { startLocalServer, type RunningLocalServer } from '../../src/local/app';
import { CORS_ALLOW_HEADERS, createRouter, type HttpRequest } from '../../src/router';
import { MOBILE, setup } from '../auth/helpers';

const root = mkdtempSync(join(tmpdir(), 'wf-kyc-persona-'));
const APP = 'http://127.0.0.1:5180';
let srv: RunningLocalServer;

beforeAll(async () => {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html>');
  srv = await startLocalServer({
    stage: 'local', apiPort: 0, consolePort: 0, dataDir: join(root, 'data'), consoleDist: dist, appOrigin: APP,
    print: () => undefined, logger: { info: () => undefined, error: () => undefined },
  });
});
afterAll(async () => {
  await srv?.close();
  rmSync(root, { recursive: true, force: true });
});

/** A one-host cookie jar (name -> value), like a browser on 127.0.0.1. */
class Jar {
  readonly c = new Map<string, string>();
  header(): string {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  take(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const [nv, ...attrs] = sc.split('; ');
      const i = nv!.indexOf('=');
      const name = nv!.slice(0, i);
      expect(attrs).toEqual(expect.arrayContaining(['Path=/', 'HttpOnly', 'Secure', 'SameSite=None', 'Partitioned']));
      if (attrs.includes('Max-Age=0')) this.c.delete(name);
      else this.c.set(name, nv!.slice(i + 1));
    }
  }
}

async function auth(jar: Jar, path: string, body: unknown, persona?: string) {
  const r = await fetch(`${srv.apiUrl}${path}`, {
    method: 'POST',
    headers: {
      origin: APP, 'x-wf-client': 'web', 'content-type': 'application/json', ...(persona ? { 'x-wf-persona': persona } : {}),
      ...(jar.c.size ? { cookie: jar.header() } : {}),
    },
    body: JSON.stringify(body),
  });
  jar.take(r);
  return { status: r.status, json: (await r.json()) as Record<string, any> };
}

async function signIn(jar: Jar, mobile: string, persona?: string): Promise<string> {
  const sent = await auth(jar, '/auth/otp/send', { kind: 'mobile', contact: mobile }, persona);
  const v = await auth(jar, '/auth/otp/verify', { challengeId: sent.json.challengeId, code: sent.json.demoCode }, persona);
  expect(v.status).toBe(200);
  expect(v.json.refreshToken).toBeUndefined();
  return v.json.userId as string;
}

describe('local persona refresh cookies', () => {
  it('two test users in one cookie jar stay separate (set, read and clear)', async () => {
    const jar = new Jar();
    const fast = await signIn(jar, '9000000001', 'fast');
    const full = await signIn(jar, '9000000002', 'full');
    expect([...jar.c.keys()].sort()).toEqual(['wf_rt_fast', 'wf_rt_full']);
    expect(fast).not.toBe(full);
    // a reload in each tab refreshes its own user
    expect((await auth(jar, '/auth/refresh', {}, 'fast')).json.userId).toBe(fast);
    expect((await auth(jar, '/auth/refresh', {}, 'full')).json.userId).toBe(full);
    // no / unknown persona -> plain wf_rt, which neither user has
    expect((await auth(jar, '/auth/refresh', {})).status).toBe(401);
    expect((await auth(jar, '/auth/refresh', {}, 'nobody')).status).toBe(401);
    expect([...jar.c.keys()].sort()).toEqual(['wf_rt_fast', 'wf_rt_full']);
    // logging one out clears only its cookie
    await auth(jar, '/auth/logout', {}, 'fast');
    expect([...jar.c.keys()]).toEqual(['wf_rt_full']);
    expect((await auth(jar, '/auth/refresh', {}, 'full')).json.userId).toBe(full);
  });

  it('no header -> the normal wf_rt cookie', async () => {
    const jar = new Jar();
    await signIn(jar, '9000000003');
    expect([...jar.c.keys()]).toEqual(['wf_rt']);
  });

  it('CORS preflight allows x-wf-persona on the local server only', async () => {
    const r = await fetch(`${srv.apiUrl}/auth/refresh`, { method: 'OPTIONS', headers: { origin: APP } });
    expect(r.headers.get('access-control-allow-headers')).toBe(`${CORS_ALLOW_HEADERS}, x-wf-persona`);
    expect(CORS_ALLOW_HEADERS).not.toContain('x-wf-persona');
  });

  it('the header is ignored when STAGE is not local (even if persona ids are passed in)', async () => {
    for (const stage of ['dev', 'prod', 'Local', undefined]) {
      const a = setup();
      const router = createRouter({
        auth: { otp: a.otp, tokens: a.tokens, clock: a.clock, personaIds: ['fast'] }, tokens: a.tokens, kyc: {}, review: {},
        staff: new FakeStaffVerifier(), allowedOrigins: [APP], appOrigins: [APP], logger: new MemoryLogger(), clock: a.clock,
        ...(stage ? { stage } : {}),
      });
      const req = (path: string, body: unknown): HttpRequest => ({
        method: 'POST', path, ip: '203.0.113.4', query: {}, body: JSON.stringify(body),
        headers: { origin: APP, 'x-wf-client': 'web', 'x-wf-persona': 'fast' },
      });
      const sent = JSON.parse((await router(req('/auth/otp/send', { kind: 'mobile', contact: MOBILE }))).body);
      const v = await router(req('/auth/otp/verify', { challengeId: sent.challengeId, code: a.sender.lastCode }));
      expect(v.statusCode, String(stage)).toBe(200);
      expect(v.cookies[0], String(stage)).toMatch(/^wf_rt=/);
    }
  });
});
