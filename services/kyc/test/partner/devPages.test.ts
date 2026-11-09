// R4: dev-only fake DigiLocker / e-sign pages: FakePartner links -> page -> signed webhook.
import { describe, expect, it } from 'vitest';
import { buildRouter, devPartnerSetup } from '../../src/handlers/api';
import { FakeClock } from '../../src/lib/clock';
import { MemoryLogger } from '../../src/kyc/log';
import { devPartnerRoutes, eventFor, linkPayload, linkSignerFrom, linkTag } from '../../src/partner/devPages';
import { FakePartner } from '../../src/partner/fake';
import { createRouter, type DevPartnerRequest, type DevPartnerResponse } from '../../src/router';
import { HmacWebhookVerifier, SIGNATURE_HEADER } from '../../src/webhook/hmac';
import { setup as authSetup } from '../auth/helpers';
import { baseCase, REFS, setup as webhookSetup, USER } from '../webhook/helpers';

const SECRET = 'test-webhook-secret-0123456789'; // same as the webhook test helpers
const API = 'https://abc123.execute-api.ap-south-1.amazonaws.com/dev';
const RETURN = 'https://nitishsana.github.io/wealthfire/kyc-return';

function harness() {
  const clock = new FakeClock();
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  let status = 200;
  const routes = devPartnerRoutes({
    webhookSecret: async () => SECRET,
    webhookUrl: `${API}/webhooks/partner`,
    clock,
    newId: () => `id${sent.length + 1}`,
    send: async (url, init) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return { status };
    },
  });
  const partner = new FakePartner({ baseUrl: `${API}/dev-partner/`, linkSigner: linkSignerFrom(async () => SECRET) });
  const call = (key: string, r: Partial<DevPartnerRequest>): Promise<DevPartnerResponse> =>
    routes[key]!({ method: key.split(' ')[0]!, path: key.split(' ')[1]!, params: {}, query: {}, headers: {}, ip: '1', ...r });
  return { clock, sent, routes, partner, call, setStatus: (s: number) => { status = s; } };
}

const query = (url: string) => Object.fromEntries(new URL(url).searchParams);
const form = (q: Record<string, string>, extra: Record<string, string>) => new URLSearchParams({ ...q, ...extra }).toString();

describe('FakePartner links (R4)', () => {
  it('point to /dev-partner/... on the API, tagged for the user, ref and return URL', async () => {
    const { partner } = harness();
    const a = await partner.startAadhaar('user-1', 'digilocker', RETURN);
    const url = new URL(a.redirectUrl!);
    expect(`${url.origin}${url.pathname}`).toBe(`${API}/dev-partner/digilocker`);
    const q = query(a.redirectUrl!);
    expect(q).toMatchObject({ ref: a.challengeRef, return: RETURN, u: 'user-1' });
    expect(q.t).toBe(linkTag(SECRET, linkPayload('digilocker', a.challengeRef!, 'user-1', RETURN)));
    const e = await partner.startEsign('user-1', 'wealthfire://kyc-return');
    expect(new URL(e.redirectUrl).pathname).toBe('/dev/dev-partner/esign');
    expect(query(e.redirectUrl)).toMatchObject({ ref: e.ref, u: 'user-1', return: 'wealthfire://kyc-return' });
  });

  it('without a link signer (tests, non-dev) the old placeholder links are unchanged', async () => {
    const r = await new FakePartner().startEsign('u', RETURN);
    expect(r.redirectUrl).toMatch(/^https:\/\/fake-partner\.invalid\/esign\?ref=esign-\d+&return=/);
    expect(query(r.redirectUrl).u).toBeUndefined();
  });
});

describe('dev partner pages (R4)', () => {
  it('exposes GET/POST for digilocker and esign only', () => {
    expect(Object.keys(harness().routes).sort()).toEqual([
      'GET /dev-partner/digilocker', 'GET /dev-partner/esign', 'POST /dev-partner/digilocker', 'POST /dev-partner/esign',
    ]);
  });

  it('GET shows an HTML form with the link fields, escaped, with strict headers', async () => {
    const h = harness();
    const a = await h.partner.startAadhaar('user-1', 'digilocker', `${RETURN}?x=<b>`);
    const r = await h.call('GET /dev-partner/digilocker', { query: query(a.redirectUrl!) });
    expect(r.status).toBe(200);
    expect(r.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'content-security-policy': expect.stringContaining("default-src 'none'"),
    });
    const html = r.body as string;
    expect(html).toContain('<form method="post" action="digilocker">');
    expect(html).toContain('name="last4"');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).toContain('dev only');
  });

  it('GET refuses a link without a valid tag (403) or with missing fields (400)', async () => {
    const h = harness();
    const a = await h.partner.startAadhaar('user-1', 'digilocker', RETURN);
    const q = query(a.redirectUrl!);
    expect((await h.call('GET /dev-partner/digilocker', { query: { ...q, u: 'user-2' } })).status).toBe(403);
    expect((await h.call('GET /dev-partner/digilocker', { query: { ...q, return: 'https://evil.example/' } })).status).toBe(403);
    expect((await h.call('GET /dev-partner/esign', { query: q })).status).toBe(403); // tag is per step
    expect((await h.call('GET /dev-partner/digilocker', { query: { ...q, t: undefined as never } })).status).toBe(400);
    expect((await h.call('GET /dev-partner/digilocker', { query: { ...q, return: 'javascript:alert(1)' } })).status).toBe(400);
  });

  it('POST digilocker verified sends a signed kyc.result aadhaar webhook and returns to the app', async () => {
    const h = harness();
    const a = await h.partner.startAadhaar('user-1', 'digilocker', RETURN);
    const r = await h.call('POST /dev-partner/digilocker', { body: form(query(a.redirectUrl!), { outcome: 'verified', last4: '1234' }) });
    expect(r.status).toBe(200);
    expect(r.body as string).toContain(`<a href="${RETURN}">Return to Wealthfire</a>`);
    expect(r.body as string).toContain(`http-equiv="refresh" content="1;url=${RETURN}"`);
    expect(h.sent).toHaveLength(1);
    const s = h.sent[0]!;
    expect(s.url).toBe(`${API}/webhooks/partner`);
    expect(new HmacWebhookVerifier(SECRET).verifyWebhook({ [SIGNATURE_HEADER]: s.headers[SIGNATURE_HEADER]! }, s.body)).toBe(true);
    expect(JSON.parse(s.body)).toEqual({
      id: 'devp_id1', timestamp: h.clock.now(), occurredAt: h.clock.now(), userId: 'user-1', ref: a.challengeRef,
      type: 'kyc.result', data: { check: 'aadhaar', verified: true, last4: '1234' },
    });
  });

  it.each(['done', 'failed', 'expired', 'timeout'])('POST esign %s sends esign.completed', async (outcome) => {
    const h = harness();
    const e = await h.partner.startEsign('user-1', RETURN);
    expect((await h.call('POST /dev-partner/esign', { body: form(query(e.redirectUrl), { outcome }) })).status).toBe(200);
    expect(JSON.parse(h.sent[0]!.body)).toMatchObject({ type: 'esign.completed', ref: e.ref, data: { status: outcome } });
  });

  it('POST refuses bad outcomes, a missing last 4, forged tags; nothing is sent', async () => {
    const h = harness();
    const a = await h.partner.startAadhaar('user-1', 'digilocker', RETURN);
    const q = query(a.redirectUrl!);
    expect((await h.call('POST /dev-partner/digilocker', { body: form(q, { outcome: 'verified' }) })).status).toBe(400);
    expect((await h.call('POST /dev-partner/digilocker', { body: form(q, { outcome: 'verified', last4: '12a4' }) })).status).toBe(400);
    expect((await h.call('POST /dev-partner/digilocker', { body: form(q, { outcome: 'done' }) })).status).toBe(400);
    expect((await h.call('POST /dev-partner/digilocker', { body: form({ ...q, ref: 'aad-999999' }, { outcome: 'timeout' }) })).status).toBe(403);
    expect((await h.call('POST /dev-partner/digilocker', { body: 'x'.repeat(5000) })).status).toBe(400);
    expect(h.sent).toHaveLength(0);
  });

  it('a failed delivery shows an error page (502), not the return link', async () => {
    const h = harness();
    h.setStatus(500);
    const e = await h.partner.startEsign('user-1', RETURN);
    const r = await h.call('POST /dev-partner/esign', { body: form(query(e.redirectUrl), { outcome: 'done' }) });
    expect(r.status).toBe(502);
    expect(r.body as string).not.toContain('Return to Wealthfire');
  });

  it('eventFor maps every outcome', () => {
    const l = { ref: 'r1', userId: 'u1', returnUrl: RETURN, tag: 'x' };
    expect(eventFor('digilocker', 'not-verified', undefined, l, 'i', 1)).toMatchObject({ data: { check: 'aadhaar', verified: false } });
    expect(eventFor('digilocker', 'timeout', undefined, l, 'i', 1)).toMatchObject({ data: { check: 'aadhaar', timeout: true } });
    expect(eventFor('esign', 'verified', '1234', l, 'i', 1)).toBeNull();
  });
});

describe('dev page webhook end to end (R4 + S17)', () => {
  it('the delivered e-sign event is accepted by the webhook for the case that stored the ref', async () => {
    const h = harness();
    const w = webhookSetup({ kycCase: baseCase({ partnerRefs: { ...REFS, esign: 'esign-000001' } }) });
    const e = await h.partner.startEsign(USER, RETURN);
    expect(e.ref).toBe('esign-000001');
    h.clock.set(w.clock.now()); // page and webhook agree on the time
    await h.call('POST /dev-partner/esign', { body: form(query(e.redirectUrl), { outcome: 'done' }) });
    const s = h.sent[0]!;
    const res = await w.send(s.body);
    expect(res.body.outcome).toBe('applied');
    expect((await w.stored()).evidence!.esign).toBe('done');
  });
});

describe('router registration and api wiring', () => {
  const routerFor = (stage: string | undefined) => {
    const a = authSetup();
    return createRouter({
      auth: { otp: a.otp, tokens: a.tokens, clock: a.clock },
      tokens: a.tokens, kyc: {}, review: {}, staff: { verify: async () => null }, allowedOrigins: [], logger: new MemoryLogger(), clock: a.clock,
      ...(stage !== undefined ? { stage } : {}),
      devPartner: harness().routes,
    } as Parameters<typeof createRouter>[0]);
  };

  it('pages answer only on STAGE=dev, as text/html', async () => {
    const req = { method: 'GET', path: '/dev-partner/esign', headers: {}, query: {}, ip: '1' };
    const dev = await routerFor('dev')(req);
    expect(dev.statusCode).toBe(400); // reached the page (incomplete link)
    expect(dev.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(dev.body).toContain('<!doctype html>');
    for (const stage of ['prod', 'Dev', undefined]) expect((await routerFor(stage)(req)).statusCode, String(stage)).toBe(404);
  });

  it('devPartnerSetup: dev + API_BASE_URL (trailing slash ok) + WEBHOOK_SECRET_ARN only', async () => {
    const read = async () => SECRET;
    const env = { STAGE: 'dev', API_BASE_URL: `${API}/`, WEBHOOK_SECRET_ARN: 'arn:aws:secretsmanager:ap-south-1:1:secret:w' };
    const s = devPartnerSetup(env, read)!;
    expect(s.fake.baseUrl).toBe(`${API}/dev-partner`);
    expect(Object.keys(s.routes)).toHaveLength(4);
    expect(devPartnerSetup({ ...env, STAGE: 'prod' }, read)).toBeNull();
    expect(devPartnerSetup({ ...env, API_BASE_URL: undefined }, read)).toBeNull();
    expect(devPartnerSetup({ ...env, WEBHOOK_SECRET_ARN: '' }, read)).toBeNull();
    expect(() => devPartnerSetup({ ...env, API_BASE_URL: 'http://abc.example/dev' }, read)).toThrow(/API_BASE_URL/);
  });

  it('the secret is read once and re-read after a failure', async () => {
    let n = 0;
    const s = devPartnerSetup(
      { STAGE: 'dev', API_BASE_URL: API, WEBHOOK_SECRET_ARN: 'arn' },
      async () => { n++; if (n === 1) throw new Error('down'); return SECRET; },
    )!;
    const p = new FakePartner(s.fake);
    await expect(p.startEsign('u', RETURN)).rejects.toThrow('down');
    await p.startEsign('u', RETURN);
    await p.startEsign('u', RETURN);
    expect(n).toBe(2);
  });

  it('buildRouter needs FIELD_KEY_ID for PAN / contact envelopes (S9), not DATA_KEY_ID', () => {
    const env = { STAGE: 'dev', HMAC_KEY_ID: 'arn:hmac', DATA_KEY_ID: 'arn:data', JWT_KEY_ID: 'arn:jwt' };
    expect(() => buildRouter(env)).toThrow(/Missing env FIELD_KEY_ID/);
  });
});
