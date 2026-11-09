import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, paidChecksLeft } from '../../src/config';

describe('loadConfig', () => {
  it('defaults when env is empty', () => {
    expect(loadConfig({})).toEqual(DEFAULT_CONFIG);
  });
  it('reads valid values', () => {
    expect(loadConfig({ KYC_FACE_MATCH_MIN: '0.9', KYC_LIVENESS_REQUIRED: ' FALSE ', KYC_MAX_PAID_CHECKS_PER_DAY: '3' })).toEqual({
      ...DEFAULT_CONFIG, faceMatchMin: 0.9, livenessRequired: false, maxPaidChecksPerDay: 3,
    });
  });
  it('falls back to safe defaults on blank / invalid / out-of-range values', () => {
    for (const v of ['', '  ', 'abc', '0', '-1', '1.5', 'Infinity']) {
      expect(loadConfig({ KYC_FACE_MATCH_MIN: v }).faceMatchMin).toBe(DEFAULT_CONFIG.faceMatchMin);
    }
    for (const v of ['0', '2.5', '-3', 'x']) {
      expect(loadConfig({ KYC_MAX_PAID_CHECKS_PER_DAY: v }).maxPaidChecksPerDay).toBe(DEFAULT_CONFIG.maxPaidChecksPerDay);
    }
  });
  it('liveness stays on for anything but "false"', () => {
    for (const v of ['true', '0', 'no', 'off', '']) expect(loadConfig({ KYC_LIVENESS_REQUIRED: v }).livenessRequired).toBe(true);
  });
  it('accepts the upper bound 1 for face match', () => {
    expect(loadConfig({ KYC_FACE_MATCH_MIN: '1' }).faceMatchMin).toBe(1);
  });
  it('reads process.env by default', () => {
    expect(loadConfig().livenessFailsToReject).toBe(2);
  });
});

describe('paidChecksLeft', () => {
  it('counts down and never goes negative', () => {
    expect(DEFAULT_CONFIG.maxPaidChecksPerDay).toBe(10);
    expect(paidChecksLeft(0, DEFAULT_CONFIG)).toBe(10);
    expect(paidChecksLeft(9, DEFAULT_CONFIG)).toBe(1);
    expect(paidChecksLeft(14, DEFAULT_CONFIG)).toBe(0);
  });
});
