import { describe, expect, it } from 'vitest';
import {
  DynamoConsentRepo, DynamoCostRepo, DynamoIdempotencyRepo, IDEMPOTENCY_TTL_SEC, kycTablesFromEnv, memoryKycRepos, type KycCaseRecord,
} from '../../src/kyc/repo';
import { DynamoCaseStore } from '../../src/store/dynamo';

const rec = (over: Partial<KycCaseRecord> = {}): KycCaseRecord => ({
  userId: 'u1', status: 'pre-verified', path: null, masks: { pan: 'XXXXXX234F', aadhaar: 'XXXX XXXX 1234' },
  partnerRefs: {}, checks: {}, reason: null, updatedAt: '2026-11-06T00:00:00.000Z', version: 1,
  createdAt: '2026-11-06T00:00:00.000Z', panEnc: 'l1.x', panHash: 'h',
  evidence: { typed: { firstName: 'A', lastName: 'B', dob: '1990-01-01' }, deviceHandCheck: false, otpAadhaarLast4: '1234', panIndividual: true },
  next: 'kra-lookup', ...over,
});

const TABLES = { TABLE_KYC_CASES: 'c', TABLE_AUDIT: 'a', TABLE_COSTS: 'k', CONSENTS_TABLE: 'cons' };
const idem = (over: Record<string, unknown> = {}) => ({ id: 'abc', requestHash: 'h', state: 'pending' as const, createdAt: 1, expiresAt: 1000, ...over });

/** Records commands; fails conditional writes when `fail` is set. */
class FakeDoc {
  sent: { name: string; input: Record<string, any> }[] = [];
  fail = false;
  item: Record<string, unknown> | undefined;
  items: Record<string, unknown>[] | undefined;
  async send(cmd: { constructor: { name: string }; input: Record<string, any> }): Promise<any> {
    this.sent.push({ name: cmd.constructor.name, input: cmd.input });
    if (this.fail && (cmd.input.ConditionExpression || cmd.input.TransactItems)) {
      throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
    }
    return { Item: this.item, Items: this.items };
  }
}

describe('memory KYC repos', () => {
  it('case save is optimistic on version', async () => {
    const r = memoryKycRepos();
    expect(await r.cases.save(rec(), 0)).toBe(true);
    expect(await r.cases.save(rec(), 0)).toBe(false); // exists
    expect(await r.cases.save(rec({ version: 3 }), 1)).toBe(false); // must be +1
    expect(await r.cases.save(rec({ version: 2 }), 1)).toBe(true);
    expect(await r.cases.save(rec({ version: 2 }), 1)).toBe(false); // stale
    expect((await r.cases.get('u1'))!.version).toBe(2);
  });

  it('writes the audit row with the case', async () => {
    const r = memoryKycRepos();
    const row = { userId: 'u1', ts: 't#1', actor: 'system' as const, action: 'kyc.start' as const, before: null, after: null };
    await r.cases.save(rec(), 0, row);
    expect(r.audit.rows).toEqual([row]);
    await r.audit.write(row); // the same (userId, ts) twice keeps one row
    expect(r.audit.rows).toHaveLength(1);
  });

  it('cost cap counter', async () => {
    const r = memoryKycRepos();
    expect(await r.costs.reserve('u', 'd', 2)).toBe(true);
    expect(await r.costs.reserve('u', 'd', 2)).toBe(true);
    expect(await r.costs.reserve('u', 'd', 2)).toBe(false);
    expect(await r.costs.reserve('u', 'd2', 2)).toBe(true);
    expect(await r.costs.used('u', 'd')).toBe(2);
  });

  it('S11 signing counter is separate from the paid-check cap and counts n at once', async () => {
    const r = memoryKycRepos();
    expect(await r.costs.reserveSignings('u', 'd', 3, 9)).toBe(true);
    expect(await r.costs.reserveSignings('u', 'd', 3, 9)).toBe(true);
    expect(await r.costs.reserveSignings('u', 'd', 3, 9)).toBe(true);
    expect(await r.costs.reserveSignings('u', 'd', 1, 9)).toBe(false);
    expect(await r.costs.reserveSignings('u', 'd2', 1, 9)).toBe(true);
    expect(await r.costs.used('u', 'd')).toBe(0);
  });

  it('S18: an expired idempotency record is gone and can be claimed again', async () => {
    const r = memoryKycRepos();
    expect(await r.idempotency.claim(idem(), 10)).toBe(true);
    expect(await r.idempotency.claim(idem(), 999)).toBe(false);
    expect(await r.idempotency.get('abc', 999)).not.toBeNull();
    expect(await r.idempotency.get('abc', 1000)).toBeNull();
    expect(await r.idempotency.claim(idem({ expiresAt: 5000 }), 1000)).toBe(true);
    expect(IDEMPOTENCY_TTL_SEC).toBe(86_400);
  });

  it('consents: the newest row per purpose wins', async () => {
    const r = memoryKycRepos();
    expect(await r.consents.latest('u', 'esign')).toBeNull();
    await r.consents.record({ userId: 'u', sk: 'esign#2026-01-01T00:00:00.000Z#1', purpose: 'esign', action: 'given', at: 'x' });
    await r.consents.record({ userId: 'u', sk: 'esign#2026-01-02T00:00:00.000Z#1', purpose: 'esign', action: 'withdrawn', at: 'y' });
    await r.consents.record({ userId: 'u', sk: 'face-match#2026-01-03T00:00:00.000Z#1', purpose: 'face-match', action: 'given', at: 'z' });
    expect((await r.consents.latest('u', 'esign'))!.action).toBe('withdrawn');
    expect((await r.consents.latest('u', 'face-match'))!.action).toBe('given');
    expect(await r.consents.latest('other', 'esign')).toBeNull();
  });

  it('R9 releasePan drops only this user\u2019s claim; archive/remove are version-checked and audited', async () => {
    const r = memoryKycRepos();
    expect(await r.cases.claimPan('h', 'u1')).toBe(true);
    await r.cases.releasePan('h', 'u2');
    expect(r.cases.panOwner('h')).toBe('u1');
    await r.cases.releasePan('h', 'u1');
    expect(await r.cases.claimPan('h', 'u2')).toBe(true);

    const row = { userId: 'u1', ts: 't#2', actor: 'system' as const, action: 'kyc.case-archived' as const, before: null, after: null };
    await r.cases.save(rec(), 0);
    expect(await r.cases.archive('u1', 9, 't', row)).toBe(false);
    expect(await r.cases.archive('u1', 1, '2026-11-09T00:00:00.000Z', row)).toBe(true);
    expect(await r.cases.get('u1')).toBeNull();
    const arch = [...r.cases.archived.values()][0]!;
    expect(arch).toMatchObject({ userId: 'u1', status: 'pre-verified' });
    expect(arch).not.toHaveProperty('panEnc');
    expect(arch).not.toHaveProperty('evidence');
    await r.cases.save(rec(), 0);
    expect(await r.cases.remove('u1', 2, { ...row, ts: 't#3' })).toBe(false);
    expect(await r.cases.remove('u1', 1, { ...row, ts: 't#3' })).toBe(true);
    expect(await r.cases.get('u1')).toBeNull();
    expect(r.audit.rows.map((x) => x.ts)).toEqual(['t#2', 't#3']);
  });
});

describe('DynamoDB KYC repos', () => {
  it('table names from the stack env (TABLE_* + CONSENTS_TABLE)', () => {
    expect(kycTablesFromEnv(TABLES)).toEqual({ cases: 'c', audit: 'a', costs: 'k', consents: 'cons' });
    expect(() => kycTablesFromEnv({ ...TABLES, TABLE_KYC_CASES: undefined, KYC_CASES_TABLE: 'c2' })).toThrow(/TABLE_KYC_CASES/);
    expect(() => kycTablesFromEnv({ ...TABLES, CONSENTS_TABLE: undefined })).toThrow(/CONSENTS_TABLE/);
    expect(() => kycTablesFromEnv({})).toThrow(/TABLE_KYC_CASES/);
  });

  it('case save: create needs no item, update needs the version; audit in one transaction', async () => {
    const doc = new FakeDoc();
    const r = new DynamoCaseStore(doc, 'cases', 'audit');
    expect(await r.save(rec(), 0)).toBe(true);
    expect(doc.sent[0]).toMatchObject({ name: 'PutCommand', input: { TableName: 'cases', ConditionExpression: 'attribute_not_exists(userId)' } });
    await r.save(rec({ version: 5 }), 4, { userId: 'u1', ts: 't', actor: 'system', action: 'kyc.a', before: null, after: null });
    const tx = doc.sent[1]!.input.TransactItems;
    expect(doc.sent[1]!.name).toBe('TransactWriteCommand');
    expect(tx[0].Put).toMatchObject({ TableName: 'cases', ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': 4 } });
    expect(tx[1].Put).toMatchObject({ TableName: 'audit', ConditionExpression: 'attribute_not_exists(ts)' });
    doc.fail = true;
    expect(await r.save(rec({ version: 6 }), 5)).toBe(false);
    expect(await r.save(rec({ version: 9 }), 5)).toBe(false); // wrong version, no write
    expect(await r.get('idem#x')).toBeNull();
    expect(await r.get('arch#u1#t')).toBeNull();
  });

  it('releasePan is a conditional delete on the owner; archive moves the minimised case in one transaction', async () => {
    const doc = new FakeDoc();
    const r = new DynamoCaseStore(doc, 'cases', 'audit');
    await r.releasePan('h1', 'u1');
    expect(doc.sent[0]).toMatchObject({
      name: 'DeleteCommand', input: { Key: { userId: 'pan#h1' }, ConditionExpression: 'ownerId = :me', ExpressionAttributeValues: { ':me': 'u1' } },
    });
    doc.item = rec({ version: 4 }) as unknown as Record<string, unknown>;
    const row = { userId: 'u1', ts: 't', actor: 'system' as const, action: 'kyc.case-archived' as const, before: null, after: null };
    expect(await r.archive('u1', 3, 'T', row)).toBe(false); // stale version: no write
    expect(await r.archive('u1', 4, 'T', row)).toBe(true);
    const tx = doc.sent.at(-1)!.input.TransactItems;
    expect(tx[0].Put.Item).toMatchObject({ userId: 'arch#u1#T', archivedAt: 'T', record: { userId: 'u1', status: 'pre-verified' } });
    expect(tx[0].Put.Item).not.toHaveProperty('status'); // stays out of the byStatus GSI
    expect(tx[0].Put.Item.record).not.toHaveProperty('panEnc');
    expect(tx[1].Delete).toMatchObject({ Key: { userId: 'u1' }, ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': 4 } });
    expect(tx[2].Put).toMatchObject({ TableName: 'audit' });
    expect(await r.remove('u1', 4, row)).toBe(true);
    expect(doc.sent.at(-1)!.input.TransactItems[0].Delete).toMatchObject({ Key: { userId: 'u1' } });
    doc.fail = true;
    await r.releasePan('h1', 'u2'); // another owner: swallowed
    expect(await r.remove('u1', 4, row)).toBe(false);
  });

  it('idempotency records live under idem# keys with a TTL; claim is conditional (or the old one expired)', async () => {
    const doc = new FakeDoc();
    const r = new DynamoIdempotencyRepo(doc, 'cases');
    expect(await r.claim(idem(), 10)).toBe(true);
    expect(doc.sent[0]!.input).toMatchObject({
      Item: { userId: 'idem#abc', state: 'pending', expiresAt: 1000 },
      ConditionExpression: 'attribute_not_exists(userId) OR expiresAt <= :now',
      ExpressionAttributeValues: { ':now': 10 },
    });
    doc.item = { userId: 'idem#abc', requestHash: 'h', state: 'done', response: { status: 200, body: {} }, createdAt: 1, expiresAt: 1000 };
    expect(await r.get('abc', 10)).toEqual({ id: 'abc', requestHash: 'h', state: 'done', response: { status: 200, body: {} }, createdAt: 1, expiresAt: 1000 });
    expect(await r.get('abc', 1000)).toBeNull(); // expired but not yet swept by TTL
    doc.fail = true;
    expect(await r.claim(idem(), 10)).toBe(false);
    await r.release('abc'); // condition failure swallowed
    expect(doc.sent.at(-1)!.name).toBe('DeleteCommand');
  });

  it('cost cap is an atomic conditional ADD on cap#<day>; signings on sign#<day>', async () => {
    const doc = new FakeDoc();
    const r = new DynamoCostRepo(doc, 'costs');
    expect(await r.reserve('u1', '2026-11-06', 5)).toBe(true);
    expect(doc.sent[0]!.input).toMatchObject({
      Key: { month: 'cap#2026-11-06', checkId: 'u1' }, UpdateExpression: 'ADD #n :one', ExpressionAttributeValues: { ':max': 5 },
    });
    expect(await r.reserveSignings('u1', '2026-11-06', 3, 9)).toBe(true);
    expect(doc.sent[1]!.input).toMatchObject({
      Key: { month: 'sign#2026-11-06', checkId: 'u1' }, UpdateExpression: 'ADD #n :n', ExpressionAttributeValues: { ':n': 3, ':room': 6 },
    });
    expect(await r.reserveSignings('u1', '2026-11-06', 10, 9)).toBe(false);
    doc.fail = true;
    expect(await r.reserve('u1', '2026-11-06', 5)).toBe(false);
    expect(await r.reserveSignings('u1', '2026-11-06', 1, 9)).toBe(false);
    doc.item = { count: 3 };
    expect(await r.used('u1', '2026-11-06')).toBe(3);
  });

  it('consents: append-only put; latest is a newest-first query on <purpose>#', async () => {
    const doc = new FakeDoc();
    const r = new DynamoConsentRepo(doc, 'consents');
    await r.record({ userId: 'u1', sk: 'esign#T#n', purpose: 'esign', action: 'given', at: 'T' });
    expect(doc.sent[0]!.input).toMatchObject({ TableName: 'consents', Item: { userId: 'u1', sk: 'esign#T#n' }, ConditionExpression: 'attribute_not_exists(sk)' });
    doc.items = [{ userId: 'u1', sk: 'esign#T#n', purpose: 'esign', action: 'given', at: 'T' }];
    expect((await r.latest('u1', 'esign'))!.action).toBe('given');
    expect(doc.sent[1]!.input).toMatchObject({
      KeyConditionExpression: 'userId = :u AND begins_with(sk, :p)', ExpressionAttributeValues: { ':u': 'u1', ':p': 'esign#' },
      ScanIndexForward: false, Limit: 1,
    });
    doc.items = [];
    expect(await r.latest('u1', 'pan-check')).toBeNull();
  });
});
