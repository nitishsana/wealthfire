import { describe, expect, it } from 'vitest';
import {
  DynamoCostRepo, DynamoIdempotencyRepo, DynamoKycCaseRepo, kycTablesFromEnv, memoryKycRepos, type KycCaseRecord,
} from '../../src/kyc/repo';

const rec = (over: Partial<KycCaseRecord> = {}): KycCaseRecord => ({
  userId: 'u1', status: 'pre-verified', path: null, masks: { pan: 'XXXXXX234F', aadhaar: 'XXXX XXXX 1234' },
  partnerRefs: {}, checks: {}, reason: null, updatedAt: '2026-11-06T00:00:00.000Z', version: 1,
  createdAt: '2026-11-06T00:00:00.000Z', panEnc: 'l1.x', panHash: 'h',
  evidence: { typed: { firstName: 'A', lastName: 'B', dob: '1990-01-01' }, deviceHandCheck: false, otpAadhaarLast4: '1234', panIndividual: true },
  next: 'kra-lookup', ...over,
});

/** Records commands; fails conditional writes when `fail` is set. */
class FakeDoc {
  sent: { name: string; input: Record<string, any> }[] = [];
  fail = false;
  item: Record<string, unknown> | undefined;
  async send(cmd: { constructor: { name: string }; input: Record<string, any> }): Promise<any> {
    this.sent.push({ name: cmd.constructor.name, input: cmd.input });
    if (this.fail && (cmd.input.ConditionExpression || cmd.input.TransactItems)) {
      throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
    }
    return { Item: this.item };
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
    const row = { userId: 'u1', ts: 't#1', actor: 'system' as const, action: 'kyc.start', before: null, after: null };
    await r.cases.save(rec(), 0, row);
    expect(r.audit.rows).toEqual([row]);
    await expect(r.audit.write(row)).rejects.toThrow();
  });

  it('cost cap counter', async () => {
    const r = memoryKycRepos();
    expect(await r.costs.reserve('u', 'd', 2)).toBe(true);
    expect(await r.costs.reserve('u', 'd', 2)).toBe(true);
    expect(await r.costs.reserve('u', 'd', 2)).toBe(false);
    expect(await r.costs.reserve('u', 'd2', 2)).toBe(true);
    expect(await r.costs.used('u', 'd')).toBe(2);
  });
});

describe('DynamoDB KYC repos', () => {
  it('table names from the stack env (TABLE_*) or *_TABLE', () => {
    expect(kycTablesFromEnv({ TABLE_KYC_CASES: 'c', TABLE_AUDIT: 'a', TABLE_COSTS: 'k' })).toEqual({ cases: 'c', audit: 'a', costs: 'k' });
    expect(kycTablesFromEnv({ KYC_CASES_TABLE: 'c2', TABLE_AUDIT: 'a', TABLE_COSTS: 'k' }).cases).toBe('c2');
    expect(() => kycTablesFromEnv({})).toThrow(/KYC_CASES_TABLE/);
  });

  it('case save: create needs no item, update needs the version; audit in one transaction', async () => {
    const doc = new FakeDoc();
    const r = new DynamoKycCaseRepo(doc, 'cases', 'audit');
    expect(await r.save(rec(), 0)).toBe(true);
    expect(doc.sent[0]).toMatchObject({ name: 'PutCommand', input: { TableName: 'cases', ConditionExpression: 'attribute_not_exists(userId)' } });
    await r.save(rec({ version: 5 }), 4, { userId: 'u1', ts: 't', actor: 'system', action: 'a', before: null, after: null });
    const tx = doc.sent[1]!.input.TransactItems;
    expect(doc.sent[1]!.name).toBe('TransactWriteCommand');
    expect(tx[0].Put).toMatchObject({ TableName: 'cases', ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': 4 } });
    expect(tx[1].Put).toMatchObject({ TableName: 'audit', ConditionExpression: 'attribute_not_exists(ts)' });
    doc.fail = true;
    expect(await r.save(rec({ version: 6 }), 5)).toBe(false);
    expect(await r.save(rec({ version: 9 }), 5)).toBe(false); // wrong version, no write
    expect(await r.get('idem#x')).toBeNull();
  });

  it('idempotency records live under idem# keys; claim is conditional', async () => {
    const doc = new FakeDoc();
    const r = new DynamoIdempotencyRepo(doc, 'cases');
    expect(await r.claim({ id: 'abc', requestHash: 'h', state: 'pending', createdAt: 1 })).toBe(true);
    expect(doc.sent[0]!.input).toMatchObject({ Item: { userId: 'idem#abc', state: 'pending' }, ConditionExpression: 'attribute_not_exists(userId)' });
    doc.item = { userId: 'idem#abc', requestHash: 'h', state: 'done', response: { status: 200, body: {} }, createdAt: 1 };
    expect(await r.get('abc')).toEqual({ id: 'abc', requestHash: 'h', state: 'done', response: { status: 200, body: {} }, createdAt: 1 });
    doc.fail = true;
    expect(await r.claim({ id: 'abc', requestHash: 'h', state: 'pending', createdAt: 1 })).toBe(false);
    await r.release('abc'); // condition failure swallowed
    expect(doc.sent.at(-1)!.name).toBe('DeleteCommand');
  });

  it('cost cap is an atomic conditional ADD on cap#<day>', async () => {
    const doc = new FakeDoc();
    const r = new DynamoCostRepo(doc, 'costs');
    expect(await r.reserve('u1', '2026-11-06', 5)).toBe(true);
    expect(doc.sent[0]!.input).toMatchObject({
      Key: { month: 'cap#2026-11-06', checkId: 'u1' }, UpdateExpression: 'ADD #n :one', ExpressionAttributeValues: { ':max': 5 },
    });
    doc.fail = true;
    expect(await r.reserve('u1', '2026-11-06', 5)).toBe(false);
    doc.item = { count: 3 };
    expect(await r.used('u1', '2026-11-06')).toBe(3);
  });
});
