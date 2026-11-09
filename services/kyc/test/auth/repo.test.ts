import { describe, expect, it } from 'vitest';
import { memoryRepos, tableNamesFromEnv, type OtpChallenge, type UserRecord } from '../../src/lib/repo';

const user = (id: string, hash: string): UserRecord => ({
  userId: id, contactKind: 'email', contactHash: hash, contactEnc: 'enc', createdAt: 1,
});

describe('MemoryUserRepo', () => {
  it('creates once per contact hash', async () => {
    const { users } = memoryRepos();
    expect((await users.createIfAbsent(user('u1', 'h1'))).created).toBe(true);
    const again = await users.createIfAbsent(user('u2', 'h1'));
    expect(again.created).toBe(false);
    expect(again.user.userId).toBe('u1');
    expect(users.size()).toBe(1);
    expect((await users.findByContactHash('h1'))?.userId).toBe('u1');
    expect(await users.findByContactHash('nope')).toBeNull();
    expect(await users.get('u2')).toBeNull();
  });
  it('returns copies', async () => {
    const { users } = memoryRepos();
    await users.createIfAbsent(user('u1', 'h1'));
    const u = (await users.get('u1'))!;
    u.firstName = 'changed';
    expect((await users.get('u1'))!.firstName).toBeUndefined();
  });
});

describe('MemorySessionRepo', () => {
  it('markUsed has a single winner', async () => {
    const { sessions } = memoryRepos();
    await sessions.putSession({ tokenHash: 't', userId: 'u', familyId: 'f', createdAt: 1, expiresAt: 10 });
    expect(await sessions.markUsed('t', 2)).toBe(true);
    expect(await sessions.markUsed('t', 3)).toBe(false);
    expect(await sessions.markUsed('missing', 3)).toBe(false);
    expect((await sessions.getSession('t'))?.usedAt).toBe(2);
  });
  it('revokeFamily keeps the first reason', async () => {
    const { sessions } = memoryRepos();
    await sessions.putFamily({ familyId: 'f', userId: 'u', createdAt: 1, expiresAt: 10 });
    await sessions.revokeFamily('f', 5, 'reuse');
    await sessions.revokeFamily('f', 6, 'logout');
    expect(await sessions.getFamily('f')).toMatchObject({ revokedAt: 5, revokedReason: 'reuse' });
    await sessions.revokeFamily('missing', 1, 'logout');
    expect(await sessions.getFamily('missing')).toBeNull();
  });
});

describe('MemoryOtpRepo', () => {
  const ch: OtpChallenge = {
    challengeId: 'c', targetHash: 'h', contactKind: 'mobile', contactEnc: 'e', codeHash: 'x', createdAt: 1, expiresAt: 2, tries: 0,
  };
  it('incrementTries stops at max; delete has a single winner', async () => {
    const { otp } = memoryRepos();
    await otp.putChallenge(ch);
    expect(await otp.incrementTries('c', 2)).toBe(1);
    expect(await otp.incrementTries('c', 2)).toBe(2);
    expect(await otp.incrementTries('c', 2)).toBeNull();
    expect(await otp.incrementTries('missing', 2)).toBeNull();
    expect(await otp.deleteChallenge('c')).toBe(true);
    expect(await otp.deleteChallenge('c')).toBe(false);
    expect(otp.challengeCount()).toBe(0);
  });
  it('send log uses optimistic versions', async () => {
    const { otp } = memoryRepos();
    expect(await otp.putSendLog({ key: 'k', sends: [1] }, 1, 0)).toBe(false);
    expect(await otp.putSendLog({ key: 'k', sends: [1] }, 0, 0)).toBe(true);
    expect(await otp.putSendLog({ key: 'k', sends: [1, 2] }, 0, 0)).toBe(false);
    expect(await otp.putSendLog({ key: 'k', sends: [1, 2] }, 1, 0)).toBe(true);
    expect(await otp.getSendLog('k')).toEqual({ key: 'k', sends: [1, 2], version: 2 });
  });
});

describe('tableNamesFromEnv', () => {
  it('reads names and fails on missing', () => {
    expect(tableNamesFromEnv({ TABLE_USERS: 'u', TABLE_SESSIONS: 's', TABLE_OTP: 'o' })).toEqual({ users: 'u', sessions: 's', otp: 'o' });
    expect(() => tableNamesFromEnv({ TABLE_USERS: 'u' })).toThrow(/TABLE_SESSIONS/);
    // the old *_TABLE names are gone (one naming scheme, matching infra/stack.ts)
    expect(() => tableNamesFromEnv({ USERS_TABLE: 'u', SESSIONS_TABLE: 's', OTP_TABLE: 'o' })).toThrow(/TABLE_USERS/);
  });
});
