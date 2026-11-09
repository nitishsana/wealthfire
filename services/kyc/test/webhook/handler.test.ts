import { describe, expect, it } from 'vitest';
import { REPLAY_WINDOW_MS } from '../../src/webhook/handler';
import { baseCase, baseEvidence, REFS, setup, UPLOAD_REF, USER, withResultRefs } from './helpers';

const kraOk = { check: 'kra', status: 'validated', name: 'NITISH SANA', dob: '1990-08-15' };

describe('webhook: signature and envelope', () => {
  it('401 on a bad signature, and nothing changes', async () => {
    const t = setup();
    const res = await t.send(t.event('kyc.result', kraOk), 'wrong-secret-wrong-secret');
    expect(res).toEqual({ status: 401, body: { error: 'bad_signature' } });
    expect((await t.stored()).kycCase.version).toBe(1);
    expect(t.ignored()).toHaveLength(0);
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
    expect(t.applied()).toHaveLength(1);
  });

  it('a duplicate face event does not count twice towards the liveness reject', async () => {
    const t = setup({ kycCase: withResultRefs() });
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
    t.cases.get = async (id: string) => {
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
    expect(t.applied()[0]).toMatchObject({
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

  it('full KYC: not-found → aadhaar → (pan + face via the API) → esign → verified (full-kyc)', async () => {
    // S#10: PAN and face results reach the case synchronously through the API, never the webhook
    const t = setup({
      evidence: baseEvidence({ pan: { valid: true, nameMatch: true, aadhaarLinked: true }, face: [{ match: 0.95, live: true }] }),
    });
    const steps: [string, Record<string, unknown>][] = [
      ['kyc.result', { check: 'kra', status: 'not-found' }],
      ['kyc.result', { check: 'aadhaar', verified: true, last4: '1234' }],
    ];
    for (const [type, data] of steps) {
      expect((await t.send(t.event(type, data))).body.outcome).toBe('applied');
      expect((await t.stored()).kycCase.status).toBe('pre-verified');
      t.clock.advance(1000);
    }
    // a webhook PAN / face result in the middle changes nothing
    expect((await t.send(t.event('kyc.result', { check: 'face', match: 0.1, live: false }))).body.outcome).toBe('ignored-ref-mismatch');
    await t.send(t.event('esign.completed', { status: 'done' }, { ref: 'es_1' }));
    const s = await t.stored();
    expect(s.kycCase).toMatchObject({ status: 'verified', path: 'full-kyc', reason: 'full-kyc-passed', version: 4 });
    expect(s.kycCase.checks).toMatchObject({ aadhaar: 'pass', pan: 'pass', 'face-match': 'pass', liveness: 'pass', esign: 'pass' });
    expect(s.evidence!.face).toEqual([{ match: 0.95, live: true }]);
    expect(s.kycCase.partnerRefs.esign).toBe('es_1');
    expect(t.applied().map((a: { action: string }) => a.action)).toEqual([
      'webhook.kyc-result', 'webhook.kyc-result', 'webhook.esign',
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

  it('kyc.result pan invalid (stored PAN ref matches) → rejected', async () => {
    const t = setup({ kycCase: withResultRefs() });
    await t.send(t.event('kyc.result', { check: 'pan', valid: false, nameMatch: false, aadhaarLinked: false }));
    expect((await t.stored()).kycCase).toMatchObject({ status: 'rejected', reason: 'pan-invalid' });
  });

  it('kyc.result face (stored face ref matches): two liveness fails → rejected', async () => {
    const t = setup({ kycCase: withResultRefs() });
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
    const t = setup({
      kycCase: baseCase({
        status: 'verified', path: 'full-kyc', reason: 'full-kyc-passed', checks: { esign: 'pass' },
        partnerRefs: { ...REFS, kraUpload: UPLOAD_REF },
      }),
    });
    await t.send(t.event('kra.upload', { status: 'uploaded' }, { ref: 'up_1' }));
    const s = await t.stored();
    expect(s.kycCase).toMatchObject({ status: 'verified', reason: 'full-kyc-passed', checks: { esign: 'pass' }, version: 2 });
    expect(s.kycCase.partnerRefs.kraUpload).toBe('up_1');
    expect(s.evidence!.kraUpload).toEqual({ status: 'uploaded' });
    expect(t.applied()[0]!.action).toBe('webhook.kra-upload');
  });

  it('kra.upload on a case that is not verified is ignored (200, audited)', async () => {
    const t = setup();
    expect((await t.send(t.event('kra.upload', { status: 'uploaded' }))).body.outcome).toBe('ignored-not-verified');
    expect((await t.stored()).kycCase.version).toBe(1);
    expect(t.ignored()[0]).toMatchObject({ outcome: 'ignored-not-verified', action: 'webhook.kra-upload' });
  });
});

describe('webhook: out-of-order and ignored events', () => {
  it('an older result for the same check arriving later is ignored', async () => {
    const t = setup({ kycCase: withResultRefs() });
    const now = t.clock.now();
    await t.send(t.event('kyc.result', { check: 'pan', valid: true, nameMatch: true, aadhaarLinked: true }, { occurredAt: now }));
    const res = await t.send(
      t.event('kyc.result', { check: 'pan', valid: false, nameMatch: false, aadhaarLinked: false }, { occurredAt: now - 60_000 }),
    );
    expect(res.body.outcome).toBe('ignored-stale');
    const s = await t.stored();
    expect(s.kycCase.status).toBe('pre-verified');
    expect(s.evidence!.pan).toEqual({ valid: true, nameMatch: true, aadhaarLinked: true });
    expect(t.ignored()[0]).toMatchObject({ outcome: 'ignored-stale', check: 'pan' });
  });

  it('a late e-sign "failed" does not undo an earlier "done"', async () => {
    const t = setup();
    const now = t.clock.now();
    await t.send(t.event('esign.completed', { status: 'done' }, { occurredAt: now }));
    expect((await t.send(t.event('esign.completed', { status: 'failed' }, { occurredAt: now - 1 }))).body.outcome).toBe('ignored-stale');
    expect((await t.stored()).evidence!.esign).toBe('done');
  });

  it('results for different checks in any order reach the same decision', async () => {
    const t = setup({ kycCase: withResultRefs() });
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
    const t = setup({ kycCase: withResultRefs(), evidence: baseEvidence({ kra: { status: 'not-found' } }) });
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
    expect(t.ignored()[0]).toMatchObject({ outcome: 'ignored-terminal', before: { status: 'rejected' } });
  });

  it('a result for another partner session (ref mismatch) is ignored', async () => {
    const t = setup({ kycCase: baseCase({ partnerRefs: { esign: 'es_new' } }) });
    expect((await t.send(t.event('esign.completed', { status: 'done' }, { ref: 'es_old' }))).body.outcome).toBe('ignored-ref-mismatch');
    expect((await t.stored()).evidence!.esign).toBeUndefined();
  });

  it('an unknown user is ignored (200, audited)', async () => {
    const t = setup({ kycCase: null });
    expect((await t.send(t.event('kyc.result', kraOk))).body.outcome).toBe('ignored-unknown-case');
    expect(t.ignored()[0]).toMatchObject({ outcome: 'ignored-unknown-case', before: null });
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
    t.store.cases.beforeWrite = () => {
      if (first) {
        first = false;
        t.store.cases.touch(USER); // another writer bumped the version
      }
    };
    expect((await t.send(t.event('kyc.result', kraOk))).body.outcome).toBe('applied');
    const s = await t.stored();
    expect(s.kycCase).toMatchObject({ status: 'verified', version: 3 });
    expect(t.applied()).toHaveLength(1);
    expect(t.applied()[0]!.before!.version).toBe(2);
  });

  it('two conflicts in a row → 500, claim released, partner retry succeeds', async () => {
    const t = setup();
    t.store.cases.beforeWrite = () => t.store.cases.touch(USER);
    const e = t.event('kyc.result', kraOk);
    expect((await t.send(e)).status).toBe(500);
    expect(t.applied()).toHaveLength(0);
    t.store.cases.beforeWrite = undefined;
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
    const text = JSON.stringify(t.applied());
    for (const s of ['NITISH', '1990']) expect(text).not.toContain(s);
  });
});

describe('webhook: S17 partner ref binding', () => {
  const record = (t: ReturnType<typeof setup>) => t.store.cases.all().find((c) => c.userId === USER)!;

  it.each([
    ['kra result', 'kyc.result', kraOk],
    ['aadhaar result', 'kyc.result', { check: 'aadhaar', verified: true, last4: '1234' }],
    ['e-sign result', 'esign.completed', { status: 'done' }],
  ] as const)('%s without a ref is refused, audited and logged; case unchanged', async (_label, type, data) => {
    const t = setup();
    const res = await t.send(t.event(type, data, { ref: undefined }));
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'ignored-ref-mismatch' } });
    expect((await t.stored()).kycCase.version).toBe(1);
    expect(t.ignored()[0]).toMatchObject({ outcome: 'ignored-ref-mismatch' });
    expect(t.logs.at(-1)).toMatchObject({ msg: 'webhook.refused', outcome: 'ignored-ref-mismatch', status: 200 });
  });

  it('a ref from another session is refused', async () => {
    const t = setup();
    expect((await t.send(t.event('kyc.result', kraOk, { ref: 'kra_other' }))).body.outcome).toBe('ignored-ref-mismatch');
    expect((await t.stored()).kycCase.status).toBe('pre-verified');
  });

  it('a late KRA result after the lookup timed out (no stored ref) is refused; the case stays with staff', async () => {
    const t = setup({
      kycCase: baseCase({ status: 'under-review', reason: 'partner-timeout', partnerRefs: { aadhaar: REFS.aadhaar } }),
      evidence: baseEvidence({ kra: 'timeout' }),
    });
    const res = await t.send(t.event('kyc.result', kraOk, { ref: 'kra_late' }));
    expect(res.body.outcome).toBe('ignored-ref-mismatch');
    const s = await t.stored();
    expect(s.kycCase).toMatchObject({ status: 'under-review', reason: 'partner-timeout', version: 1 });
    expect(s.kycCase.partnerRefs.kra).toBeUndefined();
    expect(s.evidence!.kra).toBe('timeout');
  });

  it('a kra.upload with a ref other than the stored upload ref is refused', async () => {
    const t = setup({ kycCase: baseCase({ status: 'verified', reason: 'staff-approved', partnerRefs: { kraUpload: UPLOAD_REF } }) });
    expect((await t.send(t.event('kra.upload', { status: 'uploaded' }, { ref: 'up_2' }))).body.outcome).toBe('ignored-ref-mismatch');
    expect((await t.send(t.event('kra.upload', { status: 'uploaded' }))).body.outcome).toBe('applied');
    expect(record(t).evidence.kraUpload).toEqual({ status: 'uploaded' });
  });

  it.each([
    ['PAN with a ref', { check: 'pan', valid: false, nameMatch: false, aadhaarLinked: false }, {}],
    ['PAN without a ref', { check: 'pan', valid: false, nameMatch: false, aadhaarLinked: false }, { ref: undefined }],
    ['face with a ref', { check: 'face', match: 0.1, live: false }, {}],
    ['face without a ref', { check: 'face', match: 0.1, live: false }, { ref: undefined }],
    ['PAN timeout', { check: 'pan', timeout: true }, {}],
  ] as const)('S#10: a webhook %s result is refused when no PAN / face ref is stored (the API default)', async (_l, data, extra) => {
    const t = setup();
    const res = await t.send(t.event('kyc.result', data, extra));
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'ignored-ref-mismatch' } });
    const s = await t.stored();
    expect(s.kycCase).toMatchObject({ status: 'pre-verified', version: 1 });
    expect(s.evidence!.pan).toBeUndefined();
    expect(s.evidence!.face).toBeUndefined();
    expect(t.applied()).toHaveLength(0);
    expect(t.ignored()[0]).toMatchObject({ outcome: 'ignored-ref-mismatch', check: data.check });
    expect(t.logs.at(-1)).toMatchObject({ msg: 'webhook.refused', outcome: 'ignored-ref-mismatch', status: 200 });
  });

  it('S#10: a webhook PAN / face result cannot overturn the API\'s synchronous result', async () => {
    const t = setup({
      evidence: baseEvidence({ pan: { valid: true, nameMatch: true, aadhaarLinked: true }, face: [{ match: 0.95, live: true }] }),
    });
    await t.send(t.event('kyc.result', { check: 'pan', valid: false, nameMatch: false, aadhaarLinked: false }));
    await t.send(t.event('kyc.result', { check: 'face', match: 0.1, live: false }));
    await t.send(t.event('kyc.result', { check: 'face', match: 0.1, live: false }));
    const s = await t.stored();
    expect(s.evidence!.pan).toEqual({ valid: true, nameMatch: true, aadhaarLinked: true });
    expect(s.evidence!.face).toEqual([{ match: 0.95, live: true }]);
    expect(s.kycCase).toMatchObject({ status: 'pre-verified', version: 1 });
  });

  it('S#10: with a stored PAN / face ref, only the matching ref is applied', async () => {
    const t = setup({ kycCase: withResultRefs() });
    const pan = { check: 'pan', valid: true, nameMatch: true, aadhaarLinked: true };
    expect((await t.send(t.event('kyc.result', pan, { ref: 'pan_other' }))).body.outcome).toBe('ignored-ref-mismatch');
    expect((await t.send(t.event('kyc.result', pan))).body.outcome).toBe('applied');
    expect((await t.send(t.event('kyc.result', { check: 'face', match: 0.9, live: true }, { ref: 'face_other' }))).body.outcome).toBe('ignored-ref-mismatch');
    expect((await t.send(t.event('kyc.result', { check: 'face', match: 0.9, live: true }))).body.outcome).toBe('applied');
  });

  it('the stored refs are never overwritten by an event', async () => {
    const t = setup();
    await t.send(t.event('kyc.result', kraOk));
    expect((await t.stored()).kycCase.partnerRefs).toEqual(REFS);
  });
});

describe('webhook: R1 e-sign after a staff Approve', () => {
  const approved = (over: Parameters<typeof baseCase>[0] = {}) =>
    baseCase({ status: 'verified', path: 'hand-check', reason: 'staff-approved', ...over });
  const record = (t: ReturnType<typeof setup>) => t.store.cases.all().find((c) => c.userId === USER)!;

  it('e-sign done on an approved, unsigned case records it and makes the KRA upload due', async () => {
    const t = setup({ kycCase: approved(), evidence: baseEvidence({ deviceHandCheck: true, esign: 'pending' }) });
    const res = await t.send(t.event('esign.completed', { status: 'done' }));
    expect(res.body.outcome).toBe('applied');
    const rec = record(t);
    expect(rec).toMatchObject({ status: 'verified', reason: 'staff-approved', path: 'hand-check', next: 'kra-upload', version: 2 });
    expect(rec.checks.esign).toBe('pass');
    expect(rec.evidence.esign).toBe('done');
    expect(t.applied()[0]).toMatchObject({ action: 'webhook.esign', before: { status: 'verified' }, after: { status: 'verified' } });
  });

  it('e-sign failed keeps the case waiting for e-sign (no KRA upload)', async () => {
    const t = setup({ kycCase: approved(), evidence: baseEvidence({ esign: 'pending' }) });
    await t.send(t.event('esign.completed', { status: 'failed' }));
    const rec = record(t);
    expect(rec).toMatchObject({ status: 'verified', next: 'esign' });
    expect(rec.evidence.esign).toBe('pending');
  });

  it('an approved case that is already e-signed or uploaded ignores e-sign events', async () => {
    const signed = setup({ kycCase: approved(), evidence: baseEvidence({ esign: 'done' }) });
    expect((await signed.send(signed.event('esign.completed', { status: 'failed' }))).body.outcome).toBe('ignored-terminal');
    const uploaded = setup({ kycCase: approved({ partnerRefs: { ...REFS, kraUpload: UPLOAD_REF } }) });
    expect((await uploaded.send(uploaded.event('esign.completed', { status: 'done' }))).body.outcome).toBe('ignored-terminal');
  });

  it('a rejected case still ignores e-sign events', async () => {
    const t = setup({ kycCase: baseCase({ status: 'rejected', reason: 'staff-rejected' }) });
    expect((await t.send(t.event('esign.completed', { status: 'done' }))).body.outcome).toBe('ignored-terminal');
  });

  it('e-sign on an approved case still needs the stored e-sign ref (S17)', async () => {
    const t = setup({ kycCase: approved({ partnerRefs: {} }), evidence: baseEvidence({ esign: 'pending' }) });
    expect((await t.send(t.event('esign.completed', { status: 'done' }))).body.outcome).toBe('ignored-ref-mismatch');
    expect(record(t).evidence.esign).toBe('pending');
  });
});
