// DynamoDB CaseStore + AuditStore (layout in ./types.ts). Uses the `kyc_cases` GSI `byStatus`
// (partition status, sort updatedAt) and the `audit` table (partition userId, sort ts).
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DocClient } from '../lib/repo';
import {
  BadCursorError, PAN_PREFIX, isCaseKey,
  type AuditRow, type AuditStore, type CasePage, type CaseStore, type CaseUpdate, type KycCaseRecord,
} from './types';

export const STATUS_INDEX = 'byStatus';
const AUDIT_PAGE_MAX = 100;

export function isConditionFailure(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
}

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

const auditPut = (table: string, row: AuditRow) => ({
  TableName: table,
  Item: { ...row },
  ConditionExpression: 'attribute_not_exists(ts)',
});

export class DynamoCaseStore implements CaseStore {
  constructor(private readonly doc: DocClient, private readonly table: string, private readonly auditTable: string) {}

  async get(userId: string): Promise<KycCaseRecord | null> {
    if (!isCaseKey(userId)) return null;
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { userId }, ConsistentRead: true }));
    return (out.Item as KycCaseRecord | undefined) ?? null;
  }

  async save(rec: KycCaseRecord, expectedVersion: number, audit?: AuditRow): Promise<boolean> {
    if (rec.version !== expectedVersion + 1 || !isCaseKey(rec.userId)) return false;
    const put = {
      TableName: this.table,
      Item: { ...rec },
      ...(expectedVersion === 0
        ? { ConditionExpression: 'attribute_not_exists(userId)' }
        : { ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': expectedVersion } }),
    };
    try {
      if (audit) {
        await this.doc.send(new TransactWriteCommand({ TransactItems: [{ Put: put }, { Put: auditPut(this.auditTable, audit) }] }));
      } else {
        await this.doc.send(new PutCommand(put));
      }
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  async update(u: CaseUpdate): Promise<'ok' | 'conflict'> {
    const names: Record<string, string> = { '#version': 'version' };
    const values: Record<string, unknown> = { ':expected': u.expectedVersion, ':next': u.expectedVersion + 1 };
    const sets = ['#version = :next'];
    let i = 0;
    for (const [k, v] of Object.entries(u.set)) {
      if (v === undefined) continue;
      i++;
      names[`#f${i}`] = k;
      values[`:f${i}`] = v;
      sets.push(`#f${i} = :f${i}`);
    }
    const removes = (u.remove ?? []).map((k, j) => {
      names[`#r${j}`] = k;
      return `#r${j}`;
    });
    let condition = 'attribute_exists(userId) AND #version = :expected';
    if (u.requireStatus !== undefined) {
      names['#status'] = 'status';
      values[':requireStatus'] = u.requireStatus;
      condition += ' AND #status = :requireStatus';
    }
    try {
      await this.doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.table,
              Key: { userId: u.userId },
              UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
              ConditionExpression: condition,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          },
          { Put: auditPut(this.auditTable, u.audit) },
        ],
      }));
      return 'ok';
    } catch (e) {
      if (isConditionFailure(e)) return 'conflict';
      throw e;
    }
  }

  async listUnderReview(q: { limit: number; cursor?: string }): Promise<CasePage> {
    const out = await this.doc.send(new QueryCommand({
      TableName: this.table,
      IndexName: STATUS_INDEX,
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'under-review' },
      ScanIndexForward: false,
      Limit: q.limit,
      ...(q.cursor ? { ExclusiveStartKey: decodeCursor(q.cursor) } : {}),
    }));
    const next = encodeCursor(out.LastEvaluatedKey);
    return { items: (out.Items ?? []) as KycCaseRecord[], ...(next ? { nextCursor: next } : {}) };
  }

  async claimPan(panHash: string, userId: string): Promise<boolean> {
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table,
        Item: { userId: PAN_PREFIX + panHash, ownerId: userId },
        ConditionExpression: 'attribute_not_exists(userId) OR ownerId = :me',
        ExpressionAttributeValues: { ':me': userId },
      }));
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }
}

export class DynamoAuditStore implements AuditStore {
  constructor(private readonly doc: DocClient, private readonly table: string) {}

  async write(row: AuditRow): Promise<void> {
    try {
      await this.doc.send(new PutCommand(auditPut(this.table, row)));
    } catch (e) {
      if (!isConditionFailure(e)) throw e; // the same row is already there
    }
  }

  async listForUser(userId: string, limit = AUDIT_PAGE_MAX): Promise<AuditRow[]> {
    const out = await this.doc.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ScanIndexForward: false,
      Limit: Math.min(limit, AUDIT_PAGE_MAX),
    }));
    return (out.Items ?? []) as AuditRow[];
  }
}

export function dynamoStore(doc: DocClient, tables: { cases: string; audit: string }): { cases: DynamoCaseStore; audit: DynamoAuditStore } {
  return { cases: new DynamoCaseStore(doc, tables.cases, tables.audit), audit: new DynamoAuditStore(doc, tables.audit) };
}
