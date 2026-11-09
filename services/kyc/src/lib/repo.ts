// Storage interfaces for auth (users, sessions, OTP) with an in-memory implementation for tests
// and a DynamoDB implementation for Lambda. Domain times are epoch ms; DynamoDB items also carry
// `expiresAt` in epoch SECONDS for the table TTL.
//
// DynamoDB layout (no GSIs needed):
//   users    pk userId            user items; `contact#<hash>` pointer items enforce one user per contact
//   sessions pk refreshTokenHash  refresh-token items; `family#<id>` items hold the family revoke flag
//   otp      pk challengeId       challenge items; `rate#<key>` items hold send-time logs for rate limits
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

export type ContactKind = 'email' | 'mobile';

export interface UserRecord {
  userId: string;
  contactKind: ContactKind;
  /** hmacLookup of the normalised contact; unique per user */
  contactHash: string;
  /** Encryptor output of the normalised contact */
  contactEnc: string;
  createdAt: number;
  firstName?: string;
  lastName?: string;
  panHash?: string;
  panLast4?: string;
  aadhaarLast4?: string;
}

export interface UserRepo {
  get(userId: string): Promise<UserRecord | null>;
  findByContactHash(contactHash: string): Promise<UserRecord | null>;
  /** Creates the user unless the contact already belongs to one; returns the stored user. */
  createIfAbsent(user: UserRecord): Promise<{ user: UserRecord; created: boolean }>;
}

export interface SessionRecord {
  /** sha256 of the refresh token; the token itself is never stored */
  tokenHash: string;
  userId: string;
  familyId: string;
  createdAt: number;
  expiresAt: number;
  /** set when the token was rotated; a second use is reuse */
  usedAt?: number;
  device?: string;
}

export interface TokenFamily {
  familyId: string;
  userId: string;
  createdAt: number;
  /** absolute end of the login; no token in the family outlives it */
  expiresAt: number;
  revokedAt?: number;
  revokedReason?: 'logout' | 'reuse';
}

export interface SessionRepo {
  putSession(s: SessionRecord): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRecord | null>;
  /** Atomically marks a token used. False when missing or already used (single winner). */
  markUsed(tokenHash: string, at: number): Promise<boolean>;
  putFamily(f: TokenFamily): Promise<void>;
  getFamily(familyId: string): Promise<TokenFamily | null>;
  revokeFamily(familyId: string, at: number, reason: 'logout' | 'reuse'): Promise<void>;
}

export interface OtpChallenge {
  challengeId: string;
  targetHash: string;
  contactKind: ContactKind;
  contactEnc: string;
  /** argon2id PHC string */
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  tries: number;
}

export interface SendLog {
  key: string;
  /** send times (epoch ms) inside the current window */
  sends: number[];
  lastChallengeId?: string;
  /** optimistic-lock version; 0 means not stored yet */
  version: number;
}

export interface OtpRepo {
  putChallenge(c: OtpChallenge): Promise<void>;
  getChallenge(challengeId: string): Promise<OtpChallenge | null>;
  /** Atomically tries += 1 while tries < max. Returns the new count, or null if missing / already at max. */
  incrementTries(challengeId: string, max: number): Promise<number | null>;
  /** True only for the call that actually deleted it. */
  deleteChallenge(challengeId: string): Promise<boolean>;
  getSendLog(key: string): Promise<SendLog | null>;
  /** Conditional write on `expectedVersion` (0 = must not exist). False on a concurrent change. */
  putSendLog(log: Omit<SendLog, 'version'>, expectedVersion: number, expiresAt: number): Promise<boolean>;
}

export interface AuthRepos {
  users: UserRepo;
  sessions: SessionRepo;
  otp: OtpRepo;
}

const clone = <T>(v: T): T => structuredClone(v);

// ---------- In-memory ----------

export class MemoryUserRepo implements UserRepo {
  private readonly byId = new Map<string, UserRecord>();
  private readonly byContact = new Map<string, string>();

  async get(userId: string): Promise<UserRecord | null> {
    const u = this.byId.get(userId);
    return u ? clone(u) : null;
  }

  async findByContactHash(contactHash: string): Promise<UserRecord | null> {
    const id = this.byContact.get(contactHash);
    return id ? this.get(id) : null;
  }

  async createIfAbsent(user: UserRecord): Promise<{ user: UserRecord; created: boolean }> {
    const existing = await this.findByContactHash(user.contactHash);
    if (existing) return { user: existing, created: false };
    if (this.byId.has(user.userId)) throw new Error('userId already exists');
    this.byId.set(user.userId, clone(user));
    this.byContact.set(user.contactHash, user.userId);
    return { user: clone(user), created: true };
  }

  /** @internal test hook */
  size(): number {
    return this.byId.size;
  }
}

export class MemorySessionRepo implements SessionRepo {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly families = new Map<string, TokenFamily>();

  async putSession(s: SessionRecord): Promise<void> {
    this.sessions.set(s.tokenHash, clone(s));
  }

  async getSession(tokenHash: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(tokenHash);
    return s ? clone(s) : null;
  }

  async markUsed(tokenHash: string, at: number): Promise<boolean> {
    const s = this.sessions.get(tokenHash);
    if (!s || s.usedAt !== undefined) return false;
    s.usedAt = at;
    return true;
  }

  async putFamily(f: TokenFamily): Promise<void> {
    this.families.set(f.familyId, clone(f));
  }

  async getFamily(familyId: string): Promise<TokenFamily | null> {
    const f = this.families.get(familyId);
    return f ? clone(f) : null;
  }

  async revokeFamily(familyId: string, at: number, reason: 'logout' | 'reuse'): Promise<void> {
    const f = this.families.get(familyId);
    if (f && f.revokedAt === undefined) {
      f.revokedAt = at;
      f.revokedReason = reason;
    }
  }

  /** @internal test hook: every stored session key */
  storedKeys(): string[] {
    return [...this.sessions.keys()];
  }
}

export class MemoryOtpRepo implements OtpRepo {
  private readonly challenges = new Map<string, OtpChallenge>();
  private readonly logs = new Map<string, SendLog>();

  async putChallenge(c: OtpChallenge): Promise<void> {
    this.challenges.set(c.challengeId, clone(c));
  }

  async getChallenge(challengeId: string): Promise<OtpChallenge | null> {
    const c = this.challenges.get(challengeId);
    return c ? clone(c) : null;
  }

  async incrementTries(challengeId: string, max: number): Promise<number | null> {
    const c = this.challenges.get(challengeId);
    if (!c || c.tries >= max) return null;
    c.tries += 1;
    return c.tries;
  }

  async deleteChallenge(challengeId: string): Promise<boolean> {
    return this.challenges.delete(challengeId);
  }

  async getSendLog(key: string): Promise<SendLog | null> {
    const l = this.logs.get(key);
    return l ? clone(l) : null;
  }

  async putSendLog(log: Omit<SendLog, 'version'>, expectedVersion: number, _expiresAt: number): Promise<boolean> {
    const cur = this.logs.get(log.key)?.version ?? 0;
    if (cur !== expectedVersion) return false;
    this.logs.set(log.key, { ...clone(log), version: cur + 1 });
    return true;
  }

  /** @internal test hook */
  challengeCount(): number {
    return this.challenges.size;
  }
}

export function memoryRepos(): { users: MemoryUserRepo; sessions: MemorySessionRepo; otp: MemoryOtpRepo } {
  return { users: new MemoryUserRepo(), sessions: new MemorySessionRepo(), otp: new MemoryOtpRepo() };
}

// ---------- DynamoDB ----------

export interface DynamoTableNames {
  users: string;
  sessions: string;
  otp: string;
}

/** Minimal surface of DynamoDBDocumentClient used here (lets tests pass a fake). */
export type DocClient = Pick<DynamoDBDocumentClient, 'send'>;

const ttlSeconds = (ms: number): number => Math.ceil(ms / 1000);

function isConditionFailure(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
}

function strip<T extends object>(item: Record<string, unknown>, drop: string[]): T {
  const out: Record<string, unknown> = { ...item };
  for (const k of drop) delete out[k];
  return out as T;
}

const CONTACT_PREFIX = 'contact#';
const FAMILY_PREFIX = 'family#';
const RATE_PREFIX = 'rate#';

export class DynamoUserRepo implements UserRepo {
  constructor(private readonly doc: DocClient, private readonly table: string) {}

  async get(userId: string): Promise<UserRecord | null> {
    if (userId.startsWith(CONTACT_PREFIX)) return null;
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { userId }, ConsistentRead: true }));
    return out.Item ? (out.Item as UserRecord) : null;
  }

  async findByContactHash(contactHash: string): Promise<UserRecord | null> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { userId: CONTACT_PREFIX + contactHash }, ConsistentRead: true }),
    );
    const owner = out.Item?.ownerId;
    return typeof owner === 'string' ? this.get(owner) : null;
  }

  async createIfAbsent(user: UserRecord): Promise<{ user: UserRecord; created: boolean }> {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { userId: CONTACT_PREFIX + user.contactHash, ownerId: user.userId },
                ConditionExpression: 'attribute_not_exists(userId)',
              },
            },
            { Put: { TableName: this.table, Item: { ...user }, ConditionExpression: 'attribute_not_exists(userId)' } },
          ],
        }),
      );
      return { user, created: true };
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      const existing = await this.findByContactHash(user.contactHash);
      if (!existing) throw e;
      return { user: existing, created: false };
    }
  }
}

export class DynamoSessionRepo implements SessionRepo {
  constructor(private readonly doc: DocClient, private readonly table: string) {}

  async putSession(s: SessionRecord): Promise<void> {
    const { tokenHash, expiresAt, ...rest } = s;
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { refreshTokenHash: tokenHash, ...rest, expiresAtMs: expiresAt, expiresAt: ttlSeconds(expiresAt) },
      }),
    );
  }

  async getSession(tokenHash: string): Promise<SessionRecord | null> {
    if (tokenHash.startsWith(FAMILY_PREFIX)) return null;
    const out = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { refreshTokenHash: tokenHash }, ConsistentRead: true }),
    );
    if (!out.Item) return null;
    const i = out.Item;
    return { ...strip<SessionRecord>(i, ['refreshTokenHash', 'expiresAtMs', 'expiresAt']), tokenHash, expiresAt: i.expiresAtMs as number };
  }

  async markUsed(tokenHash: string, at: number): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { refreshTokenHash: tokenHash },
          UpdateExpression: 'SET usedAt = :at',
          ConditionExpression: 'attribute_exists(refreshTokenHash) AND attribute_not_exists(usedAt)',
          ExpressionAttributeValues: { ':at': at },
        }),
      );
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  async putFamily(f: TokenFamily): Promise<void> {
    const { expiresAt, ...rest } = f;
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { refreshTokenHash: FAMILY_PREFIX + f.familyId, ...rest, expiresAtMs: expiresAt, expiresAt: ttlSeconds(expiresAt) },
      }),
    );
  }

  async getFamily(familyId: string): Promise<TokenFamily | null> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { refreshTokenHash: FAMILY_PREFIX + familyId }, ConsistentRead: true }),
    );
    if (!out.Item) return null;
    const i = out.Item;
    return { ...strip<TokenFamily>(i, ['refreshTokenHash', 'expiresAtMs', 'expiresAt']), expiresAt: i.expiresAtMs as number };
  }

  async revokeFamily(familyId: string, at: number, reason: 'logout' | 'reuse'): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { refreshTokenHash: FAMILY_PREFIX + familyId },
          UpdateExpression: 'SET revokedAt = :at, revokedReason = :r',
          ConditionExpression: 'attribute_exists(refreshTokenHash) AND attribute_not_exists(revokedAt)',
          ExpressionAttributeValues: { ':at': at, ':r': reason },
        }),
      );
    } catch (e) {
      if (!isConditionFailure(e)) throw e; // missing or already revoked: nothing to do
    }
  }
}

export class DynamoOtpRepo implements OtpRepo {
  constructor(private readonly doc: DocClient, private readonly table: string) {}

  async putChallenge(c: OtpChallenge): Promise<void> {
    const { expiresAt, ...rest } = c;
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: { ...rest, expiresAtMs: expiresAt, expiresAt: ttlSeconds(expiresAt) } }),
    );
  }

  async getChallenge(challengeId: string): Promise<OtpChallenge | null> {
    if (challengeId.startsWith(RATE_PREFIX)) return null;
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { challengeId }, ConsistentRead: true }));
    if (!out.Item) return null;
    const i = out.Item;
    return { ...strip<OtpChallenge>(i, ['expiresAtMs', 'expiresAt']), expiresAt: i.expiresAtMs as number };
  }

  async incrementTries(challengeId: string, max: number): Promise<number | null> {
    if (challengeId.startsWith(RATE_PREFIX)) return null;
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { challengeId },
          UpdateExpression: 'ADD tries :one',
          ConditionExpression: 'attribute_exists(challengeId) AND tries < :max',
          ExpressionAttributeValues: { ':one': 1, ':max': max },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      return (out.Attributes?.tries as number | undefined) ?? null;
    } catch (e) {
      if (isConditionFailure(e)) return null;
      throw e;
    }
  }

  async deleteChallenge(challengeId: string): Promise<boolean> {
    if (challengeId.startsWith(RATE_PREFIX)) return false;
    try {
      await this.doc.send(
        new DeleteCommand({ TableName: this.table, Key: { challengeId }, ConditionExpression: 'attribute_exists(challengeId)' }),
      );
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  async getSendLog(key: string): Promise<SendLog | null> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { challengeId: RATE_PREFIX + key }, ConsistentRead: true }),
    );
    if (!out.Item) return null;
    const i = out.Item;
    return {
      key,
      sends: (i.sends as number[] | undefined) ?? [],
      lastChallengeId: i.lastChallengeId as string | undefined,
      version: (i.version as number | undefined) ?? 0,
    };
  }

  async putSendLog(log: Omit<SendLog, 'version'>, expectedVersion: number, expiresAt: number): Promise<boolean> {
    const item = {
      challengeId: RATE_PREFIX + log.key,
      sends: log.sends,
      lastChallengeId: log.lastChallengeId,
      version: expectedVersion + 1,
      expiresAt: ttlSeconds(expiresAt),
    };
    try {
      await this.doc.send(
        new PutCommand(
          expectedVersion === 0
            ? { TableName: this.table, Item: item, ConditionExpression: 'attribute_not_exists(challengeId)' }
            : {
                TableName: this.table,
                Item: item,
                ConditionExpression: 'version = :v',
                ExpressionAttributeValues: { ':v': expectedVersion },
              },
        ),
      );
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }
}

/** Env var names holding the table names (set by the CDK stack). */
export const TABLE_ENV = { users: 'USERS_TABLE', sessions: 'SESSIONS_TABLE', otp: 'OTP_TABLE' } as const;

export function tableNamesFromEnv(env: Record<string, string | undefined> = process.env): DynamoTableNames {
  const get = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`Missing env ${k}`);
    return v;
  };
  return { users: get(TABLE_ENV.users), sessions: get(TABLE_ENV.sessions), otp: get(TABLE_ENV.otp) };
}

export function createDocClient(client: DynamoDBClient = new DynamoDBClient({})): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

export function dynamoRepos(tables: DynamoTableNames, doc: DocClient = createDocClient()): AuthRepos {
  return {
    users: new DynamoUserRepo(doc, tables.users),
    sessions: new DynamoSessionRepo(doc, tables.sessions),
    otp: new DynamoOtpRepo(doc, tables.otp),
  };
}
