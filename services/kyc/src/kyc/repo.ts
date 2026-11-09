// Storage the KYC routes use. Cases and audit rows live in the ONE shared store (src/store, also
// used by the webhook and the review routes); this file adds idempotency records, paid-check
// costs, the upload-signing counter and consent records. In-memory implementations for tests,
// DynamoDB for Lambda.
//
// DynamoDB layout (tables from the CDK stack; case / audit layout in src/store/types.ts):
//   kyc_cases pk userId        `idem#<hash>` items hold idempotency records (no `status`
//                               attribute, so they stay out of the byStatus GSI); `expiresAt`
//                               (epoch seconds) is the table TTL attribute (S18: 24 h)
//   costs     pk month, sk checkId
//                               one row per paid check (month = yyyy-mm); `cap#<yyyy-mm-dd>` /
//                               `<userId>` rows hold the per-user daily paid-check counter;
//                               `sign#<yyyy-mm-dd>` / `<userId>` rows the daily upload-signing counter (S11)
//                               (both counters carry `expiresAt`, the table TTL attribute: 2 days, S#14)
//   consents  pk userId, sk `<purpose>#<iso time>#<seq>` (CONSENTS_TABLE, S2, S#11)
//                               append-only: a 'given' or 'withdrawn' row per user action, plus
//                               'case-closed' rows when a case is archived or deleted; never
//                               updated or deleted (DELETE /kyc/data keeps them)
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ENV, requireEnv, TABLE_ENV, type Env } from '../lib/env';
import type { DocClient } from '../lib/repo';
import type { PaidCheck } from '../partner/types';
import { DynamoAuditStore, DynamoCaseStore, isConditionFailure } from '../store/dynamo';
import { MemoryAuditStore, MemoryCaseStore } from '../store/memory';
import { IDEM_PREFIX, type AuditRow, type AuditStore, type CaseEvidence, type CaseStore } from '../store/types';

export type { CaseSnapshot, DocumentKind, DocumentLink, KycCaseRecord, Timeout } from '../store/types';

/** The case evidence (one shape for the KYC routes and the webhook). */
export type KycEvidence = CaseEvidence;
/** One audit row (shared shape). */
export type KycAuditRow = AuditRow;
/** The part of the shared case store the KYC routes use. */
export type KycCaseRepo = Pick<CaseStore, 'get' | 'save' | 'claimPan' | 'releasePan' | 'archive' | 'remove' | 'removeArchived'>;
export type KycAuditRepo = AuditStore;

/** S18: idempotency records live 24 h. */
export const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;

/** Stored result of a request made with an Idempotency-Key. */
export interface IdempotencyRecord {
  /** sha256 of userId + route + key */
  id: string;
  /** keyed hash of the request body, so a reused key with a different body is refused */
  requestHash: string;
  state: 'pending' | 'done';
  response?: { status: number; body: Record<string, unknown> };
  createdAt: number;
  /** epoch SECONDS after which the record is gone (DynamoDB TTL attribute) */
  expiresAt: number;
}

export interface IdempotencyRepo {
  /** The record, or null when there is none or it has expired at `nowSec`. */
  get(id: string, nowSec: number): Promise<IdempotencyRecord | null>;
  /** Creates a pending record (replacing an expired one). False if a live one already exists. */
  claim(rec: IdempotencyRecord, nowSec: number): Promise<boolean>;
  complete(id: string, response: { status: number; body: Record<string, unknown> }): Promise<void>;
  /** Drops a pending record (the request failed). */
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
  /** S11: atomically counts `n` upload signings for user on day while the total stays <= max. */
  reserveSignings(userId: string, day: string, n: number, max: number): Promise<boolean>;
}

/** What each consent covers (S2). Every paid partner call needs a prior consent for its purpose. */
export const CONSENT_PURPOSES = ['digilocker', 'aadhaar-otp', 'pan-check', 'face-match', 'esign', 'kra-upload'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/**
 * 'given' / 'withdrawn': the user's own action. 'case-closed' (S#11): appended for every purpose
 * when a case is archived or deleted, so a NEW case needs fresh 'given' rows.
 */
export type ConsentAction = 'given' | 'withdrawn' | 'case-closed';

export interface ConsentRow {
  userId: string;
  /** `<purpose>#<iso time>#<seq>`, seq a 6-digit counter: monotonic per (user, purpose) (S#11) */
  sk: string;
  purpose: ConsentPurpose;
  action: ConsentAction;
  at: string;
  /** S#11: the live case when the row was written (absent before the first case exists) */
  caseId?: string;
  /** S#14: hmacLookup(mac, 'ip', ip), never the raw IP */
  ipHash?: string;
}

/** S#11: the sort key of a consent row. */
export function consentSk(purpose: ConsentPurpose, at: string, seq: number): string {
  return `${purpose}#${at}#${String(seq).padStart(6, '0')}`;
}

/** S#11: the (time, seq) of a consent sort key; seq is -1 for an older nonce-style key. */
export function parseConsentSk(sk: string): { at: string; seq: number } {
  const parts = sk.split('#');
  const seq = parts[2] !== undefined && /^\d{6}$/.test(parts[2]) ? Number(parts[2]) : -1;
  return { at: parts[1] ?? '', seq };
}

export interface ConsentRepo {
  /** Appends one row (rows are never changed or deleted by the app). False when the sort key is already taken. */
  record(row: ConsentRow): Promise<boolean>;
  /** The newest row for this purpose, or null. */
  latest(userId: string, purpose: ConsentPurpose): Promise<ConsentRow | null>;
}

const clone = <T>(v: T): T => structuredClone(v);

// ---------- In-memory ----------

export class MemoryIdempotencyRepo implements IdempotencyRepo {
  readonly items = new Map<string, IdempotencyRecord>();
  async get(id: string, nowSec: number): Promise<IdempotencyRecord | null> {
    const r = this.items.get(id);
    return r && r.expiresAt > nowSec ? clone(r) : null;
  }
  async claim(rec: IdempotencyRecord, nowSec: number): Promise<boolean> {
    const cur = this.items.get(rec.id);
    if (cur && cur.expiresAt > nowSec) return false;
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
  async reserveSignings(userId: string, day: string, n: number, max: number): Promise<boolean> {
    const k = `sign#${day}#${userId}`;
    const used = this.counters.get(k) ?? 0;
    if (used + n > max) return false;
    this.counters.set(k, used + n);
    return true;
  }
}

export class MemoryConsentRepo implements ConsentRepo {
  readonly rows: ConsentRow[] = [];
  async record(row: ConsentRow): Promise<boolean> {
    if (this.rows.some((r) => r.userId === row.userId && r.sk === row.sk)) return false;
    this.rows.push(clone(row));
    return true;
  }
  async latest(userId: string, purpose: ConsentPurpose): Promise<ConsentRow | null> {
    const mine = this.rows.filter((r) => r.userId === userId && r.purpose === purpose).sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
    const r = mine[mine.length - 1];
    return r ? clone(r) : null;
  }
}

export interface KycRepos {
  cases: KycCaseRepo;
  audit: KycAuditRepo;
  idempotency: IdempotencyRepo;
  costs: CostRepo;
  consents: ConsentRepo;
}

export function memoryKycRepos(): {
  cases: MemoryCaseStore; audit: MemoryAuditStore; idempotency: MemoryIdempotencyRepo; costs: MemoryCostRepo; consents: MemoryConsentRepo;
} {
  const audit = new MemoryAuditStore();
  return {
    cases: new MemoryCaseStore(audit), audit, idempotency: new MemoryIdempotencyRepo(), costs: new MemoryCostRepo(),
    consents: new MemoryConsentRepo(),
  };
}

// ---------- DynamoDB ----------

export interface KycTableNames {
  cases: string;
  audit: string;
  costs: string;
  consents: string;
}

/** Table names from env (TABLE_KYC_CASES / TABLE_AUDIT / TABLE_COSTS / CONSENTS_TABLE, set by the CDK stack). */
export function kycTablesFromEnv(env: Env = process.env): KycTableNames {
  return {
    cases: requireEnv(env, TABLE_ENV.kycCases),
    audit: requireEnv(env, TABLE_ENV.audit),
    costs: requireEnv(env, TABLE_ENV.costs),
    consents: requireEnv(env, ENV.consentsTable),
  };
}

const CAP_PREFIX = 'cap#';
const SIGN_PREFIX = 'sign#';
/** S#14: daily counter rows live this long after their India day starts. */
export const COUNTER_TTL_SEC = 2 * 24 * 60 * 60;

/**
 * S#14: `expiresAt` (epoch seconds, the costs table TTL attribute) of a `cap#<day>` / `sign#<day>`
 * counter row: 2 days after the start of that India day (yyyy-mm-dd). Per-check cost rows never
 * get one (billing record).
 */
export function counterExpiresAt(day: string): number {
  const start = Date.parse(`${day}T00:00:00.000+05:30`);
  if (Number.isNaN(start)) throw new Error('bad day');
  return Math.floor(start / 1000) + COUNTER_TTL_SEC;
}

export class DynamoIdempotencyRepo implements IdempotencyRepo {
  constructor(private readonly doc: DocClient, private readonly table: string) {}

  async get(id: string, nowSec: number): Promise<IdempotencyRecord | null> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { userId: IDEM_PREFIX + id }, ConsistentRead: true }));
    if (!out.Item) return null;
    const { userId: _k, ...rest } = out.Item;
    const rec = { ...(rest as Omit<IdempotencyRecord, 'id'>), id };
    // TTL deletion is lazy: an expired row may still be there for a while
    return typeof rec.expiresAt === 'number' && rec.expiresAt <= nowSec ? null : rec;
  }

  async claim(rec: IdempotencyRecord, nowSec: number): Promise<boolean> {
    const { id, ...rest } = rec;
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table,
        Item: { userId: IDEM_PREFIX + id, ...rest },
        ConditionExpression: 'attribute_not_exists(userId) OR expiresAt <= :now',
        ExpressionAttributeValues: { ':now': nowSec },
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
        UpdateExpression: 'ADD #n :one SET #e = if_not_exists(#e, :exp)',
        ConditionExpression: 'attribute_not_exists(#n) OR #n < :max',
        ExpressionAttributeNames: { '#n': 'count', '#e': 'expiresAt' },
        ExpressionAttributeValues: { ':one': 1, ':max': max, ':exp': counterExpiresAt(day) },
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

  async reserveSignings(userId: string, day: string, n: number, max: number): Promise<boolean> {
    if (n < 1 || n > max) return false;
    try {
      await this.doc.send(new UpdateCommand({
        TableName: this.table,
        Key: { month: SIGN_PREFIX + day, checkId: userId },
        UpdateExpression: 'ADD #n :n SET #e = if_not_exists(#e, :exp)',
        ConditionExpression: 'attribute_not_exists(#n) OR #n <= :room',
        ExpressionAttributeNames: { '#n': 'count', '#e': 'expiresAt' },
        ExpressionAttributeValues: { ':n': n, ':room': max - n, ':exp': counterExpiresAt(day) },
      }));
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }
}

export class DynamoConsentRepo implements ConsentRepo {
  constructor(private readonly doc: DocClient, private readonly table: string) {}

  async record(row: ConsentRow): Promise<boolean> {
    try {
      await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...row }, ConditionExpression: 'attribute_not_exists(sk)' }));
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  async latest(userId: string, purpose: ConsentPurpose): Promise<ConsentRow | null> {
    const out = await this.doc.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'userId = :u AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':u': userId, ':p': `${purpose}#` },
      ScanIndexForward: false,
      Limit: 1,
      ConsistentRead: true,
    }));
    return (out.Items?.[0] as ConsentRow | undefined) ?? null;
  }
}

/** KYC repos over DynamoDB; `cases` / `audit` are the shared store. */
export function dynamoKycRepos(tables: KycTableNames, doc: DocClient): {
  cases: DynamoCaseStore; audit: DynamoAuditStore; idempotency: DynamoIdempotencyRepo; costs: DynamoCostRepo; consents: DynamoConsentRepo;
} {
  return {
    cases: new DynamoCaseStore(doc, tables.cases, tables.audit),
    audit: new DynamoAuditStore(doc, tables.audit),
    idempotency: new DynamoIdempotencyRepo(doc, tables.cases),
    costs: new DynamoCostRepo(doc, tables.costs),
    consents: new DynamoConsentRepo(doc, tables.consents),
  };
}
