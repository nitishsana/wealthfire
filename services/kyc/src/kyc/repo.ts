// Storage for KYC cases, idempotency records, audit rows and paid-check costs. In-memory
// implementations for tests, DynamoDB for Lambda.
//
// DynamoDB layout (tables from the CDK stack):
//   kyc_cases pk userId        case items (KycCaseRecord); `idem#<hash>` items hold idempotency
//                               records (no `status` attribute, so they stay out of the byStatus GSI)
//   audit     pk userId, sk ts  one row per system decision (ts = ISO time + '#' + nonce)
//   costs     pk month, sk checkId
//                               one row per paid check (month = yyyy-mm); `cap#<yyyy-mm-dd>` /
//                               `<userId>` rows hold the per-user daily paid-check counter
//
// A case item never holds a full Aadhaar number, and the PAN only as Encryptor output (`panEnc`)
// plus an HMAC lookup key (`panHash`).
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DocClient } from '../lib/repo';
import type { PaidCheck } from '../partner/types';
import type { CheckName, KycCase, KycPath, KycStatus, NextStep, ReasonCode } from '../types';

export type Timeout = 'timeout';

/**
 * Everything decide() needs except the current status/reason (the `evidence` attribute; same
 * shape as the webhook's CaseEvidence, which may add its own bookkeeping fields). Masks only.
 */
export interface KycEvidence {
  /** device onboarding ended in a hand check */
  deviceHandCheck: boolean;
  /** typed at onboarding (names and DOB, used for the KRA name/DOB match) */
  typed: { firstName: string; lastName: string; dob: string };
  panIndividual: boolean;
  /** last 4 of the Aadhaar verified by the device Aadhaar OTP */
  otpAadhaarLast4: string;
  kra?: { status: 'validated' | 'registered' | 'on-hold' | 'not-found'; name?: string; dob?: string } | Timeout;
  aadhaar?: { verified: true; last4: string } | Timeout;
  pan?: { valid: boolean; nameMatch: boolean; aadhaarLinked: boolean } | Timeout;
  face?: ({ match: number; live: boolean } | Timeout)[];
  esign?: 'done' | 'pending' | Timeout;
}

/** One `kyc_cases` item: the shared KycCase fields plus what the KYC routes need. */
export interface KycCaseRecord extends KycCase {
  createdAt: string;
  /** Encryptor output of the normalised PAN (context {purpose:'pan', userId}) */
  panEnc: string;
  /** hmacLookup(mac, 'pan', PAN) */
  panHash: string;
  evidence: KycEvidence;
  /** last decided next step (re-derived from evidence on read, since webhooks may not update it) */
  next: NextStep;
  unclear?: CheckName[];
}

export interface KycCaseRepo {
  get(userId: string): Promise<KycCaseRecord | null>;
  /**
   * Writes `rec` (version must be expectedVersion + 1; expectedVersion 0 = must not exist) and,
   * in the same transaction, the audit row if given. False on a concurrent change.
   */
  save(rec: KycCaseRecord, expectedVersion: number, audit?: KycAuditRow): Promise<boolean>;
}

export interface CaseSnapshot {
  status: KycStatus;
  path: KycPath | null;
  reason: ReasonCode | null;
  version: number;
}

/** One `audit` item. Never holds PAN, Aadhaar, tokens or document data. */
export interface KycAuditRow {
  userId: string;
  /** ISO time + '#' + nonce */
  ts: string;
  actor: 'system' | `staff:${string}`;
  action: string;
  before: CaseSnapshot | null;
  after: CaseSnapshot | null;
  ip?: string;
}

export interface KycAuditRepo {
  write(row: KycAuditRow): Promise<void>;
  listForUser(userId: string): Promise<KycAuditRow[]>;
}

/** Stored result of a request made with an Idempotency-Key. */
export interface IdempotencyRecord {
  /** sha256 of userId + route + key */
  id: string;
  /** sha256 of the request body, so a reused key with a different body is refused */
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
  /** User-triggered paid checks counted today. */
  used(userId: string, day: string): Promise<number>;
  record(row: CostRow): Promise<void>;
}

const clone = <T>(v: T): T => structuredClone(v);

// ---------- In-memory ----------

export class MemoryKycCaseRepo implements KycCaseRepo {
  private readonly items = new Map<string, KycCaseRecord>();
  constructor(private readonly audit?: MemoryKycAuditRepo) {}

  async get(userId: string): Promise<KycCaseRecord | null> {
    const c = this.items.get(userId);
    return c ? clone(c) : null;
  }

  async save(rec: KycCaseRecord, expectedVersion: number, audit?: KycAuditRow): Promise<boolean> {
    const cur = this.items.get(rec.userId)?.version ?? 0;
    if (cur !== expectedVersion || rec.version !== expectedVersion + 1) return false;
    this.items.set(rec.userId, clone(rec));
    if (audit) await this.audit?.write(audit);
    return true;
  }

  /** @internal test hook: raw stored items */
  all(): KycCaseRecord[] {
    return [...this.items.values()].map(clone);
  }

  /** @internal test hook: simulate another writer (e.g. staff) changing the case */
  async put(rec: KycCaseRecord): Promise<void> {
    this.items.set(rec.userId, clone(rec));
  }
}

export class MemoryKycAuditRepo implements KycAuditRepo {
  readonly rows: KycAuditRow[] = [];
  async write(row: KycAuditRow): Promise<void> {
    if (this.rows.some((r) => r.userId === row.userId && r.ts === row.ts)) throw new Error('duplicate audit row');
    this.rows.push(clone(row));
  }
  async listForUser(userId: string): Promise<KycAuditRow[]> {
    return this.rows.filter((r) => r.userId === userId).map(clone);
  }
}

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
  cases: MemoryKycCaseRepo; audit: MemoryKycAuditRepo; idempotency: MemoryIdempotencyRepo; costs: MemoryCostRepo;
} {
  const audit = new MemoryKycAuditRepo();
  return { cases: new MemoryKycCaseRepo(audit), audit, idempotency: new MemoryIdempotencyRepo(), costs: new MemoryCostRepo() };
}

// ---------- DynamoDB ----------

export interface KycTableNames {
  cases: string;
  audit: string;
  costs: string;
}

/** Table names from env. Accepts the CDK stack's TABLE_* names and the KYC_CASES_TABLE style. */
export function kycTablesFromEnv(env: Record<string, string | undefined> = process.env): KycTableNames {
  const get = (...keys: string[]): string => {
    for (const k of keys) {
      const v = env[k];
      if (v) return v;
    }
    throw new Error(`Missing env ${keys.join(' / ')}`);
  };
  return {
    cases: get('KYC_CASES_TABLE', 'TABLE_KYC_CASES'),
    audit: get('AUDIT_TABLE', 'TABLE_AUDIT'),
    costs: get('COSTS_TABLE', 'TABLE_COSTS'),
  };
}

function isConditionFailure(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
}

const IDEM_PREFIX = 'idem#';
const CAP_PREFIX = 'cap#';

export class DynamoKycCaseRepo implements KycCaseRepo {
  constructor(private readonly doc: DocClient, private readonly table: string, private readonly auditTable: string) {}

  async get(userId: string): Promise<KycCaseRecord | null> {
    if (userId.startsWith(IDEM_PREFIX)) return null;
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { userId }, ConsistentRead: true }));
    return (out.Item as KycCaseRecord | undefined) ?? null;
  }

  async save(rec: KycCaseRecord, expectedVersion: number, audit?: KycAuditRow): Promise<boolean> {
    if (rec.version !== expectedVersion + 1) return false;
    const put = {
      TableName: this.table,
      Item: { ...rec },
      ...(expectedVersion === 0
        ? { ConditionExpression: 'attribute_not_exists(userId)' }
        : { ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': expectedVersion } }),
    };
    try {
      if (audit) {
        await this.doc.send(new TransactWriteCommand({
          TransactItems: [
            { Put: put },
            { Put: { TableName: this.auditTable, Item: { ...audit }, ConditionExpression: 'attribute_not_exists(ts)' } },
          ],
        }));
      } else {
        await this.doc.send(new PutCommand(put));
      }
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }
}

export class DynamoKycAuditRepo implements KycAuditRepo {
  constructor(private readonly doc: DocClient, private readonly table: string) {}

  async write(row: KycAuditRow): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...row }, ConditionExpression: 'attribute_not_exists(ts)' }));
  }

  async listForUser(_userId: string): Promise<KycAuditRow[]> {
    throw new Error('not used by the KYC routes; the review console reads the audit trail');
  }
}

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

export function dynamoKycRepos(tables: KycTableNames, doc: DocClient): KycRepos {
  return {
    cases: new DynamoKycCaseRepo(doc, tables.cases, tables.audit),
    audit: new DynamoKycAuditRepo(doc, tables.audit),
    idempotency: new DynamoIdempotencyRepo(doc, tables.cases),
    costs: new DynamoCostRepo(doc, tables.costs),
  };
}
