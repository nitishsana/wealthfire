import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterAll, describe, expect, it } from 'vitest';
import { assertNotLocalStage, buildRouter, createHandler } from '../../src/handlers/api';
import { MemoryLogger } from '../../src/kyc/log';
import { FakeStaffVerifier } from '../../src/kyc/staff';
import { createLocalApp, startLocalServer } from '../../src/local/app';
import { DEMO_REVIEWER_HEADER, LocalDemoSender } from '../../src/local/demo';
import { assertLocalStage, assertLoopbackHost } from '../../src/local/guard';
import { createRouter, type HttpRequest } from '../../src/router';
import { OtpService } from '../../src/auth/otp';
import { Argon2Hasher } from '../../src/lib/crypto';
import { FAST_ARGON2, MOBILE, setup } from '../auth/helpers';

const dataDir = mkdtempSync(join(tmpdir(), 'wf-kyc-guard-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('bind address + stage guards', () => {
  it('the local server binds 127.0.0.1 only', async () => {
    expect(() => assertLoopbackHost('127.0.0.1')).not.toThrow();
    for (const h of ['0.0.0.0', '::', '::1', 'localhost', '192.168.1.5', '127.0.0.2', '']) {
      expect(() => assertLoopbackHost(h), h).toThrow(/127\.0\.0\.1 only/);
      await expect(startLocalServer({ stage: 'local', host: h, apiPort: 0, consolePort: 0, dataDir, consoleDist: dataDir }), h).rejects.toThrow(/127\.0\.0\.1 only/);
    }
  });

  it('the local server runs only with STAGE exactly local', async () => {
    for (const s of ['dev', 'prod', 'Local', ' local', '', undefined]) {
      expect(() => assertLocalStage(s), String(s)).toThrow(/STAGE=local/);
      await expect(startLocalServer({ stage: s, apiPort: 0, consolePort: 0, dataDir, consoleDist: dataDir })).rejects.toThrow(/STAGE=local/);
      expect(() => createLocalApp({
        stage: s, dataDir, consoleDist: dataDir, apiOrigin: 'http://127.0.0.1:5181', consoleOrigin: 'http://127.0.0.1:5182',
      })).toThrow(/STAGE=local/);
    }
  });

  it('the Lambda api handler refuses STAGE=local (before any AWS client is made) and answers 503', async () => {
    for (const s of ['local', 'LOCAL', ' local ']) {
      expect(() => assertNotLocalStage({ STAGE: s })).toThrow(/local server/);
      expect(() => buildRouter({ STAGE: s })).toThrow(/local server/);
    }
    expect(() => assertNotLocalStage({ STAGE: 'dev' })).not.toThrow();
    const h = createHandler(() => buildRouter({ STAGE: 'local' }));
    const event = {
      version: '2.0', rawPath: '/auth/otp/send', headers: {}, isBase64Encoded: false,
      requestContext: { stage: '$default', http: { method: 'POST', sourceIp: '1.2.3.4' } },
    } as unknown as APIGatewayProxyEventV2;
    const r = (await h(event)) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.body).error).toBe('not_configured');
  });
});

describe('router: demoCode only on STAGE=local', () => {
  const routerFor = (stage: string | undefined) => {
    const a = setup();
    const demo = new LocalDemoSender('local', () => undefined);
    // the demo sender is wired as the OTP sender so it holds the code
    const otp = new OtpService({
      repos: a.repos, clock: a.clock, mac: a.mac, encryptor: a.encryptor, hasher: new Argon2Hasher(FAST_ARGON2), sender: demo, tokens: a.tokens,
      metrics: a.metrics,
    });
    const staff = new FakeStaffVerifier();
    const router = createRouter({
      auth: { otp, tokens: a.tokens, clock: a.clock, demo },
      tokens: a.tokens, kyc: {}, review: { 'GET /review/cases': async () => ({ status: 200, body: { items: [] } }) }, staff,
      allowedOrigins: [], logger: new MemoryLogger(), clock: a.clock,
      ...(stage !== undefined ? { stage } : {}),
    });
    return { router, demo, a };
  };
  const send: HttpRequest = {
    method: 'POST', path: '/auth/otp/send', headers: {}, query: {}, ip: '203.0.113.9', body: JSON.stringify({ kind: 'mobile', contact: MOBILE }),
  };

  it('STAGE=local answers demoCode = the code just sent', async () => {
    const { router, demo } = routerFor('local');
    const r = await router(send);
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.demoCode).toMatch(/^\d{6}$/);
    expect(body.demoCode).toBe(demo.codeFor('mobile', '9876543210'));
    expect(Object.keys(body).sort()).toEqual(['challengeId', 'demoCode', 'expiresAt', 'resendAt']);
  });

  it('demoCode is absent on any other stage, even when a demo source is passed in', async () => {
    for (const stage of ['dev', 'prod', 'Local', undefined]) {
      const r = await routerFor(stage).router(send);
      expect(r.statusCode, String(stage)).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.demoCode, String(stage)).toBeUndefined();
      expect(Object.keys(body).sort()).toEqual(['challengeId', 'expiresAt', 'resendAt']);
    }
  });

  it('the demo reviewer token is refused by the normal staff verifier (any stage)', async () => {
    for (const stage of ['dev', 'prod', 'local']) {
      const r = await routerFor(stage).router({ method: 'GET', path: '/review/cases', headers: { authorization: DEMO_REVIEWER_HEADER }, query: {}, ip: '1' });
      expect(r.statusCode, stage).toBe(401);
    }
  });

  it('fake partner pages are served on STAGE=local and dev, never elsewhere', async () => {
    const a = setup();
    const page = async () => ({ status: 200, body: '<p>x</p>', headers: { 'content-type': 'text/html; charset=utf-8' } });
    for (const [stage, want] of [['local', 200], ['dev', 200], ['prod', 404], ['LOCAL', 404], [undefined, 404]] as const) {
      const router = createRouter({
        auth: { otp: a.otp, tokens: a.tokens, clock: a.clock }, tokens: a.tokens, kyc: {}, review: {}, staff: new FakeStaffVerifier(),
        allowedOrigins: [], logger: new MemoryLogger(), clock: a.clock, devPartner: { 'GET /dev-partner/digilocker': page },
        ...(stage !== undefined ? { stage } : {}),
      });
      expect((await router({ method: 'GET', path: '/dev-partner/digilocker', headers: {}, query: {}, ip: '1' })).statusCode, String(stage)).toBe(want);
    }
  });
});
