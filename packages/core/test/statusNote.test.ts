import { describe, expect, it } from 'vitest';
import { accountStatusNote, DOC_MESSAGES, monotonicProgress } from '../src';

describe('Settings > Account: verified line (TC-35)', () => {
  it('shows the done-verified text only once Verified', () => {
    expect(accountStatusNote('verified')).toBe('Your final KYC check is complete. Your account is verified.');
    expect(accountStatusNote('verified')).toBe(DOC_MESSAGES.doneVerified);
    for (const s of ['pre-verified', 'under-review', 'rejected', null, undefined] as const) expect(accountStatusNote(s)).toBeUndefined();
  });
});

describe('reading progress never goes down', () => {
  it('keeps the highest % of one read', () => {
    let p: number | null = null;
    const seen: number[] = [];
    for (const v of [10, 64, 57, 80, 79.6, 120, -5]) { p = monotonicProgress(p, v); seen.push(p); }
    expect(seen).toEqual([10, 64, 64, 80, 80, 100, 100]);
    expect(monotonicProgress(null, -3)).toBe(0);
  });
});
