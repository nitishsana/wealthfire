import { describe, expect, it } from 'vitest';
import { LOCAL_PERSONAS, localPersona } from '../src/localPersonas';
import {
  DOB_MESSAGES, panSurnameWarning, validateDob, validateMobile, validateName, validatePan,
} from '../src/onboarding';

describe('LOCAL_PERSONAS', () => {
  it('has the six required test users, with unique ids and distinct mobiles', () => {
    const ids = LOCAL_PERSONAS.map((p) => p.id);
    expect(ids).toEqual(['fast', 'full', 'handcheck', 'panused', 'slow', 'minor']);
    expect(new Set(ids).size).toBe(ids.length);
    const mobiles = LOCAL_PERSONAS.map((p) => p.mobile);
    expect(new Set(mobiles).size).toBe(mobiles.length);
  });

  it('every value passes the app validators; the date of birth is valid except for `minor`', () => {
    for (const p of LOCAL_PERSONAS) {
      expect(validateMobile(p.mobile), p.id).toBeNull();
      expect(validateName(p.firstName), p.id).toBeNull();
      expect(validateName(p.lastName), p.id).toBeNull();
      expect(validatePan(p.pan), p.id).toBeNull();
      expect(panSurnameWarning(p.pan, p.lastName), p.id).toBeNull();
      expect(p.aadhaarLast4, p.id).toMatch(/^\d{4}$/);
      expect(p.dob, p.id).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
      expect(p.name.length, p.id).toBeGreaterThan(0);
      expect(p.tests.length, p.id).toBeGreaterThan(0);
      if (p.id === 'minor') expect(validateDob(p.dob)).toBe(DOB_MESSAGES.minor);
      else expect(validateDob(p.dob), p.id).toBeNull();
    }
  });

  it('`panused` shares the PAN of `fast`; every other PAN is its own', () => {
    expect(localPersona('panused')!.pan).toBe(localPersona('fast')!.pan);
    const others = LOCAL_PERSONAS.filter((p) => p.id !== 'panused').map((p) => p.pan);
    expect(new Set(others).size).toBe(others.length);
  });

  it('localPersona: unknown ids give undefined', () => {
    expect(localPersona('full')!.name).toBe('Ravi Kumar');
    for (const bad of ['', 'FAST', 'nope', undefined, 1]) expect(localPersona(bad)).toBeUndefined();
  });
});
