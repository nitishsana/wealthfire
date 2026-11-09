import { describe, expect, it } from 'vitest';
import { REPLAY_WINDOW_MS } from '../../src/webhook/handler';
import { baseCase, baseEvidence, setup, USER } from './helpers';

const kraOk = { check: 'kra', status: 'validated', name: 'NITISH SANA', dob: '1990-08-15' };

describe('webhook: signature and envelope', () => {
  it('401 on a bad signature, and nothing changes', async () => {
    const t = setup();
    const res = await t.send(t.event('kyc.result', kraOk), 'wrong-secret-wrong-secret');
    expect(res).toEqual({ status: 401, body: { error: 'bad_signature' } });
    expect((await t.stored()).kycCase.version).toBe(1);
    expect(t.audit.entries).toHaveLength(0);
  });

  it('401 with no signature header', async () => {
    const t = setup();
    expect((await t.send(t.event('kyc.result', kraOk), null)).status).toBe(401);
  });

  it('401 when the verifier throws', async () => {
    const t = setup();
    t.deps.verifier = { verifyWebhook: () => { throw new Error('boom'); } };
    expect((await t.send(t.event('kyc.result', kraOk))).status).toBe(401);
  });

  it('400 on signed but malformed bodies', async () => {
    const t = setup();
    for (const bad of [
      'not json',
      '[]',
      { ...t.event('kyc.result', kraOk), id: undefined },
      { ...t.event('kyc.result', kraOk), id: 'has space' },
      { ...t.event('kyc.result', kraOk), type: 'other' },
      { ...t.event('kyc.result', kraOk), timestamp: 'yesterday' },
      { ...t.event('kyc.result', kraOk), userId: '' },
      t.event('kyc.result', { check: 'kra', status: 'maybe' }),
      t.event('kyc.result', { check: 'aadhaar', verified: true, last4: '12' }),
      t.event('kyc.result', { check: 'face', match: 2, live: true }),
      t.event('kyc.result', { check: 'pan', valid: true }),
      t.event('kyc.result', { check: 'kra', timeout: 'yes' }),
      t.event('esign.completed', { status: 'maybe' }),
      t.event('kra.upload', { status: 'done' }),
      { ...t.event('kra.upload', { status: 'pending' }), data: 'x' },
    ]) {
      expect((await t.send(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await t.stored()).kycCase.version).toBe(1);
  });

  it('400 on an empty or oversized body', async () => {
    const t = setup();
    expect((await t.send('')).status).toBe(400);
    expect((await t.send('x'.repeat(64 * 1024 + 1))).status).toBe(400);
  });
});

describe('webhook: replay and duplicates', () => {
  it('401 stale_event outside the 5-minute window (past and future)', async () => {
    const t = setup();
    const old = { ...t.event('kyc.result', kraOk), timestamp: t.clock.now() - REPLAY_WINDOW_MS - 1 };
    expect(await t.send(old)).toEqual({ status: 401, body: { error: 'stale_event' } });
    const future = { ...t.event('kyc.result', kraOk), timestamp: t.clock.now() + REPLAY_WINDOW_MS + 1 };
    expect((await t.send(future)).status).toBe(401);
    const edge = { ...t.event('kyc.result', kraOk), timestamp: new Date(t.clock.now() - REPLAY_WINDOW_MS).toISOString() };
    expect((await t.send(edge)).status).toBe(200);
  });

  it('replayed delivery after the window is refused even with a valid signature', async () => {
    const t = setup();
    const e = t.event('kyc.result', kraOk);
    expect((await t.send(e)).status).toBe(200);
    t.clock.advance(REPLAY_WINDOW_MS + 1000);
    expect((await t.send(e)).status).toBe(401);
  });

  it('200 duplicate for a signed event id already processed; case written once', async () => {
    const t = setup();
    const e = t.event('kyc.result', kraOk);
    expect((await t.send(e)).body).toEqual({ ok: true, outcome: 'applied' });
    expect(await t.send(e)).toEqual({ status: 200, body: { ok: true, outcome: 'duplicate' } });
    expect((await t.stored()).kycCase.version).toBe(2);
    expect(t.cases.audit).toHaveLength(1);
  });

  it('a duplicate face event does not count twice towards the liveness reject', async () => {
    const t = setup();
    const e = t.event('kyc.result', { check: 'face', match: 0.9, live: false });
    await t.send(e);
    await t.send(e);
    const s = await t.stored();
    expect(s.evidence!.face).toHaveLength(1);
    expect(s.kycCase.status).toBe('pre-verified');
  });

  it('a failed run releases the claim so the partner retry is processed', async () => {
    const t = setup();
    const realGet = t.cases.get.bind(t.cases);
    let fail = true;
    t.cases.get = async (id) => {
      if (fail) throw new Error('dynamo down');
      return realGet(id);
    };
    const e = t.event('kyc.result', kraOk);
    expect(await t.send(e)).toEqual({ status: 500, body: { error: 'internal' } });
    expect(t.seen.state(e.id)).toBeUndefined();
    fail = false;
    expect((await t.send(e)).body).toEqual({ ok: true, outcome: 'applied' });
    expect(t.seen.state(e.id)).toBe('done');
  });

  it('a crashed run (claim never released) can be retried after the lease', async () => {
    const t = setup();
    const e = t.event('kyc.result', kraOk);
    await t.seen.claim(e.id, t.clock.now(), 60_000, 86_400_000);
    expect((await t.send(e)).body.outcome).toBe('duplicate');
    t.clock.advance(61_000);
    expect((await t.send({ ...e, timestamp: t.clock.now() })).body.outcome).toBe('applied');
  });
});

describe('webhook: event types', () => {
  it('kyc.result kra validated + match → verified (kra-validated), ref stored, audited', async () => {
    const t = setup();
    const res = await t.send(t.event('kyc.result', kraOk, { ref: 'kra_1' }));
    expect(res.status).toBe(200);
    const s = await t.stored();
    expect(s.kycCase).toMatchObject({ status: 'verified', path: 'kra-validated', reason: 'kra-validated', version: 2 });
    expect(s.kycCase.partnerRefs.kra).toBe('kra_1');
    expect(t.cases.audit[0]).toMatchObject({
      userId: USER, actor: 'system', action: 'webhook.kyc-result', outcome: 'applied', check: 'kra',
      before: { status: 'pre-verified', version: 1 }, after: { status: 'verified', version: 2 },
    });
  });

  it('kyc.result kra timeout → under-review (partner-timeout); a later passing result verifies', async () => {
    const t = setup();
    await t.send(t.event('kyc.result', { check: 'kra', timeout: true }));
    expect((await t.stored()).kycCase).toMatchObject({ status: 'under-review', reason: 'partner-timeout' });
    t.clock.advance(1000);
    await t.send(t.event('kyc.result', kraOk));
    expect((await t.stored()).kycCase).toMatchObject({ status: 'verified', path: 'kra-validated' });
  });

  it('an under-review case waiting for staff is never verified by a webhook', async () => {
    const t = setup({ kycCase: baseCase({ status: 'under-review', reason: 'check-unclear' }) });
    await t.send(t.event('kyc.result', kraOk));
    expect((await t.stored()).kycCase).toMatchObject({ status: 'under-review', reason: 'check-unclear', version: 2 });
  });

  it('full KYC: not-found → aadhaar → pan → face → esign → verified (full-kyc)', async () => {
    const t = setup();
    const steps: [string, Record<string, unknown>, string][] = [
      ['kyc.result', { check: 'kra', status: 'not-found' }, 'aadhaar'],
      ['kyc.result', { check: 'aadhaar', verified: true, last4: '1234' }, 'pan'],
      ['kyc.result', { check: 'pan', valid: true, nameMatch: true, aadhaarLinked: true }, 'face'],
      ['kyc.result', { check: 'face', match: 0.95, live: true }, 'esign'],
    ];
    for (const [type, data] of steps) {
      expect((await t.send(t.event(type, data))).body.outcome).toBe('applied');
      expect((await t.stored()).kycCase.status).toBe('pre-verified');
      t.clock.advance(1000);
    }
    await t.send(t.event('esign.completed', { status: 'done' }, { ref: 'es_1' }));
    const s = await t.stored();
    expect(s.kycCase).toMatchObject({ status: 'verified', path: 'full-kyc', reason: 'full-kyc-passed', version: 6 });
    expect(s.kycCase.checks).toMatchObject({ aadhaar: 'pass', pan: 'pass', 'face-match': 'pass', liveness: 'pass', esign: 'pass' });
    expect(s.kycCase.partnerRefs.esign).toBe('es_1');
    expect(t.cases.audit.map((a) => a.action)).toEqual([
      'webhook.kyc-result', 'webhook.kyc-result', 'webhook.kyc-result', 'webhook.kyc-result', 'webhook.esign',
    ]);
  });

  it('kyc.result aadhaar last-4 mismatch → rejected', async () => {
    const t = setup();
    await t.send(t.event('kyc.result', { check: 'aadhaar', verified: true, last4: '9999' }));
    expect((await t.stored()).kycCase).toMatchObject({ status: 'rejected', reason: 'aadhaar-mismatch' });
  });

  it('kyc.result aadhaar not verified → under-review (person checks it)', async () => {
    const t = setup({ evidence: baseEvidence({ kra: { status: 'not-found' } }) });
    await t.send(t.event('kyc.result', { check: 'aadhaar', verified: false }));
    const s = await t.stored();
    expect(s.kycCase).toMatchObject({ status: 'under-review', reason: 'check-unclear', checks: { aadhaar: 'unclear' } });
    expect(s.evidence!.aadhaarFailed).toBe(true);
  });

  it('kyc.result pan invalid → rejected', async () => {
    const t = setup();
    await t.send(t.event('kyc.result', { check: 'pan', valid: false, nameMatch: false, aadhaarLinked: false }));
    expect((await t.stored()).kycCase).toMatchObject({ status: 'rejected', reason: 'pan-invalid' });
  });

  it('kyc.result face: two liveness fails → rejected', async () => {
    const t = setup();
    await t.send(t.event('kyc.result', { check: 'face', match: 0.9, live: false }));
    t.clock.advance(1000);
    await t.send(t.event('kyc.result', { check: 'face', match: 0.9, live: false }));
    expect((await t.stored()).kycCase).toMatchObject({ status: 'rejected', reason: 'liveness-failed' });
  });

  it('esign.completed failed → still in progress (esign pending)', async () => {
    const full = baseEvidence({
      kra: { status: 'not-found' }, aadhaar: { verified: true, last4: '1234' },
      pan: { valid: true, nameMatch: true, aadhaarLinked: true }, face: [{ match: 0.9, live: true }],
    });
    const t = setup({ evidence: full });
    await t.send(t.event('esign.completed', { status: 'failed' }));
    const s = await t.stored();
    expect(s.kycCase).toMatchObject({ status: 'pre-verified', reason: 'in-progress' });
    expect(s.evidence!.esign).toBe('pending');
  });

  it('esign.completed timeout → under-review', async () => {
    const full = baseEvidence({
      kra: { status: 'not-found' }, aadhaar: { verified: true, last4: '1234' },
      pan: { valid: true, nameMatch: true, aadhaarLinked: true }, face: [{ match: 0.9, live: true }],
    });
    const t = setup({ evidence: full });
    await t.send(t.event('esign.completed', { status: 'timeout' }));
    expect((await t.stored()).kycCase.status).toBe('under-review');
  });

  it('kra.upload on a verified case records the status and ref without re-deciding', async () => {
    const t = setup({ kycCase: baseCase({ status: 'verified', path: 'full-kyc', reason: 'full-kyc-passed', checks: { esign: 'pass' } }) });
    await t.send(t.event('kra.upload', { status: 'uploaded' }, { ref: 'up_1' }));
    const s = await t.stored();
    expect(s.kycCase).toMatchObject({ status: 'verified', reason: 'full-kyc-passed', checks: { esign: 'pass' }, version: 2 });
    expect(s.kycCase.partnerRefs.kraUpload).toBe('up_1');
    expect(s.evidence!.kraUpload).toEqual({ status: 'uploaded' });
    expect(t.cases.audit[0]!.action).toBe('webhook.kra-upload');
  });

  it('kra.upload on a case that is not verified is ignored (200, audited)', async () => {
    const t = setup();
    expect((await t.send(t.event('kra.upload', { status: 'uploaded' }))).body.outcome).toBe('ignored-not-verified');
    expect((await t.stored()).kycCase.version).toBe(1);
    expect(t.audit.entries[0]).toMatchObject({ outcome: 'ignored-not-verified', action: 'webhook.kra-upload' });
  });
});

describe('webhook: out-of-order and ignored events', () => {
  it('an older result for the same check arriving later is ignored', async () => {
    const t = setup();
    const now = t.clock.now();
    await t.send(t.event('kyc.result', { check: 'pan', valid: true, nameMatch: true, aadhaarLinked: true }, { occurredAt: now }));
    const res = await t.send(
      t.event('kyc.result', { check: 'pan', valid: false, nameMatch: false, aadhaarLinked: false }, { occurredAt: now - 60_000 }),
    );
    expect(res.body.outcome).toBe('ignored-stale');
    const s = await t.stored();
    expect(s.kycCase.status).toBe('pre-verified');
    expect(s.evidence!.pan).toEqual({ valid: true, nameMatch: true, aadhaarLinked: true });
    expect(t.audit.entries[0]).toMatchObject({ outcome: 'ignored-stale', check: 'pan' });
  });

  it('a late e-sign "failed" does not undo an earlier "done"', async () => {
    const t = setup();
    const now = t.clock.now();
    await t.send(t.event('esign.completed', { status: 'done' }, { occurredAt: now }));
    expect((await t.send(t.event('esign.completed', { status: 'failed' }, { occurredAt: now - 1 }))).body.outcome).toBe('ignored-stale');
    expect((await t.stored()).evidence!.esign).toBe('done');
  });

  it('results for different checks in any order reach the same decision', async () => {
    const t = setup();
    const evts = [
      t.event('esign.completed', { status: 'done' }),
      t.event('kyc.result', { check: 'face', match: 0.95, live: true }),
      t.event('kyc.result', { check: 'pan', valid: true, nameMatch: true, aadhaarLinked: true }),
      t.event('kyc.result', { check: 'aadhaar', verified: true, last4: '1234' }),
    ];
    for (const e of evts) {
      await t.send(e);
      expect((await t.stored()).kycCase.status).toBe('pre-verified'); // KRA lookup not back yet
    }
    await t.send(t.event('kyc.result', { check: 'kra', status: 'not-found' }));
    expect((await t.stored()).kycCase).toMatchObject({ status: 'verified', path: 'full-kyc' });
  });

  it('face attempts are kept in event-time order (latest attempt decides)', async () => {
    const t = setup({ evidence: baseEvidence({ kra: { status: 'not-found' } }) });
    const now = t.clock.now();
    await t.send(t.event('kyc.result', { check: 'face', match: 0.95, live: true }, { occurredAt: now }));
    await t.send(t.event('kyc.result', { check: 'face', match: 0.95, live: false }, { occurredAt: now - 30_000 }));
    const s = await t.stored();
    expect(s.evidence!.face).toEqual([{ match: 0.95, live: false }, { match: 0.95, live: true }]);
    expect(s.evidence!.faceTs).toEqual([now - 30_000, now]);
    expect(s.kycCase.checks['face-match']).toBe('pass');
  });

  it('events for a terminal case are ignored (200, audited)', async () => {
    const t = setup({ kycCase: baseCase({ status: 'rejected', reason: 'pan-invalid' }) });
    const res = await t.send(t.event('kyc.result', kraOk));
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'ignored-terminal' } });
    expect((await t.stored()).kycCase.status).toBe('rejected');
    expect(t.audit.entries[0]).toMatchObject({ outcome: 'ignored-terminal', before: { status: 'rejected' } });
  });

  it('a result for another partner session (ref mismatch) is ignored', async () => {
    const t = setup({ kycCase: baseCase({ partnerRefs: { esign: 'es_new' } }) });
    expect((await t.send(t.event('esign.completed', { status: 'done' }, { ref: 'es_old' }))).body.outcome).toBe('ignored-ref-mismatch');
    expect((await t.stored()).evidence!.esign).toBeUndefined();
  });

  it('an unknown user is ignored (200, audited)', async () => {
    const t = setup({ kycCase: null });
    expect((await t.send(t.event('kyc.result', kraOk))).body.outcome).toBe('ignored-unknown-case');
    expect(t.audit.entries[0]).toMatchObject({ outcome: 'ignored-unknown-case', before: null });
  });

  it('a case without evidence answers 500 so the partner retries', async () => {
    const t = setup({ evidence: null });
    const e = t.event('kyc.result', kraOk);
    expect((await t.send(e)).status).toBe(500);
    expect(t.seen.state(e.id)).toBeUndefined();
  });

  it('under-review hand-check case stays under-review on new results', async () => {
    const t = setup({ kycCase: baseCase({ status: 'under-review', path: 'hand-check' }), evidence: baseEvidence({ deviceHandCheck: true }) });
    await t.send(t.event('kyc.result', kraOk));
    expect((await t.stored()).kycCase).toMatchObject({ status: 'under-review', path: 'hand-check' });
  });
});

describe('webhook: version conflicts', () => {
  it('retries once after a concurrent write and applies on the fresh case', async () => {
    const t = setup();
    let first = true;
    t.cases.beforeSave = () => {
      if (first) {
        first = false;
        t.cases.touch(USER); // another writer bumped the version
      }
    };
    expect((await t.send(t.event('kyc.result', kraOk))).body.outcome).toBe('applied');
    const s = await t.stored();
    expect(s.kycCase).toMatchObject({ status: 'verified', version: 3 });
    expect(t.cases.audit).toHaveLength(1);
    expect(t.cases.audit[0]!.before!.version).toBe(2);
  });

  it('two conflicts in a row → 500, claim released, partner retry succeeds', async () => {
    const t = setup();
    t.cases.beforeSave = () => t.cases.touch(USER);
    const e = t.event('kyc.result', kraOk);
    expect((await t.send(e)).status).toBe(500);
    expect(t.cases.audit).toHaveLength(0);
    t.cases.beforeSave = undefined;
    expect((await t.send(e)).body.outcome).toBe('applied');
  });
});

describe('webhook: logging', () => {
  it('never logs body contents or partner values', async () => {
    const t = setup();
    await t.send(t.event('kyc.result', kraOk, { ref: 'kra_secret_ref' }));
    await t.send(t.event('kyc.result', { check: 'aadhaar', verified: true, last4: '1234' }));
    await t.send('{"name":"NITISH SANA"');
    await t.send(t.event('kyc.result', kraOk), 'wrong-secret-wrong-secret');
    const text = JSON.stringify(t.logs);
    for (const s of ['NITISH', 'SANA', '1990', '1234', 'kra_secret_ref', 'validated']) expect(text).not.toContain(s);
    expect(t.logs.length).toBeGreaterThanOrEqual(4);
    for (const l of t.logs) {
      expect(Object.keys(l).every((k) => ['msg', 'eventId', 'type', 'outcome', 'status', 'error'].includes(k))).toBe(true);
    }
  });

  it('audit rows hold no partner values', async () => {
    const t = setup();
    await t.send(t.event('kyc.result', kraOk));
    const text = JSON.stringify(t.cases.audit);
    for (const s of ['NITISH', '1990']) expect(text).not.toContain(s);
  });
});
