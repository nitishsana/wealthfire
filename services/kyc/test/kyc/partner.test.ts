import { describe, expect, it } from 'vitest';
import { FAKE_LOW_FACE_SCORE, FakePartner } from '../../src/partner/fake';
import { isPartnerTimeout, PartnerTimeoutError } from '../../src/partner/types';

describe('FakePartner', () => {
  it('picks the scenario from the PAN digits', () => {
    const p = new FakePartner();
    expect(p.scenarioForPan('ABCPE0001F')).toBe('kra-validated');
    expect(p.scenarioForPan('abcpe0003f')).toBe('unclear');
    expect(p.scenarioForPan('ABCPE0004F')).toBe('reject');
    expect(p.scenarioForPan('ABCPE0005F')).toBe('timeout');
    expect(p.scenarioForPan('ABCPE1234F')).toBe('full-kyc-pass');
  });

  it('lookupKyc: validated with the registered person, else not-found; timeout throws', async () => {
    const p = new FakePartner({ person: { name: 'NITISH SANA', dob: '1990-01-02' } });
    expect(await p.lookupKyc('ABCPE0001F')).toMatchObject({ status: 'validated', name: 'NITISH SANA', dob: '1990-01-02', ref: expect.stringMatching(/^kra-/) });
    p.setPerson('ABCPE0001F', { name: 'X Y', dob: '2000-01-01' });
    expect((await p.lookupKyc('ABCPE0001F')).name).toBe('X Y');
    expect(await p.lookupKyc('ABCPE1234F')).toMatchObject({ status: 'not-found' });
    await expect(p.lookupKyc('ABCPE0005F')).rejects.toBeInstanceOf(PartnerTimeoutError);
    expect(p.calls.lookupKyc).toBe(4);
  });

  it('verifyPan: reject → invalid; unclear → name partial; else all pass', async () => {
    const p = new FakePartner();
    expect(await p.verifyPan('ABCPE0004F', 'A B')).toEqual({ valid: false, nameMatch: false, aadhaarLinked: false });
    expect(await p.verifyPan('ABCPE0003F', 'A B')).toEqual({ valid: true, nameMatch: false, aadhaarLinked: true });
    expect(await p.verifyPan('ABCPE1234F', 'A B')).toEqual({ valid: true, nameMatch: true, aadhaarLinked: true });
  });

  it('faceMatch follows the scenario of the user who owns the Aadhaar ref', async () => {
    const p = new FakePartner();
    const good = await p.startAadhaar('user-a', 'otp', 'wealthfire://x');
    const low = await p.startAadhaar('user-b', 'digilocker', 'https://app.example/r');
    p.setScenario('user-b', 'unclear');
    expect((await p.faceMatch('k', good.challengeRef!)).match).toBeGreaterThan(0.9);
    expect((await p.faceMatch('k', low.challengeRef!)).match).toBe(FAKE_LOW_FACE_SCORE);
    expect(low.redirectUrl).toContain('return=https%3A%2F%2Fapp.example%2Fr');
    expect(p.ownerOf(low.challengeRef!)).toBe('user-b');
  });

  it('overrides, failNext and a user-level timeout', async () => {
    const p = new FakePartner();
    p.setScenario('ABCPE1234F', 'kra-validated');
    expect((await p.lookupKyc('ABCPE1234F')).status).toBe('validated');
    p.failNext('uploadToKra', 2);
    await expect(p.uploadToKra('u')).rejects.toSatisfy(isPartnerTimeout);
    await expect(p.uploadToKra('u')).rejects.toSatisfy(isPartnerTimeout);
    expect((await p.uploadToKra('u')).ref).toMatch(/^kraup-/);
    p.setScenario('u2', 'timeout');
    await expect(p.startEsign('u2', 'wealthfire://x')).rejects.toBeInstanceOf(PartnerTimeoutError);
    expect((await p.startEsign('u3', 'wealthfire://x')).redirectUrl).toMatch(/esign\?ref=esign-/);
  });

  it('verifyWebhook checks an HMAC signature in constant time', () => {
    const p = new FakePartner({ webhookSecret: 's3cret' });
    const body = '{"event":"esign.done"}';
    expect(p.verifyWebhook(p.sign(body), body)).toBe(true);
    expect(p.verifyWebhook({ 'X-Fake-Signature': p.sign(body)['x-fake-signature']! }, body)).toBe(true);
    expect(p.verifyWebhook(p.sign(body), body + ' ')).toBe(false);
    expect(p.verifyWebhook({}, body)).toBe(false);
    expect(p.verifyWebhook({ 'x-fake-signature': 'abc' }, body)).toBe(false);
    expect(new FakePartner({ webhookSecret: 'other' }).verifyWebhook(p.sign(body), body)).toBe(false);
  });
});
