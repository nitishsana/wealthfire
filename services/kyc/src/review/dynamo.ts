// DynamoDB implementations of the review ports. Uses the `kyc_cases` GSI `byStatus`
// (partition status, sort updatedAt) and the `audit` table (partition userId, sort ts).
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DocClient } from '../lib/repo';
import type { KycCase } from '../types';
import { BadCursorError, type AuditEntry, type AuditLog, type CasePage, type ReviewCaseStore } from './ports';

const STATUS_INDEX = 'byStatus';

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) return undefined;
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Only accepts the exact key shape this store issues. */
function decodeCursor(cursor: string): Record<string, string> {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    const keys = Object.keys(v).sort().join(',');
    if (keys === 'status,updatedAt,userId' && v.status === 'under-review'
      && typeof v.updatedAt === 'string' && typeof v.userId === 'string') {
      return v as Record<string, string>;
    }
  } catch {
    /* fall through */
  }
  throw new BadCursorError();
}

function isConditionFailure(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
}

export class DynamoReviewCaseStore implements ReviewCaseStore {
  constructor(
    private readonly doc: DocClient,
    private readonly casesTable: string,
    private readonly auditTable: string,
  ) {}

  async listUnderReview(q: { limit: number; cursor?: string }): Promise<CasePage> {
    const out = await this.doc.send(new QueryCommand({
      TableName: this.casesTable,
      IndexName: STATUS_INDEX,
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'under-review' },
      ScanIndexForward: false,
      Limit: q.limit,
      ...(q.cursor ? { ExclusiveStartKey: decodeCursor(q.cursor) } : {}),
    }));
    const next = encodeCursor(out.LastEvaluatedKey);
    return { items: (out.Items ?? []) as KycCase[], ...(next ? { nextCursor: next } : {}) };
  }

  async get(userId: string): Promise<KycCase | null> {
    const out = await this.doc.send(new GetCommand({ TableName: this.casesTable, Key: { userId }, ConsistentRead: true }));
    return (out.Item as KycCase | undefined) ?? null;
  }

  async saveDecision(w: { before: KycCase; after: KycCase; audit: AuditEntry }): Promise<'ok' | 'conflict'> {
    try {
      await this.doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.casesTable,
              Item: { ...w.after },
              ConditionExpression: 'version = :v AND #s = :s',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':v': w.before.version, ':s': 'under-review' },
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
      }));
      return 'ok';
    } catch (e) {
      if (isConditionFailure(e)) return 'conflict';
      throw e;
    }
  }
}

export class DynamoAuditLog implements AuditLog {
  constructor(private readonly doc: DocClient, private readonly table: string) {}

  async write(entry: AuditEntry): Promise<void> {
    await this.doc.send(new PutCommand({
      TableName: this.table,
      Item: { ...entry },
      ConditionExpression: 'attribute_not_exists(ts)',
    }));
  }

  async listForUser(userId: string, limit: number): Promise<AuditEntry[]> {
    const out = await this.doc.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ScanIndexForward: false,
      Limit: limit,
    }));
    return (out.Items ?? []) as AuditEntry[];
  }
}
