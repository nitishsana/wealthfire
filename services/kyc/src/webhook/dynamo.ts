// DynamoDB adapters for the webhook.
//
//   kyc_cases            pk userId    the KycCase fields + `evidence` (CaseEvidence). The webhook only
//                                     UPDATES the fields it owns, so attributes other writers add stay.
//   audit                pk userId, sk ts
//   WEBHOOK_EVENTS_TABLE pk eventId   { state: 'processing' | 'done', leaseUntil (ms), expiresAt (s, TTL) }
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DocClient } from '../lib/repo';
import type { KycCase } from '../types';
import type {
  CaseEvidence, SeenEventStore, StoredCase, WebhookAuditEntry, WebhookAuditLog, WebhookCaseStore,
} from './ports';

const ttlSeconds = (ms: number): number => Math.ceil(ms / 1000);

function isConditionFailure(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
}

export class DynamoSeenEventStore implements SeenEventStore {
  constructor(private readonly doc: DocClient, private readonly table: string) {}

  async claim(eventId: string, now: number, leaseMs: number, ttlMs: number): Promise<'claimed' | 'duplicate'> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { eventId, state: 'processing', leaseUntil: now + leaseMs, expiresAt: ttlSeconds(now + ttlMs) },
          // New id, a crashed run's lease that ran out, or an expired item TTL has not removed yet.
          ConditionExpression:
            'attribute_not_exists(eventId) OR (#s = :processing AND leaseUntil < :now) OR expiresAt <= :nowSec',
          ExpressionAttributeNames: { '#s': 'state' },
          ExpressionAttributeValues: { ':processing': 'processing', ':now': now, ':nowSec': Math.floor(now / 1000) },
        }),
      );
      return 'claimed';
    } catch (e) {
      if (isConditionFailure(e)) return 'duplicate';
      throw e;
    }
  }

  async complete(eventId: string, now: number, ttlMs: number): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { eventId, state: 'done', leaseUntil: 0, expiresAt: ttlSeconds(now + ttlMs) },
      }),
    );
  }

  async release(eventId: string): Promise<void> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { eventId },
          ConditionExpression: '#s = :processing',
          ExpressionAttributeNames: { '#s': 'state' },
          ExpressionAttributeValues: { ':processing': 'processing' },
        }),
      );
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
    }
  }
}

const CASE_FIELDS = ['userId', 'status', 'path', 'masks', 'partnerRefs', 'checks', 'reason', 'note', 'updatedAt', 'version'] as const;

export class DynamoWebhookCaseStore implements WebhookCaseStore {
  constructor(private readonly doc: DocClient, private readonly casesTable: string, private readonly auditTable: string) {}

  async get(userId: string): Promise<StoredCase | null> {
    const out = await this.doc.send(new GetCommand({ TableName: this.casesTable, Key: { userId }, ConsistentRead: true }));
    const i = out.Item;
    if (!i) return null;
    const c: Record<string, unknown> = {};
    for (const k of CASE_FIELDS) if (i[k] !== undefined) c[k] = i[k];
    const kycCase = {
      path: null,
      reason: null,
      partnerRefs: {},
      checks: {},
      masks: { pan: '', aadhaar: '' },
      version: 0,
      ...c,
    } as unknown as KycCase;
    const evidence = (i.evidence as CaseEvidence | undefined) ?? null;
    return { kycCase, evidence };
  }

  async save(w: { before: KycCase; after: KycCase; evidence: CaseEvidence; audit: WebhookAuditEntry }): Promise<'ok' | 'conflict'> {
    const a = w.after;
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.casesTable,
                Key: { userId: w.before.userId },
                UpdateExpression:
                  'SET #status = :status, #path = :path, #reason = :reason, #checks = :checks, ' +
                  '#refs = :refs, #evidence = :evidence, #updatedAt = :updatedAt, #version = :next',
                ConditionExpression: '#version = :expected',
                ExpressionAttributeNames: {
                  '#status': 'status', '#path': 'path', '#reason': 'reason', '#checks': 'checks', '#refs': 'partnerRefs',
                  '#evidence': 'evidence', '#updatedAt': 'updatedAt', '#version': 'version',
                },
                ExpressionAttributeValues: {
                  ':status': a.status, ':path': a.path, ':reason': a.reason, ':checks': a.checks, ':refs': a.partnerRefs,
                  ':evidence': w.evidence, ':updatedAt': a.updatedAt, ':next': a.version, ':expected': w.before.version,
                },
              },
            },
            {
              Put: {
                TableName: this.auditTable,
                Item: { ...w.audit },
                ConditionExpression: 'attribute_not_exists(ts)',
              },
            },
          ],
        }),
      );
      return 'ok';
    } catch (e) {
      if (isConditionFailure(e)) return 'conflict';
      throw e;
    }
  }
}

export class DynamoWebhookAuditLog implements WebhookAuditLog {
  constructor(private readonly doc: DocClient, private readonly table: string) {}

  async write(entry: WebhookAuditEntry): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...entry } }));
  }
}

/** Env var names (TABLE_KYC_CASES / TABLE_AUDIT match infra/stack.ts; WEBHOOK_EVENTS_TABLE is new). */
export const WEBHOOK_ENV = {
  cases: 'TABLE_KYC_CASES',
  audit: 'TABLE_AUDIT',
  events: 'WEBHOOK_EVENTS_TABLE',
  secretArn: 'WEBHOOK_SECRET_ARN',
} as const;

export interface WebhookTables {
  cases: string;
  audit: string;
  events: string;
}

export function webhookTablesFromEnv(env: Record<string, string | undefined> = process.env): WebhookTables {
  const get = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`Missing env ${k}`);
    return v;
  };
  return { cases: get(WEBHOOK_ENV.cases), audit: get(WEBHOOK_ENV.audit), events: get(WEBHOOK_ENV.events) };
}

export function dynamoWebhookStores(t: WebhookTables, doc: DocClient) {
  return {
    cases: new DynamoWebhookCaseStore(doc, t.cases, t.audit),
    audit: new DynamoWebhookAuditLog(doc, t.audit),
    seen: new DynamoSeenEventStore(doc, t.events),
  };
}
