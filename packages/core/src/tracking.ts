import type { Snapshot } from './types';
import { fvLump, fvSip } from './finance';

/** Add or replace this month's snapshot. Keeps one per month, sorted by date. */
export function upsertSnapshot(list: Snapshot[], snap: Snapshot): Snapshot[] {
  const month = snap.date.slice(0, 7);
  return [...list.filter((s) => s.date.slice(0, 7) !== month), snap].sort((a, b) => a.date.localeCompare(b.date));
}

export interface ProgressReport {
  snapshots: number;
  firstDate: string | null;
  growthPct: number; // investable growth since first snapshot
  monthlyAddedAvg: number;
  /** Actual vs where the plan said you'd be after the elapsed time; >0 means ahead */
  vsPlanPct: number | null;
  verdict: 'ahead' | 'on_plan' | 'behind' | 'new';
  messages: string[];
}

function monthsBetween(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number) as [number, number];
  const [yb, mb] = b.split('-').map(Number) as [number, number];
  return (yb - ya) * 12 + (mb - ma);
}

/**
 * Compare the latest check-in with where the plan said you'd be,
 * starting from the first check-in: its corpus grows at the portfolio return
 * and its SIP keeps going with yearly step-up.
 */
export function trackProgress(snapshots: Snapshot[], plan: { returnPct: number; stepUpPct: number } | null): ProgressReport {
  if (snapshots.length < 2) {
    return { snapshots: snapshots.length, firstDate: snapshots[0]?.date ?? null, growthPct: 0, monthlyAddedAvg: 0, vsPlanPct: null, verdict: 'new', messages: ['Save a check-in each month to track your FIRE progress.'] };
  }
  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const months = Math.max(1, monthsBetween(first.date, last.date));
  const growthPct = first.investable > 0 ? ((last.investable - first.investable) / first.investable) * 100 : 0;
  const monthlyAddedAvg = (last.investable - first.investable) / months;

  let vsPlanPct: number | null = null;
  if (plan) {
    const years = months / 12;
    const expected = fvLump(first.investable, plan.returnPct, years) + fvSip(first.monthlySip, plan.returnPct, years, plan.stepUpPct);
    if (expected > 0) vsPlanPct = ((last.investable - expected) / expected) * 100;
  }
  const verdict = vsPlanPct === null ? 'on_plan' : vsPlanPct > 3 ? 'ahead' : vsPlanPct < -3 ? 'behind' : 'on_plan';
  const messages: string[] = [];
  messages.push(`Investments grew ${growthPct.toFixed(1)}% over ${months} month${months === 1 ? '' : 's'}.`);
  if (verdict === 'ahead') messages.push('You are ahead of plan. You may retire earlier.');
  if (verdict === 'behind') messages.push('You are behind plan. Raise your SIP or review spending.');
  if (verdict === 'on_plan') messages.push('You are on plan. Keep going.');
  if (last.fireNumber > first.fireNumber * 1.1) messages.push('Your FIRE number went up more than 10%. Check if spending is creeping up.');
  return { snapshots: snapshots.length, firstDate: first.date, growthPct, monthlyAddedAvg, vsPlanPct, verdict, messages };
}
