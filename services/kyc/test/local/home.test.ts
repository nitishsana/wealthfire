import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_PERSONAS } from '@wealthfire/core/src/localPersonas';
import { MemoryLogger } from '../../src/kyc/log';
import { FakeStaffVerifier } from '../../src/kyc/staff';
import { startLocalServer, type RunningLocalServer } from '../../src/local/app';
import { LocalDemoSender, MAX_RECENT_CODES } from '../../src/local/demo';
import { HOME_TITLE, homePage, isPortOpen } from '../../src/local/home';
import { createRouter } from '../../src/router';
import { setup } from '../auth/helpers';

const root = mkdtempSync(join(tmpdir(), 'wf-kyc-home-'));
let srv: RunningLocalServer;
const APP = 'http://127.0.0.1:5180';

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

describe('Local test home (GET /)', () => {
  it('serves the page with a strict CSP, a persona card + link for each test user, staff and server sections', async () => {
    expect(srv.homeUrl).toBe(`${srv.apiUrl}/`);
    const r = await fetch(srv.homeUrl);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toMatch(/unsafe|script-src/);
    const html = await r.text();
    expect(html).toContain(`<title>${HOME_TITLE}</title>`);
    expect(html).toContain(`<h1>${HOME_TITLE}</h1>`);
    expect(html).not.toMatch(/<script/i);
    for (const h of ['Sign in to the app as a test investor', 'Staff', 'Local server']) expect(html).toContain(`>${h}</h2>`);
    for (const p of LOCAL_PERSONAS) {
      expect(html).toContain(`href="${APP}/?persona=${p.id}&amp;reader=demo&amp;mode=match"`);
      expect(html).toContain(`>Sign in as ${p.name}</a>`);
      expect(html).toContain(p.mobile);
      expect(html).toContain(p.pan);
    }
    expect(html).toContain(`href="${srv.consoleUrl}/">Sign in as demo reviewer</a>`);
    expect(html).toContain('href="/local/reset">Reset local data</a>');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('test cases page opens with the launcher');
  });

  it('status: the API and console are Running, a closed app port is Not running (text, not colour)', async () => {
    const html = await (await fetch(srv.homeUrl)).text();
    const port = (u: string) => new URL(u).port;
    expect(html).toMatch(new RegExp(`127\\.0\\.0\\.1:${port(srv.apiUrl)}</td><td class="status">Running`));
    expect(html).toMatch(new RegExp(`127\\.0\\.0\\.1:${port(srv.consoleUrl)}</td><td class="status">Running`));
    const appUp = await isPortOpen(5180);
    expect(html).toContain(`127.0.0.1:5180</td><td class="status">${appUp ? 'Running' : 'Not running'}`);
  });

  it('lists the latest DEMO codes per masked contact, newest first', async () => {
    const send = (contact: string) => fetch(`${srv.apiUrl}/auth/otp/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'mobile', contact }),
    }).then((r) => r.json() as Promise<{ demoCode: string }>);
    const a = await send('9000000001');
    const b = await send('9000000002');
    const html = await (await fetch(srv.homeUrl)).text();
    const ia = html.indexOf(`******0001</td><td><strong>${a.demoCode}</strong>`);
    const ib = html.indexOf(`******0002</td><td><strong>${b.demoCode}</strong>`);
    expect(ia).toBeGreaterThan(0);
    expect(ib).toBeGreaterThan(0);
    expect(ib).toBeLessThan(ia);
    expect(html).not.toContain('9000000001</td>'); // the card shows the mobile, the code list only the mask
  });

  it('LocalDemoSender.recent keeps one line per contact, newest first, at most 10', async () => {
    let t = 0;
    const s = new LocalDemoSender('local', () => undefined, () => ++t);
    for (let i = 0; i < 12; i++) await s.send('mobile', `90000000${String(i).padStart(2, '0')}`, String(100000 + i));
    await s.send('mobile', '9000000011', '999999');
    const r = s.recent();
    expect(r).toHaveLength(MAX_RECENT_CODES);
    expect(r[0]).toMatchObject({ contact: '******0011', code: '999999' });
    expect(r.filter((x) => x.contact === '******0011')).toHaveLength(1);
    expect(r.map((x) => x.contact)).not.toContain('******0000');
  });

  it('escapes every value', () => {
    const html = homePage({
      appOrigin: APP, consoleOrigin: 'http://127.0.0.1:5182', resetPath: '/local/reset', status: [], codes: [{ contact: '<b>x', code: '"1', at: 0 }],
      personas: [{ ...LOCAL_PERSONAS[0]!, name: '<script>alert(1)</script>', id: 'a"b' }],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('?persona=a%22b&amp;reader=demo&amp;mode=match');
    expect(html).toContain('&lt;b&gt;x');
  });

  it('absent when STAGE is not local: the Lambda-style router has no home page', async () => {
    const a = setup();
    for (const stage of ['dev', 'prod', undefined]) {
      const router = createRouter({
        auth: { otp: a.otp, tokens: a.tokens, clock: a.clock }, tokens: a.tokens, kyc: {}, review: {}, staff: new FakeStaffVerifier(),
        allowedOrigins: [], logger: new MemoryLogger(), clock: a.clock, ...(stage ? { stage } : {}),
      });
      const r = await router({ method: 'GET', path: '/', headers: {}, query: {}, ip: '1' });
      expect(r.statusCode, String(stage)).toBe(404);
      expect(r.body).not.toContain(HOME_TITLE);
    }
  });
});
