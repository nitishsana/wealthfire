// Storage the KYC routes use. Cases and audit rows live in the ONE shared store (src/store, also
// used by the webhook and the review routes); this file adds idempotency records and paid-check
// costs. In-memory implementations for tests, DynamoDB for Lambda.
//
// DynamoDB layout (tables from the CDK stack; case / audit layout in src/store/types.ts):
//   kyc_cases pk userId        `idem#<hash>` items hold idempotency records (no `status`
//                               attribute, so they stay out of the byStatus GSI)
//   costs     pk month, sk checkId
//                               one row per paid check (month = yyyy-mm); `cap#<yyyy-mm-dd>` /
//                               `<userId>` rows hold the per-user daily paid-check counter
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requireEnv, TABLE_ENV, type Env } from '../lib/env';
import type { DocClient } from '../lib/repo';
import type { PaidCheck } from '../partner/types';
import { DynamoAuditStore, DynamoCaseStore, isConditionFailure } from '../store/dynamo';
import { MemoryAuditStore, MemoryCaseStore } from '../store/memory';
import { IDEM_PREFIX, type AuditRow, type AuditStore, type CaseEvidence, type CaseStore } from '../store/types';

export type { CaseSnapshot, KycCaseRecord, Timeout } from '../store/types';

/** The case evidence (one shape for the KYC routes and the webhook). */
export type KycEvidence = CaseEvidence;
/** One audit row (shared shape). */
export type KycAuditRow = AuditRow;
/** The part of the shared case store the KYC routes use. */
export type KycCaseRepo = Pick<CaseStore, 'get' | 'save' | 'claimPan'>;
export type KycAuditRepo = AuditStore;

/** Stored result of a request made with an Idempotency-Key. */
export interface IdempotencyRecord {
  /** sha256 of userId + route + key */
  id: string;
  /** keyed hash of the request body, so a reused key with a different body is refused */
  requestHash: string;
  state: 'pending' | 'done';
  response?: { status: number; body: Record<string, unknown> };
  createdAt: number;
}

export interface IdempotencyRepo {
  get(id: string): Promise<IdempotencyRecord | null>;
  /** Creates a pending record. False if one already exists. */
  claim(rec: IdempotencyRecord): Promise<boolean>;
  complete(id: string, response: { status: number; body: Record<string, unknown> }): Promise<void>;
  /** Drops a pending record (the request failed before any paid call). */
  release(id: string): Promise<void>;
}

export interface CostRow {
  /** yyyy-mm */
  month: string;
  checkId: string;
  check: PaidCheck;
  costInr: number;
  userId: string;
  at: string;
}

export interface CostRepo {
  /** Atomically counts one paid check for user on day (yyyy-mm-dd) while below max. False when the cap is reached. */
  reserve(userId: string, day: string, max: number): Promise<boolean>;
  /** Paid checks counted today. */
  used(userId: string, day: string): Promise<number>;
  record(row: CostRow): Promise<void>;
}

const clone = <T>(v: T): T => structuredClone(v);

// ---------- In-memory ----------

export class MemoryIdempotencyRepo implements IdempotencyRepo {
  readonly items = new Map<string, IdempotencyRecord>();
  async get(id: string): Promise<IdempotencyRecord | null> {
    const r = this.items.get(id);
    return r ? clone(r) : null;
  }
  async claim(rec: IdempotencyRecord): Promise<boolean> {
    if (this.items.has(rec.id)) return false;
    this.items.set(rec.id, clone(rec));
    return true;
  }
  async complete(id: string, response: { status: number; body: Record<string, unknown> }): Promise<void> {
    const r = this.items.get(id);
    if (r) {
      r.state = 'done';
      r.response = clone(response);
    }
  }
  async release(id: string): Promise<void> {
    if (this.items.get(id)?.state === 'pending') this.items.delete(id);
  }
}

export class MemoryCostRepo implements CostRepo {
  readonly rows: CostRow[] = [];
  private readonly counters = new Map<string, number>();
  async reserve(userId: string, day: string, max: number): Promise<boolean> {
    const k = `${day}#${userId}`;
    const n = this.counters.get(k) ?? 0;
    if (n >= max) return false;
    this.counters.set(k, n + 1);
    return true;
  }
  async used(userId: string, day: string): Promise<number> {
    return this.counters.get(`${day}#${userId}`) ?? 0;
  }
  async record(row: CostRow): Promise<void> {
    this.rows.push(clone(row));
  }
}

export interface KycRepos {
  cases: KycCaseRepo;
  audit: KycAuditRepo;
  idempotency: IdempotencyRepo;
  costs: CostRepo;
}

export function memoryKycRepos(): {
  cases: MemoryCaseStore; audit: MemoryAuditStore; idempotency: MemoryIdempotencyRepo; costs: MemoryCostRepo;
} {
  const audit = new MemoryAuditStore();
  return { cases: new MemoryCaseStore(audit), audit, idempotency: new MemoryIdempotencyRepo(), costs: new MemoryCostRepo() };
}

// ---------- DynamoDB ----------

export interface KycTableNames {
  cases: string;
  audit: string;
  costs: string;
}

/** Table names from env (TABLE_KYC_CASES / TABLE_AUDIT / TABLE_COSTS, set by the CDK stack). */
export function kycTablesFromEnv(env: Env = process.env): KycTableNames {
  return {
    cases: requireEnv(env, TABLE_ENV.kycCases),
    audit: requireEnv(env, TABLE_ENV.audit),
    costs: requireEnv(env, TABLE_ENV.costs),
  };
}

const CAP_PREFIX = 'cap#';

export class DynamoIdempotencyRepo implements IdempotencyRepo {
  constructor(private readonly doc: DocClient, private readonly table: string) {}

  async get(id: string): Promise<IdempotencyRecord | null> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { userId: IDEM_PREFIX + id }, ConsistentRead: true }));
    if (!out.Item) return null;
    const { userId: _k, ...rest } = out.Item;
    return { ...(rest as Omit<IdempotencyRecord, 'id'>), id };
  }

  async claim(rec: IdempotencyRecord): Promise<boolean> {
    const { id, ...rest } = rec;
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table,
        Item: { userId: IDEM_PREFIX + id, ...rest },
        ConditionExpression: 'attribute_not_exists(userId)',
      }));
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  async complete(id: string, response: { status: number; body: Record<string, unknown> }): Promise<void> {
    await this.doc.send(new UpdateCommand({
      TableName: this.table,
      Key: { userId: IDEM_PREFIX + id },
      UpdateExpression: 'SET #st = :d, #r = :r',
      ExpressionAttributeNames: { '#st': 'state', '#r': 'response' },
      ExpressionAttributeValues: { ':d': 'done', ':r': response },
    }));
  }

  async release(id: string): Promise<void> {
    try {
      await this.doc.send(new DeleteCommand({
        TableName: this.table,
        Key: { userId: IDEM_PREFIX + id },
        ConditionExpression: '#st = :p',
        ExpressionAttributeNames: { '#st': 'state' },
        ExpressionAttributeValues: { ':p': 'pending' },
      }));
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
    }
  }
}

export class DynamoCostRepo implements CostRepo {
  constructor(private readonly doc: DocClient, private readonly table: string) {}

  async reserve(userId: string, day: string, max: number): Promise<boolean> {
    try {
      await this.doc.send(new UpdateCommand({
        TableName: this.table,
        Key: { month: CAP_PREFIX + day, checkId: userId },
        UpdateExpression: 'ADD #n :one',
        ConditionExpression: 'attribute_not_exists(#n) OR #n < :max',
        ExpressionAttributeNames: { '#n': 'count' },
        ExpressionAttributeValues: { ':one': 1, ':max': max },
      }));
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  async used(userId: string, day: string): Promise<number> {
    const out = await this.doc.send(new GetCommand({
      TableName: this.table, Key: { month: CAP_PREFIX + day, checkId: userId }, ConsistentRead: true,
    }));
    return (out.Item?.count as number | undefined) ?? 0;
  }

  async record(row: CostRow): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...row } }));
  }
}

/** KYC repos over DynamoDB; `cases` / `audit` are the shared store. */
export function dynamoKycRepos(tables: KycTableNames, doc: DocClient): {
  cases: DynamoCaseStore; audit: DynamoAuditStore; idempotency: DynamoIdempotencyRepo; costs: DynamoCostRepo;
} {
  return {
    cases: new DynamoCaseStore(doc, tables.cases, tables.audit),
    audit: new DynamoAuditStore(doc, tables.audit),
    idempotency: new DynamoIdempotencyRepo(doc, tables.cases),
    costs: new DynamoCostRepo(doc, tables.costs),
  };
}
