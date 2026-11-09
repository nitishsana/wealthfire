import { describe, expect, it } from 'vitest';
import type { DocClient } from '../../src/lib/repo';
import { looksLikeIdNumber, maskAadhaar, maskPan } from '../../src/review/mask';
import { BadCursorError } from '../../src/review/ports';
import { kindOf } from '../../src/review/s3';
import { DynamoAuditStore, DynamoCaseStore } from '../../src/store/dynamo';
import { reviewCaseStore } from '../../src/store/views';
import { makeCase } from './fakes';

/** The review routes' store is the shared Dynamo case store seen through reviewCaseStore(). */
const reviewStore = (doc: DocClient, cases: string, audit: string) => reviewCaseStore(new DynamoCaseStore(doc, cases, audit));

type Sent = { name: string; input: Record<string, unknown> };

function fakeDoc(reply: (cmd: Sent) => unknown): DocClient & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send: (async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const s = { name: cmd.constructor.name, input: cmd.input };
      sent.push(s);
      return reply(s);
    }) as never,
  };
}

describe('mask', () => {
  it('rebuilds masks from the last 4 characters', () => {
    expect(maskPan('ABCPE1234F')).toBe('XXXXXX234F');
    expect(maskPan('xxxxxx234f')).toBe('XXXXXX234F');
    expect(maskPan(undefined)).toBe('XXXXXXXXXX');
    expect(maskAadhaar('2345 6789 1234')).toBe('XXXX XXXX 1234');
    expect(maskAadhaar('XXXX-XXXX-1234')).toBe('XXXX XXXX 1234');
    expect(maskAadhaar('12')).toBe('XXXX XXXX XXXX');
  });

  it('spots ID numbers in free text', () => {
    expect(looksLikeIdNumber('pan abcpe1234f')).toBe(true);
    expect(looksLikeIdNumber('2345-6789-1234')).toBe(true);
    expect(looksLikeIdNumber('Blurry photo, retake on 12 Nov')).toBe(false);
  });
});

describe('s3 kindOf', () => {
  it('maps file names to kinds', () => {
    expect(kindOf('selfie.jpg')).toBe('selfie');
    expect(kindOf('aadhaar-front.png')).toBe('aadhaar');
    expect(kindOf('PAN_1.pdf')).toBe('pan');
    expect(kindOf('notes.txt')).toBe('other');
  });
});

describe('shared DynamoCaseStore via reviewCaseStore', () => {
  it('queries byStatus newest first and round-trips the cursor', async () => {
    const lek = { status: 'under-review', updatedAt: '2026-11-01T00:00:00.000Z', userId: 'u1' };
    const doc = fakeDoc(() => ({ Items: [makeCase()], LastEvaluatedKey: lek }));
    const store = reviewStore(doc, 'cases', 'audit');
    const page = await store.listUnderReview({ limit: 10 });
    expect(doc.sent[0]?.input).toMatchObject({ IndexName: 'byStatus', ScanIndexForward: false, Limit: 10 });
    expect(page.nextCursor).toBeTypeOf('string');
    await store.listUnderReview({ limit: 10, cursor: page.nextCursor as string });
    expect(doc.sent[1]?.input.ExclusiveStartKey).toEqual(lek);
  });

  it('rejects forged cursors', async () => {
    const store = reviewStore(fakeDoc(() => ({})), 'cases', 'audit');
    const forged = Buffer.from(JSON.stringify({ status: 'verified', updatedAt: 'x', userId: 'u' })).toString('base64url');
    await expect(store.listUnderReview({ limit: 1, cursor: forged })).rejects.toBeInstanceOf(BadCursorError);
    await expect(store.listUnderReview({ limit: 1, cursor: '%%%' })).rejects.toBeInstanceOf(BadCursorError);
  });

  it('writes only the decision fields + audit in one conditional transaction; maps condition failure to conflict', async () => {
    const before = makeCase();
    const after = { ...before, status: 'verified' as const, reason: 'staff-approved' as const, version: 4, note: 'ok' };
    const audit = { userId: before.userId, ts: 't#1', actor: 'staff:s' as const, action: 'review.approve' as const, before: null, after: null };
    const ok = fakeDoc(() => ({}));
    expect(await reviewStore(ok, 'cases', 'audit').saveDecision({ before, after, next: 'kra-upload', audit })).toBe('ok');
    const items = ok.sent[0]?.input.TransactItems as {
      Update?: { TableName: string; UpdateExpression: string; ConditionExpression: string; ExpressionAttributeValues: Record<string, unknown>; ExpressionAttributeNames: Record<string, string> };
      Put?: { TableName: string };
    }[];
    expect(items[0]?.Update?.TableName).toBe('cases');
    expect(items[1]?.Put?.TableName).toBe('audit');
    const upd = items[0]!.Update!;
    expect(upd.ConditionExpression).toBe('attribute_exists(userId) AND #version = :expected AND #status = :requireStatus');
    expect(upd.ExpressionAttributeValues).toMatchObject({ ':expected': 3, ':next': 4, ':requireStatus': 'under-review' });
    const setFields = Object.values(upd.ExpressionAttributeNames);
    expect(setFields).toEqual(expect.arrayContaining(['status', 'reason', 'next', 'note', 'updatedAt', 'version']));
    // PAN / evidence / partner refs are never rewritten by a staff decision
    for (const f of ['masks', 'panEnc', 'panHash', 'evidence', 'partnerRefs']) expect(setFields).not.toContain(f);
    expect(Object.values(upd.ExpressionAttributeValues)).toContain('kra-upload');

    const failing = fakeDoc(() => {
      throw Object.assign(new Error('x'), { name: 'TransactionCanceledException' });
    });
    expect(await reviewStore(failing, 'cases', 'audit').saveDecision({ before, after, next: 'kra-upload', audit })).toBe('conflict');
  });

  it('audit log queries newest first', async () => {
    const doc = fakeDoc(() => ({ Items: [] }));
    await new DynamoAuditStore(doc, 'audit').listForUser('u1', 5);
    expect(doc.sent[0]?.input).toMatchObject({ TableName: 'audit', ScanIndexForward: false, Limit: 5 });
  });
});
