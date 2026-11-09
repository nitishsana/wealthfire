import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type KycConfig } from '../../src/config';
import {
  canStaffTransition,
  canSystemTransition,
  decide,
  KycTransitionError,
  staffDecide,
  type DecideInput,
} from '../../src/decide';
import type { KycStatus } from '../../src/types';

const cfg: KycConfig = { ...DEFAULT_CONFIG };
const noLiveness: KycConfig = { ...DEFAULT_CONFIG, livenessRequired: false };

const typed = { firstName: 'Nitish', lastName: 'Sana', dob: '15/08/1990' };
const kraOk = { status: 'validated' as const, name: 'NITISH SANA', dob: '1990-08-15' };
const aadhaarOk = { verified: true as const, last4: '1234' };
const panOk = { valid: true, nameMatch: true, aadhaarLinked: true };
const faceOk = { match: 0.95, live: true };

/** A case that has finished the KRA lookup with "not-found" (full KYC path), nothing else yet. */
function base(over: Partial<DecideInput> = {}): DecideInput {
  return {
    current: 'pre-verified',
    deviceHandCheck: false,
    typed,
    panIndividual: true,
    otpAadhaarLast4: '1234',
    kra: { status: 'not-found' },
    ...over,
  };
}

/** Every full-KYC check passes. */
const fullPass = (over: Partial<DecideInput> = {}): DecideInput =>
  base({ aadhaar: aadhaarOk, pan: panOk, face: [faceOk], esign: 'done', ...over });

describe('decide: terminal cases', () => {
  for (const current of ['verified', 'rejected'] as const) {
    it(`throws KycTransitionError on a ${current} case`, () => {
      expect(() => decide(base({ current }), cfg)).toThrow(KycTransitionError);
      try {
        decide(base({ current }), cfg);
      } catch (e) {
        expect(e).toMatchObject({ name: 'KycTransitionError', from: current, to: current });
      }
    });
  }
});

describe('decide: row 4, clear fails → rejected', () => {
  it('PAN not individual', () => {
    const d = decide(fullPass({ panIndividual: false }), cfg);
    expect(d).toMatchObject({ status: 'rejected', path: 'full-kyc', reason: 'pan-not-individual', next: 'none' });
    expect(d.checks).toEqual({ pan: 'fail' });
  });
  it('PAN invalid', () => {
    const d = decide(fullPass({ pan: { ...panOk, valid: false } }), cfg);
    expect(d).toMatchObject({ status: 'rejected', reason: 'pan-invalid', next: 'none' });
    expect(d.checks).toEqual({ pan: 'fail' });
  });
  it('Aadhaar last 4 differs from the OTP-verified last 4', () => {
    const d = decide(fullPass({ aadhaar: { verified: true, last4: '9999' } }), cfg);
    expect(d).toMatchObject({ status: 'rejected', reason: 'aadhaar-mismatch' });
    expect(d.checks).toEqual({ aadhaar: 'fail' });
  });
  it('liveness failed twice (threshold from config)', () => {
    const d = decide(base({ face: [{ match: 0.9, live: false }, { match: 0.9, live: false }] }), cfg);
    expect(d).toMatchObject({ status: 'rejected', reason: 'liveness-failed' });
    expect(d.checks).toEqual({ liveness: 'fail' });
  });
  it('liveness failed twice still rejects even if a later attempt passes', () => {
    const d = decide(fullPass({ face: [{ match: 0.9, live: false }, { match: 0.9, live: false }, faceOk] }), cfg);
    expect(d.reason).toBe('liveness-failed');
  });
  it('liveness reject count follows config.livenessFailsToReject', () => {
    const face = [{ match: 0.9, live: false }, { match: 0.9, live: false }];
    expect(decide(base({ face }), { ...cfg, livenessFailsToReject: 3 }).status).not.toBe('rejected');
    expect(decide(base({ face: [face[0]!] }), { ...cfg, livenessFailsToReject: 1 }).reason).toBe('liveness-failed');
  });
  it('timeouts do not count as liveness fails', () => {
    const d = decide(base({ face: [{ match: 0.9, live: false }, 'timeout'] }), cfg);
    expect(d.status).toBe('under-review');
    expect(d.unclear).toEqual(['face-match']);
  });
  it('liveness fails are ignored when liveness is not required', () => {
    const face = [{ match: 0.95, live: false }, { match: 0.95, live: false }];
    const d = decide(fullPass({ face }), noLiveness);
    expect(d).toMatchObject({ status: 'verified', path: 'full-kyc' });
    expect(d.checks.liveness).toBeUndefined();
  });
  it('timed-out PAN / Aadhaar are not clear fails', () => {
    expect(decide(fullPass({ pan: 'timeout' }), cfg).status).toBe('under-review');
    expect(decide(fullPass({ aadhaar: 'timeout' }), cfg).status).toBe('under-review');
  });
});

describe('decide: fail vs unclear / hand check precedence', () => {
  it('a clear fail beats a device hand check', () => {
    expect(decide(fullPass({ deviceHandCheck: true, panIndividual: false }), cfg).status).toBe('rejected');
  });
  it('a clear fail beats an unclear check elsewhere', () => {
    const d = decide(fullPass({ pan: { valid: false, nameMatch: false, aadhaarLinked: false }, face: ['timeout'] }), cfg);
    expect(d).toMatchObject({ status: 'rejected', reason: 'pan-invalid' });
  });
  it('a clear fail beats a KRA timeout and the KRA fast path', () => {
    expect(decide(base({ kra: 'timeout', aadhaar: { verified: true, last4: '0000' } }), cfg).reason).toBe('aadhaar-mismatch');
    expect(decide(base({ kra: kraOk, panIndividual: false }), cfg).reason).toBe('pan-not-individual');
  });
  it('fail checks run in order: not-individual before invalid before Aadhaar before liveness', () => {
    const all = base({
      panIndividual: false,
      pan: { ...panOk, valid: false },
      aadhaar: { verified: true, last4: '0000' },
      face: [{ match: 0, live: false }, { match: 0, live: false }],
    });
    expect(decide(all, cfg).reason).toBe('pan-not-individual');
    expect(decide({ ...all, panIndividual: true }, cfg).reason).toBe('pan-invalid');
    expect(decide({ ...all, panIndividual: true, pan: panOk }, cfg).reason).toBe('aadhaar-mismatch');
    expect(decide({ ...all, panIndividual: true, pan: panOk, aadhaar: aadhaarOk }, cfg).reason).toBe('liveness-failed');
  });
});

describe('decide: row 3, device hand check → under-review', () => {
  it('goes to a person even when KRA would validate', () => {
    const d = decide(base({ deviceHandCheck: true, kra: kraOk }), cfg);
    expect(d).toEqual({ status: 'under-review', path: 'hand-check', reason: 'device-hand-check', next: 'wait', checks: {} });
  });
  it('goes to a person before the KRA lookup', () => {
    expect(decide(base({ deviceHandCheck: true, kra: undefined }), cfg).reason).toBe('device-hand-check');
  });
});

describe('decide: row 1, KRA fast path', () => {
  it('KRA lookup not done → in progress, status unchanged', () => {
    const d = decide(base({ kra: undefined }), cfg);
    expect(d).toEqual({ status: 'pre-verified', path: null, reason: 'in-progress', next: 'kra-lookup', checks: {} });
    const t = decide(base({ current: 'under-review', currentReason: 'partner-timeout', kra: undefined }), cfg);
    expect(t).toEqual({ status: 'under-review', path: null, reason: 'partner-timeout', next: 'kra-lookup', checks: {} });
  });
  it('KRA timeout → under-review, reason partner-timeout, kra unclear', () => {
    const d = decide(base({ kra: 'timeout' }), cfg);
    expect(d).toEqual({
      status: 'under-review', path: null, reason: 'partner-timeout', next: 'wait', checks: {}, unclear: ['kra'],
    });
  });
  it('validated + name match + DOB match → verified (kra-validated)', () => {
    const d = decide(base({ kra: kraOk }), cfg);
    expect(d).toEqual({
      status: 'verified', path: 'kra-validated', reason: 'kra-validated', next: 'none',
      checks: { 'kra-name': 'pass', 'kra-dob': 'pass' },
    });
  });
  it('validated from an under-review partner-timeout case verifies (system retry)', () => {
    const d = decide(base({ current: 'under-review', currentReason: 'partner-timeout', kra: kraOk }), cfg);
    expect(d).toMatchObject({ status: 'verified', path: 'kra-validated', reason: 'kra-validated' });
  });
  it('validated but name fails → falls to full KYC', () => {
    const d = decide(base({ kra: { ...kraOk, name: 'RAHUL SANA' } }), cfg);
    expect(d).toMatchObject({ status: 'pre-verified', path: 'full-kyc', reason: 'in-progress', next: 'aadhaar' });
    expect(d.checks).toMatchObject({ 'kra-name': 'fail', 'kra-dob': 'pass' });
  });
  it('validated but name only an initial (unclear) → falls to full KYC', () => {
    const d = decide(base({ kra: { ...kraOk, name: 'N SANA' } }), cfg);
    expect(d).toMatchObject({ path: 'full-kyc', next: 'aadhaar' });
    expect(d.checks['kra-name']).toBe('unclear');
  });
  it('validated but no KRA name → name fail → full KYC', () => {
    const d = decide(base({ kra: { status: 'validated', dob: kraOk.dob } }), cfg);
    expect(d.checks['kra-name']).toBe('fail');
    expect(d.path).toBe('full-kyc');
  });
  it('validated but DOB differs or missing → full KYC', () => {
    expect(decide(base({ kra: { ...kraOk, dob: '1990-08-16' } }), cfg).checks['kra-dob']).toBe('fail');
    const d = decide(base({ kra: { status: 'validated', name: kraOk.name } }), cfg);
    expect(d.checks['kra-dob']).toBe('fail');
    expect(d.path).toBe('full-kyc');
  });
  it('validated with a failed name still verifies through a passing full KYC', () => {
    const d = decide(fullPass({ kra: { ...kraOk, name: 'RAHUL SANA' } }), cfg);
    expect(d).toMatchObject({ status: 'verified', path: 'full-kyc', reason: 'full-kyc-passed' });
  });
  for (const status of ['registered', 'on-hold', 'not-found'] as const) {
    it(`KRA ${status} → full KYC, no KRA name/DOB checks recorded`, () => {
      const d = decide(base({ kra: { status, name: kraOk.name, dob: kraOk.dob } }), cfg);
      expect(d).toMatchObject({ path: 'full-kyc', reason: 'in-progress', next: 'aadhaar', checks: {} });
    });
  }
});

describe('decide: row 2, full KYC', () => {
  it('everything passes → verified (full-kyc), then KRA upload', () => {
    const d = decide(fullPass(), cfg);
    expect(d).toEqual({
      status: 'verified', path: 'full-kyc', reason: 'full-kyc-passed', next: 'kra-upload',
      checks: {
        aadhaar: 'pass', pan: 'pass', 'pan-name': 'pass', 'pan-aadhaar-link': 'pass',
        liveness: 'pass', 'face-match': 'pass', esign: 'pass',
      },
    });
  });
  it('without liveness required, verified with no liveness check', () => {
    const d = decide(fullPass(), noLiveness);
    expect(d.status).toBe('verified');
    expect(d.checks.liveness).toBeUndefined();
  });

  describe('in progress: next is the first missing step, status unchanged', () => {
    it('nothing done → aadhaar', () => {
      expect(decide(base(), cfg)).toEqual({
        status: 'pre-verified', path: 'full-kyc', reason: 'in-progress', next: 'aadhaar', checks: {},
      });
    });
    it('aadhaar done → pan-check', () => {
      const d = decide(base({ aadhaar: aadhaarOk }), cfg);
      expect(d).toMatchObject({ next: 'pan-check', checks: { aadhaar: 'pass' } });
    });
    it('aadhaar + pan done → selfie', () => {
      expect(decide(base({ aadhaar: aadhaarOk, pan: panOk }), cfg).next).toBe('selfie');
      expect(decide(base({ aadhaar: aadhaarOk, pan: panOk, face: [] }), cfg).next).toBe('selfie');
    });
    it('one liveness fail → retake selfie (no reject yet)', () => {
      const d = decide(base({ aadhaar: aadhaarOk, pan: panOk, face: [{ match: 0.99, live: false }], esign: 'done' }), cfg);
      expect(d).toMatchObject({ status: 'pre-verified', reason: 'in-progress', next: 'selfie' });
      expect(d.checks.liveness).toBeUndefined();
      expect(d.checks['face-match']).toBeUndefined();
    });
    it('one liveness fail then a good selfie → verified', () => {
      expect(decide(fullPass({ face: [{ match: 0.99, live: false }, faceOk] }), cfg).status).toBe('verified');
    });
    it('selfie done, e-sign missing or pending → esign', () => {
      expect(decide(fullPass({ esign: undefined }), cfg).next).toBe('esign');
      expect(decide(fullPass({ esign: 'pending' }), cfg)).toMatchObject({ next: 'esign', reason: 'in-progress' });
    });
    it('a later step done but an earlier one missing → earliest missing step', () => {
      expect(decide(fullPass({ aadhaar: undefined }), cfg).next).toBe('aadhaar');
      expect(decide(fullPass({ pan: undefined }), cfg).next).toBe('pan-check');
      expect(decide(fullPass({ face: undefined }), cfg).next).toBe('selfie');
    });
    it('an under-review case stays under-review while in progress', () => {
      expect(decide(base({ current: 'under-review' }), cfg).status).toBe('under-review');
    });
  });

  describe('row 3: any unclear check → under-review', () => {
    const cases: [string, Partial<DecideInput>, string[], 'check-unclear' | 'partner-timeout'][] = [
      ['Aadhaar timeout', { aadhaar: 'timeout' }, ['aadhaar'], 'partner-timeout'],
      ['PAN timeout', { pan: 'timeout' }, ['pan'], 'partner-timeout'],
      ['PAN name partial', { pan: { ...panOk, nameMatch: false } }, ['pan-name'], 'check-unclear'],
      ['PAN not Aadhaar-linked', { pan: { ...panOk, aadhaarLinked: false } }, ['pan-aadhaar-link'], 'check-unclear'],
      ['face match timeout', { face: ['timeout'] }, ['face-match'], 'partner-timeout'],
      ['low face score', { face: [{ match: 0.79, live: true }] }, ['face-match'], 'check-unclear'],
      ['e-sign timeout', { esign: 'timeout' }, ['esign'], 'partner-timeout'],
    ];
    for (const [label, over, unclear, reason] of cases) {
      it(label, () => {
        const d = decide(fullPass(over), cfg);
        expect(d).toMatchObject({ status: 'under-review', path: 'full-kyc', reason, next: 'wait' });
        expect(d.unclear).toEqual(unclear);
        for (const name of unclear) expect(d.checks[name as keyof typeof d.checks]).toBe('unclear');
      });
    }
    it('lists every unclear check, in step order', () => {
      const d = decide(fullPass({ aadhaar: 'timeout', pan: { valid: true, nameMatch: false, aadhaarLinked: false }, face: ['timeout'], esign: 'timeout' }), cfg);
      expect(d.unclear).toEqual(['aadhaar', 'pan-name', 'pan-aadhaar-link', 'face-match', 'esign']);
    });
    it('unclear beats a missing step (no waiting on the user)', () => {
      const d = decide(base({ aadhaar: 'timeout' }), cfg);
      expect(d).toMatchObject({ status: 'under-review', next: 'wait', unclear: ['aadhaar'] });
    });
    it('the latest face attempt is the one judged', () => {
      expect(decide(fullPass({ face: ['timeout', faceOk] }), cfg).status).toBe('verified');
      expect(decide(fullPass({ face: [faceOk, 'timeout'] }), cfg).status).toBe('under-review');
    });
  });

  describe('face-match threshold from config', () => {
    it('score exactly at the threshold passes (≥)', () => {
      expect(decide(fullPass({ face: [{ match: 0.8, live: true }] }), cfg).status).toBe('verified');
    });
    it('a stricter config sends the same score to review', () => {
      const d = decide(fullPass({ face: [{ match: 0.85, live: true }] }), { ...cfg, faceMatchMin: 0.9 });
      expect(d.unclear).toEqual(['face-match']);
    });
    it('a looser config passes a lower score', () => {
      expect(decide(fullPass({ face: [{ match: 0.6, live: true }] }), { ...cfg, faceMatchMin: 0.5 }).status).toBe('verified');
    });
  });
});

describe('transition guards', () => {
  const all: KycStatus[] = ['pre-verified', 'under-review', 'verified', 'rejected'];
  it('system: terminal cases never move; under-review never goes back to pre-verified', () => {
    for (const to of all) {
      expect(canSystemTransition('verified', to, 'partner-timeout')).toBe(false);
      expect(canSystemTransition('rejected', to, 'partner-timeout')).toBe(false);
      expect(canSystemTransition('pre-verified', to)).toBe(true);
      expect(canSystemTransition('under-review', to, 'partner-timeout')).toBe(to !== 'pre-verified');
    }
  });
  it('system: under-review → verified only when the reason is partner-timeout', () => {
    expect(canSystemTransition('under-review', 'verified', 'partner-timeout')).toBe(true);
    for (const r of [undefined, null, 'check-unclear', 'device-hand-check', 'in-progress'] as const) {
      expect(canSystemTransition('under-review', 'verified', r)).toBe(false);
      expect(canSystemTransition('under-review', 'rejected', r)).toBe(true);
      expect(canSystemTransition('under-review', 'under-review', r)).toBe(true);
    }
  });
  it('staff: only under-review → verified / rejected', () => {
    for (const from of all) {
      for (const to of all) {
        expect(canStaffTransition(from, to)).toBe(from === 'under-review' && (to === 'verified' || to === 'rejected'));
      }
    }
  });
  it('decide never produces an illegal system transition', () => {
    const inputs: DecideInput[] = [
      base({ kra: undefined }), base({ kra: 'timeout' }), base({ kra: kraOk }), base(), fullPass(),
      fullPass({ panIndividual: false }), fullPass({ deviceHandCheck: true }), fullPass({ esign: 'timeout' }),
    ];
    const starts = [
      { current: 'pre-verified' as const, currentReason: null },
      ...([null, 'partner-timeout', 'check-unclear', 'device-hand-check'] as const).map((r) => ({
        current: 'under-review' as const, currentReason: r,
      })),
    ];
    for (const s of starts) {
      for (const i of inputs) {
        const d = decide({ ...i, ...s }, cfg);
        if (d.status !== s.current) expect(canSystemTransition(s.current, d.status, s.currentReason)).toBe(true);
        expect(s.current === 'under-review' && d.status === 'pre-verified').toBe(false);
      }
    }
  });
});

describe('decide: under-review cases (system vs staff)', () => {
  const ur = (currentReason: DecideInput['currentReason'], over: Partial<DecideInput> = {}) =>
    base({ current: 'under-review', currentReason, ...over });

  it('partner-timeout: a retry that now passes verifies (KRA and full KYC)', () => {
    expect(decide(ur('partner-timeout', { kra: kraOk }), cfg).status).toBe('verified');
    expect(decide({ ...fullPass(), current: 'under-review', currentReason: 'partner-timeout' }, cfg)).toMatchObject({
      status: 'verified', reason: 'full-kyc-passed',
    });
  });
  it('partner-timeout: steps still missing → stays under-review, reason kept, next is the step', () => {
    const d = decide(ur('partner-timeout', { aadhaar: aadhaarOk }), cfg);
    expect(d).toMatchObject({ status: 'under-review', reason: 'partner-timeout', next: 'pan-check' });
  });
  it('partner-timeout: a real doubt on retry becomes check-unclear', () => {
    const d = decide({ ...fullPass({ face: [{ match: 0.5, live: true }] }), current: 'under-review', currentReason: 'partner-timeout' }, cfg);
    expect(d).toMatchObject({ status: 'under-review', reason: 'check-unclear', unclear: ['face-match'] });
  });
  for (const r of ['check-unclear', 'device-hand-check', null, undefined] as const) {
    it(`reason ${String(r)}: never verified by the system, waits for staff`, () => {
      for (const i of [ur(r, { kra: kraOk }), { ...fullPass(), current: 'under-review' as const, currentReason: r }, ur(r)]) {
        const d = decide(i, cfg);
        expect(d.status).toBe('under-review');
        expect(d.next).toBe('wait');
        expect(d.reason).toBe(r ?? 'check-unclear');
      }
    });
    it(`reason ${String(r)}: a clear fail still rejects`, () => {
      expect(decide(ur(r, { panIndividual: false }), cfg).status).toBe('rejected');
    });
  }
  it('a staff-needed case is never relabelled partner-timeout by a later timeout', () => {
    expect(decide(ur('check-unclear', { kra: 'timeout' }), cfg).reason).toBe('check-unclear');
    expect(decide(ur(undefined, { kra: 'timeout' }), cfg).reason).toBe('check-unclear');
  });
  it('without a stored reason, a fresh unclear reason is kept (device hand check)', () => {
    expect(decide(ur(undefined, { deviceHandCheck: true }), cfg).reason).toBe('device-hand-check');
  });
  it('keeps unclear names on a staff-needed case', () => {
    const d = decide({ ...fullPass({ face: [{ match: 0.5, live: true }] }), current: 'under-review', currentReason: 'check-unclear' }, cfg);
    expect(d.unclear).toEqual(['face-match']);
  });
});

describe('staffDecide: row 5', () => {
  const review = { status: 'under-review' as const, path: 'full-kyc' as const };

  it('approve → verified, then KRA upload, note trimmed', () => {
    expect(staffDecide(review, { kind: 'approve', staffId: 's1', note: '  docs ok  ' })).toEqual({
      status: 'verified', path: 'full-kyc', reason: 'staff-approved', next: 'kra-upload', checks: {}, note: 'docs ok',
    });
  });
  it('approve without a note (or blank note) has no note', () => {
    expect(staffDecide(review, { kind: 'approve', staffId: 's1' })).not.toHaveProperty('note');
    expect(staffDecide(review, { kind: 'approve', staffId: 's1', note: '   ' })).not.toHaveProperty('note');
  });
  it('reject → rejected with the trimmed reason as note', () => {
    expect(staffDecide(review, { kind: 'reject', staffId: 's1', reason: ' blurry PAN ' })).toEqual({
      status: 'rejected', path: 'full-kyc', reason: 'staff-rejected', next: 'none', checks: {}, note: 'blurry PAN',
    });
  });
  it('a case with no path yet gets path hand-check', () => {
    expect(staffDecide({ status: 'under-review', path: null }, { kind: 'approve', staffId: 's1' }).path).toBe('hand-check');
    expect(staffDecide({ status: 'under-review', path: 'hand-check' }, { kind: 'reject', staffId: 's1', reason: 'x' }).path).toBe('hand-check');
  });
  it('reject needs a reason', () => {
    for (const reason of ['', '   ']) {
      expect(() => staffDecide(review, { kind: 'reject', staffId: 's1', reason })).toThrow(/needs a reason/);
    }
  });
  it('staff id is required', () => {
    expect(() => staffDecide(review, { kind: 'approve', staffId: ' ' })).toThrow(/staff id is required/);
    expect(() => staffDecide(review, { kind: 'reject', staffId: '', reason: 'x' })).toThrow(KycTransitionError);
  });
  for (const status of ['pre-verified', 'verified', 'rejected'] as const) {
    it(`staff cannot decide a ${status} case`, () => {
      for (const action of [
        { kind: 'approve' as const, staffId: 's1' },
        { kind: 'reject' as const, staffId: 's1', reason: 'x' },
      ]) {
        try {
          staffDecide({ status, path: 'full-kyc' }, action);
          expect.unreachable();
        } catch (e) {
          expect(e).toBeInstanceOf(KycTransitionError);
          expect(e).toMatchObject({ from: status, to: 'staff-action' });
        }
      }
    });
  }
});
