import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config';
import { DynamoCaseStore } from '../../src/store/dynamo';
import { decideFromEvidence } from '../../src/store/evidence';
import { memoryStore } from '../../src/store/memory';
import { BadCursorError, type AuditRow, type KycCaseRecord } from '../../src/store/types';
import { reviewCaseStore, webhookCaseStore } from '../../src/store/views';

const rec = (over: Partial<KycCaseRecord> = {}): KycCaseRecord => ({
  userId: 'u1', status: 'under-review', path: 'full-kyc', masks: { pan: 'XXXXXX234F', aadhaar: 'XXXX XXXX 1234' },
  partnerRefs: { kra: 'kra-1' }, checks: { pan: 'pass' }, reason: 'check-unclear', updatedAt: '2026-11-06T00:00:00.000Z', version: 1,
  createdAt: '2026-11-06T00:00:00.000Z', panEnc: 'l1.x', panHash: 'h',
  evidence: { typed: { firstName: 'A', lastName: 'B', dob: '1990-01-01' }, deviceHandCheck: false, otpAadhaarLast4: '1234', panIndividual: true },
  next: 'wait', unclear: ['pan-name'], ...over,
});
const row = (ts: string, over: Partial<AuditRow> = {}): AuditRow => ({
  userId: 'u1', ts, actor: 'system', action: 'kyc.test', before: null, after: null, ...over,
});

class FakeDoc {
  sent: { name: string; input: Record<string, any> }[] = [];
  fail: string | null = null;
  async send(cmd: { constructor: { name: string }; input: Record<string, any> }): Promise<any> {
    this.sent.push({ name: cmd.constructor.name, input: cmd.input });
    if (this.fail) throw Object.assign(new Error('x'), { name: this.fail });
    return {};
  }
}

describe('MemoryCaseStore (the one in-memory store)', () => {
  it('update: partial, version-checked, keeps other fields, drops removed ones, writes the audit row', async () => {
    const s = memoryStore();
    await s.cases.save(rec(), 0);
    const r = await s.cases.update({
      userId: 'u1', expectedVersion: 1, requireStatus: 'under-review',
      set: { status: 'verified', reason: 'staff-approved', next: 'kra-upload', updatedAt: 't2', path: undefined },
      remove: ['unclear'], audit: row('t#1'),
    });
    expect(r).toBe('ok');
    const got = (await s.cases.get('u1'))!;
    expect(got).toMatchObject({ status: 'verified', reason: 'staff-approved', next: 'kra-upload', version: 2, path: 'full-kyc', panEnc: 'l1.x' });
    expect(got.unclear).toBeUndefined();
    expect(got.evidence.typed.firstName).toBe('A');
    expect(s.audit.rows.map((a) => a.ts)).toEqual(['t#1']);
  });

  it('update: conflict on a stale version, a missing case or the wrong status; nothing written', async () => {
    const s = memoryStore();
    await s.cases.save(rec(), 0);
    expect(await s.cases.update({ userId: 'u1', expectedVersion: 0, set: {}, audit: row('a') })).toBe('conflict');
    expect(await s.cases.update({ userId: 'nope', expectedVersion: 1, set: {}, audit: row('b') })).toBe('conflict');
    expect(await s.cases.update({ userId: 'u1', expectedVersion: 1, requireStatus: 'pre-verified', set: {}, audit: row('c') })).toBe('conflict');
    expect(s.audit.rows).toEqual([]);
    expect((await s.cases.get('u1'))!.version).toBe(1);
  });

  it('listUnderReview: newest first, own cursor only', async () => {
    const s = memoryStore();
    for (let i = 0; i < 3; i++) await s.cases.save(rec({ userId: `u${i}`, updatedAt: `2026-11-0${i + 1}` }), 0);
    await s.cases.save(rec({ userId: 'v', status: 'verified', updatedAt: '2026-12-01' }), 0);
    const p1 = await s.cases.listUnderReview({ limit: 2 });
    expect(p1.items.map((c) => c.userId)).toEqual(['u2', 'u1']);
    const p2 = await s.cases.listUnderReview({ limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((c) => c.userId)).toEqual(['u0']);
    expect(p2.nextCursor).toBeUndefined();
    await expect(s.cases.listUnderReview({ limit: 2, cursor: 'c2' })).rejects.toBeInstanceOf(BadCursorError);
  });

  it('audit: newest first with a limit; same (userId, ts) kept once', async () => {
    const s = memoryStore();
    await s.audit.write(row('2026-01-01#a'));
    await s.audit.write(row('2026-01-03#c'));
    await s.audit.write(row('2026-01-02#b'));
    await s.audit.write(row('2026-01-02#b', { action: 'kyc.other' }));
    expect((await s.audit.listForUser('u1')).map((r) => r.ts)).toEqual(['2026-01-03#c', '2026-01-02#b', '2026-01-01#a']);
    expect(await s.audit.listForUser('u1', 1)).toHaveLength(1);
  });

  it('review and webhook views write through to the same record and audit log', async () => {
    const s = memoryStore();
    await s.cases.save(rec(), 0);
    const review = reviewCaseStore(s.cases);
    const webhook = webhookCaseStore(s.cases);
    const w = (await webhook.get('u1'))!;
    expect(Object.keys(w.kycCase)).not.toContain('panEnc');
    expect(w.evidence).toEqual(rec().evidence);
    const before = (await review.get('u1'))!;
    expect(await review.saveDecision({
      before, after: { ...before, status: 'verified', reason: 'staff-approved', version: 2, updatedAt: 't' }, next: 'kra-upload',
      audit: row('t#r', { actor: 'staff:s1', action: 'review.approve' }),
    })).toBe('ok');
    const after = (await s.cases.get('u1'))!;
    expect(after).toMatchObject({ status: 'verified', next: 'kra-upload', panHash: 'h', version: 2 });
    expect(after.note).toBeUndefined();
    expect(s.audit.rows.map((r) => r.action)).toEqual(['review.approve']);
  });
});

describe('DynamoCaseStore', () => {
  it('claimPan is one conditional put on pan#<hash>; another owner → false', async () => {
    const doc = new FakeDoc();
    const s = new DynamoCaseStore(doc, 'cases', 'audit');
    expect(await s.claimPan('h1', 'u1')).toBe(true);
    expect(doc.sent[0]).toEqual({
      name: 'PutCommand',
      input: {
        TableName: 'cases', Item: { userId: 'pan#h1', ownerId: 'u1' },
        ConditionExpression: 'attribute_not_exists(userId) OR ownerId = :me', ExpressionAttributeValues: { ':me': 'u1' },
      },
    });
    doc.fail = 'ConditionalCheckFailedException';
    expect(await s.claimPan('h1', 'u2')).toBe(false);
    doc.fail = 'ThrottlingException';
    await expect(s.claimPan('h1', 'u2')).rejects.toThrow();
  });

  it('pointer and idempotency keys are never read or written as cases', async () => {
    const doc = new FakeDoc();
    const s = new DynamoCaseStore(doc, 'cases', 'audit');
    expect(await s.get('pan#h1')).toBeNull();
    expect(await s.get('idem#x')).toBeNull();
    expect(await s.save(rec({ userId: 'pan#h1' }), 0)).toBe(false);
    expect(doc.sent).toHaveLength(0);
  });

  it('update builds SET / REMOVE with placeholders only (no values in the expression)', async () => {
    const doc = new FakeDoc();
    const s = new DynamoCaseStore(doc, 'cases', 'audit');
    await s.update({ userId: 'u1', expectedVersion: 4, set: { status: 'rejected', note: 'Name mismatch' }, remove: ['unclear'], audit: row('t') });
    const upd = doc.sent[0]!.input.TransactItems[0].Update;
    expect(upd.UpdateExpression).toBe('SET #version = :next, #f1 = :f1, #f2 = :f2 REMOVE #r0');
    expect(upd.UpdateExpression).not.toContain('Name mismatch');
    expect(upd.ExpressionAttributeNames).toEqual({ '#version': 'version', '#f1': 'status', '#f2': 'note', '#r0': 'unclear' });
    expect(upd.ExpressionAttributeValues).toEqual({ ':expected': 4, ':next': 5, ':f1': 'rejected', ':f2': 'Name mismatch' });
  });
});

describe('decideFromEvidence (shared by the KYC routes and the webhook)', () => {
  const ev = rec().evidence;
  it('a failed Aadhaar eKYC sends the case to a person', () => {
    const d = decideFromEvidence({ ...ev, kra: { status: 'not-found' }, aadhaarFailed: true }, 'pre-verified', null, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'under-review', reason: 'check-unclear', next: 'wait', checks: { aadhaar: 'unclear' } });
  });
  it('keeps a staff-waiting reason such as pan-in-use', () => {
    const d = decideFromEvidence({ ...ev, aadhaarFailed: true }, 'under-review', 'pan-in-use', DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'under-review', reason: 'pan-in-use' });
    expect(decideFromEvidence(ev, 'under-review', 'pan-in-use', DEFAULT_CONFIG)).toMatchObject({ reason: 'pan-in-use', next: 'wait' });
  });
  it('bookkeeping fields do not reach decide()', () => {
    const d = decideFromEvidence({ ...ev, kra: { status: 'not-found' }, faceTs: [1], eventTs: { kra: 1 }, kraUpload: { status: 'pending' } }, 'pre-verified', null, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'pre-verified', next: 'aadhaar' });
  });
});
