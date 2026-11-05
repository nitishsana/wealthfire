import { describe, expect, it } from 'vitest';
import {
  analyze, categorize, computeRiskScore, DEFAULT_ASSUMPTIONS, demoData, deserialize, emptyData,
  equityCap, fvLump, fvSip, parseDate, parseStatement, phaseFor, planBuckets, requiredSip,
  RISK_QUESTIONS, serialize, suggestPortfolio, summarizeExpenses, trackProgress, upsertSnapshot, inrShort,
} from '../src';

describe('finance', () => {
  it('fvLump compounds yearly', () => {
    expect(fvLump(100000, 10, 2)).toBeCloseTo(121000, 0);
  });
  it('fvSip with 0% equals sum of payments', () => {
    expect(fvSip(1000, 0, 2)).toBeCloseTo(24000, 6);
  });
  it('fvSip step-up raises the total', () => {
    expect(fvSip(1000, 12, 10, 10)).toBeGreaterThan(fvSip(1000, 12, 10, 0));
  });
  it('requiredSip inverts fvSip', () => {
    const sip = requiredSip(1e7, 12, 15, 10);
    expect(fvSip(sip, 12, 15, 10)).toBeGreaterThanOrEqual(1e7);
    expect(fvSip(sip - 2, 12, 15, 10)).toBeLessThan(1e7);
  });
});

describe('risk', () => {
  it('all lowest answers + old age = Conservative 0', () => {
    const answers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.id, 0]));
    expect(computeRiskScore(answers, 65)).toEqual({ score: 0, profile: 'Conservative' });
  });
  it('all highest answers + young = Aggressive 100', () => {
    const answers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.id, 4]));
    expect(computeRiskScore(answers, 25)).toEqual({ score: 100, profile: 'Aggressive' });
  });
});

describe('portfolio', () => {
  it('weights sum to 100 for every profile and horizon', () => {
    for (const p of ['Conservative', 'Moderate', 'Balanced', 'Growth', 'Aggressive'] as const) {
      for (const y of [0, 1, 3, 6, 12, 25]) {
        const s = suggestPortfolio(p, y, 10000, DEFAULT_ASSUMPTIONS);
        const sum = s.lines.reduce((t, l) => t + l.weight, 0);
        expect(sum).toBeCloseTo(100, 0);
        expect(s.equityPct).toBeLessThanOrEqual(equityCap(y) + 0.5);
      }
    }
  });
});

describe('expenses', () => {
  it('categorizes common merchants', () => {
    expect(categorize('SWIGGY BANGALORE')).toBe('Food');
    expect(categorize('OLA CABS')).toBe('Transport');
    expect(categorize('Motorola store')).toBe('Other');
    expect(categorize('Apollo Clinic')).toBe('Health');
    expect(categorize('HOME LOAN EMI')).toBe('EMI');
    expect(categorize('Premium chemist')).toBe('Other');
  });
  it('parses date formats', () => {
    expect(parseDate('05/10/2026')).toBe('2026-10-05');
    expect(parseDate('2026-10-05')).toBe('2026-10-05');
    expect(parseDate('5 Oct 2026')).toBe('2026-10-05');
    expect(parseDate('31/13/2026')).toBeNull();
  });
  it('parses a statement and skips credits', () => {
    const text = [
      'Date, Description, Amount',
      '05/10/2026, SWIGGY BANGALORE, 450.00',
      '06 Oct 2026  AMAZON PAY INDIA  1,299.00 Dr',
      '07/10/2026 PAYMENT RECEIVED - THANK YOU 25,000.00 Cr',
      '08/10/2026, UBER INDIA, ₹ 320',
    ].join('\n');
    const r = parseStatement(text);
    expect(r.expenses.map((e) => [e.date, e.amount, e.category])).toEqual([
      ['2026-10-05', 450, 'Food'],
      ['2026-10-06', 1299, 'Shopping'],
      ['2026-10-08', 320, 'Transport'],
    ]);
    expect(r.expenses[0]!.description).toBe('SWIGGY BANGALORE');
    expect(r.skipped).toBe(2);
  });
  it('summarizes per month and leaves EMI out of living cost', () => {
    const s = summarizeExpenses([
      { id: '1', date: '2026-09-01', description: 'x', amount: 1000, category: 'Food', source: 'manual' },
      { id: '2', date: '2026-10-01', description: 'y', amount: 3000, category: 'Food', source: 'manual' },
      { id: '3', date: '2026-10-02', description: 'z', amount: 2000, category: 'EMI', source: 'manual' },
    ]);
    expect(s.months).toBe(2);
    expect(s.monthlyAverage).toBe(3000);
    expect(s.monthlyLiving).toBe(2000);
  });
});

describe('buckets', () => {
  it('phases by years to FIRE', () => {
    expect(phaseFor(20)).toBe('accumulate');
    expect(phaseFor(6)).toBe('build_bucket2');
    expect(phaseFor(2)).toBe('build_bucket1');
    expect(phaseFor(0)).toBe('drawdown');
  });
  it('drawdown refills from Bucket 2 when equity is down, never from Bucket 3', () => {
    const p = planBuckets({ current: { bucket1: 100000, bucket2: 3000000, bucket3: 10000000 }, yearsToFire: 0, monthlyExpense: 100000, monthlyExpenseAtFire: 100000, lastYearEquityReturn: -15, monthlySip: 0 });
    expect(p.moves.some((m) => m.from === 'bucket3')).toBe(false);
    expect(p.moves[0]).toMatchObject({ from: 'bucket2', to: 'bucket1', amount: 2300000 });
  });
  it('drawdown refills from Bucket 3 when equity is up', () => {
    const p = planBuckets({ current: { bucket1: 100000, bucket2: 6000000, bucket3: 10000000 }, yearsToFire: 0, monthlyExpense: 100000, monthlyExpenseAtFire: 100000, lastYearEquityReturn: 12, monthlySip: 0 });
    expect(p.moves[0]).toMatchObject({ from: 'bucket3', to: 'bucket1' });
  });
});

describe('tracking', () => {
  it('keeps one snapshot per month', () => {
    let l = upsertSnapshot([], { date: '2026-10-01', investable: 1, netWorth: 1, fireNumber: 1, monthlySip: 1 });
    l = upsertSnapshot(l, { date: '2026-10-20', investable: 2, netWorth: 2, fireNumber: 1, monthlySip: 1 });
    l = upsertSnapshot(l, { date: '2026-09-01', investable: 0, netWorth: 0, fireNumber: 1, monthlySip: 1 });
    expect(l.map((s) => s.investable)).toEqual([0, 2]);
  });
  it('measures vs plan from the first check-in', () => {
    const snaps = [
      { date: '2026-01-01', investable: 1000000, netWorth: 0, fireNumber: 1, monthlySip: 10000 },
      { date: '2027-01-01', investable: 1300000, netWorth: 0, fireNumber: 1, monthlySip: 10000 },
    ];
    // Plan at 10%: 11 L + ~1.27 L of SIP = ~12.3 L, so 13 L is ahead.
    expect(trackProgress(snaps, { returnPct: 10, stepUpPct: 0 }).verdict).toBe('ahead');
    expect(trackProgress(snaps, { returnPct: 25, stepUpPct: 0 }).verdict).toBe('behind');
  });
  it('is new with fewer than 2 snapshots', () => {
    expect(trackProgress([], null).verdict).toBe('new');
  });
});

describe('store', () => {
  it('round-trips and survives bad json', () => {
    const d = demoData(new Date(2026, 10, 5));
    expect(deserialize(serialize(d))).toEqual(d);
    expect(deserialize('{not json')).toEqual(emptyData());
    expect(deserialize(null)).toEqual(emptyData());
  });
});

describe('engine', () => {
  it('reports what is missing on empty data', () => {
    const a = analyze(emptyData());
    expect(a.ready).toBe(false);
    expect(a.missing).toEqual(['profile', 'risk', 'expenses']);
    expect(a.fire).toBeNull();
  });
  it('produces a full, sane plan for demo data', () => {
    const a = analyze(demoData(new Date(2026, 10, 5)));
    expect(a.ready).toBe(true);
    expect(a.risk?.profile).toBe('Growth');
    expect(a.netWorth.investable).toBe(4350000);
    expect(a.fire!.yearsToFire).toBe(13);
    expect(a.fire!.fireNumber).toBeGreaterThan(a.fire!.fireNumberToday);
    expect(a.fire!.requiredMonthlySip).toBeGreaterThan(0);
    expect(a.portfolio!.lines.length).toBeGreaterThan(3);
    expect(a.buckets!.phase).toBe('accumulate');
    expect(a.progress.snapshots).toBe(2);
  });
});

describe('format', () => {
  it('short INR', () => {
    expect(inrShort(42000000)).toBe('₹4.20 Cr');
    expect(inrShort(3850000)).toBe('₹38.5 L');
  });
});
