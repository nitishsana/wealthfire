import type { BucketState } from './types';
import type { NetWorthSummary } from './networth';

/**
 * 3-bucket FIRE plan.
 *  Bucket 1 "Spend":  next 2 years of expenses in cash / liquid funds.
 *  Bucket 2 "Refill": years 3-7 in debt funds, FDs, gold.
 *  Bucket 3 "Grow":   the rest in equity, for year 8 onward.
 */
export const BUCKET_YEARS = { bucket1: 2, bucket2: 5 } as const;

export type BucketPhase = 'accumulate' | 'build_bucket2' | 'build_bucket1' | 'drawdown';

export const PHASE_LABELS: Record<BucketPhase, string> = {
  accumulate: 'Grow phase',
  build_bucket2: 'Build Bucket 2',
  build_bucket1: 'Build Bucket 1',
  drawdown: 'Retired: live off buckets',
};

export interface BucketMove {
  from: keyof BucketState | 'sip';
  to: keyof BucketState;
  amount: number; // INR; for 'sip' this is per month
  reason: string;
}

export interface BucketPlan {
  phase: BucketPhase;
  targets: BucketState;
  current: BucketState;
  fillPct: BucketState;
  moves: BucketMove[];
  notes: string[];
}

export const BUCKET_NAMES: Record<keyof BucketState, string> = {
  bucket1: 'Bucket 1 · Spend',
  bucket2: 'Bucket 2 · Refill',
  bucket3: 'Bucket 3 · Grow',
};

/** Map holdings to buckets: cash -> B1, debt + gold -> B2, equity -> B3. */
export function bucketsFromNetWorth(nw: NetWorthSummary): BucketState {
  return { bucket1: nw.byClass.cash, bucket2: nw.byClass.debt + nw.byClass.gold, bucket3: nw.byClass.equity };
}

export function phaseFor(yearsToFire: number): BucketPhase {
  if (yearsToFire <= 0) return 'drawdown';
  if (yearsToFire <= 3) return 'build_bucket1';
  if (yearsToFire <= 7) return 'build_bucket2';
  return 'accumulate';
}

export interface BucketInput {
  current: BucketState;
  yearsToFire: number;
  /** Monthly spend in today's rupees */
  monthlyExpense: number;
  /** Monthly spend expected on FIRE day */
  monthlyExpenseAtFire: number;
  /** Equity return over the last 12 months, %. Drives refill source. */
  lastYearEquityReturn: number;
  monthlySip: number;
}

const pct = (a: number, b: number) => (b <= 0 ? 100 : Math.min(100, Math.round((a / b) * 100)));

export function planBuckets(input: BucketInput): BucketPlan {
  const { current, yearsToFire, monthlyExpense, monthlyExpenseAtFire, lastYearEquityReturn, monthlySip } = input;
  const phase = phaseFor(yearsToFire);
  const spend = phase === 'drawdown' ? monthlyExpense : monthlyExpenseAtFire;
  const total = current.bucket1 + current.bucket2 + current.bucket3;

  const targets: BucketState =
    phase === 'accumulate'
      ? // Before FIRE: Bucket 1 is just a 6-month emergency fund.
        { bucket1: monthlyExpense * 6, bucket2: 0, bucket3: Math.max(0, total - monthlyExpense * 6) }
      : {
          bucket1: spend * 12 * BUCKET_YEARS.bucket1,
          bucket2: spend * 12 * BUCKET_YEARS.bucket2,
          bucket3: Math.max(0, total - spend * 12 * (BUCKET_YEARS.bucket1 + BUCKET_YEARS.bucket2)),
        };
  // In build phases, the lower buckets only need to be full by the end of the phase.
  const moves: BucketMove[] = [];
  const notes: string[] = [];
  const equityDown = lastYearEquityReturn < 0;
  const r = (n: number) => Math.round(n);
  const gap1 = targets.bucket1 - current.bucket1;
  const gap2 = targets.bucket2 - current.bucket2;

  if (phase === 'accumulate') {
    if (gap1 > 0) moves.push({ from: 'sip', to: 'bucket1', amount: r(Math.min(monthlySip, gap1 / 6)), reason: 'Finish your 6-month emergency fund first.' });
    notes.push(`FIRE is ${Math.round(yearsToFire)} years away. Keep SIPs in growth funds.`);
    notes.push(`Start building Bucket 2 when FIRE is ${7} years away.`);
  }

  if (phase === 'build_bucket2') {
    const monthsLeft = Math.max(1, (yearsToFire - 3) * 12);
    if (gap2 > 0) {
      moves.push({ from: 'sip', to: 'bucket2', amount: r(Math.min(monthlySip, gap2 / monthsLeft)), reason: 'Send part of each SIP to debt funds.' });
      if (!equityDown) moves.push({ from: 'bucket3', to: 'bucket2', amount: r(Math.min(current.bucket3 * 0.1, gap2 / Math.max(1, monthsLeft / 12))), reason: 'Equity is up. Lock in some gains this year.' });
      else notes.push('Equity is down. Do not sell equity now; use new SIPs only.');
    }
    if (gap1 > 0 && monthlyExpense * 6 > current.bucket1) moves.push({ from: 'sip', to: 'bucket1', amount: r(Math.min(monthlySip, (monthlyExpense * 6 - current.bucket1) / 6)), reason: 'Keep a 6-month emergency fund.' });
  }

  if (phase === 'build_bucket1') {
    const monthsLeft = Math.max(1, yearsToFire * 12);
    if (gap1 > 0) {
      moves.push({ from: 'sip', to: 'bucket1', amount: r(Math.min(monthlySip, gap1 / monthsLeft)), reason: 'Fill 2 years of spending in liquid funds.' });
      const src = equityDown ? 'bucket2' : 'bucket3';
      moves.push({ from: src, to: 'bucket1', amount: r(gap1 / Math.max(1, yearsToFire)), reason: equityDown ? 'Equity is down, so refill from Bucket 2.' : 'Equity is up, so take from Bucket 3.' });
    }
    if (gap2 > 0 && !equityDown) moves.push({ from: 'bucket3', to: 'bucket2', amount: r(gap2 / Math.max(1, yearsToFire)), reason: 'Top up Bucket 2 before FIRE day.' });
  }

  if (phase === 'drawdown') {
    const yearlySpend = monthlyExpense * 12;
    notes.push(`Take ₹${r(monthlyExpense).toLocaleString('en-IN')} a month from Bucket 1 only.`);
    if (current.bucket1 < yearlySpend * BUCKET_YEARS.bucket1) {
      const need = yearlySpend * BUCKET_YEARS.bucket1 - current.bucket1;
      if (equityDown) {
        moves.push({ from: 'bucket2', to: 'bucket1', amount: r(Math.min(need, current.bucket2)), reason: 'Equity is down. Refill from Bucket 2; let equity recover.' });
      } else {
        moves.push({ from: 'bucket3', to: 'bucket1', amount: r(Math.min(need, current.bucket3)), reason: 'Equity is up. Refill Bucket 1 from gains.' });
      }
    }
    if (!equityDown && gap2 > 0) moves.push({ from: 'bucket3', to: 'bucket2', amount: r(Math.min(gap2, current.bucket3 * 0.2)), reason: 'Good year: top up Bucket 2 from equity.' });
    if (equityDown) notes.push('Bad year for equity. Do not sell Bucket 3.');
  }

  return {
    phase,
    targets: { bucket1: r(targets.bucket1), bucket2: r(targets.bucket2), bucket3: r(targets.bucket3) },
    current,
    fillPct: {
      bucket1: pct(current.bucket1, targets.bucket1),
      bucket2: pct(current.bucket2, targets.bucket2),
      bucket3: pct(current.bucket3, targets.bucket3),
    },
    moves: moves.filter((m) => m.amount > 0),
    notes,
  };
}
