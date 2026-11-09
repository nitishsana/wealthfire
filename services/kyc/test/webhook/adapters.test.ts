import { describe, expect, it } from 'vitest';
import { secretFrom } from '../../src/handlers/webhook';
import { DynamoSeenEventStore, DynamoWebhookAuditLog, DynamoWebhookCaseStore, webhookTablesFromEnv } from '../../src/webhook/dynamo';
import { HmacWebhookVerifier, signBody } from '../../src/webhook/hmac';
import { MemorySeenEventStore } from '../../src/webhook/memory';
import type { DocClient } from '../../src/lib/repo';
import { FakePartner } from '../../src/partner/fake';
import type { WebhookVerifier } from '../../src/webhook/ports';
import { baseCase, baseEvidence, SECRET } from './helpers';

type Cmd = { constructor: { name: string }; input: Record<string, any> };

function fakeDoc(respond: (cmd: Cmd) => unknown = () => ({})) {
  const calls: Cmd[] = [];
  const doc = {
    send: async (cmd: Cmd) => {
      calls.push(cmd);
      const r = respond(cmd);
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as DocClient;
  return { doc, calls };
}

const condFail = () => Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });

describe('HmacWebhookVerifier', () => {
  const v = new HmacWebhookVerifier(SECRET);
  const body = '{"a":1}';
  it('accepts hex with or without sha256= prefix', () => {
    expect(v.verifyWebhook({ 'x-webhook-signature': signBody(SECRET, body) }, body)).toBe(true);
    expect(v.verifyWebhook({ 'x-webhook-signature': `sha256=${signBody(SECRET, body)}` }, body)).toBe(true);
  });
  it('rejects a changed body, wrong secret, bad format or missing header', () => {
    expect(v.verifyWebhook({ 'x-webhook-signature': signBody(SECRET, body) }, '{"a":2}')).toBe(false);
    expect(v.verifyWebhook({ 'x-webhook-signature': signBody('other-secret-other-secret', body) }, body)).toBe(false);
    expect(v.verifyWebhook({ 'x-webhook-signature': 'zz' }, body)).toBe(false);
    expect(v.verifyWebhook({}, body)).toBe(false);
  });
  it('refuses a short secret', () => {
    expect(() => new HmacWebhookVerifier('short')).toThrow();
  });
});

describe('KycPartner compatibility', () => {
  it('FakePartner satisfies WebhookVerifier and its signatures pass the handler check', () => {
    const fake = new FakePartner({ webhookSecret: SECRET });
    const v: WebhookVerifier = fake;
    const body = '{"a":1}';
    expect(v.verifyWebhook(fake.sign(body), body)).toBe(true);
    expect(v.verifyWebhook(fake.sign(body), '{"a":2}')).toBe(false);
  });
});

describe('MemorySeenEventStore', () => {
  it('claim → duplicate while leased/done; release frees it; TTL expiry frees it', async () => {
    const s = new MemorySeenEventStore();
    expect(await s.claim('e', 0, 100, 1000)).toBe('claimed');
    expect(await s.claim('e', 50, 100, 1000)).toBe('duplicate');
    await s.release('e');
    expect(await s.claim('e', 60, 100, 1000)).toBe('claimed');
    await s.complete('e', 70, 1000);
    await s.release('e'); // no-op on a done event
    expect(await s.claim('e', 500, 100, 1000)).toBe('duplicate');
    expect(await s.claim('e', 1070, 100, 1000)).toBe('claimed');
  });
});

describe('DynamoSeenEventStore', () => {
  it('claims with a conditional put and maps a condition failure to duplicate', async () => {
    const ok = fakeDoc();
    expect(await new DynamoSeenEventStore(ok.doc, 'events').claim('e1', 10_000, 60_000, 86_400_000)).toBe('claimed');
    const put = ok.calls[0]!;
    expect(put.constructor.name).toBe('PutCommand');
    expect(put.input).toMatchObject({ TableName: 'events', Item: { eventId: 'e1', state: 'processing', leaseUntil: 70_000, expiresAt: 86_410 } });
    expect(put.input.ConditionExpression).toContain('attribute_not_exists(eventId)');
    const dup = fakeDoc(condFail);
    expect(await new DynamoSeenEventStore(dup.doc, 'events').claim('e1', 0, 1, 1)).toBe('duplicate');
  });
  it('rethrows other errors; release ignores a condition failure', async () => {
    const boom = fakeDoc(() => new Error('throttled'));
    await expect(new DynamoSeenEventStore(boom.doc, 'events').claim('e1', 0, 1, 1)).rejects.toThrow('throttled');
    const cf = fakeDoc(condFail);
    await expect(new DynamoSeenEventStore(cf.doc, 'events').release('e1')).resolves.toBeUndefined();
  });
  it('complete writes state done with a TTL', async () => {
    const f = fakeDoc();
    await new DynamoSeenEventStore(f.doc, 'events').complete('e1', 1000, 2000);
    expect(f.calls[0]!.input.Item).toEqual({ eventId: 'e1', state: 'done', leaseUntil: 0, expiresAt: 3 });
  });
});

describe('DynamoWebhookCaseStore', () => {
  it('get splits the item into case and evidence (null when missing)', async () => {
    const ev = baseEvidence();
    const f = fakeDoc(() => ({ Item: { ...baseCase(), evidence: ev, otherAttr: 'x' } }));
    const got = await new DynamoWebhookCaseStore(f.doc, 'cases', 'audit').get('user-1');
    expect(got!.kycCase).toEqual(baseCase());
    expect(got!.evidence).toEqual(ev);
    expect(f.calls[0]!.input).toMatchObject({ TableName: 'cases', Key: { userId: 'user-1' }, ConsistentRead: true });
    const noEv = fakeDoc(() => ({ Item: { ...baseCase() } }));
    expect((await new DynamoWebhookCaseStore(noEv.doc, 'cases', 'audit').get('user-1'))!.evidence).toBeNull();
    const none = fakeDoc(() => ({}));
    expect(await new DynamoWebhookCaseStore(none.doc, 'cases', 'audit').get('user-1')).toBeNull();
  });

  it('save is one transaction: version-checked update + audit put; conflict on condition failure', async () => {
    const before = baseCase();
    const after = { ...before, status: 'verified' as const, version: 2 };
    const audit = {
      userId: 'user-1', ts: 't#e1', actor: 'system' as const, action: 'webhook.kyc-result' as const,
      eventId: 'e1', outcome: 'applied' as const, before: null, after: null,
    };
    const f = fakeDoc();
    const store = new DynamoWebhookCaseStore(f.doc, 'cases', 'audit');
    expect(await store.save({ before, after, evidence: baseEvidence(), audit })).toBe('ok');
    const tx = f.calls[0]!;
    expect(tx.constructor.name).toBe('TransactWriteCommand');
    const [upd, put] = tx.input.TransactItems;
    expect(upd.Update.ConditionExpression).toBe('#version = :expected');
    expect(upd.Update.ExpressionAttributeValues).toMatchObject({ ':expected': 1, ':next': 2, ':status': 'verified' });
    expect(upd.Update.UpdateExpression).not.toContain('masks');
    expect(put.Put).toMatchObject({ TableName: 'audit', Item: audit });
    const tc = fakeDoc(() => Object.assign(new Error('tx'), { name: 'TransactionCanceledException' }));
    expect(await new DynamoWebhookCaseStore(tc.doc, 'cases', 'audit').save({ before, after, evidence: baseEvidence(), audit })).toBe('conflict');
  });

  it('audit log puts the row', async () => {
    const f = fakeDoc();
    const row = { userId: 'u', ts: 't', actor: 'system' as const, action: 'webhook.esign' as const, eventId: 'e', outcome: 'ignored-terminal' as const, before: null, after: null };
    await new DynamoWebhookAuditLog(f.doc, 'audit').write(row);
    expect(f.calls[0]!.input).toEqual({ TableName: 'audit', Item: row });
  });
});

describe('env and secret', () => {
  it('reads table names from env and fails on a missing one', () => {
    expect(webhookTablesFromEnv({ TABLE_KYC_CASES: 'c', TABLE_AUDIT: 'a', WEBHOOK_EVENTS_TABLE: 'e' })).toEqual({ cases: 'c', audit: 'a', events: 'e' });
    expect(() => webhookTablesFromEnv({ TABLE_KYC_CASES: 'c', TABLE_AUDIT: 'a' })).toThrow('WEBHOOK_EVENTS_TABLE');
  });
  it('secretFrom accepts a plain string or {"secret"}', () => {
    expect(secretFrom('  abc  ')).toBe('abc');
    expect(secretFrom('{"secret":"xyz"}')).toBe('xyz');
    expect(() => secretFrom('{"other":1}')).toThrow();
  });
});
