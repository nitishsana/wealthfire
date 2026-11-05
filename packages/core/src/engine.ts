// One call that turns stored data into everything the screens show.
// Web, Android and iOS all render from analyze(), so results match everywhere.
import type { AppData, Snapshot } from './types';
import { computeRiskScore, isRiskComplete } from './risk';
import type { RiskResult } from './types';
import { summarizeNetWorth, type NetWorthSummary } from './networth';
import { summarizeExpenses, type ExpenseSummary } from './expenses';
import { suggestPortfolio, type PortfolioSuggestion } from './portfolio';
import { computeFirePlan, type FirePlan } from './fire';
import { bucketsFromNetWorth, planBuckets, type BucketPlan } from './buckets';
import { trackProgress, type ProgressReport } from './tracking';
import { todayIso } from './format';

export interface Analysis {
  ready: boolean;
  missing: string[];
  risk: RiskResult | null;
  netWorth: NetWorthSummary;
  expenses: ExpenseSummary;
  portfolio: PortfolioSuggestion | null;
  fire: FirePlan | null;
  buckets: BucketPlan | null;
  progress: ProgressReport;
}

export interface AnalyzeOptions {
  /** Override of assumptions.lastYearEquityReturn, %. */
  lastYearEquityReturn?: number;
}

export function analyze(data: AppData, opts: AnalyzeOptions = {}): Analysis {
  const netWorth = summarizeNetWorth(data.assets, data.liabilities);
  const expenses = summarizeExpenses(data.expenses);
  const missing: string[] = [];
  if (!data.profile) missing.push('profile');
  if (!isRiskComplete(data.riskAnswers)) missing.push('risk');
  if (expenses.months === 0 && !data.profile?.monthlyExpenseOverride) missing.push('expenses');

  const profile = data.profile;
  const risk = profile ? computeRiskScore(data.riskAnswers, profile.age) : null;

  let portfolio: PortfolioSuggestion | null = null;
  let fire: FirePlan | null = null;
  let buckets: BucketPlan | null = null;

  if (profile && risk) {
    const yearsToFire = Math.max(0, profile.targetRetireAge - profile.age);
    // First pass with the current SIP to get a return, then size the portfolio to the required SIP.
    const draft = suggestPortfolio(risk.profile, yearsToFire, profile.currentMonthlySip, data.assumptions);
    fire = computeFirePlan({
      profile,
      monthlyLiving: expenses.monthlyLiving,
      monthlyEmi: netWorth.monthlyEmi,
      investable: netWorth.investable,
      portfolioReturn: draft.expectedReturn,
      assumptions: data.assumptions,
    });
    const sipToSplit = Math.max(profile.currentMonthlySip, fire.requiredMonthlySip);
    portfolio = suggestPortfolio(risk.profile, yearsToFire, sipToSplit, data.assumptions);
    buckets = planBuckets({
      current: data.buckets ?? bucketsFromNetWorth(netWorth),
      yearsToFire,
      monthlyExpense: fire.monthlyExpenseToday,
      monthlyExpenseAtFire: fire.monthlyExpenseAtFire,
      lastYearEquityReturn: opts.lastYearEquityReturn ?? data.assumptions.lastYearEquityReturn,
      monthlySip: sipToSplit,
    });
  }

  const progress = trackProgress(
    data.snapshots,
    portfolio ? { returnPct: portfolio.expectedReturn, stepUpPct: data.assumptions.sipStepUp } : null,
  );
  return { ready: missing.length === 0, missing, risk, netWorth, expenses, portfolio, fire, buckets, progress };
}

/** Build this month's check-in from current data. */
export function makeSnapshot(data: AppData, a: Analysis, date = todayIso()): Snapshot {
  return {
    date,
    investable: Math.round(a.netWorth.investable),
    netWorth: Math.round(a.netWorth.netWorth),
    fireNumber: Math.round(a.fire?.fireNumberToday ?? 0),
    monthlySip: data.profile?.currentMonthlySip ?? 0,
  };
}
