import { describe, expect, it } from 'vitest';
import { analyze, computeCoastFire, corpusFundedSpend, DEFAULT_ASSUMPTIONS, demoData, FIRE_TYPES, fireTypeInfo, type Profile } from '../src';

const profile: Profile = { name: 'T', age: 30, city: '', monthlyIncome: 200000, dependents: 0, targetRetireAge: 45, lifeExpectancy: 85, currentMonthlySip: 40000 };

describe('FIRE types', () => {
  it('has Lean, FIRE, Barista and Fat', () => {
    expect(FIRE_TYPES.map((t) => t.id)).toEqual(['lean', 'regular', 'barista', 'fat']);
    expect(fireTypeInfo('fat').name).toBe('Fat FIRE');
  });
  it('corpus spend per type', () => {
    expect(corpusFundedSpend('lean', profile, 100000)).toBe(70000);
    expect(corpusFundedSpend('regular', profile, 100000)).toBe(100000);
    expect(corpusFundedSpend('fat', profile, 100000)).toBe(150000);
    expect(corpusFundedSpend('barista', profile, 100000)).toBe(60000); // default 40% part-time
    expect(corpusFundedSpend('barista', { ...profile, partTimeIncome: 25000 }, 100000)).toBe(75000);
    expect(corpusFundedSpend('barista', { ...profile, partTimeIncome: 500000 }, 100000)).toBe(0);
  });

  it('engine: lean and barista below FIRE below fat; earliest age the other way', () => {
    const a = analyze(demoData(new Date(2026, 10, 5)));
    const n = Object.fromEntries(a.fireTypes.map((t) => [t.type.id, t.plan]));
    // Barista with the default 40% side income needs 60% of spend from the corpus: less than Lean's 70%.
    expect(n.barista!.fireNumber).toBeLessThan(n.lean!.fireNumber);
    expect(n.lean!.fireNumber).toBeLessThan(n.regular!.fireNumber);
    expect(n.regular!.fireNumber).toBeLessThan(n.fat!.fireNumber);
    expect(n.lean!.earliestFireAgeWithCurrentSip!).toBeLessThanOrEqual(n.regular!.earliestFireAgeWithCurrentSip!);
    expect(n.fat!.requiredMonthlySip).toBeGreaterThan(n.regular!.requiredMonthlySip);
    // Savings rate is about real spending, not the target: same for every type.
    expect(n.lean!.savingsRatePct).toBe(n.fat!.savingsRatePct);
  });

  it('chosen type drives the main plan; default is FIRE', () => {
    const d = demoData(new Date(2026, 10, 5));
    expect(analyze(d).fireType!.id).toBe('regular');
    const lean = analyze({ ...d, profile: { ...d.profile!, fireType: 'lean' } });
    expect(lean.fireType!.id).toBe('lean');
    expect(lean.fire!.fireNumber).toBe(lean.fireTypes[0]!.plan.fireNumber);
    expect(lean.fire!.messages.some((m) => m.includes('Lean FIRE'))).toBe(true);
  });
});

describe('Coast FIRE', () => {
  it('needed today grows to the age-60 target with no more saving', () => {
    const c = computeCoastFire(profile, 100000, 0, 10, DEFAULT_ASSUMPTIONS, 60);
    expect(c.neededToday * Math.pow(1.1, 30)).toBeCloseTo(c.targetAtCoastAge, -2);
    expect(c.reached).toBe(false);
    expect(c.ageReached).not.toBeNull();
  });
  it('is reached when investments already cover it', () => {
    const c = computeCoastFire(profile, 50000, 1e8, 10, DEFAULT_ASSUMPTIONS);
    expect(c.reached).toBe(true);
    expect(c.ageReached).toBe(30);
    expect(c.progressPct).toBe(100);
  });
});
