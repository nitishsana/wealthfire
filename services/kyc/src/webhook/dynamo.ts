// DynamoDB wiring for the webhook.
//
//   kyc_cases / audit     the shared store (src/store/dynamo.ts) through webhookCaseStore(); the
//                         webhook only UPDATES the case fields it owns, so other attributes stay.
//   TABLE_WEBHOOK_EVENTS  pk eventId   { state: 'processing' | 'done', leaseUntil (ms), expiresAt (s, TTL) }
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ENV, requireEnv, TABLE_ENV, type Env } from '../lib/env';
import type { DocClient } from '../lib/repo';
import { DynamoAuditStore, DynamoCaseStore, isConditionFailure } from '../store/dynamo';
import { webhookCaseStore } from '../store/views';
import type { SeenEventStore, WebhookAuditLog, WebhookCaseStore } from './ports';

const ttlSeconds = (ms: number): number => Math.ceil(ms / 1000);

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

/** Env var names the webhook Lambda reads (the shared scheme in src/lib/env.ts). */
export const WEBHOOK_ENV = {
  cases: TABLE_ENV.kycCases,
  audit: TABLE_ENV.audit,
  events: TABLE_ENV.webhookEvents,
  secretArn: ENV.webhookSecretArn,
} as const;

export interface WebhookTables {
  cases: string;
  audit: string;
  events: string;
}

export function webhookTablesFromEnv(env: Env = process.env): WebhookTables {
  return {
    cases: requireEnv(env, WEBHOOK_ENV.cases),
    audit: requireEnv(env, WEBHOOK_ENV.audit),
    events: requireEnv(env, WEBHOOK_ENV.events),
  };
}

export function dynamoWebhookStores(t: WebhookTables, doc: DocClient): {
  cases: WebhookCaseStore; audit: WebhookAuditLog; seen: DynamoSeenEventStore;
} {
  return {
    cases: webhookCaseStore(new DynamoCaseStore(doc, t.cases, t.audit)),
    audit: new DynamoAuditStore(doc, t.audit),
    seen: new DynamoSeenEventStore(doc, t.events),
  };
}
