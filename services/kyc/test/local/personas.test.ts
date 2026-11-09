// Each LOCAL_PERSONAS test user reaches its outcome against the FakePartner (real KYC routes).
import { describe, expect, it } from 'vitest';
import { LOCAL_PERSONAS, localPersona, type LocalPersona } from '@wealthfire/core/src/localPersonas';
import { env, RETURN_URL, type Env } from '../kyc/helpers';

const p = (id: string): LocalPersona => localPersona(id)!;
const startBody = (x: LocalPersona) => ({
  firstName: x.firstName, lastName: x.lastName, dob: x.dob, pan: x.pan, aadhaarLast4: x.aadhaarLast4, deviceResult: 'pre-verified',
});

async function start(e: Env, x: LocalPersona) {
  const token = await e.signIn(x.mobile);
  return { token, userId: await e.userIdOf(token), res: await e.call('POST', '/kyc/start', { token, body: startBody(x) }) };
}

describe('LOCAL_PERSONAS drive the FakePartner to their outcome', () => {
  it('covers every persona', () => {
    expect(LOCAL_PERSONAS.map((x) => x.id)).toEqual(['fast', 'full', 'handcheck', 'panused', 'slow', 'minor']);
  });

  it('fast: KYC record found → Verified at start', async () => {
    const e = env();
    const { res } = await start(e, p('fast'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json).toMatchObject({ status: 'verified', path: 'kra-validated', next: 'none', eligibleToInvest: true });
  });

  it('full: no KYC record → DigiLocker → selfie → e-sign → Verified', async () => {
    const e = env();
    const x = p('full');
    const { token, userId, res } = await start(e, x);
    expect(res.json).toMatchObject({ status: 'pre-verified', path: 'full-kyc', next: 'aadhaar' });
    expect((await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN_URL } })).statusCode).toBe(200);
    await e.svc.recordAadhaar(userId, { verified: true, last4: x.aadhaarLast4 });
    expect((await e.call('GET', '/kyc/status', { token })).json.next).toBe('selfie');
    const f = await e.call('POST', '/kyc/selfie', { token, body: { uploadId: await e.uploadSelfie(token) } });
    expect(f.json.next).toBe('esign');
    expect((await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } })).statusCode).toBe(200);
    expect(await e.svc.recordEsign(userId, 'done')).toMatchObject({ status: 'verified', next: 'none', eligibleToInvest: true });
  });

  it('handcheck: after DigiLocker the case waits for staff (PAN name unclear)', async () => {
    const e = env();
    const x = p('handcheck');
    const { token, userId, res } = await start(e, x);
    expect(res.json.next).toBe('aadhaar');
    await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN_URL } });
    await e.svc.recordAadhaar(userId, { verified: true, last4: x.aadhaarLast4 });
    expect((await e.call('GET', '/kyc/status', { token })).json)
      .toMatchObject({ status: 'under-review', reason: 'check-unclear', next: 'wait', unclear: ['pan-name'] });
  });

  it('panused: after `fast` started KYC, the same PAN goes to staff as pan-in-use', async () => {
    const e = env();
    expect((await start(e, p('fast'))).res.json.status).toBe('verified');
    const { res } = await start(e, p('panused'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json).toMatchObject({ status: 'under-review', reason: 'pan-in-use', next: 'wait' });
  });

  it('slow: the partner times out → partner-timeout (the app shows Try again)', async () => {
    const e = env();
    const { res } = await start(e, p('slow'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json).toMatchObject({ status: 'under-review', reason: 'partner-timeout' });
  });

  it('minor: under 18 → refused with under_age', async () => {
    const e = env();
    const { res } = await start(e, p('minor'));
    expect(res.statusCode).toBe(400);
    expect(res.json.error).toBe('under_age');
  });
});
