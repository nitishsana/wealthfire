// Boots the real local server on random loopback ports and walks the whole flow over HTTP.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSENT_PURPOSES } from '../../src/kyc/repo';
import { startLocalServer, type RunningLocalServer } from '../../src/local/app';
import { DEMO_REVIEWER_HEADER } from '../../src/local/demo';
import { LOCAL_FILES_PATH } from '../../src/local/files';

const root = mkdtempSync(join(tmpdir(), 'wf-kyc-e2e-'));
const dataDir = join(root, '.local-data');
const dist = join(root, 'dist');
const APP = 'http://127.0.0.1:5180';
const RETURN = `${APP}/kyc/return`;
const lines: string[] = [];
let srv: RunningLocalServer;

const silent = { info: () => undefined, error: () => undefined };
const boot = () => startLocalServer({
  stage: 'local', apiPort: 0, consolePort: 0, dataDir, consoleDist: dist, appOrigin: APP, print: (l) => lines.push(l), logger: silent,
});

beforeAll(async () => {
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>console</title>');
  writeFileSync(join(dist, 'app.js'), 'console.log(1)');
  srv = await boot();
});
afterAll(async () => {
  await srv?.close();
  rmSync(root, { recursive: true, force: true });
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(500, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500, 7)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(500, 7)]);

async function api(method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: APP, ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST' && /^\/kyc\/(start|aadhaar|selfie|esign|retry)$/.test(path)) headers['idempotency-key'] = `idem-${Math.random().toString(36).slice(2)}`;
  const r = await fetch(`${srv.apiUrl}${path}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, json: text.startsWith('{') ? JSON.parse(text) : {}, text };
}

/** OTP send (demoCode) → verify; returns the access token. */
async function signIn(contact: string): Promise<string> {
  const sent = await api('POST', '/auth/otp/send', { body: { kind: 'mobile', contact } });
  expect(sent.status, sent.text).toBe(200);
  expect(sent.json.demoCode).toMatch(/^\d{6}$/);
  expect(lines).toContain(`DEMO code for ******${contact.replace(/\D/g, '').slice(-4)}: ${sent.json.demoCode}`);
  const v = await api('POST', '/auth/otp/verify', { body: { challengeId: sent.json.challengeId, code: sent.json.demoCode } });
  expect(v.status, v.text).toBe(200);
  for (const purpose of CONSENT_PURPOSES) expect((await api('POST', '/kyc/consent', { token: v.json.accessToken, body: { purpose } })).status).toBe(200);
  return v.json.accessToken as string;
}

/** Opens a fake partner link and submits the form like a tester would. */
async function partnerPage(redirectUrl: string, fields: Record<string, string>): Promise<string> {
  const u = new URL(redirectUrl);
  expect(u.origin).toBe(srv.apiUrl);
  const show = await fetch(u);
  expect(show.status).toBe(200);
  expect(await show.text()).toContain('<form method="post"');
  const form = new URLSearchParams({
    ref: u.searchParams.get('ref')!, u: u.searchParams.get('u')!, return: u.searchParams.get('return')!, t: u.searchParams.get('t')!, ...fields,
  });
  const r = await fetch(`${srv.apiUrl}${u.pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: srv.apiUrl }, body: form.toString(),
  });
  const html = await r.text();
  expect(r.status, html).toBe(200);
  expect(html).toContain('Result sent');
  return html;
}

/** POST /kyc/documents for these files, then PUT each to its signed local URL. */
async function upload(token: string, files: { kind: string; type: string; bytes: Buffer }[]) {
  const r = await api('POST', '/kyc/documents', { token, body: { files: files.map((f) => ({ kind: f.kind, contentType: f.type, size: f.bytes.length })) } });
  expect(r.status, r.text).toBe(200);
  const out: { kind: string; uploadId: string; url: string; headers: Record<string, string> }[] = r.json.uploads;
  for (const [i, up] of out.entries()) {
    expect(up.url.startsWith(`${srv.apiUrl}${LOCAL_FILES_PATH}`)).toBe(true);
    // browsers set content-length themselves; everything else is sent as given
    const { 'content-length': len, ...rest } = up.headers;
    expect(len).toBe(String(files[i]!.bytes.length));
    const put = await fetch(up.url, { method: 'PUT', headers: { ...rest, origin: APP }, body: files[i]!.bytes });
    expect(put.status, await put.clone().text()).toBe(200);
    expect(put.headers.get('access-control-allow-origin')).toBe(APP);
    // no overwrite through the same URL
    expect((await fetch(up.url, { method: 'PUT', headers: rest, body: files[i]!.bytes })).status).toBe(412);
  }
  return out;
}

describe('local server end to end', () => {
  it('prints-ready URLs; console serves dist + config.json; CORS preflights for the app and the console', async () => {
    expect(srv.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(srv.resetUrl).toBe(`${srv.apiUrl}/local/reset`);
    const cfg = await fetch(`${srv.consoleUrl}/config.json`);
    expect(await cfg.json()).toEqual({ apiUrl: srv.apiUrl, localDemo: true });
    const idx = await fetch(`${srv.consoleUrl}/`);
    expect(idx.headers.get('content-type')).toMatch(/text\/html/);
    expect(idx.headers.get('content-security-policy')).toBeNull(); // the built page carries its own CSP
    expect((await fetch(`${srv.consoleUrl}/app.js`)).status).toBe(200);
    expect((await fetch(`${srv.consoleUrl}/..%2Fpackage.json`)).status).toBe(404);
    // a dist/config.json written by `build.mjs --local` is served as-is
    writeFileSync(join(dist, 'config.json'), JSON.stringify({ apiUrl: 'http://127.0.0.1:5181', localDemo: true, extra: 1 }));
    expect(await (await fetch(`${srv.consoleUrl}/config.json`)).json()).toEqual({ apiUrl: 'http://127.0.0.1:5181', localDemo: true, extra: 1 });
    rmSync(join(dist, 'config.json'));

    const consoleOrigin = srv.consoleUrl;
    const pre = await fetch(`${srv.apiUrl}/review/cases`, {
      method: 'OPTIONS', headers: { origin: consoleOrigin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(consoleOrigin);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/authorization/);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/content-type/);
    const filePre = await fetch(`${srv.apiUrl}${LOCAL_FILES_PATH}kyc/u/selfie-1.jpg`, { method: 'OPTIONS', headers: { origin: APP } });
    expect(filePre.status).toBe(204);
    expect(filePre.headers.get('access-control-allow-headers')).toBe('content-type, x-amz-tagging, if-none-match');
    const evil = await fetch(`${srv.apiUrl}/kyc/status`, { headers: { origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('OTP → consent → start → DigiLocker page → selfie + documents → e-sign page → verified', async () => {
    const token = await signIn('+91 98765 43210');
    const s = await api('POST', '/kyc/start', {
      token, body: { firstName: 'Asha', lastName: 'Rao', dob: '15/08/1990', pan: 'ABCPR0002K', aadhaarLast4: '1234', deviceResult: 'pre-verified' },
    });
    expect(s.status, s.text).toBe(200);
    expect(s.json.next).toBe('aadhaar');
    const a = await api('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN } });
    expect(a.status, a.text).toBe(200);
    expect(a.json.redirectUrl.startsWith(`${srv.apiUrl}/dev-partner/digilocker?`)).toBe(true);
    const done = await partnerPage(a.json.redirectUrl, { outcome: 'verified', last4: '1234' });
    expect(done).toContain(RETURN);
    const afterAadhaar = await api('GET', '/kyc/status', { token });
    expect(afterAadhaar.json, afterAadhaar.text).toMatchObject({ status: 'pre-verified', next: 'selfie', checks: { aadhaar: 'pass' } });

    const ups = await upload(token, [
      { kind: 'selfie', type: 'image/jpeg', bytes: JPEG }, { kind: 'aadhaar', type: 'application/pdf', bytes: PDF }, { kind: 'pan', type: 'image/png', bytes: PNG },
    ]);
    const selfie = ups.find((u) => u.kind === 'selfie')!;
    const f = await api('POST', '/kyc/selfie', { token, body: { uploadId: selfie.uploadId } });
    expect(f.status, f.text).toBe(200);
    expect(f.json.next).toBe('esign');
    const userId = selfie.url.split('/')[5]!;
    expect(srv.app.files.stateOf(`kyc/${userId}/${selfie.uploadId}`)).toBe('linked');

    const es = await api('POST', '/kyc/esign', { token, body: { returnUrl: RETURN } });
    expect(es.status, es.text).toBe(200);
    await partnerPage(es.json.redirectUrl, { outcome: 'done' });
    const st = await api('GET', '/kyc/status', { token });
    expect(st.json).toMatchObject({ status: 'verified', path: 'full-kyc', next: 'none', eligibleToInvest: true });
    expect(st.text).not.toContain('ABCPR0002K');

    // a forged dev-page result is refused
    const u = new URL(es.json.redirectUrl);
    const forged = await fetch(`${srv.apiUrl}/dev-partner/esign`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ref: u.searchParams.get('ref')!, u: 'someone-else', return: RETURN, t: u.searchParams.get('t')!, outcome: 'done' }).toString(),
    });
    expect(forged.status).toBe(403);
  });

  it('hand-check case: approved through the review route with the demo reviewer token', async () => {
    const token = await signIn('+91 98765 40001');
    const s = await api('POST', '/kyc/start', {
      token, body: { firstName: 'Asha', lastName: 'Rao', dob: '15/08/1990', pan: 'ABCPR0003K', aadhaarLast4: '1234', deviceResult: 'pre-verified' },
    });
    expect(s.status, s.text).toBe(200);
    const a = await api('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN } });
    await partnerPage(a.json.redirectUrl, { outcome: 'verified', last4: '1234' });
    const st = await api('GET', '/kyc/status', { token });
    expect(st.json).toMatchObject({ status: 'under-review', next: 'wait' });
    await upload(token, [
      { kind: 'selfie', type: 'image/jpeg', bytes: JPEG }, { kind: 'aadhaar', type: 'application/pdf', bytes: PDF }, { kind: 'pan', type: 'image/png', bytes: PNG },
    ]);

    const reviewer = { authorization: DEMO_REVIEWER_HEADER, origin: srv.consoleUrl };
    expect((await api('GET', '/review/cases', { headers: { origin: srv.consoleUrl } })).status).toBe(401);
    expect((await api('GET', '/review/cases', { headers: { ...reviewer, authorization: 'Bearer local-demo-reviewerX' } })).status).toBe(401);
    expect((await api('GET', '/review/cases', { token, headers: { origin: srv.consoleUrl } })).status).toBe(401);
    const list = await api('GET', '/review/cases', { headers: reviewer });
    expect(list.status, list.text).toBe(200);
    expect(list.headers.get('access-control-allow-origin')).toBe(srv.consoleUrl);
    const id = list.json.items[0].id as string;
    const one = await api('GET', `/review/cases/${id}`, { headers: reviewer });
    expect(one.status, one.text).toBe(200);
    const docs = JSON.stringify(one.json);
    const link = /"url":"([^"]+)"/.exec(docs)![1]!;
    expect(link.startsWith(`${srv.apiUrl}${LOCAL_FILES_PATH}`)).toBe(true);
    const got = await fetch(link);
    expect(got.status).toBe(200);
    expect((await got.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const ok = await api('POST', `/review/cases/${id}`, { headers: reviewer, body: { action: 'approve', note: 'name ok' } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.case).toMatchObject({ status: 'verified', reason: 'staff-approved' });
    const audit = await api('GET', `/review/cases/${id}`, { headers: reviewer });
    expect(audit.text).toContain('staff:demo-reviewer');
  });

  it('data survives a restart (state.json, keys kept); Reset wipes it', async () => {
    const token = await signIn('+91 98765 40002');
    expect((await api('GET', '/kyc/status', { token })).status).toBe(200);
    expect(existsSync(join(dataDir, 'state.json'))).toBe(true);
    await srv.close();
    srv = await boot();
    // the same access token (signed with the kept key, session in state.json) still works
    expect((await api('GET', '/kyc/status', { token })).status).toBe(200);

    const page = await fetch(srv.resetUrl);
    expect(await page.text()).toContain('Reset local data');
    const cross = await fetch(srv.resetUrl, { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    expect((await api('GET', '/kyc/status', { token })).status).toBe(200);
    const r = await fetch(srv.resetUrl, { method: 'POST', headers: { origin: srv.apiUrl } });
    expect(await r.text()).toContain('Local data cleared.');
    expect((await api('GET', '/kyc/status', { token })).status).toBe(401);
    expect(srv.app.files.keys()).toEqual([]);
    expect(existsSync(join(dataDir, 'keys.json'))).toBe(true);
  });
});
