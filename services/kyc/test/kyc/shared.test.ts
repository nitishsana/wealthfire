// The three layers (KYC routes, partner webhook, staff review) on ONE store and ONE audit log.
import { describe, expect, it } from 'vitest';
import { handleWebhook, type WebhookDeps } from '../../src/webhook/handler';
import { HmacWebhookVerifier, signBody } from '../../src/webhook/hmac';
import { MemorySeenEventStore } from '../../src/webhook/memory';
import { AADHAAR_LAST4, env, PANS, RETURN_URL, startBody, type Env } from './helpers';

const SECRET = 'shared-test-webhook-secret-0123';
const REVIEWER = { authorization: 'Bearer staff-token-reviewer-0001' };

function webhook(e: Env) {
  const deps: WebhookDeps = {
    verifier: new HmacWebhookVerifier(SECRET),
    cases: e.webhookCases,
    audit: e.repos.audit,
    seen: new MemorySeenEventStore(),
    config: e.config,
    clock: e.clock,
  };
  let n = 0;
  return async (userId: string, type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const body = JSON.stringify({ id: `evt_${++n}`, type, timestamp: e.clock.now(), userId, data, ...extra });
    return handleWebhook({ body, headers: { 'x-webhook-signature': signBody(SECRET, body) } }, deps);
  };
}

describe('one store for KYC routes, webhook and review', () => {
  it('full KYC driven by webhooks: verified by the e-sign webhook, then the KRA upload runs', async () => {
    const e = env();
    const send = webhook(e);
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN_URL } });
    const ref = (await e.repos.cases.get(userId))!.partnerRefs.aadhaar;

    expect((await send(userId, 'kyc.result', { check: 'aadhaar', verified: true, last4: AADHAAR_LAST4 }, { ref })).body)
      .toEqual({ ok: true, outcome: 'applied' });
    // the webhook stored next = pan-check; the next status read runs it
    expect((await e.repos.cases.get(userId))!.next).toBe('pan-check');
    const st = await e.call('GET', '/kyc/status', { token });
    expect(st.json).toMatchObject({ status: 'pre-verified', next: 'selfie', checks: { aadhaar: 'pass', pan: 'pass' } });

    await e.call('POST', '/kyc/selfie', { token, body: { uploadId: await e.uploadSelfie(token) } });
    await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } });
    expect((await send(userId, 'esign.completed', { status: 'done' })).body.outcome).toBe('applied');
    const rec = (await e.repos.cases.get(userId))!;
    expect(rec).toMatchObject({ status: 'verified', path: 'full-kyc', next: 'kra-upload' });
    expect(rec.panEnc).toMatch(/./); // the webhook kept the attributes it does not own

    const done = await e.call('GET', '/kyc/status', { token });
    expect(done.json).toMatchObject({ status: 'verified', next: 'none', eligibleToInvest: true });
    expect(e.partner.calls.uploadToKra).toBe(1);

    // one audit trail, in write order, from all writers
    const actions = e.repos.audit.all().filter((r) => r.userId === userId).map((r) => r.action);
    expect(actions).toEqual([
      'kyc.start', 'kyc.aadhaar-start', 'webhook.kyc-result', 'kyc.pan-check', 'kyc.selfie', 'kyc.esign-start',
      'webhook.esign', 'kyc.kra-upload',
    ]);
    // versions line up across writers: every write +1
    expect((await e.repos.cases.get(userId))!.version).toBe(actions.length);
  });

  it('a webhook result that makes the case unclear shows in the staff queue; the case detail shows the whole trail', async () => {
    const e = env();
    const send = webhook(e);
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN_URL } });
    await send(userId, 'kyc.result', { check: 'aadhaar', verified: false });
    expect((await e.call('GET', '/kyc/status', { token })).json).toMatchObject({ status: 'under-review', reason: 'check-unclear', next: 'wait' });

    const list = await e.call('GET', '/review/cases', { headers: REVIEWER });
    expect(list.json.items.map((c: { id: string }) => c.id)).toEqual([userId]);
    const detail = await e.call('GET', `/review/cases/${userId}`, { headers: REVIEWER });
    expect(detail.statusCode).toBe(200);
    const historyActions = detail.json.history.map((h: { action: string }) => h.action).sort();
    expect(historyActions).toEqual(['kyc.aadhaar-start', 'kyc.start', 'review.view', 'webhook.kyc-result'].sort());

    // staff approve wins; a late webhook for a terminal case is ignored and audited
    expect((await e.call('POST', `/review/cases/${userId}`, { headers: REVIEWER, body: { action: 'approve' } })).statusCode).toBe(200);
    expect((await send(userId, 'kyc.result', { check: 'pan', valid: false, nameMatch: false, aadhaarLinked: false })).body.outcome)
      .toBe('ignored-terminal');
    expect((await e.repos.cases.get(userId))!.status).toBe('verified');
  });
});
